const path = require('node:path');
const esbuild = require('esbuild');
const output = path.resolve(__dirname, '../out/member-callback.test.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'member-callback.test.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: output, logLevel: 'warning' });
require(output);
