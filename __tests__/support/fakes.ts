import type {
  AcquireBody,
  AcquireStatus,
  Connection,
  LockApi
} from '../../src/client.js'
import type { DaemonControl, StopResult } from '../../src/daemon.js'
import type { Timing } from '../../src/defaults.js'
import type { Io } from '../../src/io.js'
import type { Clock } from '../../src/session.js'
import type { DaemonInfo, DaemonStatus } from '../../src/state.js'

export const FAST_TIMING: Timing = {
  pollIntervalMs: 3_000,
  heartbeatIntervalMs: 10_000,
  releaseRetryIntervalMs: 3_000,
  waitLogIntervalMs: 60_000
}

/** Time only moves when someone sleeps. */
export class FakeClock implements Clock {
  t = 1_700_000_000_000
  sleeps: number[] = []
  now(): number {
    return this.t
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError()
    this.sleeps.push(ms)
    this.t += ms
    await Promise.resolve()
    if (signal?.aborted) throw abortError()
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

export interface LogLine {
  level: 'debug' | 'info' | 'warning' | 'error' | 'failed'
  message: string
}

export class FakeIo implements Io {
  inputs: Record<string, string> = {}
  outputs: Record<string, string> = {}
  env: Record<string, string> = {}
  state: Record<string, string> = {}
  secrets: string[] = []
  logs: LogLine[] = []
  summaries: string[] = []
  failed: string | undefined

  constructor(inputs: Record<string, string> = {}) {
    this.inputs = inputs
  }
  getInput(name: string): string {
    return (this.inputs[name] ?? '').trim()
  }
  setOutput(name: string, value: string): void {
    this.outputs[name] = value
  }
  exportVariable(name: string, value: string): void {
    this.env[name] = value
  }
  saveState(name: string, value: string): void {
    this.state[name] = value
  }
  getState(name: string): string {
    return this.state[name] ?? ''
  }
  setSecret(value: string): void {
    this.secrets.push(value)
  }
  debug(message: string): void {
    this.logs.push({ level: 'debug', message })
  }
  info(message: string): void {
    this.logs.push({ level: 'info', message })
  }
  warning(message: string): void {
    this.logs.push({ level: 'warning', message })
  }
  error(message: string): void {
    this.logs.push({ level: 'error', message })
  }
  setFailed(message: string): void {
    this.failed = message
    this.logs.push({ level: 'failed', message })
  }
  async appendSummary(markdown: string): Promise<void> {
    this.summaries.push(markdown)
  }
  messages(level: LogLine['level']): string[] {
    return this.logs.filter((l) => l.level === level).map((l) => l.message)
  }
}

type Step<T> = T | Error | ((call: number) => T | Promise<T>)

/** A LockApi whose answers are scripted per call; the last entry repeats. */
export class ScriptedApi implements LockApi {
  calls: Array<{ op: string; arg?: unknown }> = []
  acquireSteps: Array<Step<string>> = ['lock-1']
  statusSteps: Array<Step<AcquireStatus>> = [
    { lockId: 'lock-1', state: 'ACQUIRED', resources: ['printer'] }
  ]
  heartbeatSteps: Array<Step<void>> = [undefined]
  releaseSteps: Array<Step<void>> = [undefined]

  async acquire(body: AcquireBody): Promise<string> {
    return this.run('acquire', this.acquireSteps, body)
  }
  async status(lockId: string): Promise<AcquireStatus> {
    return this.run('status', this.statusSteps, lockId)
  }
  async heartbeat(lockId: string): Promise<void> {
    return this.run('heartbeat', this.heartbeatSteps, lockId)
  }
  async release(lockId: string): Promise<void> {
    return this.run('release', this.releaseSteps, lockId)
  }
  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length
  }

  private async run<T>(op: string, steps: Array<Step<T>>, arg: unknown) {
    const n = this.calls.filter((c) => c.op === op).length
    this.calls.push({ op, arg })
    const step = steps[Math.min(n, steps.length - 1)] as Step<T>
    if (step instanceof Error) throw step
    if (typeof step === 'function') {
      return await (step as (call: number) => T | Promise<T>)(n)
    }
    return step
  }
}

/** A DaemonControl that records what it was asked to do. */
export class FakeDaemon implements DaemonControl {
  started: Array<{ lockId: string; connection: Connection }> = []
  stopped: Array<{ info: DaemonInfo; reason: string }> = []
  status: DaemonStatus = {
    pid: 4242,
    lockId: 'lock-1',
    startedAt: 0,
    attempts: 1,
    okCount: 1,
    failCount: 0,
    warnings: []
  }
  readyError: Error | undefined
  stopOutcome: StopResult['outcome'] = 'stopped'

  start(o: { lockId: string; connection: Connection }): DaemonInfo {
    this.started.push({ lockId: o.lockId, connection: o.connection })
    return {
      pid: 4242,
      statusFile: '/nonexistent/status.json',
      logFile: '/nonexistent/heartbeat.log',
      stopFile: '/nonexistent/stop'
    }
  }
  async waitReady(): Promise<DaemonStatus> {
    if (this.readyError) throw this.readyError
    return this.status
  }
  async stop(info: DaemonInfo, reason: string): Promise<StopResult> {
    this.stopped.push({ info, reason })
    return { outcome: this.stopOutcome, status: this.status }
  }
  readStatus(): DaemonStatus | undefined {
    return this.status
  }
}
