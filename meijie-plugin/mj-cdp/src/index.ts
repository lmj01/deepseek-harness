/**
 * mj-cdp — a Harness plugin that analyzes the current browser through the
 * Chrome DevTools Protocol (CDP).
 *
 * The browser exposes a debugging endpoint (launch with
 * `--remote-debugging-port=9222`); the plugin connects to it over HTTP
 * (`/json/list` target discovery) and WebSocket (per-target CDP sessions) and
 * registers four model-facing tools:
 *
 * - `cdp_targets` — list the browser's tabs (title, url, type).
 * - `cdp_evaluate` — run JavaScript in a page and read the returned value
 *   (page state, DOM queries, network-derived data).
 * - `cdp_screenshot` — capture a page's visual output as png/jpeg, saved
 *   locally so the harness `read_image` tool can view it.
 * - `cdp_console` — read console logs and page exceptions buffered since the
 *   session attached.
 *
 * Node 22's built-in WebSocket is the transport; no dependencies are needed.
 * The plugin is read-only with respect to the page except for the expression
 * the agent asks `cdp_evaluate` to run.
 *
 * The plugin is loaded as a raw Cordis plugin row (a `.ts` file referenced by
 * absolute path from a profile patch, e.g. `meijie-plugin/mj-cdp/cordis.yml`);
 * under the harness `dsh` source launch (tsx + the root tsconfig `paths`
 * facade) its `@deepseek-ai/*` imports resolve to the workspace sources.
 *
 * @module mj-cdp
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, hostname, release, version, platform } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createCdpClient, type CdpClient, type CdpSession, type CdpTarget } from './cdp.ts'

export const name = 'mj-cdp'

export const inject = ['tools']

export interface Config {
  /** Path to the Chrome/Edge executable; when set, the plugin launches it via chrome-launcher with a debugging port (no manual --remote-debugging-port needed). */
  chromePath?: string
  /** Launch Chrome with this profile directory (chrome-launcher userDataDir), e.g. for portable Chrome builds. */
  userDataDir?: string
  /** Debugging port for the launched Chrome (0 = OS-assigned). */
  chromePort?: number
  /** Launch Chrome headless (default true); false opens a visible window. */
  headless?: boolean
  /** Launch Chrome as soon as the plugin loads instead of on the first tool call. */
  launchOnLoad?: boolean
  /** Browser debugging endpoint to CONNECT to when chromePath is unset, e.g. http://127.0.0.1:9222. */
  cdpEndpoint?: string
  /** Directory `cdp_screenshot` writes images into (default: os.tmpdir()/mj-cdp). */
  cdpOutputDir?: string
  /** Cap on buffered console entries per page. */
  maxConsoleEntries?: number
  /** Log tool invocations to stdout. */
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  chromePath: Schema.string(),
  userDataDir: Schema.string(),
  chromePort: Schema.number(),
  headless: Schema.boolean().default(false),
  launchOnLoad: Schema.boolean().default(false),
  cdpEndpoint: Schema.string(),
  cdpOutputDir: Schema.string(),
  maxConsoleEntries: Schema.number().default(200),
  verbose: Schema.boolean().default(false),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One attached console session: the socket plus its bounded log buffer. */
interface ConsoleSession {
  session: CdpSession
  entries: Array<{ type: string; text: string }>
}

export function apply(ctx: Context, config: Config): void {
  const log = (message: string): void => {
    if (config.verbose) console.log(`[mj-cdp] ${message}`)
  }

  // Machine-specific defaults: on the dev machine (Windows 11 build 26200)
  // launch the Windows portable Chrome from WSL — chromePath/userDataDir use
  // the WSL mount paths (/mnt/e), and chrome-launcher converts the
  // --user-data-dir flag back to a Windows path (E:\...) for the Windows exe.
  // Note: inside WSL os.platform() is 'linux', never 'win32', so the machine
  // check keys on hostname/release only.
  if (platform() === 'linux') {
    if (release() === '6.6.87.2-microsoft-standard-WSL2' && version() === '#1 SMP PREEMPT_DYNAMIC Thu Jun  5 18:30:46 UTC 2025') {
      config.userDataDir = '/mnt/e/portableApp/GoogleChromePortable64/App/DefaultData/profile/Default'
      config.chromePath = '/mnt/e/portableApp/GoogleChromePortable64/App/Chrome-bin/chrome.exe'
      config.launchOnLoad = true
    }
  } else if (platform() === 'win32') {
    if (hostname() === 'meijie' && release() === '10.0.26200') {
      config.userDataDir = 'E:\\portableApp\\GoogleChromePortable64\\App\\DefaultData\\profile\\Default'
      config.chromePath = 'E:\\portableApp\\GoogleChromePortable64\\App\\Chrome-bin\\chrome.exe'
      config.launchOnLoad = true
    }
  }

  console.log(`[mj-cdp] plugin loaded (${config.chromePath !== undefined ? `chromePath=${config.chromePath}` : `endpoint=${config.cdpEndpoint ?? 'http://127.0.0.1:9222'}`}${config.launchOnLoad === true ? ', launchOnLoad' : ''})`)

  // Explicit resolve step: the deployment's screenshot directory, defaulted
  // once at load.
  const outputDir = config.cdpOutputDir ?? join(tmpdir(), 'mj-cdp')

  /** Per-page console sessions; closed on fiber teardown. */
  const consoleSessions = new Map<string, ConsoleSession>()
  ctx.effect(() => () => {
    for (const state of consoleSessions.values()) state.session.close()
  }, 'mj-cdp.console')

  /** The Chrome instance launched by this plugin (chromePath mode), if any. */
  let launchedChrome: { port: number; kill(): void | Promise<unknown> } | undefined
  ctx.effect(() => () => {
    void launchedChrome?.kill()
  }, 'mj-cdp.chrome')

  /**
   * Launch Chrome via chrome-launcher with a debugging port. Loads the
   * library lazily — the connect mode (cdpEndpoint) does not need it.
   * @returns the launched instance.
   */
  const launchChrome = async (): Promise<{ port: number; kill(): void | Promise<unknown> }> => {
    let chromeLauncher: typeof import('chrome-launcher')
    try {
      chromeLauncher = await import('chrome-launcher')
    } catch {
      throw new Error('mj-cdp: chrome-launcher is not installed — run `npm install` in meijie-plugin/ to enable the chromePath launch path')
    }
    const chromeFlags = ['--no-first-run', '--no-default-browser-check']
    if (config.headless !== false) chromeFlags.push('--headless=new')
    try {
      return await chromeLauncher.launch({
        ...(config.chromePath !== undefined ? { chromePath: config.chromePath } : {}),
        ...(config.userDataDir !== undefined ? { userDataDir: config.userDataDir } : {}),
        port: config.chromePort ?? 0,
        chromeFlags,
      })
    } catch (error) {
      throw new Error(`mj-cdp: failed to launch Chrome at ${config.chromePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Resolve the CDP endpoint for one call: an explicit override wins, then a
   * launched Chrome, then the chromePath launch mode, then the configured
   * connect endpoint.
   * @param endpoint - the call's endpoint parameter, if given.
   * @returns the resolved endpoint URL.
   */
  const resolveEndpoint = async (endpoint: string | undefined): Promise<string> => {
    if (endpoint !== undefined) return endpoint.replace(/\/+$/, '')
    if (launchedChrome !== undefined) return `http://127.0.0.1:${launchedChrome.port}`
    if (config.chromePath !== undefined) {
      const chrome = await launchChrome()
      launchedChrome = chrome
      return `http://127.0.0.1:${chrome.port}`
    }
    return (config.cdpEndpoint ?? 'http://127.0.0.1:9222').replace(/\/+$/, '')
  }

  const makeClient = (endpoint: string): CdpClient => createCdpClient({ endpoint })

  // Eager launch: when configured, start Chrome as soon as the plugin loads
  // instead of waiting for the first tool call. A failure is logged (the
  // per-call path retries and surfaces the real error to the agent).
  if (config.launchOnLoad === true && config.chromePath !== undefined) {
    launchChrome()
      .then((chrome) => {
        launchedChrome = chrome
        log(`Chrome launched on load (port ${chrome.port})`)
      })
      .catch((error: unknown) => {
        console.error(`[mj-cdp] Chrome launch on load failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /**
   * Resolve the target to inspect: an explicit id, else the first page tab.
   * @param client - the CDP client.
   * @param targetId - the call's targetId parameter, if given.
   * @returns the chosen target.
   */
  const pickTarget = async (client: CdpClient, targetId: string | undefined): Promise<CdpTarget> => {
    const targets = await client.targets()
    const chosen = targetId !== undefined
      ? targets.find(target => target.id === targetId)
      : targets.find(target => target.type === 'page') ?? targets[0]
    if (chosen === undefined) {
      throw new Error('cdp: no browser targets found — is the browser running with --remote-debugging-port?')
    }
    if (targetId !== undefined && chosen.id !== targetId) {
      throw new Error(`cdp: target ${targetId} not found`)
    }
    return chosen
  }

  /**
   * Attach (or reuse) a console session for one target and buffer its logs.
   * @param client - the CDP client.
   * @param target - the target to attach to.
   * @returns the session state with the entries collected so far.
   */
  const attachConsole = async (client: CdpClient, target: CdpTarget): Promise<ConsoleSession> => {
    const existing = consoleSessions.get(target.id)
    if (existing !== undefined) return existing
    const cap = config.maxConsoleEntries ?? 200
    const session = await client.connect(target.wsUrl)
    const state: ConsoleSession = { session, entries: [] }
    const push = (entry: { type: string; text: string }): void => {
      state.entries.push(entry)
      if (state.entries.length > cap) state.entries.splice(0, state.entries.length - cap)
    }
    session.on('Runtime.consoleAPICalled', (params) => {
      const type = typeof params.type === 'string' ? params.type : 'log'
      const text = Array.isArray(params.args)
        ? params.args.map(arg => isRecord(arg) && typeof arg.value === 'string' ? arg.value : JSON.stringify(arg ?? null)).join(' ')
        : ''
      push({ type, text })
    })
    session.on('Runtime.exceptionThrown', (params) => {
      const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {}
      const description = isRecord(details.exception) && typeof details.exception.description === 'string'
        ? details.exception.description
        : String(details.text ?? 'page exception')
      push({ type: 'exception', text: description })
    })
    try {
      await session.send('Runtime.enable')
    } catch (error) {
      session.close()
      throw error
    }
    consoleSessions.set(target.id, state)
    return state
  }

  ctx.tools.register(defineTool({
    name: 'cdp_targets',
    description: `List the tabs of the browser connected through the CDP endpoint (${config.cdpEndpoint ?? 'http://127.0.0.1:9222'}): id, title, url, and type for every target. Use the ids to inspect a specific tab with cdp_evaluate / cdp_screenshot / cdp_console.`,
    parameters: {
      endpoint: { type: 'string', description: 'CDP endpoint override; defaults to the configured cdpEndpoint.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', required: true },
          targets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.targets.map(t => `${t.id} [${t.type}] ${t.title} — ${t.url}`).join('\n'),
      }],
    },
    async execute(args) {
      const endpoint = await resolveEndpoint(args.endpoint)
      log(`cdp_targets(endpoint=${endpoint})`)
      const client = makeClient(endpoint)
      const targets = await client.targets()
      return {
        endpoint,
        targets: targets.map(target => ({ id: target.id, type: target.type, title: target.title, url: target.url })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cdp_evaluate',
    description: 'Run a JavaScript expression in a browser page through CDP and return the value it produces (returnByValue). Use it to read page state, query the DOM, or extract data the frontend holds. An expression that throws surfaces as a tool error.',
    parameters: {
      expression: { type: 'string', required: true, description: 'The JavaScript expression to evaluate in the page (non-empty).' },
      targetId: { type: 'string', description: 'Target id from cdp_targets; defaults to the first page tab.' },
      endpoint: { type: 'string', description: 'CDP endpoint override; defaults to the configured cdpEndpoint.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          type: { type: 'string', required: true },
          json: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.json} (${value.type})` }],
    },
    async execute(args) {
      const expression = args.expression.trim()
      if (expression === '') {
        throw new Error('cdp_evaluate: expression must not be empty')
      }
      const endpoint = await resolveEndpoint(args.endpoint)
      log(`cdp_evaluate(targetId=${args.targetId ?? 'first-page'})`)
      const client = makeClient(endpoint)
      const target = await pickTarget(client, args.targetId)
      const session = await client.connect(target.wsUrl)
      try {
        const result = await session.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }) as Record<string, unknown>
        if (isRecord(result.exceptionDetails)) {
          const details = result.exceptionDetails
          const description = isRecord(details.exception) && typeof details.exception.description === 'string'
            ? details.exception.description
            : String(details.text ?? 'expression threw')
          throw new Error(`cdp_evaluate: ${description}`)
        }
        const inner = isRecord(result.result) ? result.result : {}
        const value = inner.value
        let json: string
        try {
          json = value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value)
        } catch {
          json = String(value)
        }
        return { targetId: target.id, title: target.title, url: target.url, type: String(inner.type ?? 'unknown'), json }
      } finally {
        session.close()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cdp_screenshot',
    description: 'Capture the visual output of a browser page through CDP and save it to the configured cdpOutputDir (default: os.tmpdir()/mj-cdp). Combine with the harness read_image tool to view the screenshot.',
    parameters: {
      targetId: { type: 'string', description: 'Target id from cdp_targets; defaults to the first page tab.' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png).' },
      endpoint: { type: 'string', description: 'CDP endpoint override; defaults to the configured cdpEndpoint.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          format: { type: 'string', required: true },
          localPath: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Saved ${value.format} screenshot (${value.bytes} bytes):\n${value.localPath}` }],
    },
    async execute(args) {
      const endpoint = await resolveEndpoint(args.endpoint)
      const format = args.format ?? 'png'
      log(`cdp_screenshot(targetId=${args.targetId ?? 'first-page'}, format=${format})`)
      const client = makeClient(endpoint)
      const target = await pickTarget(client, args.targetId)
      const session = await client.connect(target.wsUrl)
      try {
        const result = await session.send('Page.captureScreenshot', { format }) as Record<string, unknown>
        const data = result.data
        if (typeof data !== 'string' || data === '') {
          throw new Error('cdp: Page.captureScreenshot returned no image data')
        }
        const bytes = Buffer.from(data, 'base64')
        await mkdir(outputDir, { recursive: true })
        const localPath = join(outputDir, `${target.id.replace(/[^A-Za-z0-9_-]/g, '_')}.${format}`)
        await writeFile(localPath, bytes)
        return { targetId: target.id, title: target.title, url: target.url, format, localPath, bytes: bytes.length }
      } finally {
        session.close()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cdp_console',
    description: 'Attach to a browser page through CDP and return its console log and page exceptions buffered since the first cdp_console call (capped at maxConsoleEntries). Call it again later to read newer entries.',
    parameters: {
      targetId: { type: 'string', description: 'Target id from cdp_targets; defaults to the first page tab.' },
      endpoint: { type: 'string', description: 'CDP endpoint override; defaults to the configured cdpEndpoint.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.entries.length === 0 ? '（暂无控制台输出）' : value.entries.map(e => `[${e.type}] ${e.text}`).join('\n'),
      }],
    },
    async execute(args) {
      const endpoint = await resolveEndpoint(args.endpoint)
      log(`cdp_console(targetId=${args.targetId ?? 'first-page'})`)
      const client = makeClient(endpoint)
      const target = await pickTarget(client, args.targetId)
      const state = await attachConsole(client, target)
      return {
        targetId: target.id,
        title: target.title,
        url: target.url,
        entries: state.entries.map(entry => ({ ...entry })),
      }
    },
  }))
}
