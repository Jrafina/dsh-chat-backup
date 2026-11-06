/**
 * Render the transcript of a REAL persisted session, using the plugin's own
 * extraction, so the result can be inspected without the browser.
 *
 *   node dev/preview.mjs <path-to-session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const plugin = await import('../chat-backup/index.js')

/* --- decode the concatenated zstd frames -------------------------------- */
const buffer = readFileSync(process.argv[2])
const sessionId = basename(process.argv[2]).split('.')[0]
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let index = 0; index + 4 <= buffer.length; index += 1) {
  if (MAGIC.every((byte, k) => buffer[index + k] === byte)) offsets.push(index)
}
const parts = []
for (let index = 0; index < offsets.length; index += 1) {
  const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
  try {
    parts.push(zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8'))
  } catch {
    /* trailing partial frame */
  }
}
const events = parts
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

/* --- rebuild the message list the way deriveMessages() does ------------- */
const messages = []
for (const event of events) {
  if (event.surfaceOp === undefined || event.surfaceOp === 'append') {
    // append-only surface; this log has no replace operations
  }
  switch (event.type) {
    case 'user/message':
      messages.push(event.data)
      break
    case 'assistant/message':
    case 'tool/result':
    case 'system/message':
      messages.push(event.data.message)
      break
    case 'developer/message':
      messages.push(event.data.message)
      break
    default:
      break
  }
}

const titleEvent = events.filter((event) => event.type === 'session/title').at(-1)
const title = titleEvent?.data?.title ?? '未命名会话'
const cwd = events.find((event) => event.type === 'workspace/changes')?.data?.cwd ?? 'C:\\（未知）'

const turns = plugin.toTurns(messages, new Set())
console.log(`messages: ${messages.length}  →  turns: ${turns.length}\n`)
turns.forEach((turn, index) => {
  console.log(
    `#${index + 1} Q(${turn.question.length}) A(${turn.answer.length} 字): ${turn.question.replace(/\s+/g, ' ').slice(0, 70)}`,
  )
})

console.log('\n================ transcript ================\n')
const transcript = plugin.renderTranscript({
  title,
  sessionId,
  cwd,
  turns,
  now: new Date(),
})
const { writeFileSync } = await import('node:fs')
writeFileSync('dev/preview.md', transcript, 'utf8')
console.log(`written dev/preview.md (${transcript.length} chars)`)
console.log(transcript.slice(0, 1200))
