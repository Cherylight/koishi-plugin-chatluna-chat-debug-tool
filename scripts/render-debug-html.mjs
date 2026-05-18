import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    console.error('Usage: node scripts/render-debug-html.mjs <markdown-file-path>')
    process.exit(1)
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const pluginRoot = path.resolve(scriptDir, '..')
  const outputDir = path.join(pluginRoot, '..', '..', 'data', 'chat-debug-html')
  const resolvedInputPath = path.resolve(process.cwd(), inputPath)
  const markdown = await readFile(resolvedInputPath, 'utf8')
  const libEntryUrl = pathToFileURL(path.join(pluginRoot, 'lib', 'render-preview-template.mjs')).href
  const { buildDebugPreviewHtml } = await import(libEntryUrl)
  const outputName = `${path.basename(resolvedInputPath, path.extname(resolvedInputPath))}.html`
  const outputPath = path.join(outputDir, outputName)

  await mkdir(outputDir, { recursive: true })
  await writeFile(outputPath, buildDebugPreviewHtml(markdown, {
    sourcePath: resolvedInputPath,
    titleSuffix: '本地 HTML',
    metaLabel: '源 Markdown',
    collapseJsonByDefault: true,
  }), 'utf8')

  console.log(`Generated HTML: ${outputPath}`)
}

main().catch((error) => {
  console.error('Failed to generate debug HTML:', error)
  process.exit(1)
})