import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as scripts from '../src/as_parser';
import * as database from '../src/database';
import * as completion from '../src/parsed_completion';
import * as semantics from '../src/semantic_highlighting';

database.AddPrimitiveTypes(true);
let checks = 0;
function check(name: string, run: () => void) {
    run();
    ++checks;
    console.log('PASS ' + name);
}
function parse(name: string, source: string) {
    const uri = 'file:///field-role-tests/' + name + '.as';
    const module = scripts.GetOrCreateModule(name, name + '.as', uri);
    module.textDocument = TextDocument.create(uri, 'angelscript', 1, source);
    module.content = source;
    module.loaded = true;
    scripts.ParseModule(module);
    scripts.ResolveModule(module);
    return module;
}
function tokens(module: scripts.ASModule) {
    const data = semantics.HighlightSymbols(module).data;
    const result: Array<{ text: string, start: number, type: string }> = [];
    let line = 0, character = 0;
    for (let index = 0; index < data.length; index += 5) {
        character = data[index] ? data[index + 1] : character + data[index + 1];
        line += data[index];
        const start = module.textDocument.offsetAt({ line, character });
        result.push({ text: module.content.slice(start, start + data[index + 2]), start,
            type: semantics.SemanticTypeList[data[index + 3]] });
    }
    return result;
}
function complete(module: scripts.ASModule, marker: string) {
    return completion.Complete(module, module.textDocument.positionAt(module.content.indexOf(marker) + marker.length));
}
check('declarations implicit reads writes and this access share their actual field role', () => {
    const module = parse('Access', 'class UAccessRole { config { int Limit = 3; } state { int Count = 0; } }\nimpl UAccessRole { void Run() { Count = Limit; this.Count += this.Limit; } }');
    const result = tokens(module);
    assert.deepEqual(result.filter(t => t.text == 'Limit').map(t => t.type), ['config_field', 'config_field', 'config_field']);
    assert.deepEqual(result.filter(t => t.text == 'Count').map(t => t.type), ['state_field', 'state_field', 'state_field']);
});
check('parameters and local variables that shadow fields keep their ordinary token types', () => {
    const module = parse('Shadow', 'class UShadowRole { config { int Limit; } state { int Count; } } impl UShadowRole { void Run(int Limit) { int Count = Limit; this.Count = Count; int config = 2; int state = config; } }');
    const result = tokens(module);
    assert.deepEqual(result.filter(t => t.text == 'Limit').map(t => t.type), ['config_field', 'parameter', 'parameter']);
    assert.deepEqual(result.filter(t => t.text == 'Count').map(t => t.type), ['state_field', 'local_variable', 'state_field', 'local_variable']);
    assert.ok(result.filter(t => t.text == 'config' || t.text == 'state').every(t => t.type == 'local_variable'));
});
check('inherited roles retain their colors across source modules', () => {
    parse('Parent', 'class UParentRole { config { protected int Limit; } state { protected int Count; } }');
    const module = parse('Child', 'class UChildRole : UParentRole {} impl UChildRole { int Read() { Count = Limit; return this.Count; } }');
    const result = tokens(module);
    assert.equal(result.find(t => t.text == 'Limit').type, 'config_field');
    assert.deepEqual(result.filter(t => t.text == 'Count').map(t => t.type), ['state_field', 'state_field']);
});
check('completion labels preserve names types insertion and roles after resolve', () => {
    const module = parse('CompletionRole', 'class UCompletionRole { config { int Limit; } state { int Count; } } impl UCompletionRole { void Run() { this.\n } }');
    const items = complete(module, 'this.');
    for (const [name, label] of [['Limit', '[config 配置]'], ['Count', '[state 状态]']]) {
        const item = items.find(item => item.label == name);
        assert.ok(item, name);
        assert.equal(item.labelDetails.detail.trim(), label);
        assert.equal(item.labelDetails.description, 'int');
        assert.equal(item.detail, label + ' int');
        assert.equal(item.insertText ?? item.label, name);
        const resolved = completion.Resolve(item);
        assert.equal(resolved.label, name);
        assert.equal(resolved.labelDetails.detail.trim(), label);
        assert.ok(JSON.stringify(resolved.documentation).includes(label));
    }
    const implicit = parse('ImplicitRole', 'class UImplicitRole { config { int Limit; } } impl UImplicitRole { int Read() { return Li\n } }');
    const item = complete(implicit, 'return Li').find(item => item.label == 'Limit');
    assert.equal(item.labelDetails.detail.trim(), '[config 配置]');
    assert.equal(item.insertText ?? item.label, 'Limit');
});
check('legacy member fields retain their existing highlighting and completion description', () => {
    const module = parse('LegacyRole', 'class ULegacyRole { int Count; int config; void Run() { Count = config; this.\n } }');
    assert.ok(tokens(module).filter(t => t.text == 'Count' || t.text == 'config').every(t => t.type == 'member_variable'));
    const item = complete(module, 'this.').find(item => item.label == 'Count');
    assert.equal(item.labelDetails.description, 'int');
    assert.equal(item.labelDetails.detail, undefined);
    assert.equal(item.detail, undefined);
});
check('changing a role updates semantic tokens and completion resolve without stale labels', () => {
    const initial = 'class UChangeRole { config { int Value; } } impl UChangeRole { void Run() { this.\n } }';
    const module = parse('ChangeRole', initial);
    const original = complete(module, 'this.').find(item => item.label == 'Value');
    scripts.UpdateModuleFromContent(module, initial.replace('config', 'state'));
    scripts.ParseModule(module);
    scripts.ResolveModule(module);
    assert.equal(tokens(module).find(t => t.text == 'Value').type, 'state_field');
    const item = completion.Resolve(original);
    assert.equal(item.labelDetails.detail.trim(), '[state 状态]');
    assert.equal(item.detail, '[state 状态] int');
});
console.log('Field role highlighting and completion: ' + checks + ' checks passed');
