/**
 * Minimal Chrome DevTools Protocol (CDP) client for the mj-cdp plugin.
 *
 * Two layers:
 *
 * - HTTP target discovery — `GET {endpoint}/json/list` returns every browser
 *   tab (target) with its `webSocketDebuggerUrl`.
 * - WebSocket sessions — one session per target speaks the JSON-RPC-ish CDP
 *   message protocol (`{id, method, params}` / `{id, result}` / events).
 *
 * Node 22's built-in `WebSocket` is the default transport. Both the HTTP and
 * the WebSocket transport are injectable so tests stub the browser without
 * one running.
 *
 * @module mj-cdp-cdp
 */

/** One browser target (tab) from `/json/list`. */
export interface CdpTarget {
  id: string
  /** `page`, `service_worker`, `background_page`, … */
  type: string
  title: string
  url: string
  /** The target's `webSocketDebuggerUrl`; targets without one are skipped. */
  wsUrl: string
}

/** One CDP WebSocket session. */
export interface CdpSession {
  /** Send one method and resolve with its `result` (rejects on CDP error or timeout). */
  send(method: string, params?: unknown): Promise<unknown>
  /** Subscribe to protocol events, e.g. `Runtime.consoleAPICalled`. */
  on(event: string, listener: (params: Record<string, unknown>) => void): void
  close(): void
}

/** Options for {@link createCdpClient}. */
export interface CdpClientOptions {
  /** Browser debugging endpoint, e.g. `http://127.0.0.1:9222`. */
  endpoint: string
  /** HTTP transport for target discovery; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** WebSocket factory; defaults to a real session over the global `WebSocket`. */
  wsFactory?: (url: string) => Promise<CdpSession>
}

/** The REST surface the plugin tools use. */
export interface CdpClient {
  /** List the browser's targets (tabs). */
  targets(): Promise<CdpTarget[]>
  /** Open a CDP session to one target's debugger URL. */
  connect(wsUrl: string): Promise<CdpSession>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Build a CDP client over injectable transports.
 * @param options - endpoint and optional transports.
 * @returns the client.
 */
export function createCdpClient(options: CdpClientOptions): CdpClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const wsFactory = options.wsFactory ?? WsCdpSession.connect
  const endpoint = options.endpoint.replace(/\/+$/, '')

  const targets = async (): Promise<CdpTarget[]> => {
    const response = await fetchImpl(`${endpoint}/json/list`)
    if (!response.ok) {
      throw new Error(`cdp: ${endpoint}/json/list returned ${response.status} — is the browser running with --remote-debugging-port?`)
    }
    const list = await response.json() as unknown
    if (!Array.isArray(list)) {
      throw new Error(`cdp: ${endpoint}/json/list did not return an array of targets`)
    }
    return list.flatMap((entry): CdpTarget[] => {
      if (!isRecord(entry)) return []
      const { id, type, title, url, webSocketDebuggerUrl } = entry
      if (typeof id !== 'string' || typeof webSocketDebuggerUrl !== 'string') return []
      return [{
        id,
        type: typeof type === 'string' ? type : 'page',
        title: typeof title === 'string' ? title : '',
        url: typeof url === 'string' ? url : '',
        wsUrl: webSocketDebuggerUrl,
      }]
    })
  }

  return { targets, connect: wsUrl => wsFactory(wsUrl) }
}

/** One pending CDP request. */
interface PendingRequest {
  resolve(value: unknown): void
  reject(reason: unknown): void
  timer: ReturnType<typeof setTimeout>
}

/** Real CDP session over the global WebSocket. */
export class WsCdpSession implements CdpSession {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data
        : Buffer.isBuffer(event.data) ? event.data.toString('utf8')
        : String(event.data)
      let message: unknown
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (!isRecord(message)) return
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error !== undefined) {
          pending.reject(new Error(`cdp: ${isRecord(message.error) && typeof message.error.message === 'string' ? message.error.message : 'method failed'}`))
        } else {
          pending.resolve(message.result)
        }
      } else if (typeof message.method === 'string') {
        const listeners = this.listeners.get(message.method)
        if (listeners === undefined) return
        const params = isRecord(message.params) ? message.params : {}
        for (const listener of [...listeners]) listener(params)
      }
    })
  }

  /**
   * Connect to a target's debugger URL, resolving once the socket opens.
   * @param url - the `webSocketDebuggerUrl` of a target.
   * @returns the ready session.
   */
  static connect(url: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const session = new WsCdpSession(ws)
      ws.addEventListener('open', () => resolve(session), { once: true })
      ws.addEventListener('error', (event: Event) => {
        reject(new Error(`cdp: websocket error connecting to ${url}: ${String((event as { message?: string }).message ?? '')}`))
      }, { once: true })
    })
  }

  send(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp: ${method} timed out`))
      }, 15_000)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
        timer,
      })
      this.ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }))
    })
  }

  on(event: string, listener: (params: Record<string, unknown>) => void): void {
    let listeners = this.listeners.get(event)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener)
  }

  close(): void {
    this.ws.close()
  }
}
