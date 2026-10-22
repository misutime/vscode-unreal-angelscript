const esbuild = require('esbuild');
const path = require('node:path');
const serverRoot = path.resolve(__dirname, '..');

const testSource = `
import assert from 'node:assert/strict';
import {TextDocument} from 'vscode-languageserver-textdocument';
import * as scripts from './src/as_parser';
import * as database from './src/database';
import * as completion from './src/parsed_completion';
import * as symbols from './src/symbols';
import * as references from './src/references';

database.AddPrimitiveTypes(true);

function parse(name, source) {
    const uri = 'file:///global-export-tests/' + name + '.as';
    const module = scripts.GetOrCreateModule(name, name + '.as', uri);
    module.textDocument = TextDocument.create(uri, 'angelscript', 1, source);
    module.content = source;
    module.loaded = true;
    scripts.ParseModule(module);
    return module;
}

const provider = parse('Provider', 'export int Shared() { return Hidden(); } int Hidden() { return 42; }');
const root = database.GetRootNamespace();
const shared = root.findSymbols('Shared', database.DBAllowSymbol.Functions);
assert.equal(shared.length, 1);
assert.equal(shared[0].isExported, true);
assert.equal(shared[0].isLocal, true);
const global = root.findChildNamespace('Global');
assert.ok(global);
const alias = global.findSymbols('Shared', database.DBAllowSymbol.Functions);
assert.equal(alias.length, 1);
assert.equal(alias[0].isLocal, false);
assert.equal(alias[0].declaredModule, 'Provider');
assert.ok(Number.isInteger(alias[0].moduleOffset));
assert.equal(alias[0].moduleOffset, shared[0].moduleOffset);
assert.equal(global.findSymbols('Hidden', database.DBAllowSymbol.Functions).length, 0);
const engineSnapshot = {__Global: {properties: {}, methods: {
    Shared: {name: 'Shared', return: 'int', args: [], exported: true, declaredModule: 'Provider'},
    EngineOnly: {name: 'EngineOnly', return: 'int', args: [], exported: true, declaredModule: 'EngineProvider'},
}}};
database.AddTypesFromUnreal(engineSnapshot);
database.AddTypesFromUnreal(engineSnapshot);
assert.equal(global.findSymbols('Shared', database.DBAllowSymbol.Functions).length, 1);
assert.equal(global.findSymbols('Shared', database.DBAllowSymbol.Functions)[0].moduleOffset, shared[0].moduleOffset);
assert.equal(global.findSymbols('EngineOnly', database.DBAllowSymbol.Functions).length, 1);
database.AddTypesFromUnreal({__Global: {properties: {}, methods: {}}});
assert.equal(global.findSymbols('EngineOnly', database.DBAllowSymbol.Functions).length, 0);
assert.equal(global.findSymbols('Shared', database.DBAllowSymbol.Functions).length, 1);

const source = 'int Run() { return Global::Sha';
const consumer = parse('Consumer', source);
const items = completion.Complete(consumer, consumer.textDocument.positionAt(source.length));
assert.ok(items.some(item => item.label === 'Shared'));
const bareSource = 'int Run() { return Sha';
const bare = parse('BareConsumer', bareSource);
const bareItems = completion.Complete(bare, bare.textDocument.positionAt(bareSource.length));
assert.ok(!bareItems.some(item => item.label === 'Shared'));

function finish(generator) {
    let step = generator.next();
    while (!step.done) step = generator.next();
    return step.value;
}

const resolved = parse('ResolvedConsumer', 'int Run() { return Global::Shared(); }');
scripts.ResolveModule(resolved);
const callPosition = resolved.textDocument.positionAt(resolved.content.indexOf('Shared') + 2);
const definitions = symbols.GetDefinition(resolved, callPosition);
assert.equal(definitions.length, 1);
assert.equal(definitions[0].uri, provider.displayUri);
const hover = symbols.GetHover(resolved, callPosition);
assert.ok(hover);
const providerPosition = provider.textDocument.positionAt(provider.content.indexOf('Shared') + 2);
const fromConsumer = finish(references.FindReferences(resolved.uri, callPosition));
const fromProvider = finish(references.FindReferences(provider.uri, providerPosition));
assert.ok(fromConsumer.some(location => location.uri === provider.displayUri), 'References must include the export declaration');
assert.ok(fromProvider.some(location => location.uri === resolved.displayUri), 'References must include Global calls');
const rename = finish(references.PerformRename(provider.uri, providerPosition, 'RenamedShared'));
assert.ok(rename.has(provider.displayUri));
assert.ok(rename.has(resolved.displayUri), 'Rename must include Global calls');
const renameFromConsumer = finish(references.PerformRename(resolved.uri, callPosition, 'RenamedShared'));
assert.ok(renameFromConsumer.has(provider.displayUri));
assert.ok(renameFromConsumer.has(resolved.displayUri));
const localConsumer = parse('LocalConsumer', 'int Run() { return Shared(); }');
scripts.ResolveModule(localConsumer);
assert.ok(localConsumer.semanticSymbols.some(symbol => symbol.type === scripts.ASSymbolType.UnknownError && localConsumer.content.slice(symbol.start, symbol.end) === 'Shared'));
assert.ok(!provider.semanticSymbols.some(symbol => symbol.type === scripts.ASSymbolType.UnknownError));
scripts.UpdateModuleFromContent(provider, 'int Shared() { return 42; }');
scripts.ParseModule(provider);
const afterRemoval = root.findChildNamespace('Global');
assert.ok(!afterRemoval || afterRemoval.findSymbols('Shared', database.DBAllowSymbol.Functions).length === 0);
console.log('Global export parsing, completion, definition, hover, references, rename, engine sync and removal checks passed');
`;

esbuild.buildSync({
    stdin: {contents: testSource, resolveDir: serverRoot, sourcefile: 'global-export-tests.ts', loader: 'ts'},
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(serverRoot, 'out/global-export.test.cjs'), logLevel: 'warning',
});
require(path.join(serverRoot, 'out/global-export.test.cjs'));
