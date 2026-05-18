// Standalone build script for koishi-plugin-chatluna-chat-debug-tool
// Usage: node build.mjs
import { build } from 'esbuild'

const common = {
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
    entryPoints: ['src/index.ts'],
    format: 'cjs',
    outfile: 'lib/index.cjs',
  }),
  build({
    ...common,
    entryPoints: ['src/index.ts'],
    format: 'esm',
    outfile: 'lib/index.mjs',
  }),
  build({
    ...common,
    entryPoints: ['src/render-preview-template.ts'],
    format: 'esm',
    outfile: 'lib/render-preview-template.mjs',
  }),
])

console.log('Build complete: lib/index.cjs + lib/index.mjs + lib/render-preview-template.mjs')
