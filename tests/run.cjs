// Exercise TypeScript modules with the CJS dependency entrypoints used by Koishi.
// Native ESM imports currently hit an upstream @koishijs/loader interop failure.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { buildSync } = require('esbuild')

for (const name of fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.ts')).sort()) {
  const filename = path.join(__dirname, name)
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    external: ['koishi', 'koishi-plugin-chatluna'],
  }).outputFiles[0].text
  const testModule = new Module(filename, module)
  testModule.filename = filename
  testModule.paths = Module._nodeModulePaths(__dirname)
  testModule._compile(output, filename)
}
