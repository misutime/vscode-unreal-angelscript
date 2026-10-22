import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as scripts from '../src/as_parser';
import * as database from '../src/database';
import * as completion from '../src/parsed_completion';
import * as symbols from '../src/symbols';
import * as references from '../src/references';
import { GetStructuredClassDiagnostics } from '../src/ls_diagnostics';

database.AddPrimitiveTypes(true);
let checks = 0;
function check(name: string, run: () => void) {
    run();
    ++checks;
    console.log('PASS ' + name);
}
function parse(name: string, source: string) {
    const uri = 'file:///structured-class-tests/' + name + '.as';
    const module = scripts.GetOrCreateModule(name, name + '.as', uri);
    module.textDocument = TextDocument.create(uri, 'angelscript', 1, source);
    module.content = source;
    module.loaded = true;
    scripts.ParseModule(module);
    scripts.ResolveModule(module);
    return module;
}
function finish(generator: Generator) {
    let step = generator.next();
    while (!step.done) step = generator.next();
    return step.value;
}
function property(type: database.DBType, name: string): database.DBProperty {
    const result = type.findFirstSymbol(name, database.DBAllowSymbol.Properties);
    assert.ok(result instanceof database.DBProperty, name);
    return result;
}
const source = `class UStructuredProbe
{
    config
    {
        UPROPERTY() int Distance = 1600;
        protected int Minimum = 1000;
    }
    state
    {
        int Current = 0;
    }
}
// 输入与内部状态
impl UStructuredProbe
{
    UFUNCTION() void Reset() { Current = Distance; Apply(Current); }
    private void Apply(int Value) { Current = Value; }
}
// 只读查询
impl UStructuredProbe
{
    int Read() const { return Current; }
    int Read(int Offset) const { return Current + Offset; }
}
`;
const module = parse('Structured', source);
const type = database.GetTypeByName('UStructuredProbe');
check('one class, three fields, multiple member blocks and overloads', () => {
    assert.equal(module.types.length, 1);
    assert.equal(type.isStructuredClass, true);
    assert.equal(property(type, 'Distance').fieldRole, 'config');
    assert.equal(property(type, 'Distance').typename, 'int');
    assert.equal(property(type, 'Distance').isPrivate, true);
    assert.equal(property(type, 'Minimum').isProtected, true);
    assert.equal(property(type, 'Minimum').isPrivate, false);
    assert.equal(property(type, 'Current').fieldRole, 'state');
    assert.equal(type.findSymbols('Read', database.DBAllowSymbol.Functions).length, 2);
    assert.equal(database.GetRootNamespace().findSymbols('Reset', database.DBAllowSymbol.Functions).length, 0);
    assert.deepEqual(GetStructuredClassDiagnostics(module), []);
    assert.ok(!module.semanticSymbols.some(s => s.type == scripts.ASSymbolType.UnknownError),
        JSON.stringify(module.semanticSymbols.filter(s => s.type == scripts.ASSymbolType.UnknownError)));
});
check('outline preserves field sections and separate impl source blocks', () => {
    const outline = symbols.DocumentSymbols(module);
    assert.deepEqual(outline.map(s => s.name), ['UStructuredProbe', 'impl UStructuredProbe · 输入与内部状态', 'impl UStructuredProbe · 只读查询']);
    assert.deepEqual(outline[0].children.map(s => s.name), ['config', 'state']);
    assert.deepEqual(outline[1].children.map(s => s.name), ['Reset()', 'Apply(…)']);
    assert.equal(outline[1].children[0].range.start.line, module.textDocument.positionAt(source.indexOf('Reset()')).line);
});
check('field and method definitions point to original declarations', () => {
    for (const name of ['Distance', 'Apply']) {
        const offset = source.lastIndexOf(name);
        const definition = symbols.GetDefinition(module, module.textDocument.positionAt(offset + 2));
        assert.equal(definition.length, 1, name);
        const declaration = name == 'Distance' ? source.indexOf('Distance') : source.indexOf('Apply(int');
        assert.deepEqual(definition[0].range.start, module.textDocument.positionAt(declaration));
    }
    const implOffset = source.indexOf('impl UStructuredProbe') + 7;
    assert.equal(symbols.GetDefinition(module, module.textDocument.positionAt(implOffset)).length, 1);
});
check('hover explains config role and rename follows uses in impl', () => {
    const offset = source.indexOf('Distance');
    const position = module.textDocument.positionAt(offset + 2);
    assert.match(JSON.stringify(symbols.GetHover(module, position)), /配置字段/);
    const changes = finish(references.PerformRename(module.uri, position, 'DefaultDistance'));
    assert.ok(changes.has(module.displayUri));
    assert.equal(changes.get(module.displayUri).length, 2);
    const classPosition = module.textDocument.positionAt(source.indexOf('UStructuredProbe') + 2);
    const classRename = finish(references.PerformRename(module.uri, classPosition, 'URenamedProbe'));
    assert.equal(classRename.get(module.displayUri).length, 3);
});
check('completion can see private fields and other impl methods', () => {
    const content = source.replace('Apply(Current);', 'App');
    const edited = parse('Completion', content.replace(/UStructuredProbe/g, 'UCompletionProbe'));
    const offset = edited.content.indexOf('App }') + 3;
    const items = completion.Complete(edited, edited.textDocument.positionAt(offset));
    assert.ok(items.some(item => item.label === 'Apply'), JSON.stringify(items.map(i => i.label)));
});
check('direct config writes are rejected while state writes are valid', () => {
    const bad = parse('Write', 'class UWriteProbe { config { int Value = 2; } state { int Current; } } impl UWriteProbe { void Run() { Value = 3; this.Value++; Current = Value; } }');
    const diagnostics = GetStructuredClassDiagnostics(bad);
    assert.equal(diagnostics.filter(d => d.message.includes('cannot be written')).length, 2, JSON.stringify(diagnostics));
});
check('structural diagnostics reject duplicate roles and mixed inline methods', () => {
    const bad = parse('Duplicate', 'class UDuplicateProbe { config {} config {} void Run() {} } impl UDuplicateProbe { int Illegal; }');
    const messages = GetStructuredClassDiagnostics(bad).map(d => d.message).join('\n');
    assert.match(messages, /only once/);
    assert.match(messages, /must be declared in impl/);
    assert.match(messages, /only member methods/);
});
check('impl cannot attach across files or before the class declaration', () => {
    parse('Owner', 'class UOwnerProbe {}');
    const cross = parse('Other', 'impl UOwnerProbe { void Illegal() {} }');
    assert.match(GetStructuredClassDiagnostics(cross)[0].message, /same file/);
    assert.equal(database.GetTypeByName('UOwnerProbe').findSymbols('Illegal', database.DBAllowSymbol.Functions).filter(Boolean).length, 0,
        JSON.stringify(database.GetTypeByName('UOwnerProbe').findSymbols('Illegal')));
    const before = parse('Before', 'impl UBeforeProbe { void Illegal() {} } class UBeforeProbe {}');
    assert.match(GetStructuredClassDiagnostics(before)[0].message, /preceding/);
});
check('namespace methods attach within their own namespace', () => {
    const scoped = parse('Namespace', 'namespace Upgrade { class UNamespaceProbe { state { int Value; } } impl UNamespaceProbe { int Read() { return Value; } } }');
    assert.deepEqual(GetStructuredClassDiagnostics(scoped), []);
    assert.equal(scoped.types[0].findSymbols('Read').length, 1);
    assert.ok(!scoped.semanticSymbols.some(s => s.type == scripts.ASSymbolType.UnknownError));
});
check('ordinary contextual keyword identifiers remain valid', () => {
    const legacy = parse('Legacy', 'class ULegacyProbe { int config; int state; int impl; void Run() { config = state + impl; } }');
    assert.equal(legacy.types[0].isStructuredClass, false);
    assert.ok(!legacy.semanticSymbols.some(s => s.type == scripts.ASSymbolType.UnknownError));
    assert.deepEqual(GetStructuredClassDiagnostics(legacy), []);
});
check('role metadata conflicts and misplaced defaults are diagnosed', () => {
    const bad = parse('Metadata', 'class UMetadataProbe { config { UPROPERTY(BlueprintReadWrite, Replicated) int Value; UPROPERTY(DefaultComponent) int Component; } state { UPROPERTY(EditAnywhere) int Current; } } impl UMetadataProbe { default Value = 2; UMetadataProbe() {} void __InitCustom() {} }');
    const messages = GetStructuredClassDiagnostics(bad).map(d => d.message).join('\n');
    assert.match(messages, /Blueprint writable/);
    assert.match(messages, /Runtime writable/);
    assert.match(messages, /state fields/);
    assert.match(messages, /Component declarations/);
    assert.match(messages, /Constructors/);
    assert.match(messages, /only member methods/);
});
check('comments between contextual header tokens and legacy struct diagnostics', () => {
    const valid = parse('Commented', 'class UCommentProbe { config /* 配置 */ { int Value = 2; } state /* 状态 */ {} } impl /* 功能 */ UCommentProbe /* 方法 */ { int Read() { return Value; } }');
    assert.deepEqual(GetStructuredClassDiagnostics(valid), []);
    assert.equal(valid.types[0].findSymbols('Read').length, 1);
    const invalid = parse('Struct', 'struct FStateProbe { state { int Value; } } impl FStateProbe { void Run() {} }');
    const messages = GetStructuredClassDiagnostics(invalid).map(d => d.message).join('\n');
    assert.match(messages, /require a script class/);
    assert.match(messages, /preceding script class/);
});
check('role and macro completion stays in the permitted declaration scope', () => {
    function labels(name: string, source: string, at: string) {
        const module = parse(name, source);
        return completion.Complete(module, module.textDocument.positionAt(source.indexOf(at) + at.length)).map(item => item.label);
    }
    assert.ok(labels('RoleComplete', 'class URoleComplete { conf\n}', 'conf').includes('config'));
    assert.ok(labels('ImplComplete', 'class UImplComplete {}\nimp', 'imp').includes('impl'));
    const fields = labels('FieldComplete', 'class UFieldComplete { state { UPROP\n } }', 'UPROP');
    assert.ok(fields.includes('UPROPERTY'), JSON.stringify(fields));
    assert.ok(!fields.includes('UPROPERTY(EditAnywhere)'));
    const methods = labels('MethodComplete', 'class UMethodComplete {} impl UMethodComplete { UPROP\n }', 'UPROP');
    assert.ok(!methods.includes('UPROPERTY'));
});
check('reparse removes obsolete impl methods without duplicating types', () => {
    scripts.UpdateModuleFromContent(module, 'class UStructuredProbe { state { int Current; } } impl UStructuredProbe { void NewMethod() {} }');
    scripts.ParseModule(module);
    assert.equal(module.types.length, 1);
    const updated = database.GetTypeByName('UStructuredProbe');
    assert.equal(updated.findSymbols('Read').filter(Boolean).length, 0);
    assert.equal(updated.findSymbols('NewMethod').length, 1);
});
console.log('Structured class language service: ' + checks + ' checks passed');
