/**
 * State shared between main, the heartbeat daemon, the release sub-action and
 * post (PLAN §4.5). core.saveState only reaches the same action's post, and the
 * release sub-action is a different action, so main writes one file per lock
 * under $RUNNER_TEMP/lockable-resources/. The token is never written anywhere.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Keys for core.saveState (main -> post). */
export const STATE_LOCK_ID = 'lock-id'
export const STATE_FILE = 'state-file'

/**
 * enqueued: accepted by the server, not handed to the workflow yet
 * held:     handed over; only the release step frees it
 * skipped:  skip-if-locked and the resources were busy
 * released: the release step freed it
 * withdrawn: the request was taken back before it was handed over
 * stale:    the release step found the lease STALE and left it to an administrator
 */
export type Stage =
  'enqueued' | 'held' | 'skipped' | 'released' | 'withdrawn' | 'stale'

/** Stages in which the daemon should keep sending heartbeats. */
export const ACTIVE_STAGES: ReadonlySet<Stage> = new Set(['enqueued', 'held'])

export interface DaemonInfo {
  pid: number
  statusFile: string
  logFile: string
  stopFile: string
}

export interface LockState {
  version: 1
  lockId: string
  stage: Stage
  /** GITHUB_ACTION of the lock step, to find the file if post lost its state. */
  actionId?: string
  serverUrl: string
  description: string
  enqueuedAt: number
  acquiredAt?: number
  endedAt?: number
  resources?: string[]
  daemon?: DaemonInfo
  /** Set when the release step ran but could not release the lock. */
  releaseError?: string
}

/** What the heartbeat daemon reports about itself. */
export interface DaemonStatus {
  pid: number
  lockId: string
  startedAt: number
  /** Heartbeats attempted so far. */
  attempts: number
  okCount: number
  failCount: number
  lastAttemptAt?: number
  lastOkAt?: number
  lastError?: string
  /** errorCode of a 410 answer (LOCK_STALE / LOCK_NOT_FOUND); the daemon stops sending after it. */
  terminal?: string
  /** When the 410 answer arrived. */
  terminalAt?: number
  stoppedAt?: number
  stopReason?: string
  /** Most recent distinct warnings, capped. */
  warnings: string[]
}

export function stateDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.RUNNER_TEMP || os.tmpdir(), 'lockable-resources')
}

export function fileSafe(lockId: string): string {
  return lockId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function stateFilePath(dir: string, lockId: string): string {
  return path.join(dir, `${fileSafe(lockId)}.json`)
}

export function daemonFiles(
  dir: string,
  lockId: string
): Omit<DaemonInfo, 'pid'> {
  const base = path.join(dir, fileSafe(lockId))
  return {
    statusFile: `${base}.heartbeat.json`,
    logFile: `${base}.heartbeat.log`,
    stopFile: `${base}.stop`
  }
}

let tmpCounter = 0

/** Write via a temporary file and rename, so readers never see half a file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      // Windows refuses to replace a file another process has open.
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY')) {
        fs.rmSync(tmp, { force: true })
        throw e
      }
      sleepSync(20 * attempt)
    }
  }
}

/** undefined when the file does not exist or cannot be parsed. */
export function readJson<T>(file: string): T | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export function readLockState(file: string): LockState | undefined {
  const state = readJson<LockState>(file)
  return state && state.version === 1 && state.lockId ? state : undefined
}

export function writeLockState(file: string, state: LockState): void {
  writeJsonAtomic(file, state)
}

export function updateLockState(
  file: string,
  patch: Partial<LockState>
): LockState | undefined {
  const current = readLockState(file)
  if (!current) return undefined
  const next = { ...current, ...patch }
  writeLockState(file, next)
  return next
}

export function readDaemonStatus(file: string): DaemonStatus | undefined {
  return readJson<DaemonStatus>(file)
}

/**
 * Fallback for post when core.saveState did not reach it (main killed before
 * the runner read the state): this step's lock files that still need handling.
 */
export function findActiveStateFiles(dir: string, actionId: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.heartbeat.json'))
    .map((n) => path.join(dir, n))
    .filter((file) => {
      const state = readLockState(file)
      return (
        state !== undefined &&
        state.actionId === actionId &&
        ACTIVE_STAGES.has(state.stage)
      )
    })
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
