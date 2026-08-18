/**
 * End-to-end boot check for the mj-cdp plugin.
 *
 * Starts a minimal REAL CDP mock on a random port: an HTTP `/json/list` and a
 * hand-rolled WebSocket server (RFC6455 handshake + frames) answering
 * Runtime.evaluate / Page.captureScreenshot / Runtime.enable. The plugin then
 * boots with that endpoint and its tools are exercised through the actual
 * WebSocket transport:
 *
 * - `cdp_targets` lists the mock tab;
 * - `cdp_evaluate` reads evaluated values and surfaces exceptions;
 * - `cdp_screenshot` writes a real PNG file;
 * - `cdp_console` buffers console + exception events emitted on attach.
 *
 * Run from the harness repo root (needs the tsx source-launch resolution):
 *
 *   node --import tsx/esm meijie-plugin/mj-cdp/scripts/verify-boot.ts
 *
 * @module verify-boot
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
// Loads the `tools` service declaration onto `ctx` (see dsh-tools' Context merge).
import type {} from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm/brand'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Encode one server→client WebSocket frame (unmasked). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header: number[] = [0x80 | opcode]
  const len = payload.length
  if (len < 126) {
    header.push(len)
  } else if (len < 65536) {
    header.push(126, len >> 8, len & 0xff)
  } else {
    throw new Error('mock: frame too large')
  }
  return Buffer.concat([Buffer.from(header), payload])
}

/** Read masked client frames from a socket, dispatching complete text messages. */
function handleSocket(socket: NodeJS.Socket, onMessage: (text: string) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const b0 = buffer[0]!
      const b1 = buffer[1]!
      const opcode = b0 & 0x0f
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (buffer.length < 4) return
        len = buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buffer.length < 10) return
        len = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (b1 & 0x80) !== 0
      const maskBytes = masked ? 4 : 0
      if (buffer.length < offset + maskBytes + len) return
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
      offset += maskBytes
      let payload = buffer.subarray(offset, offset + len)
      if (mask !== undefined) {
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
      }
      buffer = buffer.subarray(offset + len)
      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload))
        continue
      }
      if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString('utf8'))
    }
  })
}

/** Start the mock CDP browser: /json/list plus a WS CDP endpoint. */
async function startMockCdp(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer()
  const port = await new Promise<number>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen((server.address() as AddressInfo).port))
  })
  const targets = [{
    id: 'tab-1',
    type: 'page',
    title: '测试页',
    url: 'https://example.com/',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab-1`,
  }]
  server.on('request', (req, res) => {
    if (req.url === '/json/list' || req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(targets))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    handleSocket(socket, (text) => {
      const msg = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> }
      if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return
      const reply = (result: unknown): void => {
        socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ id: msg.id, result }))))
      }
      const emit = (method: string, params: unknown): void => {
        socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ method, params }))))
      }
      if (msg.method === 'Runtime.evaluate') {
        const expression = typeof msg.params?.expression === 'string' ? msg.params.expression : ''
        if (expression.includes('boom')) {
          reply({ exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } })
        } else if (expression.includes('JSON.stringify')) {
          reply({ result: { type: 'object', value: { count: 3, name: 'demo' } } })
        } else {
          reply({ result: { type: 'string', value: 'Hello CDP' } })
        }
      } else if (msg.method === 'Page.captureScreenshot') {
        reply({ data: PNG_BASE64 })
      } else if (msg.method === 'Runtime.enable') {
        reply({})
        emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'console says hi' }] })
        emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } })
      } else {
        reply({})
      }
    })
  })
  return { port, close: () => new Promise<void>(r => server.close(() => r())) }
}

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = join(pluginDir, 'cordis.yml')

const fail = (message: string): never => {
  console.error(`verify-boot FAILED: ${message}`)
  process.exit(1)
}

const tempDir = await mkdtemp(join(tmpdir(), 'mj-cdp-verify-'))
let ctx: Awaited<ReturnType<typeof boot>> | undefined
try {
  const mock = await startMockCdp()
  try {
    const patches = loadOverlayPatches('dsh-verify', patchPath)
    for (const patch of patches) {
      const row = patch.insert?.[0]
      if (row !== undefined && typeof row.name === 'string' && row.name.endsWith('index.ts')) {
        row.name = join(pluginDir, 'src/index.ts')
        row.disabled = false
        row.config = {
          ...(row.config as Record<string, unknown> | undefined),
          cdpEndpoint: `http://127.0.0.1:${mock.port}`,
          cdpOutputDir: join(tempDir, 'shots'),
        }
      }
    }
    const rowId = patches.find(patch => patch.insert?.[0]?.id === 'mj-cdp')
    if (rowId === undefined) fail('cordis.yml does not insert the mj-cdp row')

    const rootConfig = join(tempDir, 'cordis.yml')
    await writeFile(rootConfig, '[]\n', 'utf8')

    const toolsPatch: PatchOptions = {
      insert: [
        { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { persona: '' } },
        { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      ],
    }
    ctx = await boot('dsh-verify', rootConfig, [toolsPatch, ...patches])

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'mj-cdp')
    if (entry === undefined || entry.fiber === undefined) fail('mj-cdp entry did not activate')

    const tools = ctx.tools
    for (const expected of ['cdp_targets', 'cdp_evaluate', 'cdp_screenshot', 'cdp_console']) {
      if (!tools.schemas().some(schema => schema.name === expected)) fail(`${expected} tool not registered`)
    }

    const signal = new AbortController().signal
    let callId = 0
    const run = (name: string, args: unknown) => tools.execute({
      callId: CallId(`verify:${++callId}`),
      name,
      arguments: args,
      signal,
    })

    const targets = await run('cdp_targets', { endpoint: `http://127.0.0.1:${mock.port}` })
    const targetsValue = targets.value as { endpoint: string; targets: Array<{ id: string; title: string; url: string }> }
    if (targets.isError || targetsValue.targets.length !== 1 || targetsValue.targets[0]?.id !== 'tab-1' || targetsValue.targets[0]?.url !== 'https://example.com/') {
      fail(`cdp_targets wrong: ${JSON.stringify(targets)}`)
    }

    const evaluated = await run('cdp_evaluate', { expression: 'document.title', endpoint: `http://127.0.0.1:${mock.port}` })
    const evaluatedValue = evaluated.value as { json: string; type: string; targetId: string }
    if (evaluated.isError || evaluatedValue.json !== '"Hello CDP"' || evaluatedValue.type !== 'string' || evaluatedValue.targetId !== 'tab-1') {
      fail(`cdp_evaluate wrong: ${JSON.stringify(evaluated)}`)
    }

    const data = await run('cdp_evaluate', { expression: 'JSON.stringify(window.__DATA__)', endpoint: `http://127.0.0.1:${mock.port}` })
    const dataValue = data.value as { json: string }
    if (data.isError || dataValue.json !== '{"count":3,"name":"demo"}') fail(`cdp_evaluate JSON wrong: ${JSON.stringify(data)}`)

    const thrown = await run('cdp_evaluate', { expression: 'boom()', endpoint: `http://127.0.0.1:${mock.port}` })
    if (!thrown.isError || !JSON.stringify(thrown.content).includes('boom')) {
      fail(`cdp_evaluate should surface the exception, got ${JSON.stringify(thrown)}`)
    }

    const shot = await run('cdp_screenshot', { endpoint: `http://127.0.0.1:${mock.port}` })
    const shotValue = shot.value as { localPath: string; format: string; bytes: number }
    if (shot.isError || shotValue.format !== 'png') fail(`cdp_screenshot wrong: ${JSON.stringify(shot)}`)
    const written = await readFile(shotValue.localPath)
    const expected = Buffer.from(PNG_BASE64, 'base64')
    if (written.length !== expected.length || written.length !== shotValue.bytes) {
      fail(`cdp_screenshot bytes wrong: ${written.length} vs ${expected.length}`)
    }

    const consoleResult = await run('cdp_console', { endpoint: `http://127.0.0.1:${mock.port}` })
    const consoleValue = consoleResult.value as { entries: Array<{ type: string; text: string }> }
    if (consoleResult.isError
      || !consoleValue.entries.some(e => e.type === 'log' && e.text === 'console says hi')
      || !consoleValue.entries.some(e => e.type === 'exception' && e.text.includes('TypeError'))) {
      fail(`cdp_console entries wrong: ${JSON.stringify(consoleValue)}`)
    }

    // ── chromePath launch mode: the chrome-launcher path runs and fails loud ──
    const patches2 = loadOverlayPatches('dsh-verify', patchPath)
    for (const patch of patches2) {
      const row = patch.insert?.[0]
      if (row !== undefined && typeof row.name === 'string' && row.name.endsWith('index.ts')) {
        row.name = join(pluginDir, 'src/index.ts')
        row.disabled = false
        row.config = { ...(row.config as Record<string, unknown> | undefined), chromePath: '/nonexistent/chrome-binary', launchOnLoad: true }
      }
    }
    const rootConfig2 = join(tempDir, 'cordis2.yml')
    await writeFile(rootConfig2, '[]\n', 'utf8')
    const ctx2 = await boot('dsh-verify', rootConfig2, [toolsPatch, ...patches2])
    try {
      const launchResult = await ctx2.tools.execute({
        callId: CallId('verify:launch'),
        name: 'cdp_targets',
        arguments: {},
        signal: new AbortController().signal,
      })
      if (!launchResult.isError || !JSON.stringify(launchResult.content).includes('failed to launch Chrome')) {
        fail(`chromePath launch should fail loud with a clear error, got ${JSON.stringify(launchResult)}`)
      }
    } finally {
      await ctx2.fiber.dispose()
    }

    console.log(`verify-boot PASSED: mj-cdp activated, cdp_targets/cdp_evaluate/cdp_screenshot/cdp_console work against the real WebSocket transport (mock endpoint :${mock.port}), and the chromePath launch path fails loud on a bad binary`)
  } finally {
    // Close the console sessions first (plugin dispose), then the mock server;
    // server.close() waits for open sockets.
    await ctx?.fiber.dispose()
    await mock.close()
  }
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
