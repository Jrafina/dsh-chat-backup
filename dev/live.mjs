/**
 * Live end-to-end check: drives the plugin's real route handler with a fake
 * Session and real R2 settings, so the whole chain runs — transcript, file
 * selection, ZIP, SigV4 PUT — against the actual bucket.
 *
 *   node dev/live.mjs
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../chat-backup/index.js')

const cwd = await mkdtemp(join(tmpdir(), 'chat-backup-live-'))
await mkdir(join(cwd, 'out'), { recursive: true })
await writeFile(join(cwd, 'out', 'result.md'), '# 交付物\n\n这是一次真实的 R2 上传测试。\n')
await writeFile(join(cwd, 'out', 'sample.txt'), 'hello r2\n')

const session = {
  header: { createdAt: Date.now() - 60_000, cwd },
  ownEvents: () => [],
  deriveMessages: () => [
    { role: 'user', content: [{ type: 'text', text: 'R2 连通性测试（可删除）' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'write', arguments: '{}' }] },
    { role: 'assistant', content: [{ type: 'text', text: '已写入 out/result.md 与 out/sample.txt，并上传到 R2。' }] },
  ],
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
    get: () => undefined,
    sessions: { get: (id) => (id === 'session-live' ? session : undefined) },
  },
  {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  },
)

const outcome = await new Promise((resolvePromise) => {
  const payload = Buffer.from(JSON.stringify({ sessionId: 'session-live' }), 'utf8')
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

console.log('status:', outcome.status)
console.log(JSON.stringify(outcome.body, null, 2))

await rm(cwd, { recursive: true, force: true })
