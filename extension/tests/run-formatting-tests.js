const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const esbuild = require('esbuild');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.resolve(__dirname, '../..');
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'as-formatting-tests-'));
    const workspace = path.join(runRoot, 'workspace');
    fs.mkdirSync(workspace);
    // 独立反射夹具仅提供基础类型，测试不会连接用户的 UE 调试端口。
    const sockets = new Set();
    const reflection = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const callbackArgs = [{ name: 'Value', type: 'int' }, { name: 'Elapsed', type: 'float32' }, { name: 'Source', type: 'UObject' }];
        const json = Buffer.from(JSON.stringify({ UObject: { properties: {}, methods: {} },
            FNativeCallback: { properties: {}, isDelegate: true, methods: {
                ExecuteIfBound: { name: 'ExecuteIfBound', return: 'void', args: callbackArgs, isProperty: false },
            } }, UInputSink: { supertype: 'UObject', properties: {}, methods: {
                Bind: { name: 'Bind', return: 'void', args: [{ name: 'Callback', type: 'FNativeCallback' }], isProperty: false },
            } }, __ASMulticastCallback_FNativeEvent: { properties: {}, methods: {
                ExecuteIfBound: { name: 'ExecuteIfBound', return: 'void', args: callbackArgs, isProperty: false },
            } }, FNativeEvent: { properties: {}, methods: {
                Broadcast: { name: 'Broadcast', return: 'void', args: callbackArgs, isProperty: false },
                Add: { name: 'Add', return: 'void', args: [{ name: 'Callback', type: 'const __ASMulticastCallback_FNativeEvent&' }], isProperty: false },
                UnbindLegacy: { name: 'Unbind', return: 'void', args: [{name:'Object',type:'UObject'},{name:'FunctionName',type:'FName'}], isProperty: false },
                UnbindMember: { name: 'Unbind', return: 'void', args: [{ name: 'Callback', type: 'const __ASMulticastCallback_FNativeEvent&' }], isProperty: false },
            } }, UEventSink: { supertype: 'UObject', properties: { Signal: ['FNativeEvent'] }, methods: {} } }) + '\0');
        const length = Buffer.alloc(4);
        length.writeInt32LE(json.length);
        function packet(type, payload = Buffer.alloc(0)) {
            const header = Buffer.alloc(5);
            header.writeUInt32LE(payload.length);
            header.writeUInt8(type, 4);
            return Buffer.concat([header, payload]);
        }
        socket.write(Buffer.concat([packet(2, Buffer.concat([length, json])), packet(26)]));
        socket.on('error', () => {});
    });
    await new Promise(resolve => reflection.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(path.join(workspace, '.vscode'));
    fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
        'UnrealAngelscript.unrealConnectionPort': reflection.address().port,
    }));
    const testBundle = path.join(root, 'extension/out/tests/formatting.test.cjs');
    esbuild.buildSync({
        entryPoints: [path.join(__dirname, 'formatting.test.ts')],
        outfile: testBundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['vscode', 'clang-format-node'],
    });
    const localCode = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
    const executable = process.env.AS_TEST_VSCODE || (localCode && fs.existsSync(localCode) ? localCode : undefined);
    const report = path.join(runRoot, 'result.json');
    try { await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: process.env.AS_TEST_EXTENSION || root,
        extensionTestsPath: testBundle,
        extensionTestsEnv: { AS_FORMAT_TEST_REPORT: report, AS_FORMAT_TEST_WORKSPACE: workspace,
            AS_FORMAT_TEST_FIXTURES: path.join(__dirname, 'fixtures') },
        launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            '--disable-gpu', '--user-data-dir', path.join(runRoot, 'user'), '--extensions-dir', path.join(runRoot, 'extensions')],
    }); } finally {
        for (const socket of sockets) socket.destroy();
        reflection.close();
    }
    const results = JSON.parse(fs.readFileSync(report, 'utf8'));
    if (results.failed.length || results.passed.length < 23)
        throw new Error('Formatting report did not contain the expected successful checks');
    console.log(`Formatting: ${results.passed.length} checks passed; report: ${report}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
