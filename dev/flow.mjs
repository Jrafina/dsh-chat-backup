/**
 * Live end-to-end check of the whole backup lifecycle against the real bucket:
 * first backup, duplicate click, a new prompt, the confirmation handshake, and
 * the replacement that deletes the previous folder's objects.
 *
 *   node dev/flow.mjs
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../chat-backup/index.js')

const cwd = await mkdtemp(join(tmpdir(), 'chat-backup-flow-'))
await mkdir(join(cwd, 'out'), { recursive: true })
await writeFile(join(cwd, 'out', 'result.md'), '# 交付物\n\n生命周期测试。\n')

/* --- mutable session state, so a second prompt can appear later --------- */
const state = {
  title: 'R2 生命周期测试（可删除）',
  events: [
    { type: 'user/message', seq: 9, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'R2 生命周期测试（可删除）' }] } },
    { type: 'user/message', seq: 10, data: { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled…' }] } },
  ],
  messages: [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'R2 生命周期测试（可删除）' }] },
    { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled…' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一次备份的答复。' }] },
  ],
}

const session = {
  header: { createdAt: Date.now() - 60_000, cwd },
  ownEvents: () => state.events,
  deriveMessages: () => state.messages,
}

let handler
plugin.apply(
  {
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
    get: (name) => (name === 'sessionTitle' ? { get: () => ({ title: state.title }) } : undefined),
    sessions: { get: (id) => (id === 'session-flow' ? session : undefined) },
  },
  {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  },
)

function call(body) {
  return new Promise((resolvePromise) => {
    const payload = Buffer.from(JSON.stringify({ sessionId: 'session-flow', ...body }), 'utf8')
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield payload
      },
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        resolvePromise({ status: this.statusCode, body: JSON.parse(text) })
      },
    }
    handler(req, res)
  })
}

const show = (label, result) => {
  const body = result.body
  const summary = body.ok
    ? `ok folder=${body.folder} replaced=${body.replaced === true} deleted=${(body.deleted ?? []).length}`
    : `code=${body.code} newQuestions=${body.newQuestions ?? '-'} msg=${(body.message ?? '').slice(0, 60)}`
  console.log(`${label.padEnd(28)} status=${result.status}  ${summary}`)
}

/* The second prompt and the rename, so `--adopt` can rebuild the same state. */
const addSecondPrompt = () => {
  state.events.push({ type: 'user/message', seq: 20, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '再追加一个问题' }] } })
  state.messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '再追加一个问题' }] })
  state.messages.push({ role: 'assistant', content: [{ type: 'text', text: '第二次备份的答复。' }] })
  state.title = 'R2 生命周期测试（可删除）v2'
}

if (process.argv.includes('--adopt')) {
  // No manifest exists (deleted by the caller): the folder must be found by
  // title + session id instead.
  addSecondPrompt()
  show('6. 索引丢失后（兜底）', await call({ mode: 'auto' }))
  await rm(cwd, { recursive: true, force: true })
  process.exit(0)
}

show('1. 首次备份', await call({ mode: 'auto' }))
show('2. 再点一次', await call({ mode: 'auto' }))

addSecondPrompt()

show('3. 追加提问后再点', await call({ mode: 'auto' }))

const replaced = await call({ mode: 'replace' })
show('4. 确认追加（替换）', replaced)
console.log('   deleted keys:', JSON.stringify(replaced.body.deleted ?? []))
console.log('   new keys    :', JSON.stringify((replaced.body.objects ?? []).map((o) => o.key)))

show('5. 替换后再点', await call({ mode: 'auto' }))

await rm(cwd, { recursive: true, force: true })
