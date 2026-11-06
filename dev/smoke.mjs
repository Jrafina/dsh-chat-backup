/**
 * Offline smoke test for the chat-backup bundle: drives the registered route
 * handler with a fake Cordis context and a fake Session, then writes the
 * produced ZIP so an external unzip can confirm the archive is valid.
 *
 * Run: node dev/smoke.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const plugin = await import('../chat-backup/index.js')

/* --- a throwaway working directory with "deliverables" ------------------ */
const cwd = await mkdtemp(join(tmpdir(), 'chat-backup-'))
await mkdir(join(cwd, 'out'), { recursive: true })
await writeFile(join(cwd, 'out', 'cat.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]))
await writeFile(join(cwd, 'out', 'notes.md'), '# 结果\n\n一只赛博朋克猫。\n')
await mkdir(join(cwd, 'node_modules'), { recursive: true })
await writeFile(join(cwd, 'node_modules', 'junk.js'), 'junk')
await writeFile(join(cwd, '.env'), 'SECRET=1')

/* --- a fake Session: real prompts interleaved with injected context ------ */
const session = {
  header: { createdAt: Date.now() - 60_000, cwd },
  ownEvents: () => [],
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
    // turn 1 — the user's own words, then the three injected context messages
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我画一张赛博朋克猫' }] },
    { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
    { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>' }] },
    { role: 'user', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-04T19:58:37+08:00' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '思考…' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'write', arguments: '{}' }] },
    { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
    { role: 'assistant', content: [{ type: 'text', text: '画好了，放在 `out/cat.png`。' }] },
    // turn 2 — a real prompt, an approval notice, then the answer
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '再加一点霓虹' }] },
    { role: 'user', source: { kind: 'user-approval' }, content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never" (changed by the user).' }] },
    { role: 'assistant', content: [{ type: 'text', text: '已加上霓虹光晕。' }] },
  ],
}

/* --- capture the route handler ----------------------------------------- */
let handler
const ctx = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  webServer: {
    register: (route) => {
      handler = route.handler
      return () => {}
    },
  },
  get: () => undefined,
  sessions: { get: (id) => (id === 'session-smoke' ? session : undefined) },
}

plugin.apply(ctx, {})
if (typeof handler !== 'function') throw new Error('route was not registered')

/* --- invoke it the way the browser does -------------------------------- */
function invoke(body) {
  return new Promise((resolvePromise) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      url: '/api/chat-backup/run',
      async *[Symbol.asyncIterator]() {
        yield payload
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(text) {
        resolvePromise({ status: this.statusCode, body: JSON.parse(text) })
      },
    }
    handler(req, res)
  })
}

const dry = await invoke({ sessionId: 'session-smoke', dryRun: true })
console.log('--- dry run -------------------------------------------------')
console.log('status  :', dry.status)
console.log('folder  :', dry.body.folder)
console.log('turns   :', dry.body.turns)
console.log('files   :', JSON.stringify(dry.body.files))
console.log('skipped :', JSON.stringify(dry.body.skipped))
console.log('archive :', dry.body.archiveBytes, 'bytes')
console.log('--- transcript ----------------------------------------------')
console.log(dry.body.transcriptPreview)

/* --- ZIP validity, checked by an external unzip in the caller ---------- */
const archive = plugin.buildZip([
  { name: 'out/notes.md', data: Buffer.from('# 结果\n\n一只赛博朋克猫。\n', 'utf8'), mtime: new Date() },
  { name: 'out/cat.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]), mtime: new Date() },
  { name: '中文 文件名.txt', data: Buffer.from('中文内容', 'utf8'), mtime: new Date() },
])
const zipPath = join(process.cwd(), 'dev', 'smoke-out.zip')
await writeFile(zipPath, archive)
console.log('--- zip -----------------------------------------------------')
console.log('written :', zipPath, archive.length, 'bytes')
console.log('magic   :', archive.subarray(0, 2).toString('latin1'))

const real = await invoke({ sessionId: 'session-smoke' })
console.log('--- configured? ---------------------------------------------')
console.log('status  :', real.status, JSON.stringify(real.body).slice(0, 160))

await rm(cwd, { recursive: true, force: true })
