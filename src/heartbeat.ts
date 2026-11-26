/**
 * The heartbeat daemon's loop (docs/design.md §4.3, §6).
 *
 * - The first heartbeat goes out at once, then one every 10 s (fixed delay,
 *   like the Jenkins client).
 * - A failed heartbeat is recorded and the loop goes on: the server keeps the
 *   lock, and STALE only follows if heartbeats stay missing for 60 s.
 * - HTTP 410 (LOCK_STALE / LOCK_NOT_FOUND) ends the loop: there is no way back
 *   from STALE, so sending more would be pointless.
 * - It stops when asked (stop file or signal), and on its own when the lock's
 *   state file says the lock is no longer active or has disappeared (the
 *   runner empties RUNNER_TEMP at the end of the job), so it can never keep a
 *   lease alive after its job.
 */
import fs from 'node:fs'
import { type LockApi, RemoteApiError } from './client.js'
import type { Clock } from './session.js'
import {
  ACTIVE_STAGES,
  type DaemonStatus,
  readLockState,
  writeJsonAtomic
} from './state.js'
import { errorMessage, isoTime } from './util.js'

export interface DaemonConfig {
  lockId: string
  stateFile: string
  statusFile: string
  logFile: string
  stopFile: string
  intervalMs: number
  /** How often to check for a stop request. */
  tickMs: number
  /** How long the state file must stay missing before the daemon gives up. */
  missingStateGraceMs?: number
}

export interface DaemonDeps {
  api: Pick<LockApi, 'heartbeat'>
  clock: Clock
  pid: number
  /** Aborted on SIGTERM / SIGINT. */
  signal?: AbortSignal
}

const MAX_WARNINGS = 20

export async function runHeartbeatDaemon(
  cfg: DaemonConfig,
  deps: DaemonDeps
): Promise<DaemonStatus> {
  const { clock } = deps
  const status: DaemonStatus = {
    pid: deps.pid,
    lockId: cfg.lockId,
    startedAt: clock.now(),
    attempts: 0,
    okCount: 0,
    failCount: 0,
    warnings: []
  }
  const log = (level: string, message: string): void => {
    try {
      fs.appendFileSync(
        cfg.logFile,
        `${isoTime(clock.now())} ${level} ${message}\n`
      )
    } catch {
      // Logging must never stop the heartbeats.
    }
  }
  const warn = (message: string): void => {
    log('WARN', message)
    if (status.warnings[status.warnings.length - 1] !== message) {
      status.warnings.push(message)
      if (status.warnings.length > MAX_WARNINGS) status.warnings.shift()
    }
  }
  const save = (): void => {
    try {
      // Never create the directory: the lock step made it, and once it is
      // gone the job's temp dir has been removed. Recreating it would leave
      // files behind (and break a cleanup running at that moment).
      writeJsonAtomic(cfg.statusFile, status, { createDir: false })
    } catch (e) {
      log('WARN', `could not write ${cfg.statusFile}: ${errorMessage(e)}`)
    }
  }

  const stopper = new AbortController()
  let stopReason: string | undefined
  const requestStop = (reason: string): void => {
    if (stopReason === undefined) {
      stopReason = reason
      stopper.abort()
    }
  }
  const onSignal = (): void => requestStop('signal')
  if (deps.signal?.aborted) requestStop('signal')
  deps.signal?.addEventListener('abort', onSignal)

  const grace = cfg.missingStateGraceMs ?? 2_000
  let stateMissingSince: number | undefined
  const checkStop = (): string | undefined => {
    if (fs.existsSync(cfg.stopFile)) {
      let reason = ''
      try {
        reason = fs.readFileSync(cfg.stopFile, 'utf8').trim()
      } catch {
        // The request is what matters, not its reason.
      }
      return `stop requested${reason ? ` (${reason})` : ''}`
    }
    if (!fs.existsSync(cfg.stateFile)) {
      stateMissingSince ??= clock.now()
      return clock.now() - stateMissingSince >= grace
        ? 'state file removed (job finished)'
        : undefined
    }
    stateMissingSince = undefined
    const state = readLockState(cfg.stateFile)
    if (state && !ACTIVE_STAGES.has(state.stage)) {
      return `lock is ${state.stage}`
    }
    return undefined
  }
  // Checked on a timer as well, so a stop request also cuts short a
  // heartbeat that is in flight.
  const watcher = setInterval(() => {
    const reason = checkStop()
    if (reason) requestStop(reason)
  }, cfg.tickMs)

  save()
  log(
    'INFO',
    `started: pid=${deps.pid} lockId=${cfg.lockId} interval=${cfg.intervalMs}ms`
  )
  let consecutiveFailures = 0
  try {
    let next = clock.now()
    while (stopReason === undefined) {
      const early = checkStop()
      if (early) {
        requestStop(early)
        break
      }
      const wait = next - clock.now()
      if (wait > 0) {
        try {
          await clock.sleep(Math.min(wait, cfg.tickMs), stopper.signal)
        } catch {
          break
        }
        continue
      }

      status.attempts++
      status.lastAttemptAt = clock.now()
      try {
        await deps.api.heartbeat(cfg.lockId, stopper.signal)
        status.okCount++
        status.lastOkAt = clock.now()
        if (consecutiveFailures > 0) {
          log(
            'INFO',
            `heartbeat recovered after ${consecutiveFailures} failure(s)`
          )
        }
        consecutiveFailures = 0
      } catch (e) {
        if (stopReason !== undefined) break
        if (e instanceof RemoteApiError && e.status === 410) {
          status.terminal = e.errorCode ?? 'LOCK_NOT_FOUND'
          status.terminalAt = clock.now()
          warn(
            `The server answered HTTP 410 (${status.terminal}) to a heartbeat for lock ${cfg.lockId}; no more heartbeats are sent.`
          )
          requestStop(`server answered ${status.terminal}`)
          break
        }
        status.failCount++
        consecutiveFailures++
        status.lastError = errorMessage(e)
        warn(`Heartbeat for lock ${cfg.lockId} failed: ${status.lastError}`)
      }
      save()
      next = clock.now() + cfg.intervalMs
    }
  } finally {
    clearInterval(watcher)
    deps.signal?.removeEventListener('abort', onSignal)
    status.stoppedAt = clock.now()
    status.stopReason = stopReason ?? 'unknown'
    save()
    log(
      'INFO',
      `stopped: ${status.stopReason} (sent ${status.okCount}, failed ${status.failCount})`
    )
  }
  return status
}
