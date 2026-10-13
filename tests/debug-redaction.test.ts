import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { sanitizeDebugEntry, sanitizeDebugText } from '../src/debug-redaction'
import { renderDebugPreviewHtml } from '../src/render-image'
import { buildDebugPreviewHtml } from '../src/render-preview-template'
import { Config } from '../src/config'
import type { DebugEntry } from '../src/types'

const cipher = 'FIXTURE_OPAQUE_REASONING_NEVER_DISPLAY'
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function hasCipherField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCipherField)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => key === 'encrypted_content' || hasCipherField(child))
}

test('deep frozen payload remains unchanged and all debug copies omit opaque fields', () => {
  const original = freeze({
    requestBodyJson: { include: ['reasoning.encrypted_content'], input: [{ type: 'reasoning', encrypted_content: cipher, summary: [{ text: 'clear thought' }] }] },
    requestBodyText: JSON.stringify({input: [{encrypted_content: cipher, id: 'r1'}]}),
    responseJson: {output: [{type: 'reasoning', id: 'r2', encrypted_content: cipher}, {type: 'message', content: 'answer'}]},
    toolCalls: [{arguments: JSON.stringify({encrypted_content: cipher, value: 'OK'})}],
  })
  const before = JSON.stringify(original)
  const copy = sanitizeDebugEntry(original)
  assert.equal(JSON.stringify(original), before)
  assert.notEqual(copy, original)
  assert.notEqual(copy.requestBodyJson, original.requestBodyJson)
  assert(!hasCipherField(copy))
  assert(!JSON.stringify(copy).includes(cipher))
  assert.deepEqual(copy.requestBodyJson.include, ['reasoning.encrypted_content'])
  assert.equal(copy.requestBodyJson.input[0].summary[0].text, 'clear thought')
  assert.equal(JSON.parse(copy.toolCalls[0].arguments).value, 'OK')
})

test('mandatory defaults and configurable literal field names are enforced', () => {
  assert.deepEqual(Config({}).excludeJsonFields, ['encrypted_content'])
  const value = {encrypted_content: cipher, 'provider.secret': 'additional-secret', text: 'keep'}
  assert(!hasCipherField(sanitizeDebugEntry(value, [])))
  assert.deepEqual(sanitizeDebugEntry(value, ['provider.secret']), {text: 'keep'})
  assert.equal(sanitizeDebugText('include: ["reasoning.encrypted_content"]'), 'include: ["reasoning.encrypted_content"]')
})

test('SSE multiline JSON removes fields without erasing event framing or ordinary text', () => {
  const raw = 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{\ndata: "type":"reasoning","encrypted_content":"' + cipher + '","summary":[{"text":"visible"}]}}\n\ndata: [DONE]\n\n'
  const safe = sanitizeDebugText(raw)
  assert(safe.includes('event: response.output_item.done'))
  assert(safe.includes('[DONE]'))
  assert(!safe.includes(cipher))
  const data = safe.split('\n\n')[0].split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  assert(!hasCipherField(JSON.parse(data)))
  assert.equal(JSON.parse(data).item.summary[0].text, 'visible')
})

test('old Markdown fenced JSON keeps surrounding content and filters nested values', () => {
  const markdown = '# Old log\n<details>\n~~~json\n' + JSON.stringify({output: [{encrypted_content: cipher, text: 'answer'}]}, null, 2) + '\n~~~\n</details>\nPlain visible summary'
  const safe = sanitizeDebugText(markdown)
  assert(!safe.includes(cipher))
  assert(!safe.includes('"encrypted_content"'))
  assert(safe.includes('Plain visible summary'))
  assert(safe.includes('answer'))
  assert(safe.includes('<details>'))
  assert(!buildDebugPreviewHtml(markdown).includes(cipher))
})

test('nested JSON strings, truncated bodies and escaped error bodies cannot leak fixtures', () => {
  const encoded = JSON.stringify({body: JSON.stringify({encrypted_content: cipher, text: 'keep'})})
  assert(!sanitizeDebugText(encoded).includes(cipher))
  assert(sanitizeDebugText(encoded).includes('keep'))
  for (const text of ['{"encrypted_content":"' + cipher, 'Error: ' + JSON.stringify({encrypted_content: cipher}), 'Error: ' + JSON.stringify(JSON.stringify({encrypted_content: cipher}))]) {
    assert(!sanitizeDebugText(text).includes(cipher))
  }
})

test('entry previews remove opaque fields from Markdown and HTML without changing source', () => {
  const entry: DebugEntry = {metadata: {id:'preview',createdAt:1,source:'test',method:'POST',url:'http://localhost/responses'},tools:[],requestMessages:[],responseMessages:[{role:'assistant',content:'normal answer'}],toolCalls:[],toolResults:[],responseText:'normal answer',responseReasoningText:'visible thought',responseJson:{output:[{type:'reasoning',encrypted_content:cipher,summary:[{text:'visible thought'}]}]},requestHeaders:{},responseHeaders:{}}
  const before = JSON.stringify(entry)
  const preview = renderDebugPreviewHtml(entry)
  assert.equal(JSON.stringify(entry), before)
  assert(!preview.markdown.includes(cipher))
  assert(!preview.html.includes(cipher))
  assert(preview.markdown.includes('visible thought'))
  assert(preview.markdown.includes('normal answer'))
})

function findReplayRoot() {
  let directory = process.cwd()
  while (true) {
    const candidate = path.join(directory, 'data/chat-debug/2026-10-12')
    if (existsSync(path.join(candidate, 'json/chat-debug-mv5n7qoz-5il5gs.json'))) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}
const replayRoot = findReplayRoot()
test('existing schedule log exports retain the answer but omit captured ciphertext', {skip: !replayRoot}, () => {
  const root = replayRoot!
  const raw = JSON.parse(readFileSync(root + '/json/chat-debug-mv5n7qoz-5il5gs.json', 'utf8'))
  const opaque = raw.responseJson.output[0].encrypted_content
  assert(typeof opaque === 'string' && opaque.length > 0)
  const copy = sanitizeDebugEntry(raw)
  assert(!hasCipherField(copy))
  assert(!JSON.stringify(copy).includes(opaque))
  assert.equal(copy.responseMessages[0].content.length, 2355)
  const oldMarkdown = readFileSync(root + '/md/chat-debug-mv5n7qoz-5il5gs.md', 'utf8')
  const safeMarkdown = sanitizeDebugText(oldMarkdown)
  assert(!safeMarkdown.includes(opaque))
  assert(safeMarkdown.includes(copy.responseMessages[0].content))
  assert(!buildDebugPreviewHtml(oldMarkdown).includes(opaque))
})
