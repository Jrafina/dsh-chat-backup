/**
 * Minimal R2/S3 probe used to verify credentials and the SigV4 implementation
 * independently of the plugin. Credentials come from the environment only.
 *
 *   node dev/r2.mjs list
 *   node dev/r2.mjs ls <bucket> [prefix]
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */
import { createHash, createHmac } from 'node:crypto'
import { request } from 'node:https'

const accountId = process.env.R2_ACCOUNT_ID ?? ''
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? ''
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? ''

if (accountId === '' || accessKeyId === '' || secretAccessKey === '') {
  console.error('missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY')
  process.exit(2)
}

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex')
const hmac = (key, text) => createHmac('sha256', key).update(text).digest()
const rfc3986 = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** One SigV4-signed request against the account endpoint. */
function call({ method = 'GET', bucket, key, query = '', body = Buffer.alloc(0), contentType }) {
  const host = `${accountId}.r2.cloudflarestorage.com`
  const segments = []
  if (bucket !== undefined) segments.push(bucket)
  if (key !== undefined && key !== '') segments.push(...key.split('/'))
  const path = `/${segments.map(rfc3986).join('/')}`

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  if (contentType !== undefined) headers['content-type'] = contentType

  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/auto/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), 'auto'), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      {
        host,
        path: query === '' ? path : `${path}?${query}`,
        method,
        headers: {
          ...headers,
          authorization:
            `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
          'content-length': body.length,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', rejectPromise)
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')))
    req.end(body)
  })
}

const [command, bucket, ...rest] = process.argv.slice(2)

if (command === 'list') {
  const res = await call({})
  console.log('status:', res.status)
  console.log(res.body.slice(0, 4000))
} else if (command === 'ls') {
  const prefix = rest[0] ?? ''
  const query = ['list-type=2', prefix === '' ? '' : `prefix=${rfc3986(prefix)}`].filter(Boolean).join('&')
  const res = await call({ bucket, query })
  console.log('status:', res.status)
  console.log(res.body.slice(0, 6000))
} else if (command === 'get') {
  const key = rest[0] ?? ''
  const res = await call({ bucket, key })
  console.log('status:', res.status)
  console.log(res.body)
} else if (command === 'del') {
  const key = rest[0] ?? ''
  const res = await call({ bucket, key, method: 'DELETE' })
  console.log(`delete ${key} -> ${res.status}`)
} else if (command === 'mkb') {
  const res = await call({ method: 'PUT', bucket })
  console.log(`create bucket ${bucket} -> ${res.status}`, res.body.slice(0, 300))
} else if (command === 'put') {
  const key = rest[0] ?? ''
  const file = rest[1] ?? ''
  const { readFile } = await import('node:fs/promises')
  const body = await readFile(file)
  const res = await call({ method: 'PUT', bucket, key, body, contentType: 'application/gzip' })
  console.log(`put ${key} (${body.length} bytes) -> ${res.status}`, res.body.slice(0, 300))
} else {
  console.error('usage: list | ls <bucket> [prefix] | get <bucket> <key> | del <bucket> <key> | mkb <bucket> | put <bucket> <key> <file>')
  process.exit(2)
}
