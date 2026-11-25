/**
 * An HTTP server that plays the lockable-resources remote API, in the spirit
 * of the plugin's RemoteServerFixture: QUEUED -> outcome transitions, terminal
 * states, 404 / 410, n consecutive failures, arbitrary heartbeat statuses and
 * 503 ACQUIRES_PAUSED. Everything it receives is recorded for assertions.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const BASE = '/lockable-resources/remote/v1'

export type Outcome = {
  state: 'ACQUIRED' | 'SKIPPED' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'BOGUS'
  errorCode?: string
  resources?: string[]
  lockEnvVars?: Record<string, string>
}

export interface FakeRecord {
  lockId: string
  state: 'QUEUED' | 'ACQUIRED' | 'SKIPPED' | 'FAILED' | 'STALE' | string
  errorCode?: string
  request: Record<string, unknown>
  queuedPollsLeft: number
  outcome: Outcome
  heartbeats: number
  releases: number
  lastHeartbeatAt?: number
}

export interface FakeServerOptions {
  username: string
  token: string
  /** Answers to POST /acquire/ before one is accepted, e.g. [{ status: 503 }]. */
  acquireFailures: Array<{
    status: number
    errorCode?: string
    message?: string
  }>
  /** Polls answered QUEUED before the outcome; Infinity = queued forever. */
  queuedPolls: number
  outcome: Outcome
  /** Consecutive polls answered with pollFailureStatus before normal answers. */
  pollFailures: number
  pollFailureStatus: number
  /** Overrides the heartbeat answer when it returns a number. */
  heartbeatStatus?: (record: FakeRecord) => number | undefined
  /** Release requests answered 500 before one succeeds. */
  releaseFailures: number
}

export interface LoggedRequest {
  method: string
  path: string
  status: number
  at: number
  authorized: boolean
}

export class FakeServer {
  readonly records = new Map<string, FakeRecord>()
  readonly requests: LoggedRequest[] = []
  readonly acquireBodies: Array<Record<string, unknown>> = []
  options: FakeServerOptions
  private server!: http.Server
  private counter = 0
  url = ''

  private constructor(options: Partial<FakeServerOptions>) {
    this.options = {
      username: 'robot',
      token: 'api-token-123',
      acquireFailures: [],
      queuedPolls: 0,
      outcome: { state: 'ACQUIRED', resources: ['printer'] },
      pollFailures: 0,
      pollFailureStatus: 500,
      releaseFailures: 0,
      ...options
    }
  }

  static async start(
    options: Partial<FakeServerOptions> = {},
    contextPath = '/jenkins'
  ): Promise<FakeServer> {
    const fake = new FakeServer(options)
    fake.server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => fake.handle(req, res, body, contextPath))
    })
    await new Promise<void>((resolve) =>
      fake.server.listen(0, '127.0.0.1', resolve)
    )
    const { port } = fake.server.address() as AddressInfo
    fake.url = `http://127.0.0.1:${port}${contextPath}`
    return fake
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  connection(): { serverUrl: string; username: string; token: string } {
    return {
      serverUrl: this.url,
      username: this.options.username,
      token: this.options.token
    }
  }

  count(method: string, pattern: RegExp): number {
    return this.requests.filter(
      (r) => r.method === method && pattern.test(r.path)
    ).length
  }

  heartbeats(lockId?: string): number {
    return this.count('POST', lockPattern(lockId, 'heartbeat'))
  }

  releases(lockId?: string): number {
    return this.count('POST', lockPattern(lockId, 'release'))
  }

  record(lockId?: string): FakeRecord {
    const record = lockId
      ? this.records.get(lockId)
      : [...this.records.values()].at(-1)
    if (!record) throw new Error(`no record ${lockId ?? ''}`)
    return record
  }

  markStale(lockId: string): void {
    this.record(lockId).state = 'STALE'
  }

  private handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    contextPath: string
  ): void {
    const method = req.method ?? 'GET'
    const fullPath = (req.url ?? '').split('?')[0] ?? ''
    const expected =
      'Basic ' +
      Buffer.from(`${this.options.username}:${this.options.token}`).toString(
        'base64'
      )
    const authorized = req.headers.authorization === expected
    const send = (status: number, json?: unknown): void => {
      this.requests.push({
        method,
        path: fullPath,
        status,
        at: Date.now(),
        authorized
      })
      if (json === undefined) {
        res.writeHead(status).end()
      } else {
        res
          .writeHead(status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(json))
      }
    }
    const error = (status: number, errorCode: string, message: string): void =>
      send(status, { errorCode, message })

    if (!fullPath.startsWith(contextPath + BASE)) {
      error(404, 'NOT_FOUND', 'no such path')
      return
    }
    if (!authorized) {
      send(401)
      return
    }
    const path = fullPath.slice((contextPath + BASE).length)

    if (method === 'POST' && path === '/acquire/') {
      const failure = this.options.acquireFailures.shift()
      if (failure) {
        error(
          failure.status,
          failure.errorCode ?? 'ERROR',
          failure.message ?? 'scripted failure'
        )
        return
      }
      const parsed = JSON.parse(body) as Record<string, unknown>
      this.acquireBodies.push(parsed)
      const lockId = `lock-${++this.counter}`
      const record: FakeRecord = {
        lockId,
        state: 'QUEUED',
        request: parsed,
        queuedPollsLeft: this.options.queuedPolls,
        outcome: this.options.outcome,
        heartbeats: 0,
        releases: 0
      }
      this.records.set(lockId, record)
      send(202, { lockId, state: 'QUEUED' })
      return
    }

    let m = /^\/acquire\/([^/]+)\/$/.exec(path)
    if (method === 'GET' && m) {
      if (this.options.pollFailures > 0) {
        this.options.pollFailures--
        error(this.options.pollFailureStatus, 'BOOM', 'scripted poll failure')
        return
      }
      const record = this.records.get(decodeURIComponent(m[1] ?? ''))
      if (!record) {
        error(404, 'LOCK_NOT_FOUND', 'Lock not found')
        return
      }
      if (record.state === 'QUEUED') {
        if (record.queuedPollsLeft > 0) {
          record.queuedPollsLeft--
        } else {
          record.state = record.outcome.state
          record.errorCode = record.outcome.errorCode
          if (record.state === 'ACQUIRED') record.lastHeartbeatAt = Date.now()
        }
      }
      const json: Record<string, unknown> = {
        lockId: record.lockId,
        state: record.state
      }
      if (record.errorCode) json.errorCode = record.errorCode
      if (record.state === 'ACQUIRED' || record.state === 'STALE') {
        json.resources = record.outcome.resources ?? []
        if (record.outcome.lockEnvVars) {
          json.lockEnvVars = record.outcome.lockEnvVars
        }
      }
      send(200, json)
      return
    }

    m = /^\/lease\/([^/]+)\/(heartbeat|release)$/.exec(path)
    if (method === 'POST' && m) {
      const record = this.records.get(decodeURIComponent(m[1] ?? ''))
      if (m[2] === 'heartbeat') {
        const override = record
          ? this.options.heartbeatStatus?.(record)
          : undefined
        if (override !== undefined) {
          if (override === 204) {
            record!.heartbeats++
            send(204)
          } else {
            error(override, 'SCRIPTED', 'scripted heartbeat answer')
          }
          return
        }
        if (record?.state === 'ACQUIRED') {
          record.heartbeats++
          record.lastHeartbeatAt = Date.now()
          send(204)
        } else if (record?.state === 'STALE') {
          error(410, 'LOCK_STALE', 'Lock is STALE; contact administrator')
        } else {
          error(410, 'LOCK_NOT_FOUND', 'Lock not found or not active')
        }
        return
      }
      if (this.options.releaseFailures > 0) {
        this.options.releaseFailures--
        error(500, 'BOOM', 'scripted release failure')
        return
      }
      if (record) {
        record.releases++
        if (['ACQUIRED', 'STALE', 'QUEUED'].includes(record.state)) {
          record.state = 'FAILED'
          record.errorCode = 'RELEASED'
        }
      }
      send(204)
      return
    }

    error(404, 'NOT_FOUND', `no route for ${method} ${path}`)
  }
}

function lockPattern(lockId: string | undefined, action: string): RegExp {
  const id = lockId ? lockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[^/]+'
  return new RegExp(`/lease/${id}/${action}$`)
}
