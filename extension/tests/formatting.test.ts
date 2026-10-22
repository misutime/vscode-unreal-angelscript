import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { AngelscriptClangDocumentFormattingEditProvider } from '../src/formatting/formatter';

export async function run(): Promise<void> {
    const extension = vscode.extensions.getExtension('misutime.unreal-angelscript');
    assert.ok(extension);
    await extension.activate();
    const workspace = process.env.AS_FORMAT_TEST_WORKSPACE!;
    const results = { passed: [] as string[], failed: [] as string[] };
    const options = { insertSpaces: false, tabSize: 4 };
    const formatterConfig = vscode.workspace.getConfiguration('unreal-angelscript-clang-format');
    const report = process.env.AS_FORMAT_TEST_REPORT!;

    async function check(name: string, test: () => Promise<void>) {
        try {
            await test();
            results.passed.push(name);
        } catch (error) {
            results.failed.push(name + ': ' + String(error));
            throw error;
        } finally {
            fs.writeFileSync(report, JSON.stringify(results, null, 2));
        }
    }
    async function document(name: string, source: string) {
        const uri = vscode.Uri.file(path.join(workspace, name + '.as'));
        fs.writeFileSync(uri.fsPath, source);
        return vscode.workspace.openTextDocument(uri);
    }
    async function apply(doc: vscode.TextDocument, edits: vscode.TextEdit[]) {
        if (!edits?.length)
            return doc.getText();
        const edit = new vscode.WorkspaceEdit();
        edit.set(doc.uri, edits);
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        return doc.getText();
    }
    async function format(doc: vscode.TextDocument) {
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', doc.uri, options);
        return apply(doc, edits || []);
    }

    await check('registered providers and formatter identity', async () => {
        const doc = await document('Identity', 'int Shared(){return 42;}');
        assert.equal(doc.languageId, 'angelscript');
        assert.equal(vscode.workspace.getConfiguration('editor', { uri: doc.uri, languageId: doc.languageId }).get('defaultFormatter'), extension.id);
        assert.ok((await vscode.commands.getCommands()).includes('unreal-angelscript-clang-format.generate-config-file'));
        assert.match(await format(doc), /int Shared\(\)\s*\{\s*return 42;/);
    });
    await check('upstream AngelScript fixture', async () => {
        const fixtureRoot = process.env.AS_FORMAT_TEST_FIXTURES!;
        const doc = await document('Fixture', fs.readFileSync(path.join(fixtureRoot, 'fixture-unformatted.as'), 'utf8'));
        const expected = fs.readFileSync(path.join(fixtureRoot, 'fixture-formatted.as'), 'utf8');
        assert.equal((await format(doc)).replace(/\r\n/g, '\n'), expected.replace(/\r\n/g, '\n'));
    });
    await check('export Global macros and idempotence', async () => {
        const doc = await document('Exports', 'UFUNCTION()\nexport int Shared(int Value=42){return Value;}\nint Run(){return Global::Shared();}\n');
        const first = await format(doc);
        assert.match(first, /UFUNCTION\(\)\s+export int Shared\(int Value = 42\)/);
        assert.ok(first.includes('Global::Shared()'));
        assert.equal(await format(doc), first);
    });
    await check('Chinese comments and string contents', async () => {
        const doc = await document('Unicode', '// 中文注释：数值单位为秒。\nint Shared(){return 42;}\nFString Text=f"数值 {42}";\n');
        const output = await format(doc);
        assert.ok(output.includes('// 中文注释：数值单位为秒。'));
        assert.ok(output.includes('f"数值 {42}"'));
    });
    await check('config state and multiple impl blocks preserve boundaries', async () => {
        const doc = await document('Structured', 'class UFormatProbe\n{\nconfig{UPROPERTY() int Distance=1600;}\nstate{int Current=0;}\n}\nimpl UFormatProbe\n{\nUFUNCTION() void Reset(){Current=Distance;}\n}\nimpl UFormatProbe\n{\nint Read()const{return Current;}\n}\n');
        const first = await format(doc);
        assert.match(first, /config\s*\{\s*UPROPERTY\(\)\s+int Distance = 1600;/);
        assert.match(first, /state\s*\{\s*int Current = 0;/);
        assert.equal((first.match(/impl UFormatProbe/g) || []).length, 2);
        assert.ok(!/}\s*impl/.test(first.replace(/\r?\n/g, '@')));
        assert.match(first, /}\r?\nimpl UFormatProbe/);
        assert.equal(await format(doc), first);
    });
    await check('structured syntax with comments strings and namespace', async () => {
        const doc = await document('StructuredUnicode', 'namespace Test\n{\nclass UTextProbe {config{FString Text="impl config state 中文";} state{int Current;}}\n// 查询：保留中文与字符串。\nimpl UTextProbe {int Read()const{return Current;}}\n}\n');
        const first = await format(doc);
        assert.ok(first.includes('"impl config state 中文"'));
        assert.ok(first.includes('// 查询：保留中文与字符串。'));
        assert.match(first, /impl UTextProbe/);
        assert.equal(await format(doc), first);
    });
    await check('bundled language server resolves fields and multiple impl blocks', async () => {
        const source = 'class ULspProbe { config { int Distance = 2; } state { int Current; } }\nimpl ULspProbe { void Reset() { Current = Distance; } }\nimpl ULspProbe { int Read() const { return Current; } }\n';
        const doc = await document('LspProbe', source);
        const use = doc.positionAt(source.lastIndexOf('Distance') + 2);
        let definitions: vscode.Location[] = [];
        const deadline = Date.now() + 30000;
        while (!definitions.length && Date.now() < deadline) {
            definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, use) || [];
            if (!definitions.length) await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(definitions.length, 1);
        assert.equal(doc.offsetAt(definitions[0].range.start), source.indexOf('Distance'));
        const outline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
        assert.deepEqual(outline.map(item => item.name), ['ULspProbe', 'impl ULspProbe', 'impl ULspProbe']);
        const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, use);
        assert.match(hover.flatMap(item => item.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n'), /配置字段/);
        const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, use, 'DefaultDistance');
        assert.equal(rename.get(doc.uri).length, 2);
        const badSource = source.replace('Current = Distance;', 'Distance = 3;');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(source.length)), badSource);
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        const diagnosticsDeadline = Date.now() + 5000;
        while (!vscode.languages.getDiagnostics(doc.uri).some(item => item.message.includes('cannot be written')) && Date.now() < diagnosticsDeadline)
            await new Promise(resolve => setTimeout(resolve, 100));
        assert.ok(vscode.languages.getDiagnostics(doc.uri).some(item => item.message.includes('cannot be written')));
    });
    for (const name of ['CameraComponent', 'PlayerController', 'PlayerCharacter', 'PlayerAnimInstance']) {
        await check('actual Asasi ' + name + ' formatting preserves tokens and is idempotent', async () => {
            const source = fs.readFileSync(path.join(process.env.AS_FORMAT_TEST_FIXTURES!, 'asasi', name + '.as'), 'utf8');
            const doc = await document(name, source);
            const formatted = await format(doc);
            const tokens = (value: string) => value.replace(/\s+/g, '');
            assert.equal(tokens(formatted), tokens(source));
            assert.equal(await format(doc), formatted);
            fs.writeFileSync(path.join(workspace, name + '.formatted.as'), formatted);
        });
    }
    await check('required configuration readonly state and impl title reach the installed language server', async () => {
        const source = 'class UPracticalRoleProbe : UObject { config { UPROPERTY(Required) UObject Asset; } state { UPROPERTY(BlueprintReadOnly) int Value; } }\n// 状态更新\nimpl UPracticalRoleProbe { void Run() { Value = 3; } }\n';
        const doc = await document('PracticalRoles', source);
        await vscode.window.showTextDocument(doc);
        let outline: vscode.DocumentSymbol[] = [];
        const deadline = Date.now() + 5000;
        while (!outline.length && Date.now() < deadline) {
            outline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri) || [];
            if (!outline.length) await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(outline[1].name, 'impl UPracticalRoleProbe · 状态更新');
        const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, doc.positionAt(source.indexOf(' Asset;') + 3));
        assert.match(hover.flatMap(item => item.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n'), /必填配置/);
        const stateHover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, doc.positionAt(source.lastIndexOf('Value') + 2));
        assert.match(stateHover.flatMap(item => item.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n'), /自动建立私有字段/);
        const formatted = await format(doc);
        assert.match(formatted, /UPROPERTY\(Required\)/);
        assert.match(formatted, /UPROPERTY\(BlueprintReadOnly\)/);
        assert.equal(await format(doc), formatted);
    });
    await check('field role semantic tokens classify declarations and uses', async () => {
        const source = 'class UTokenRoleProbe { config { int Limit; } state { int Count; } }\nimpl UTokenRoleProbe { void Run(int Local) { Count = Limit; this.Count = Local; } }\n';
        const doc = await document('TokenRoles', source);
        await vscode.window.showTextDocument(doc);
        const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
        const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
        assert.ok(legend && tokens);
        const classified: Array<{ name: string, type: string }> = [];
        let line = 0, character = 0;
        for (let i = 0; i < tokens.data.length; i += 5) {
            character = tokens.data[i] ? tokens.data[i + 1] : character + tokens.data[i + 1];
            line += tokens.data[i];
            const start = doc.offsetAt(new vscode.Position(line, character));
            classified.push({ name: source.slice(start, start + tokens.data[i + 2]), type: legend.tokenTypes[tokens.data[i + 3]] });
        }
        assert.deepEqual(classified.filter(item => item.name === 'Limit').map(item => item.type), ['as_config_field', 'as_config_field']);
        assert.deepEqual(classified.filter(item => item.name === 'Count').map(item => item.type), ['as_state_field', 'as_state_field', 'as_state_field']);
        assert.ok(classified.filter(item => item.name === 'Local').every(item => item.type === 'as_parameter'));
    });
    await check('field role completion labels preserve inserted member names', async () => {
        const source = 'class ULabelRoleProbe { config { int Limit; } state { int Count; } } impl ULabelRoleProbe { void Run() { this.\n } }';
        const doc = await document('CompletionRoles', source);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(source.indexOf('this.') + 5), undefined, 100);
        for (const [name, role] of [['Limit', '[config 配置]'], ['Count', '[state 状态]']]) {
            const item = list.items.find(item => (typeof item.label === 'string' ? item.label : item.label.label) === name);
            assert.ok(item, name);
            assert.ok(typeof item.label !== 'string');
            assert.equal(item.label.detail.trim(), role);
            assert.equal(item.label.description, 'int');
            assert.equal(item.detail, role + ' int');
            assert.equal(item.insertText ?? item.label.label, name);
        }
    });
    await check('field role color defaults and explicit user overrides', async () => {
        const settings = vscode.workspace.getConfiguration('editor');
        const initial = settings.inspect<any>('semanticTokenColorCustomizations').workspaceValue;
        const defaults = settings.get<any>('semanticTokenColorCustomizations');
        assert.equal(defaults.rules['as_config_field:angelscript'], '#D7BA7D');
        assert.equal(defaults.rules['as_state_field:angelscript'], '#4EC9B0');
        assert.equal(defaults['[*Light*]'].rules['as_config_field:angelscript'], '#865500');
        assert.equal(defaults['[*Light*]'].rules['as_state_field:angelscript'], '#006D62');
        const declared = extension.packageJSON.contributes.semanticTokenTypes;
        assert.deepEqual(declared.map(type => type.id), ['as_config_field', 'as_state_field']);
        const doc = await document('ThemeRoles', 'class UThemeRoleProbe {}');
        const scoped = vscode.workspace.getConfiguration('editor', { uri: doc.uri, languageId: doc.languageId });
        assert.equal(scoped.get('semanticHighlighting.enabled'), true);
        try {
            await settings.update('semanticTokenColorCustomizations', { rules: { 'as_config_field:angelscript': '#AB1234', 'variable': '#ABCDEF' } }, vscode.ConfigurationTarget.Workspace);
            const customized = vscode.workspace.getConfiguration('editor').get<any>('semanticTokenColorCustomizations');
            assert.equal(customized.rules['as_config_field:angelscript'], '#AB1234');
            assert.equal(customized.rules['as_state_field:angelscript'], '#4EC9B0');
            assert.equal(customized.rules.variable, '#ABCDEF');
            await scoped.update('semanticHighlighting.enabled', false, vscode.ConfigurationTarget.Workspace, true);
            assert.equal(vscode.workspace.getConfiguration('editor', { uri: doc.uri, languageId: doc.languageId }).get('semanticHighlighting.enabled'), false);
        } finally {
            await settings.update('semanticTokenColorCustomizations', initial, vscode.ConfigurationTarget.Workspace);
            await scoped.update('semanticHighlighting.enabled', undefined, vscode.ConfigurationTarget.Workspace, true);
        }
    });
    await check('member callbacks preserve UTF8 short signatures and multiple impl blocks', async () => {
        const doc = await document('CallbacksFormat', 'class UCallbacksFormat:UObject{state{UInputSink Sink;}}\n// 回调：只保留需要的参数。\nimpl UCallbacksFormat{void Run(){Sink.Bind(this.OnInput);Sink.Bind(this.OnReset);}}\nimpl UCallbacksFormat{UFUNCTION() private void OnInput(int Value){}}\nimpl UCallbacksFormat{UFUNCTION() private void OnReset(){}}\n');
        const output = await format(doc);
        assert.ok(output.includes('// 回调：只保留需要的参数。'));
        assert.match(output, /this\.OnInput\)/); assert.match(output, /this\.OnReset\)/);
        assert.equal((output.match(/impl UCallbacksFormat/g) || []).length, 3);
        assert.equal(await format(doc), output);
    });
    await check('bundled callback symbols completion resolve hover and rename', async () => {
        const source = 'class UCallbackHost:UObject{state{UInputSink Sink;}}\nimpl UCallbackHost{UFUNCTION() private void OnInput(int Value){} void Run(){Sink.Bind(this.OnInput);}}\n';
        const doc = await document('CallbackHost', source);
        const offset = source.lastIndexOf('this.OnInput') + 7;
        const use = doc.positionAt(offset);
        let definitions: vscode.Location[] = [];
        const deadline = Date.now() + 30000;
        while (!definitions.length && Date.now() < deadline) {
            definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, use) || [];
            if (!definitions.length) await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(definitions.length, 1);
        assert.equal(doc.offsetAt(definitions[0].range.start), source.indexOf('OnInput'));
        const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, use);
        assert.match(hover.flatMap(item => item.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n'), /1\/3/);
        const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, use, 'OnZoom');
        assert.equal(rename.get(doc.uri).length, 2);
        await vscode.workspace.getConfiguration('UnrealAngelscript').update('insertParenthesisOnFunctionCompletion', true, vscode.ConfigurationTarget.Workspace);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(offset), undefined, 100);
        const callback = list.items.find(item => (typeof item.label == 'string' ? item.label : item.label.label) == 'OnInput');
        assert.ok(callback);
        assert.equal(callback.command, undefined);
        assert.match(JSON.stringify(callback.label), /回调 1\/3/);
        assert.equal(callback.insertText, 'OnInput');
    });
    await check('native event references preserve formatting navigation rename and signatures', async () => {
        const source = 'class UEventHost:UObject{state{UEventSink Sink;}}\nimpl UEventHost{UFUNCTION() private void OnValue(int Value){} void Run(){Sink.Signal.Add(this.OnValue);Sink.Signal.Unbind(this.OnValue);}}\n';
        const doc = await document('EventHost', source);
        const use = doc.positionAt(source.lastIndexOf('this.OnValue') + 7);
        let definitions: vscode.Location[] = [];
        const deadline = Date.now() + 30000;
        while (!definitions.length && Date.now() < deadline) {
            definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, use) || [];
            if (!definitions.length) await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(definitions.length, 1);
        const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, use, 'OnChanged');
        assert.equal(rename.get(doc.uri).length, 3);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, use, undefined, 100);
        const callback = list.items.find(item => (typeof item.label == 'string' ? item.label : item.label.label) == 'OnValue');
        assert.equal(callback.insertText, 'OnValue');
        assert.equal(callback.command, undefined);
        assert.ok(!JSON.stringify(callback.documentation).includes('__ASMulticastCallback_'));
        const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, use);
        const documentation = signature.signatures.flatMap(value => value.parameters.map(parameter =>
            typeof parameter.documentation == 'string' ? parameter.documentation : parameter.documentation?.value || '')).join('\n');
        assert.match(documentation, /原生多播事件/);
        assert.ok(!JSON.stringify(signature).includes('__ASMulticastCallback_'));
        const output = await format(doc);
        assert.match(output, /Signal\.Add\(this\.OnValue\)/);
        assert.match(output, /Signal\.Unbind\(this\.OnValue\)/);
        assert.equal(await format(doc), output);
    });
    await check('callback selection and on type formatting preserve method references', async () => {
        const doc = await document('CallbackSelection', 'void Run(){Sink.Bind(this.OnInput);}\nvoid Other(){Sink.Bind(this.OnReset);}\n');
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatRangeProvider', doc.uri, new vscode.Range(0, 0, 0, doc.lineAt(0).text.length), options);
        const output = await apply(doc, edits);
        assert.ok(output.includes('this.OnInput'));
        assert.ok(output.includes('void Other(){Sink.Bind(this.OnReset);}'));
        const input = await document('CallbackOnType', 'void Run()\n{\n\tSink.Bind(this.OnInput);\n}\n');
        const typed = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatOnTypeProvider', input.uri, new vscode.Position(2, 11), '(', options);
        assert.ok((await apply(input, typed)).includes('this.OnInput'));
    });
    await check('range formatting', async () => {
        const doc = await document('Selection', 'int First(){return 1;}\nint Second(){return 2;}\n');
        const range = new vscode.Range(0, 0, 0, doc.lineAt(0).text.length);
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatRangeProvider', doc.uri, range, options);
        const output = await apply(doc, edits);
        assert.ok(output.includes('return 1;'));
        assert.ok(output.includes('int Second(){return 2;}'));
    });
    await check('on type parentheses stays local', async () => {
        const doc = await document('Parentheses', 'void Run()\n{\n\tif(true){}\n}\n');
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatOnTypeProvider', doc.uri, new vscode.Position(2, 4), '(', options);
        assert.equal(await apply(doc, edits), 'void Run()\n{\n\tif (true){}\n}\n');
    });
    await check('workspace style without an active editor', async () => {
        const style = fs.readFileSync(path.join(extension.extensionPath, 'resources/default-style/.clang-format'), 'utf8')
            .replace('UseTab: Always', 'UseTab: Never').replace('IndentWidth: 4', 'IndentWidth: 2');
        fs.writeFileSync(path.join(workspace, 'space-style.clang-format'), style);
        await formatterConfig.update('style', 'space-style.clang-format', vscode.ConfigurationTarget.Workspace);
        try {
            const doc = await document('Style', 'int Shared(){return 42;}');
            assert.match(await format(doc), /\n  return 42;/);
        } finally {
            await formatterConfig.update('style', undefined, vscode.ConfigurationTarget.Workspace);
        }
    });
    await check('formatter can be disabled', async () => {
        const config = vscode.workspace.getConfiguration('UnrealAngelscript');
        await config.update('formatting.enabled', false, vscode.ConfigurationTarget.Workspace);
        try {
            const doc = await document('Disabled', 'int Shared(){return 42;}');
            assert.equal(await format(doc), doc.getText());
            assert.equal(doc.getText(), 'int Shared(){return 42;}');
        } finally {
            await config.update('formatting.enabled', undefined, vscode.ConfigurationTarget.Workspace);
        }
    });
    await check('on type formatting propagates errors', async () => {
        await formatterConfig.update('style', 'missing-style.clang-format', vscode.ConfigurationTarget.Workspace);
        try {
            const doc = await document('InvalidStyle', 'void Run()\n{\n\tif(true){}\n}\n');
            const formatter = new AngelscriptClangDocumentFormattingEditProvider({ extensionUri: extension.extensionUri } as vscode.ExtensionContext);
            let timeout: NodeJS.Timeout;
            const result = Promise.race([
                Promise.resolve(formatter.provideOnTypeFormattingEdits(doc, new vscode.Position(2, 4), '(', options, null)),
                new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Formatting promise did not settle')), 5000); }),
            ]);
            try {
                await assert.rejects(result, error => !String(error).includes('did not settle'));
            } finally {
                clearTimeout(timeout!);
            }
        } finally {
            await formatterConfig.update('style', undefined, vscode.ConfigurationTarget.Workspace);
        }
    });
    fs.writeFileSync(report, JSON.stringify(results, null, 2));
}
