/**
 * Build the release tarball.
 *
 *   node dev/pack.mjs
 *
 * Packs chat-backup/ with npm and renames the result to the name the GitHub
 * release asset uses: dsh-chat-backup-<version>.tgz at the repo root.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = join(root, 'chat-backup')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const output = execFileSync(`${npm} pack --json`, {
  cwd: packageDir,
  encoding: 'utf8',
  shell: true,
})
const [packed] = JSON.parse(output)

const from = join(packageDir, packed.filename)
const to = join(root, `dsh-chat-backup-${manifest.version}.tgz`)
rmSync(to, { force: true })
renameSync(from, to)

console.log(`${to}`)
console.log(`  ${packed.size} bytes, ${packed.entryCount} files, ${packed.id}`)
console.log(`  install: dsh plugin --profile <profile> add <release asset url>`)
