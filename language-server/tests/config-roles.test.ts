import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as scripts from '../src/as_parser';
import * as db from '../src/database';
import * as symbols from '../src/symbols';
import * as completion from '../src/parsed_completion';
import { GetStructuredClassDiagnostics } from '../src/ls_diagnostics';

db.AddPrimitiveTypes(true);
db.AddTypesFromUnreal({ UObject: { properties: {}, methods: {} },
    UInputAction: { supertype: 'UObject', properties: {}, methods: {} },
    AActor: { supertype: 'UObject', properties: {}, methods: {} },
    UActorComponent: { supertype: 'UObject', properties: {}, methods: {} },
    UClass: { supertype: 'UObject', properties: {}, methods: {} } });
let checks = 0;
function check(name: string, run: () => void) { run(); ++checks; console.log('PASS ' + name); }
function parse(name: string, source: string) {
    const uri = 'file:///config-role-tests/' + name + '.as';
    const module = scripts.GetOrCreateModule(name, name + '.as', uri);
    module.textDocument = TextDocument.create(uri, 'angelscript', 1, source);
    module.content = source; module.loaded = true;
    scripts.ParseModule(module); scripts.ResolveModule(module);
    return module;
}
function messages(module: scripts.ASModule) { return GetStructuredClassDiagnostics(module).map(d => d.message); }

check('required reference and short blueprint readonly declarations are accepted', () => {
    const source = 'class UConfigRoles : UObject { config { UPROPERTY(Required) UInputAction Action; } state { UPROPERTY(BlueprintReadOnly) float Speed; } } impl UConfigRoles { float Read() { return Speed; } }';
    const module = parse('Valid', source);
    assert.deepEqual(messages(module), []);
    const hover = JSON.stringify(symbols.GetHover(module, module.textDocument.positionAt(source.indexOf(' Action;') + 3)));
    assert.match(hover, /必填配置/);
    const stateHover = JSON.stringify(symbols.GetHover(module, module.textDocument.positionAt(source.lastIndexOf('Speed') + 2)));
    assert.match(stateHover, /自动建立私有字段/);
});
check('required cannot annotate state or legacy members', () => {
    for (const [name, source] of [['State', 'class UWrongState { state { UPROPERTY(Required) UInputAction Action; } }'],
        ['Legacy', 'class UWrongLegacy { UPROPERTY(Required) UInputAction Action; }']])
        assert.ok(messages(parse(name, source)).some(m => m.includes('only allowed on config')));
});
check('required rejects values actors components class references and containers', () => {
    for (const typename of ['int', 'AActor', 'UActorComponent', 'UClass', 'TArray<UInputAction>', 'TWeakObjectPtr<UInputAction>', 'TSoftObjectPtr<UInputAction>', 'TSubclassOf<UObject>']) {
        const name = 'Type' + typename.replace(/\W/g, '');
        assert.ok(messages(parse(name, `class U${name} { config { UPROPERTY(Required) ${typename} Value; } }`)).some(m => m.includes('hard UObject reference')), typename);
    }
    assert.ok(messages(parse('Value', 'class URequiredValue { config { UPROPERTY(Required = true) UInputAction Action; } }')).some(m => m.includes('takes no value')));
});
check('explicit private denial and reserved required metadata are diagnosed', () => {
    assert.ok(messages(parse('Private', 'class UPrivateDenied { state { UPROPERTY(BlueprintReadOnly, meta=(AllowPrivateAccess="false")) int Value; } }')).some(m => m.includes('AllowPrivateAccess=false')));
    assert.ok(messages(parse('Reserved', 'class UReservedMetadata { config { UPROPERTY(meta=(AngelscriptRequired="true")) UInputAction Action; } }')).some(m => m.includes('reserved metadata')));
});
check('required completion is limited to config sections', () => {
    for (const role of ['config', 'state', 'legacy']) {
        const source = `class UComplete${role} { ${role == 'legacy' ? '' : role + ' {'} UPROPERTY(Req\n ${role == 'legacy' ? '' : '}'} }`;
        const module = parse('Complete' + role, source);
        const items = completion.Complete(module, module.textDocument.positionAt(source.indexOf('Req') + 3));
        assert.equal(items.some(i => i.label == 'Required'), role == 'config', role);
    }
});
check('impl outline uses nearby documentation and keeps method declarations intact', () => {
    const source = 'class UOutlineRole {}\n/* 移动命令\n * 提交与停止\n */\nimpl UOutlineRole { void Move() {} }\nimpl UOutlineRole { void Query() {} }';
    const module = parse('Outline', source);
    const outline = symbols.DocumentSymbols(module);
    assert.equal(outline[1].name, 'impl UOutlineRole · 移动命令');
    assert.equal(outline[2].name, 'impl UOutlineRole');
    assert.equal(outline[1].children[0].name, 'Move()');
    assert.equal(outline[1].children[0].selectionRange.start.line, 4);
    scripts.UpdateModuleFromContent(module, source.replace('移动命令', '选择表现'));
    scripts.ParseModule(module); scripts.ResolveModule(module);
    assert.equal(symbols.DocumentSymbols(module)[1].name, 'impl UOutlineRole · 选择表现');
});
console.log('Configuration roles: ' + checks + ' checks passed');
