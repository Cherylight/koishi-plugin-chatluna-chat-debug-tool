// Standalone build script for koishi-plugin-chatluna-chat-debug-tool
// Usage: node build.mjs
import { build } from 'esbuild'

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'es2022',
  external: [
    'koishi',
    'koishi-plugin-chatluna',
  ],
  charset: 'utf8',
}

await Promise.all([
  build({
    ...common,
    format: 'cjs',
    outfile: 'lib/index.cjs',
  }),
  build({
    ...common,
    format: 'esm',
    outfile: 'lib/index.mjs',
  }),
])

console.log('Build complete: lib/index.cjs + lib/index.mjs')
