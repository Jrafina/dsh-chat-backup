/**
 * Decode a persisted session log that is stored as several concatenated zstd
 * frames: locate every frame magic, decompress each frame on its own, and join
 * the results.
 *
 *   node dev/dump.mjs <path-to-session.v4.jsonl.zstd> [count]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const limit = Number(process.argv[3] ?? 80)
const buffer = readFileSync(file)

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let index = 0; index + 4 <= buffer.length; index += 1) {
  if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) {
    offsets.push(index)
  }
}
console.log(`file: ${buffer.length} bytes, frame magics: ${offsets.length}`)

const texts = []
for (let index = 0; index < offsets.length; index += 1) {
  const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
  const slice = buffer.subarray(offsets[index], end)
  try {
    texts.push(zstdDecompressSync(slice).toString('utf8'))
  } catch (error) {
    console.log(`frame ${index} at ${offsets[index]} failed: ${String(error.message).slice(0, 80)} (${slice.length} bytes)`)
  }
}
const raw = texts.join('')
const lines = raw.split('\n').filter((line) => line.trim() !== '')
console.log(`decoded: ${raw.length} chars, events: ${lines.length}\n`)

let shown = 0
for (const line of lines) {
  if (shown >= limit) break
  let event
  try {
    event = JSON.parse(line)
  } catch {
    console.log('unparsed:', line.slice(0, 160))
    shown += 1
    continue
  }
  const data = event.data ?? {}
  const parts = []
  for (const [key, value] of Object.entries(data)) {
    if (key === 'message' || key === 'stream' || key === 'usage') continue
    parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value).slice(0, 46) : String(value).slice(0, 46)}`)
  }
  const message = data.message ?? data
  let text = ''
  if (Array.isArray(message?.content)) {
    text = message.content
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 110)
  }
  const extra = event.surfaceOp !== undefined ? ` surfaceOp=${JSON.stringify(event.surfaceOp)}` : ''
  const ignorable = event.ignorable === true ? ' IGNORABLE' : ''
  console.log(`${String(event.seq).padStart(4)} ${String(event.type).padEnd(20)}${extra}${ignorable} ${parts.join(' ')}`)
  if (text !== '') console.log(`      text: ${text}`)
  shown += 1
}
