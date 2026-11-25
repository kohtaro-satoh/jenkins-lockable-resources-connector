/**
 * Thin HTTP client for the remote lock API (the Jenkins client's
 * RemoteApiClient). Node's fetch, Basic authentication with an API token
 * (no CSRF crumb needed), a 5 s timeout per request.
 */
import { API_BASE_PATH, REQUEST_TIMEOUT_MS } from './defaults.js'
import { errorMessage } from './util.js'

export interface Connection {
  /** Root URL of the Jenkins server, including any context path, without a trailing slash. */
  serverUrl: string
  username: string
  token: string
}

export type AcquireState =
  | 'QUEUED'
  | 'ACQUIRED'
  | 'SKIPPED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'STALE'
  | 'UNKNOWN'

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'QUEUED',
  'ACQUIRED',
  'SKIPPED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'STALE'
])

export interface AcquireStatus {
  lockId: string
  state: AcquireState
  errorCode?: string
  message?: string
  resources?: string[]
  lockEnvVars?: Record<string, string>
}

export interface AcquireBody {
  lockRequest: Record<string, unknown>
  heartbeatIntervalSeconds?: number
  clientId?: string
}

/** The operations the action needs; tests substitute fakes. */
export interface LockApi {
  acquire(body: AcquireBody, signal?: AbortSignal): Promise<string>
  status(lockId: string, signal?: AbortSignal): Promise<AcquireStatus>
  heartbeat(lockId: string, signal?: AbortSignal): Promise<void>
  release(lockId: string, signal?: AbortSignal): Promise<void>
}

export class RemoteApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or -1 when no response arrived (network failure, timeout). */
    readonly status: number,
    readonly errorCode?: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'RemoteApiError'
  }

  /** Worth retrying: no response, a server error, or rate limiting. */
  get transient(): boolean {
    return (
      this.status < 0 ||
      this.status >= 500 ||
      this.status === 429 ||
      this.status === 408
    )
  }
}

const MAX_LOGGED_BODY_CHARS = 512

export interface ClientOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

export class RemoteApiClient implements LockApi {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly authorization: string

  constructor(
    private readonly connection: Connection,
    options: ClientOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.authorization =
      'Basic ' +
      Buffer.from(`${connection.username}:${connection.token}`).toString(
        'base64'
      )
  }

  /** POST /acquire/ and return the accepted lockId. */
  async acquire(body: AcquireBody, signal?: AbortSignal): Promise<string> {
    const path = '/acquire/'
    const { status, json } = await this.send('POST', path, body, signal)
    const lockId = extractLockId(json)
    if (!lockId) {
      throw new RemoteApiError(
        `Remote acquire response did not contain lockId (HTTP ${status})`,
        status,
        'INVALID_RESPONSE'
      )
    }
    return lockId
  }

  /** GET /acquire/{lockId}/ */
  async status(lockId: string, signal?: AbortSignal): Promise<AcquireStatus> {
    const path = `/acquire/${encodeURIComponent(lockId)}/`
    const { json } = await this.send('GET', path, undefined, signal)
    const result: AcquireStatus = {
      lockId: extractLockId(json) ?? lockId,
      state: toState(json.state)
    }
    if (typeof json.errorCode === 'string' && json.errorCode) {
      result.errorCode = json.errorCode
    }
    if (typeof json.message === 'string' && json.message) {
      result.message = json.message
    }
    if (Array.isArray(json.resources)) {
      result.resources = json.resources.map((r) => String(r))
    }
    if (isPlainObject(json.lockEnvVars)) {
      const vars: Record<string, string> = {}
      for (const [k, v] of Object.entries(json.lockEnvVars)) {
        vars[k] = v === null || v === undefined ? '' : String(v)
      }
      result.lockEnvVars = vars
    }
    return result
  }

  /** POST /lease/{lockId}/heartbeat */
  async heartbeat(lockId: string, signal?: AbortSignal): Promise<void> {
    await this.send(
      'POST',
      `/lease/${encodeURIComponent(lockId)}/heartbeat`,
      undefined,
      signal
    )
  }

  /** POST /lease/{lockId}/release (idempotent; also withdraws a QUEUED request). */
  async release(lockId: string, signal?: AbortSignal): Promise<void> {
    await this.send(
      'POST',
      `/lease/${encodeURIComponent(lockId)}/release`,
      undefined,
      signal
    )
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = this.connection.serverUrl + API_BASE_PATH + path
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authorization
    }
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const timeout = AbortSignal.timeout(this.timeoutMs)
    let response: Response
    let text: string
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: payload ?? (method === 'POST' ? '' : undefined),
        // Never follow a redirect with the credentials (and fetch would turn
        // a redirected POST into a GET); report it instead.
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      text = await response.text()
    } catch (e) {
      const reason = timeout.aborted
        ? `timed out after ${this.timeoutMs} ms`
        : describeFetchError(e)
      throw new RemoteApiError(
        `Remote API communication failure: ${method} ${path} (${reason})`,
        -1,
        undefined,
        { cause: e }
      )
    }

    const status = response.status
    if (status >= 300) {
      throw httpError(method, path, status, text, response.headers)
    }
    if (!text) {
      return { status, json: {} }
    }
    try {
      const parsed: unknown = JSON.parse(text)
      return { status, json: isPlainObject(parsed) ? parsed : {} }
    } catch {
      throw new RemoteApiError(
        `Remote response is not valid JSON for ${method} ${path} (HTTP ${status}): ${abbreviate(text)}`,
        status,
        'INVALID_JSON'
      )
    }
  }
}

function httpError(
  method: string,
  path: string,
  status: number,
  text: string,
  headers: Headers
): RemoteApiError {
  let errorCode: string | undefined
  let remoteMessage: string | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (isPlainObject(parsed)) {
      const code = parsed.errorCode ?? parsed.code
      if (typeof code === 'string' && code) errorCode = code
      if (typeof parsed.message === 'string' && parsed.message) {
        remoteMessage = abbreviate(parsed.message)
      }
    }
  } catch {
    // Not JSON (an HTML error page from Jenkins or a proxy).
  }
  let message = `Remote API request failed: ${method} ${path} returned HTTP ${status}`
  const details: string[] = []
  if (errorCode) details.push(`errorCode=${errorCode}`)
  if (remoteMessage) details.push(`message=${remoteMessage}`)
  if (details.length > 0) message += ` (${details.join(', ')})`
  message += hint(status, errorCode, headers)
  return new RemoteApiError(message, status, errorCode)
}

function hint(
  status: number,
  errorCode: string | undefined,
  headers: Headers
): string {
  if (status >= 300 && status < 400) {
    const location = headers.get('location')
    return `. The server redirected${location ? ` to ${location}` : ''}; set server-url to the final URL (scheme, host and context path).`
  }
  if (status === 401) {
    return '. Check username and token (use a Jenkins API token, not a password).'
  }
  if (status === 403 && errorCode === undefined) {
    return '. The user needs the Lockable Resources/RemoteUse permission, and the token must be an API token (a password is rejected by the CSRF crumb check).'
  }
  if (status === 404 && errorCode === undefined) {
    return '. Verify server-url (including the context path) and that the remote API is enabled.'
  }
  if (
    errorCode === 'UNKNOWN_RESOURCE' ||
    errorCode === 'UNKNOWN_LABEL' ||
    errorCode === 'UNKNOWN_GROUP'
  ) {
    return '. Verify that the resource or label exists and is exposed by exposeLabel.'
  }
  return ''
}

function describeFetchError(e: unknown): string {
  if (e instanceof Error && e.cause instanceof Error) {
    return `${e.message}: ${e.cause.message}`
  }
  return errorMessage(e)
}

function extractLockId(json: Record<string, unknown>): string | undefined {
  for (const key of ['lockId', 'requestId', 'leaseId']) {
    const value = json[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function toState(value: unknown): AcquireState {
  if (typeof value !== 'string') return 'UNKNOWN'
  const upper = value.trim().toUpperCase()
  return KNOWN_STATES.has(upper) ? (upper as AcquireState) : 'UNKNOWN'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function abbreviate(text: string): string {
  const oneLine = text.replace(/[\r\n]+/g, ' ')
  return oneLine.length <= MAX_LOGGED_BODY_CHARS
    ? oneLine
    : `${oneLine.slice(0, MAX_LOGGED_BODY_CHARS)}...(truncated, total=${oneLine.length} chars)`
}
