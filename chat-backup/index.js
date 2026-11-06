/**
 * Host half of `@local/dsh-chat-backup`.
 *
 * One operation, one implementation: `runBackup(sessionId)` reads the live
 * Session log, renders a question/answer-only Markdown transcript, collects the
 * files the most recent working turn produced (still present on disk), packs
 * them into a ZIP, and uploads both objects to Cloudflare R2 under
 * `<yyyy-mm-dd>--<title>/`.
 *
 * The Client half reaches this through one exact web route, behind the
 * composition's connection trust fence, exactly like the shipped
 * `host-open-in-app` package does.
 *
 * Only Node builtins are imported so the bundle needs no dependencies.
 */
import { createHash, createHmac } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { request as httpsRequest } from 'node:https'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Cordis function-plugin name. */
export const name = 'chat-backup'

/** The route carrier and the live session store. */
export const inject = ['webServer', 'sessions']

/** The single Client-callable endpoint. */
const RUN_PATH = '/api/chat-backup/run'

/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 16 * 1024

/** Tunables; the user's patch layer overrides them. */
const DEFAULTS = {
  accountId: '',
  accessKeyId: '',
  secretAccessKey: '',
  bucket: '',
  /** Optional key prefix inside the bucket, e.g. `backups/dsh`. */
  prefix: '',
  /** Per-file ceiling for the ZIP. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Whole-ZIP ceiling; files past it are reported as skipped. */
  maxTotalBytes: 100 * 1024 * 1024,
  /** Extra path fragments never packed (case-insensitive substring match). */
  exclude: [],
  /** Extra `source.kind` values to treat as injected context, never as questions. */
  injectedMessageKinds: [],
}

/** Directory names that are never deliverables. */
const NOISE_SEGMENTS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.dsh', '.cache', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.next', '.turbo',
])

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const pad2 = (value) => String(value).padStart(2, '0')

/** Local `yyyy-mm-dd`, the R2 folder's date part. */
function dateStamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Local `yyyy-mm-dd hh:mm` for the transcript header. */
function timeStamp(date) {
  return `${dateStamp(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Filesystem-safe folder name; keeps CJK, drops separators and control chars. */
function safeName(raw, fallback) {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const limited = cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned
  return limited === '' ? fallback : limited
}

/** UTF-8 text blocks of one message, ignoring reasoning/tool blocks. */
function textOf(message) {
  const blocks = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(message?.blocks)
      ? message.blocks
      : Array.isArray(message?.parts)
        ? message.parts
        : []
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
    else if (block.type === 'file') parts.push(`[文件：${block.attachment?.name ?? 'attachment'}]`)
  }
  return parts.join('\n').trim()
}

/* ------------------------------------------------------------------ *
 * Transcript
 * ------------------------------------------------------------------ */

/**
 * `source.kind` values the harness uses for user-role messages it injects
 * around a real prompt. They share `role: 'user'` with the user's own text, so
 * role alone cannot tell a question from context; the source tag can.
 *
 * Observed in a live session log: `runtime-context`, `skill-catalog`,
 * `time-context`, `user-approval`. Anything not listed here (including the
 * real `user`) counts as a question, so a new injected kind leaks rather than a
 * real question being dropped; `injectedMessageKinds` in the config extends it.
 */
const INJECTED_SOURCE_KINDS = new Set([
  'runtime-context',
  'skill-catalog',
  'time-context',
  'user-approval',
])

/** Whether one message is the user's own prompt rather than injected context. */
function isRealQuestion(message, injectedKinds) {
  if (message?.role !== 'user') return false
  const kind = message?.source?.kind
  if (typeof kind !== 'string') return true
  return !(INJECTED_SOURCE_KINDS.has(kind) || injectedKinds.has(kind))
}

/**
 * Sequence numbers of the session's real prompts, oldest first.
 *
 * The manifest stores the last one, so "did the user add a question after the
 * backup?" is a comparison rather than a diff of two transcripts.
 */
function realPromptSeqs(session, injectedKinds) {
  const seqs = []
  for (const event of session.ownEvents()) {
    if (event?.type !== 'user/message') continue
    if (!isRealQuestion(event.data, injectedKinds)) continue
    seqs.push(Number(event.seq))
  }
  return seqs
}

/**
 * Fold the message list into question/answer pairs.
 *
 * Every real user prompt opens a question. A turn emits one assistant text per
 * step — "先看看目录" before a tool call, then the actual reply — so the last
 * text of the turn is its answer and earlier ones are progress notes. Injected
 * context, reasoning, tool calls and tool results never reach the transcript.
 */
export function toTurns(messages, injectedKinds) {
  const turns = []
  let current
  for (const message of messages) {
    if (isRealQuestion(message, injectedKinds)) {
      current = { question: textOf(message), answer: '' }
      turns.push(current)
      continue
    }
    if (message?.role !== 'assistant') continue
    const text = textOf(message)
    if (text === '') continue
    if (current === undefined) {
      current = { question: '', answer: '' }
      turns.push(current)
    }
    current.answer = text
  }
  return turns.filter((turn) => turn.question !== '' || turn.answer !== '')
}

/** Render the Markdown transcript: one question, then the answers under it. */
export function renderTranscript({ title, sessionId, cwd, turns, now }) {
  const lines = []
  lines.push(`# ${title}`, '')
  lines.push(`- 会话 ID：\`${sessionId}\``)
  lines.push(`- 工作目录：\`${cwd}\``)
  lines.push(`- 备份时间：${timeStamp(now)}`)
  lines.push(`- 问答轮数：${turns.length}`)
  lines.push('', '---', '')
  turns.forEach((turn, index) => {
    lines.push(`## ${index + 1}. 提问`, '')
    lines.push(turn.question === '' ? '（无文本内容）' : turn.question, '')
    lines.push('**DSH 回答**', '')
    lines.push(turn.answer === '' ? '（本轮无文字回答）' : turn.answer, '')
    if (index < turns.length - 1) lines.push('---', '')
  })
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ *
 * Deliverable files
 * ------------------------------------------------------------------ */

/** True when a path fragment is noise for a deliverable archive. */
function isNoise(absolutePath, cwd, exclude) {
  const rel = relative(cwd, absolutePath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return true
  const segments = rel.split(/[\\/]/)
  for (const segment of segments) {
    if (NOISE_SEGMENTS.has(segment.toLowerCase())) return true
    if (segment.startsWith('.')) return true
  }
  const lowered = rel.toLowerCase()
  return exclude.some((fragment) => fragment !== '' && lowered.includes(String(fragment).toLowerCase()))
}

/** Absolute path of a recorder-reported change, which may be relative to cwd. */
function toAbsolute(path, cwd) {
  if (typeof path !== 'string' || path === '') return undefined
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/**
 * The files produced by the most recent working turn.
 *
 * The recorder appends one `workspace/changes` event per turn that touched the
 * disk; each carries the summary this Host can still serve. Walking newest to
 * oldest and taking the first summary that still has surviving files answers
 * "the files DSH last generated" even when a later question produced none.
 */
async function lastTurnFiles(ctx, sessionId, session, cwd, exclude) {
  const changes = ctx.get('workspaceChanges')
  if (changes !== undefined) {
    const events = session
      .ownEvents()
      .filter((event) => event && event.type === 'workspace/changes')
    for (let index = events.length - 1; index >= 0; index -= 1) {
      let summary
      try {
        summary = changes.summary(sessionId, events[index].seq)
      } catch {
        summary = undefined
      }
      if (summary === undefined || !Array.isArray(summary.files)) continue
      const files = []
      for (const file of summary.files) {
        const absolute = toAbsolute(file?.path, cwd)
        if (absolute === undefined) continue
        if (isNoise(absolute, cwd, exclude)) continue
        const info = await stat(absolute).catch(() => undefined)
        if (info === undefined || !info.isFile() || info.size === 0) continue
        files.push({ absolute, bytes: info.size, mtime: info.mtimeMs, turn: summary.turn })
      }
      if (files.length > 0) return files
    }
  }
  return mtimeFiles(cwd, session, exclude)
}

/**
 * Fallback for compositions without the workspace-changes recorder: every
 * file under the working directory written after the session was created.
 */
async function mtimeFiles(cwd, session, exclude) {
  const since = Number(session?.header?.createdAt ?? 0)
  const found = []
  const walk = async (directory, depth) => {
    if (depth > 6 || found.length > 400) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length > 400) return
      const absolute = join(directory, entry.name)
      if (isNoise(absolute, cwd, exclude)) continue
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined || info.size === 0 || info.mtimeMs < since) continue
      found.push({ absolute, bytes: info.size, mtime: info.mtimeMs, turn: undefined })
    }
  }
  await walk(cwd, 0)
  return found
}

/* ------------------------------------------------------------------ *
 * ZIP writer (store + deflate, UTF-8 names)
 * ------------------------------------------------------------------ */

let CRC_TABLE

function crc32(buffer) {
  if (CRC_TABLE === undefined) {
    CRC_TABLE = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      CRC_TABLE[index] = value
    }
  }
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time: time & 0xffff, date: day & 0xffff }
}

/** Build one ZIP archive from `{ name, data, mtime }` entries. */
export function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const crc = crc32(raw)
    let method = 0
    let body = raw
    if (raw.length > 0) {
      const deflated = deflateRawSync(raw, { level: 6 })
      if (deflated.length < raw.length) {
        method = 8
        body = deflated
      }
    }
    const stamp = dosDateTime(entry.mtime instanceof Date ? entry.mtime : new Date())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBytes, body)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(stamp.time, 12)
    record.writeUInt16LE(stamp.date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(body.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, directory, end])
}

/* ------------------------------------------------------------------ *
 * Cloudflare R2 (S3-compatible, SigV4)
 * ------------------------------------------------------------------ */

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex')
const hmac = (key, text) => createHmac('sha256', key).update(text).digest()

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function rfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Canonical URI: each key segment encoded, separators preserved. */
function canonicalPath(bucket, key) {
  const segments = key === undefined || key === '' ? [bucket] : [bucket, ...key.split('/')]
  return `/${segments.map(rfc3986).join('/')}`
}

/** Canonical query string: names sorted, every value encoded. */
function canonicalQuery(query) {
  if (query === undefined) return ''
  return Object.keys(query)
    .sort()
    .map((name) => `${rfc3986(name)}=${rfc3986(String(query[name]))}`)
    .join('&')
}

/** One SigV4-signed request, over node:https so no fetch quirks apply. */
function signedRequest(settings, { method = 'GET', key, query, body = Buffer.alloc(0), contentType }) {
  const host = `${settings.accountId}.r2.cloudflarestorage.com`
  const path = canonicalPath(settings.bucket, key)
  const search = canonicalQuery(query)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (contentType !== undefined) headers['content-type'] = contentType
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((header) => `${header}:${String(headers[header]).trim()}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [method, path, search, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/auto/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n')
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${settings.secretAccessKey}`, dateStamp), 'auto'), 's3'),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpsRequest(
      {
        host,
        path: search === '' ? path : `${path}?${search}`,
        method,
        headers: { ...headers, authorization, 'content-length': body.length },
      },
      (res) => {
        const collected = []
        res.on('data', (chunk) => collected.push(chunk))
        res.on('end', () => {
          resolveRequest({
            status: res.statusCode ?? 0,
            body: Buffer.concat(collected).toString('utf8'),
          })
        })
      },
    )
    req.on('error', rejectRequest)
    req.setTimeout(120_000, () => req.destroy(new Error(`${method} ${key} timed out after 120s`)))
    req.end(body)
  })
}

/** Upload one object; throws a readable error on a non-2xx answer. */
async function putObject(settings, key, body, contentType) {
  const result = await signedRequest(settings, { method: 'PUT', key, body, contentType })
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`R2 拒绝写入 ${key}（HTTP ${result.status}）：${result.body.slice(0, 400)}`)
  }
  return { key, bytes: body.length }
}

/** Read one object; `undefined` when the key does not exist. */
async function getObject(settings, key) {
  const result = await signedRequest(settings, { method: 'GET', key })
  if (result.status === 404) return undefined
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`R2 读取 ${key} 失败（HTTP ${result.status}）：${result.body.slice(0, 400)}`)
  }
  return result.body
}

/** Delete one object; a missing key is success (S3 answers 204 either way). */
async function deleteObject(settings, key) {
  const result = await signedRequest(settings, { method: 'DELETE', key })
  if (result.status !== 204 && (result.status < 200 || result.status >= 300)) {
    throw new Error(`R2 删除 ${key} 失败（HTTP ${result.status}）：${result.body.slice(0, 400)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Backup manifest: one small index object per session
 * ------------------------------------------------------------------ */

/**
 * The index object key for one session.
 *
 * The dated folder cannot be found again by name alone (its title and date
 * change between backups), so a stable per-session pointer lives beside the
 * folders. Deleting it only makes this plugin forget the session; it never
 * touches a backup.
 */
function manifestKey(settings, sessionId) {
  const prefix = settings.prefix === '' ? '' : `${settings.prefix}/`
  return `${prefix}_sessions/${sessionId}.json`
}

/** Previous backup record for a session, or `undefined` when never backed up. */
async function readManifest(settings, sessionId) {
  let text
  try {
    text = await getObject(settings, manifestKey(settings, sessionId))
  } catch {
    return undefined
  }
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

async function writeManifest(settings, sessionId, record) {
  await putObject(
    settings,
    manifestKey(settings, sessionId),
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'),
    'application/json; charset=utf-8',
  )
}

/** Undo the five XML entities S3 escapes in key names. */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The dated folders directly under the configured prefix, as `.../` strings. */
async function listFolders(settings) {
  const base = settings.prefix === '' ? '' : `${settings.prefix}/`
  const result = await signedRequest(settings, {
    method: 'GET',
    query: { 'list-type': '2', delimiter: '/', prefix: base },
  })
  if (result.status !== 200) return []
  const folders = []
  for (const block of result.body.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const name = /<Prefix>([\s\S]*?)<\/Prefix>/.exec(block[1])
    if (name !== null) folders.push(unescapeXml(name[1]))
  }
  return folders
}

/**
 * A backup made before manifests existed, or one whose manifest was deleted.
 *
 * Folders are matched by the `--<title>` suffix and then confirmed by reading
 * the transcript's own `会话 ID` line, so a same-titled session is never
 * mistaken for this one.
 */
async function findExistingBackup(settings, sessionId, title) {
  const folders = await listFolders(settings).catch(() => [])
  const suffix = `--${title}`
  for (const folder of folders) {
    if (!folder.replace(/\/+$/, '').endsWith(suffix)) continue
    const text = await getObject(settings, `${folder}对话.md`).catch(() => undefined)
    if (text === undefined || !text.includes(`\`${sessionId}\``)) continue
    const folderName = folder.replace(/\/+$/, '')
    return {
      folder: folderName,
      turnCount: (text.match(/^## \d+\. 提问/gm) ?? []).length,
      localTime: '',
      objects: [`${folderName}/对话.md`, `${folderName}/附件.zip`],
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------ */

function fail(code, message, status = 400) {
  return { status, payload: { ok: false, code, message } }
}

/** Resolve settings, tolerating a partially configured row. */
function resolveSettings(raw) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) }
  const env = process.env
  const pick = (value, fallback) => {
    const text = typeof value === 'string' ? value.trim() : ''
    return text === '' ? fallback : text
  }
  return {
    accountId: pick(merged.accountId, env.R2_ACCOUNT_ID ?? ''),
    accessKeyId: pick(merged.accessKeyId, env.R2_ACCESS_KEY_ID ?? ''),
    secretAccessKey: pick(merged.secretAccessKey, env.R2_SECRET_ACCESS_KEY ?? ''),
    bucket: pick(merged.bucket, env.R2_BUCKET ?? ''),
    prefix: typeof merged.prefix === 'string' ? merged.prefix.replace(/^\/+|\/+$/g, '') : '',
    maxFileBytes: Number(merged.maxFileBytes) > 0 ? Number(merged.maxFileBytes) : DEFAULTS.maxFileBytes,
    maxTotalBytes: Number(merged.maxTotalBytes) > 0 ? Number(merged.maxTotalBytes) : DEFAULTS.maxTotalBytes,
    exclude: Array.isArray(merged.exclude) ? merged.exclude.filter((item) => typeof item === 'string') : [],
    injectedKinds: new Set(
      (Array.isArray(merged.injectedMessageKinds) ? merged.injectedMessageKinds : []).filter(
        (item) => typeof item === 'string',
      ),
    ),
  }
}

/**
 * Collect, render, pack, and upload one conversation backup.
 *
 * `dryRun` stops before the network. Otherwise the run consults the session's
 * manifest first: a session already backed up with no newer prompt reports
 * `already-backed-up`, and one with newer prompts reports `needs-confirm` so the
 * caller can ask before replacing. `mode: 'replace'` performs that replacement —
 * upload the complete new folder, delete the previous folder's objects, then
 * repoint the manifest at the new one.
 */
async function runBackup(ctx, settings, sessionId, { dryRun, mode }) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    return fail('no-session', `找不到活动会话：${sessionId}`, 404)
  }

  const now = new Date()
  /** Optional services are read defensively: any of them may be absent. */
  const tryRead = (read, fallback) => {
    try {
      return read()
    } catch {
      return fallback
    }
  }
  const cwd =
    tryRead(() => ctx.get('workingDirectory')?.get(session), undefined) ??
    (typeof session.header?.cwd === 'string' && session.header.cwd !== ''
      ? session.header.cwd
      : process.cwd())

  const folded = tryRead(() => ctx.get('sessionTitle')?.get(session), undefined)
  const turns = toTurns(session.deriveMessages(), settings.injectedKinds)
  const firstQuestion = turns.find((turn) => turn.question !== '')?.question ?? ''
  const title = safeName(
    folded?.title ?? firstQuestion.split('\n')[0],
    `会话 ${String(sessionId).slice(-6)}`,
  )
  const folder = [settings.prefix, `${dateStamp(now)}--${title}`].filter((part) => part !== '').join('/')

  const transcript = renderTranscript({
    title,
    sessionId: String(sessionId),
    cwd,
    turns,
    now,
  })

  const candidates = await lastTurnFiles(ctx, sessionId, session, cwd, settings.exclude)
  const packed = []
  const skipped = []
  let total = 0
  for (const file of candidates) {
    if (file.bytes > settings.maxFileBytes) {
      skipped.push({ path: relative(cwd, file.absolute), reason: 'single file too large' })
      continue
    }
    if (total + file.bytes > settings.maxTotalBytes) {
      skipped.push({ path: relative(cwd, file.absolute), reason: 'archive too large' })
      continue
    }
    let data
    try {
      data = await readFile(file.absolute)
    } catch (error) {
      skipped.push({ path: relative(cwd, file.absolute), reason: String(error?.message ?? error) })
      continue
    }
    total += data.length
    packed.push({
      name: relative(cwd, file.absolute).split(sep).join('/'),
      data,
      mtime: new Date(file.mtime),
    })
  }

  const archive = packed.length > 0 ? buildZip(packed) : undefined
  const objects = [{ key: `${folder}/对话.md`, body: Buffer.from(transcript, 'utf8') }]
  if (archive !== undefined) objects.push({ key: `${folder}/附件.zip`, body: archive })

  const fileList = packed.map((entry) => ({ path: entry.name, bytes: entry.data.length }))
  const promptSeqs = realPromptSeqs(session, settings.injectedKinds)

  if (dryRun) {
    return {
      status: 200,
      payload: {
        ok: true,
        dryRun: true,
        folder,
        title,
        turns: turns.length,
        files: fileList,
        skipped,
        archiveBytes: archive === undefined ? 0 : archive.length,
        transcriptPreview: transcript.length > 4000 ? `${transcript.slice(0, 4000)}\n…` : transcript,
      },
    }
  }

  if (
    settings.accountId === '' ||
    settings.accessKeyId === '' ||
    settings.secretAccessKey === '' ||
    settings.bucket === ''
  ) {
    return fail(
      'not-configured',
      'R2 尚未配置：请在 profile 的 cordis.patch.yml 里为 chat-backup 填入 accountId / accessKeyId / secretAccessKey / bucket。',
      400,
    )
  }

  let previous = await readManifest(settings, sessionId)
  if (previous === undefined) previous = await findExistingBackup(settings, sessionId, title)
  if (previous !== undefined && mode !== 'replace') {
    const before = Number(previous.turnCount ?? 0)
    const added = Math.max(0, turns.length - before)
    const when =
      typeof previous.localTime === 'string' && previous.localTime !== ''
        ? `在 ${previous.localTime} `
        : ''
    return {
      status: 200,
      payload: {
        ok: false,
        code: added > 0 ? 'needs-confirm' : 'already-backed-up',
        newQuestions: added,
        message:
          added > 0
            ? `这个对话${when}备份过，之后又追加了 ${added} 个提问。`
            : `这个对话${when}备份过，之后没有新的提问。`,
        previous: {
          localTime: previous.localTime ?? '',
          backedUpAt: previous.backedUpAt ?? '',
          folder: previous.folder ?? '',
          turns: before,
          objects: Array.isArray(previous.objects) ? previous.objects.length : 0,
        },
      },
    }
  }

  const uploaded = []
  try {
    for (const object of objects) {
      uploaded.push(
        await putObject(
          settings,
          object.key,
          object.body,
          object.key.endsWith('.zip') ? 'application/zip' : 'text/markdown; charset=utf-8',
        ),
      )
    }
  } catch (error) {
    return fail('upload-failed', String(error?.message ?? error), 502)
  }

  // Only objects the new backup does not cover: on a same-day, same-title
  // replacement the folder is identical and its objects were just overwritten.
  const kept = new Set(uploaded.map((entry) => entry.key))
  const stale = (Array.isArray(previous?.objects) ? previous.objects : []).filter(
    (key) => typeof key === 'string' && !kept.has(key),
  )
  if (stale.length > 0) {
    try {
      for (const key of stale) await deleteObject(settings, key)
    } catch (error) {
      return fail(
        'delete-failed',
        `新的备份已上传，但删除旧备份失败：${String(error?.message ?? error)}`,
        502,
      )
    }
  }

  await writeManifest(settings, sessionId, {
    version: 1,
    sessionId: String(sessionId),
    title,
    folder,
    backedUpAt: now.toISOString(),
    localTime: timeStamp(now),
    lastUserSeq: promptSeqs.at(-1) ?? 0,
    turnCount: turns.length,
    objects: uploaded.map((entry) => entry.key),
  })

  return {
    status: 200,
    payload: {
      ok: true,
      folder,
      title,
      bucket: settings.bucket,
      turns: turns.length,
      replaced: previous !== undefined,
      deleted: stale,
      objects: uploaded,
      files: fileList,
      skipped,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

export function apply(ctx, config) {
  const settings = resolveSettings(config)

  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RUN_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          if (
            String(req.headers['content-type'] ?? '')
              .split(';', 1)[0]
              ?.trim()
              .toLowerCase() !== 'application/json'
          ) {
            sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
            return
          }
          let text
          try {
            text = await readBody(req)
          } catch {
            sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' })
            return
          }
          if (text === undefined) {
            sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
            return
          }
          let body
          try {
            body = JSON.parse(text)
          } catch {
            sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body must be JSON' })
            return
          }
          if (typeof body?.sessionId !== 'string' || body.sessionId === '') {
            sendJson(res, 400, { ok: false, code: 'bad-request', message: 'sessionId must be a non-empty string' })
            return
          }
          try {
            const outcome = await runBackup(ctx, settings, body.sessionId, {
              dryRun: body.dryRun === true,
              mode: body.mode === 'replace' ? 'replace' : 'auto',
            })
            sendJson(res, outcome.status, outcome.payload)
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              code: 'internal-error',
              message: String(error?.message ?? error),
            })
          }
        },
      }),
    `chat-backup: POST ${RUN_PATH}`,
  )
}
