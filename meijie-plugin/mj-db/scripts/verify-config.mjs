#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const pluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = join(pluginDirectory, 'cordis.yml')
const entryPath = join(pluginDirectory, 'src/index.ts')
const launcherPath = resolve(pluginDirectory, '../node_modules/.bin/dbx-mcp-server')

const patches = loadOverlayPatches('dsh-verify', patchPath)
const row = patches.flatMap(patch => patch.insert ?? []).find(candidate => candidate.id === 'mj-db')
if (row === undefined) throw new Error('mj-db: cordis.yml does not insert the mj-db row')
if (typeof row.name !== 'string' || !row.name.endsWith('/mj-db/src/index.ts')) {
  throw new Error(`mj-db: overlay must load the mj-db plugin entry, received ${String(row.name)}`)
}

const plugin = await import(pathToFileURL(entryPath).href)
if (plugin.name !== 'mj-db' || !Array.isArray(plugin.inject) || !plugin.inject.includes('tools')) {
  throw new Error('mj-db: plugin entry must export name mj-db and inject tools')
}
if (typeof plugin.apply !== 'function' || plugin.Config === undefined) {
  throw new Error('mj-db: plugin entry must export Config and apply')
}

await access(launcherPath)
const packageJson = JSON.parse(await readFile(resolve(pluginDirectory, '../node_modules/@dbx-app/mcp-server/package.json'), 'utf8'))
if (packageJson.version !== '0.4.75') {
  throw new Error(`mj-db: expected @dbx-app/mcp-server 0.4.75, received ${String(packageJson.version)}`)
}

const verification = spawnSync(launcherPath, ['--verify-platform'], { encoding: 'utf8' })
if (verification.error !== undefined) throw verification.error
if (verification.status !== 0) {
  throw new Error(`mj-db: DBX platform verification failed: ${verification.stderr}`)
}

console.log('verify-config PASSED: mj-db is a Cordis plugin backed by DBX MCP server 0.4.75')
