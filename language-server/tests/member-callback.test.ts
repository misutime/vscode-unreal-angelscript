import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as scripts from '../src/as_parser';
import * as db from '../src/database';
import * as completion from '../src/parsed_completion';
import * as diagnostics from '../src/ls_diagnostics';
import * as symbols from '../src/symbols';
import * as references from '../src/references';
import * as actions from '../src/code_actions';
import { callbackError } from '../src/member_callbacks';

db.AddPrimitiveTypes(true);
const args = [{ name: 'Value', type: 'int' }, { name: 'Elapsed', type: 'float32' }, { name: 'Source', type: 'UObject' }];
db.AddTypesFromUnreal({ UObject: { properties: {}, methods: {} }, FNativeCallback: { properties: {}, isDelegate: true,
    methods: { ExecuteIfBound: { name: 'ExecuteIfBound', return: 'void', args, isProperty: false }, Execute: { name: 'Execute', return: 'void', args, isProperty: false } } },
    UInputSink: { supertype: 'UObject', properties: {}, methods: { Bind: { name: 'Bind', return: 'void', args: [{name: 'Callback', type: 'FNativeCallback'}], isProperty: false } } } });
let count = 0;
function check(name: string, run: () => void) { run(); console.log('PASS ' + name); ++count; }
function parse(name: string, source: string) {
    const uri = 'file:///member-callback-tests/' + name + '.as';
    const module = scripts.GetOrCreateModule(name, name + '.as', uri);
    module.textDocument = TextDocument.create(uri, 'angelscript', 1, source);
    module.content = source; module.loaded = true;
    scripts.ParseModule(module); scripts.ResolveModule(module);
    return module;
}
let lastDiagnostics: any[] = [];
diagnostics.OnDiagnosticsChanged((uri, value) => lastDiagnostics = value);
function errors(module: scripts.ASModule) {
    diagnostics.UpdateScriptModuleDiagnostics(module, false, true);
    return lastDiagnostics.filter(value => value.severity == 1).map(value => value.message);
}
const source = `class UCallbackToolProbe : UObject { state { UInputSink Sink; FNativeCallback Saved; } }
impl UCallbackToolProbe { UFUNCTION() private void OnInput(int Value) {} UFUNCTION() private void OnReset() {} }
impl UCallbackToolProbe { UFUNCTION() private void OnFull(int Value, float32 Elapsed, UObject Source) {} }
impl UCallbackToolProbe { void Run() { Sink.Bind(this.OnInput); FNativeCallback Local = this.OnReset; Saved = this.OnFull; } }`;
check('arguments typed initializers and assignments use native delegate expectations', () => {
    const module = parse('Bindings', source);
    assert.equal(module.delegateBinds.filter(binding => binding.memberCallback).length, 3);
    assert.deepEqual(errors(module), []);
    for (const name of ['OnInput', 'OnReset', 'OnFull']) {
        const offset = module.content.lastIndexOf('this.' + name) + 5;
        assert.equal(module.getSymbolAt(offset).type, scripts.ASSymbolType.MemberFunction);
        assert.equal(symbols.GetDefinition(module, module.textDocument.positionAt(offset)).length, 1);
    }
    const offset = module.content.lastIndexOf('this.OnInput') + 5;
    assert.match(JSON.stringify(symbols.GetHover(module, module.textDocument.positionAt(offset))), /1\/3/);
    const rename = references.PerformRename(module.uri, module.textDocument.positionAt(offset), 'OnWheel');
    let step = rename.next(); while (!step.done) step = rename.next();
    assert.equal(step.value.get(module.displayUri).length, 2);
});
check('callback completion filters methods and never inserts call parentheses', () => {
    const module = parse('Completion', source.replaceAll('UCallbackToolProbe', 'UCallbackCompletion').replace('Sink.Bind(this.OnInput)', 'Sink.Bind(this.On)'));
    const items = completion.Complete(module, module.textDocument.positionAt(module.content.indexOf('this.On)') + 7));
    const method = items.find(item => item.label == 'OnInput');
    assert.ok(method);
    assert.equal(method.insertText, 'OnInput'); assert.equal(method.command, undefined);
    assert.match(method.labelDetails.detail, /回调 1\/3/);
    const resolved = completion.Resolve(method);
    assert.equal(resolved.command, undefined);
    assert.equal(resolved.insertText, 'OnInput');
    assert.ok(!items.some(item => item.label == 'Run' || item.label == 'Saved'));
    const all = parse('AllCompletion', source.replaceAll('UCallbackToolProbe', 'UCallbackAllCompletion').replace('Sink.Bind(this.OnInput)', 'Sink.Bind(this.)'));
    const available = completion.Complete(all, all.textDocument.positionAt(all.content.indexOf('this.)') + 5));
    assert.ok(available.some(item => item.label == 'OnReset'));
    assert.ok(!available.some(item => item.label == 'Run' || item.label == 'Saved' || item.label == 'Sink'));
});
const negatives = [
    ['missing UFUNCTION', 'UFUNCTION() private void OnInput', 'private void OnInput'],
    ['wrong width', 'OnInput(int Value)', 'OnInput(float Value)'],
    ['reference input', 'OnInput(int Value)', 'OnInput(int& Value)'],
    ['non void', 'private void OnInput(int Value) {}', 'private int OnInput(int Value) { return 0; }'],
    ['event target', 'UFUNCTION() private void OnInput', 'UFUNCTION(BlueprintEvent) private void OnInput'],
    ['other receiver', 'Sink.Bind(this.OnInput)', 'Sink.Bind(Sink.OnInput)'],
];
for (const [name, before, after] of negatives) check(name, () => {
    const module = parse('Negative' + count, source.replaceAll('UCallbackToolProbe', 'UCallbackNegative' + count).replace(before, after));
    assert.ok(errors(module).length, name);
});
check('script delegate is rejected and old name binds remain strict', () => {
    const module = parse('ScriptDelegate', `delegate void FScriptCallback(int Value); class UCallbackScript : UObject {}
        impl UCallbackScript { UFUNCTION() void Target() {} void Run() { FScriptCallback Value = this.Target; FNativeCallback Old(this, n"Target"); } }`);
    assert.equal(errors(module).length, 2);
});
check('overload and inheritance cannot enter callback completion', () => {
    const module = parse('Overload', `class UCallbackOverload : UObject {} impl UCallbackOverload { UFUNCTION() void Target(int Value) {} void Target() {} }`);
    const owner = db.GetTypeByName('UCallbackOverload');
    assert.match(callbackError(db.GetTypeByName('FNativeCallback'), owner.findFirstSymbol('Target', db.DBAllowSymbol.Functions) as db.DBMethod, owner), /重载/);
});
check('missing method action generates the full signature inside impl', () => {
    const source = `class UCallbackMissing : UObject { state { UInputSink Sink; } }
impl UCallbackMissing
{
    void Run()
    {
        Sink.Bind(this.OnMissing);
    }
}
`;
    const module = parse('Missing', source);
    errors(module);
    const diagnostic = lastDiagnostics.find(value => value.data?.type == 'delegateBind');
    assert.ok(diagnostic);
    const choices = actions.GetCodeActions(module, diagnostic.range, [diagnostic]);
    const action = choices.find(value => value.data?.type == 'delegateBind');
    assert.ok(action);
    const resolved = actions.ResolveCodeAction(module, action, action.data);
    const edit = resolved.edit.changes[module.displayUri][0];
    assert.match(edit.newText, /UFUNCTION\(\)/);
    assert.match(edit.newText, /OnMissing\(int Value, float32 Elapsed, UObject Source\)/);
    const offset = module.textDocument.offsetAt(edit.range.start);
    const changed = source.slice(0, offset) + edit.newText + source.slice(offset);
    const updated = parse('MissingUpdated', changed.replaceAll('UCallbackMissing', 'UCallbackMissingUpdated'));
    assert.deepEqual(errors(updated), []);
});
check('const constructor inherited and non-prefix callbacks have explicit errors', () => {
    const samples = [
        `class UCallbackConst : UObject {} impl UCallbackConst { UFUNCTION() void Target() {} void Run() const { FNativeCallback C = this.Target; } }`,
        `class UCallbackConstruct : UObject { UFUNCTION() void Target() {} UCallbackConstruct() { FNativeCallback C = this.Target; } }`,
        `class UCallbackBase : UObject { UFUNCTION() void Target() {} } class UCallbackChild : UCallbackBase {} impl UCallbackChild { void Run() { FNativeCallback C = this.Target; } }`,
        `class UCallbackSkip : UObject {} impl UCallbackSkip { UFUNCTION() void Target(float32 Elapsed) {} void Run() { FNativeCallback C = this.Target; } }`,
    ];
    for (const [index, sample] of samples.entries()) assert.ok(errors(parse('Boundary' + index, sample)).length, sample);
});
check('signature help reports native parameters and retained prefix', () => {
    const module = parse('Signature', source.replaceAll('UCallbackToolProbe', 'UCallbackSignature'));
    const offset = module.content.lastIndexOf('this.OnInput') + 7;
    const result = completion.Signature(module, module.textDocument.positionAt(offset));
    assert.match(JSON.stringify(result), /前 1\/3/);
    assert.match(JSON.stringify(result), /float32 Elapsed/);
});
check('delegate properties keep ordinary copy and assignment behavior', () => {
    const module = parse('DelegateCopy', `class UCallbackCopy : UObject { state { FNativeCallback Saved; } }
        impl UCallbackCopy { void Run() { FNativeCallback Other = this.Saved; Saved = this.Saved; } }`);
    assert.equal(module.delegateBinds.length, 0);
    assert.deepEqual(errors(module), []);
});
const eventCallback = '__ASMulticastCallback_FNativeEvent';
db.AddTypesFromUnreal({
    [eventCallback]: { properties: {}, methods: {
        ExecuteIfBound: { name: 'ExecuteIfBound', return: 'void', args, isProperty: false },
    } },
    FNativeEvent: { properties: {}, methods: {
        Broadcast: { name: 'Broadcast', return: 'void', args, isProperty: false },
        AddUFunction: { name: 'AddUFunction', return: 'void', args: [{name:'Object',type:'UObject'},{name:'FunctionName',type:'FName'}], isProperty:false },
        UnbindLegacy: { name: 'Unbind', return: 'void', args: [{name:'Object',type:'UObject'},{name:'FunctionName',type:'FName'}], isProperty:false },
        Add: { name: 'Add', return: 'void', args: [{name:'Callback',type:`const ${eventCallback}&`}], isProperty:false },
        UnbindMember: { name: 'Unbind', return: 'void', args: [{name:'Callback',type:`const ${eventCallback}&`}], isProperty:false },
    } },
    UEventSink: { supertype: 'UObject', properties: { Signal: ['FNativeEvent'] }, methods: {} },
});
const eventSource = `class UEventCallbackProbe : UObject { state { UEventSink Sink; } }
impl UEventCallbackProbe { UFUNCTION() private void OnValue(int Value) {} UFUNCTION() private void OnEmpty() {} }
impl UEventCallbackProbe { void Run() { Sink.Signal.Add(this.OnValue); Sink.Signal.Unbind(this.OnValue); } }`;
check('native event Add and overloaded Unbind share the typed method symbol', () => {
    const module = parse('NativeEvents', eventSource);
    assert.equal(module.delegateBinds.filter(binding => binding.memberCallback).length, 2);
    assert.deepEqual(errors(module), []);
    const offset = module.content.lastIndexOf('this.OnValue') + 5;
    assert.equal(symbols.GetDefinition(module, module.textDocument.positionAt(offset)).length, 1);
    const rename = references.PerformRename(module.uri, module.textDocument.positionAt(offset), 'OnChanged');
    let step = rename.next(); while (!step.done) step = rename.next();
    assert.equal(step.value.get(module.displayUri).length, 3);
    assert.match(JSON.stringify(symbols.GetHover(module, module.textDocument.positionAt(offset))), /原生多播事件/);
});
check('event subscribe and unsubscribe completion resolve without parentheses or internal types', () => {
    for (const method of ['Add', 'Unbind']) {
        const source = eventSource.replaceAll('UEventCallbackProbe', 'UEventCompletion' + method)
            .replace(`Sink.Signal.${method}(this.OnValue)`, `Sink.Signal.${method}(this.On)`);
        const module = parse('EventCompletion' + method, source);
        const offset = source.indexOf(`Sink.Signal.${method}(this.On)`) + `Sink.Signal.${method}(this.On`.length;
        const list = completion.Complete(module, module.textDocument.positionAt(offset));
        const item = list.find(value => value.label == 'OnValue');
        assert.ok(item, method);
        const resolved = completion.Resolve(item);
        assert.equal(resolved.insertText, 'OnValue');
        assert.equal(resolved.command, undefined);
        assert.match(JSON.stringify(resolved), /回调 1\/3/);
        assert.ok(!JSON.stringify(resolved.documentation).includes('__ASMulticastCallback_'));
        assert.equal(item.labelDetails.description, 'FNativeEvent');
    }
});
check('event signature help exposes the public event signature', () => {
    const module = parse('EventSignature', eventSource.replaceAll('UEventCallbackProbe', 'UEventSignature'));
    const signature = completion.Signature(module, module.textDocument.positionAt(module.content.indexOf('this.OnValue') + 7));
    assert.match(JSON.stringify(signature), /前 1\/3/);
    assert.ok(!JSON.stringify(signature).includes('__ASMulticastCallback_'));
});
check('multicast callback methods obey the existing target and prefix restrictions', () => {
    for (const [name, before, after] of negatives) {
        const replacement = before.replace('OnInput', 'OnValue').replace('Sink.Bind', 'Sink.Signal.Add');
        const changed = after.replace('OnInput', 'OnValue').replace('Sink.Bind', 'Sink.Signal.Add');
        const module = parse('EventNegative' + name, eventSource.replaceAll('UEventCallbackProbe', 'UEventNegative' + name.replaceAll(' ',''))
            .replace(replacement, changed));
        assert.ok(errors(module).length, name);
    }
});
check('legacy event name binding still requires the complete signature', () => {
    const source = eventSource.replaceAll('UEventCallbackProbe', 'UEventLegacy')
        .replace('Sink.Signal.Add(this.OnValue)', 'Sink.Signal.AddUFunction(this, n"OnValue")');
    assert.ok(errors(parse('EventLegacy', source)).length);
});
console.log(`${count} member callback checks passed`);
