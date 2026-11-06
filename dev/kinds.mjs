/**
 * Summarize the user-role message stream of a session log: which `source.kind`
 * values exist, and where each turn's real question sits.
 *
 *   node dev/kinds.mjs <path-to-session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const buffer = readFileSync(process.argv[2])
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let index = 0; index + 4 <= buffer.length; index += 1) {
  if (MAGIC.every((byte, k) => buffer[index + k] === byte)) offsets.push(index)
}
const texts = []
for (let index = 0; index < offsets.length; index += 1) {
  const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
  try {
    texts.push(zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8'))
  } catch {
    /* partial trailing frame */
  }
}
const events = texts
  .join('')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })
  .filter(Boolean)

const text = (message) =>
  (message?.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

const kinds = new Map()
console.log('seq  kind                 turn  chars  preview')
for (const event of events) {
  if (event.type !== 'user/message') continue
  const message = event.data
  const kind = message?.source?.kind ?? '(none)'
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  const body = text(message)
  console.log(
    `${String(event.seq).padStart(4)} ${kind.padEnd(20)} ${String(event.data?.turn ?? '').padStart(4)} ${String(body.length).padStart(6)}  ${body.slice(0, 46)}`,
  )
}

console.log('\nsource.kind histogram:')
for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${kind}: ${count}`)

const assistantTexts = events.filter(
  (event) => event.type === 'assistant/message' && text(event.data?.message) !== '',
)
console.log(`\nassistant/message with text: ${assistantTexts.length}`)
for (const event of assistantTexts.slice(0, 14)) {
  console.log(
    `  seq ${String(event.seq).padStart(4)} turn ${String(event.data.turn).padStart(3)} step ${String(event.data.step).padStart(3)}  ${text(event.data.message).slice(0, 60)}`,
  )
}
