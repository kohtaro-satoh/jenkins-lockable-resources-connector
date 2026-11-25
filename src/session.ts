/**
 * Acquire state machine (the acquiring half of the Jenkins client's
 * RemoteLockSession): enqueue, retry while the server is paused (503),
 * poll until the request leaves QUEUED. The clock and the HTTP client are
 * injected so the tests can drive every branch.
 */
import { setTimeout as delay } from 'node:timers/promises'
import type { AcquireBody, AcquireStatus, LockApi } from './client.js'
import { RemoteApiError } from './client.js'
import { MAX_CONSECUTIVE_POLL_FAILURES, type Timing } from './defaults.js'
import { errorMessage, formatDuration } from './util.js'

export interface Clock {
  now(): number
  /** Rejects when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal })
  }
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warning(message: string): void
}

export type AcquireOutcome =
  | {
      state: 'ACQUIRED'
      lockId: string
      resources: string[]
      lockEnvVars: Record<string, string>
    }
  | { state: 'SKIPPED'; lockId: string }

export class AcquireError extends Error {
  constructor(
    message: string,
    /** Set once the server accepted the request. */
    readonly lockId: string | undefined,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'AcquireError'
  }
}

export class AcquireCancelledError extends AcquireError {
  constructor(lockId: string | undefined) {
    super(
      lockId
        ? `Cancelled while waiting for lock ${lockId}`
        : 'Cancelled before the lock request was accepted',
      lockId
    )
    this.name = 'AcquireCancelledError'
  }
}

export interface AcquireOptions {
  api: LockApi
  body: AcquireBody
  /** For log lines, e.g. "label 'plc', quantity 1". */
  description: string
  /** Epoch ms after which a paused server (503) is given up on; 0 = never. */
  deadline: number
  clock: Clock
  log: Logger
  timing: Timing
  signal?: AbortSignal
  /** Called as soon as the server accepted the request, before polling. */
  onEnqueued?: (lockId: string) => void
}

export async function acquireLock(o: AcquireOptions): Promise<AcquireOutcome> {
  const lockId = await enqueue(o)
  o.onEnqueued?.(lockId)
  return await poll(o, lockId)
}

async function enqueue(o: AcquireOptions): Promise<string> {
  let pausedLogged = false
  for (;;) {
    throwIfCancelled(o, undefined)
    try {
      // Not cut short by a cancel: the server may accept the request anyway,
      // and only with its lockId can the request be withdrawn. It takes at
      // most the 5 s request timeout; the cancel is seen right after.
      return await o.api.acquire(o.body)
    } catch (e) {
      throwIfCancelled(o, undefined)
      if (e instanceof RemoteApiError && e.status === 503) {
        // Paused for maintenance, not broken: keep asking until this
        // request's own allocation timeout, like the Jenkins client.
        if (o.deadline > 0 && o.clock.now() >= o.deadline) {
          throw new AcquireError(
            'Timed out while the server was not accepting new acquire requests (errorCode=ACQUIRES_PAUSED)',
            undefined,
            { cause: e }
          )
        }
        if (!pausedLogged) {
          o.log.info(
            'The server is not accepting new acquire requests right now (HTTP 503); waiting for it to resume.'
          )
          pausedLogged = true
        }
        await sleep(o, undefined)
        continue
      }
      // Fail closed: any other refusal or communication failure stops here.
      throw new AcquireError(
        `Lock request failed: ${errorMessage(e)}`,
        undefined,
        {
          cause: e
        }
      )
    }
  }
}

async function poll(
  o: AcquireOptions,
  lockId: string
): Promise<AcquireOutcome> {
  const max = MAX_CONSECUTIVE_POLL_FAILURES
  let failures = 0
  let lastState: string | undefined
  const waitStart = o.clock.now()
  let nextWaitLog = waitStart + o.timing.waitLogIntervalMs

  for (let first = true; ; first = false) {
    if (!first) await sleep(o, lockId)
    throwIfCancelled(o, lockId)

    let status: AcquireStatus
    try {
      status = await o.api.status(lockId, o.signal)
    } catch (e) {
      throwIfCancelled(o, lockId)
      if (
        e instanceof RemoteApiError &&
        (e.status === 404 || e.status === 410)
      ) {
        throw new AcquireError(
          `The server has no record of lock ${lockId} (HTTP ${e.status}); it may have restarted or the record expired.`,
          lockId,
          { cause: e }
        )
      }
      failures++
      if (failures >= max) {
        throw new AcquireError(
          `Polling lock ${lockId} failed ${failures} times in a row; giving up: ${errorMessage(e)}`,
          lockId,
          { cause: e }
        )
      }
      o.log.warning(
        `Polling lock ${lockId} failed (${failures}/${max}); retrying: ${errorMessage(e)}`
      )
      continue
    }
    failures = 0

    if (status.state !== lastState) {
      lastState = status.state
      o.log.debug(`Lock ${lockId} is ${status.state}`)
    }

    switch (status.state) {
      case 'QUEUED': {
        const now = o.clock.now()
        if (now >= nextWaitLog) {
          o.log.info(
            `Still waiting for ${o.description} (${formatDuration(now - waitStart)}, lockId=${lockId})`
          )
          nextWaitLog += o.timing.waitLogIntervalMs
        }
        continue
      }
      case 'ACQUIRED':
        // Always the accepted lockId: the state file, the lock-id output and
        // the release step must all name the same lock.
        return {
          state: 'ACQUIRED',
          lockId,
          resources: status.resources ?? [],
          lockEnvVars: status.lockEnvVars ?? {}
        }
      case 'SKIPPED':
        return { state: 'SKIPPED', lockId }
      default:
        throw new AcquireError(failureMessage(lockId, status), lockId)
    }
  }
}

function failureMessage(lockId: string, status: AcquireStatus): string {
  let message = `Lock ${lockId} was not acquired: state=${status.state}`
  if (status.errorCode) message += `, errorCode=${status.errorCode}`
  if (status.message) message += `, message=${status.message}`
  if (status.errorCode === 'LOCK_WAIT_TIMEOUT') {
    message += ' (timeout-for-allocate-resource expired)'
  }
  return message
}

function throwIfCancelled(o: AcquireOptions, lockId: string | undefined): void {
  if (o.signal?.aborted) throw new AcquireCancelledError(lockId)
}

async function sleep(
  o: AcquireOptions,
  lockId: string | undefined
): Promise<void> {
  try {
    await o.clock.sleep(o.timing.pollIntervalMs, o.signal)
  } catch (e) {
    if (o.signal?.aborted) throw new AcquireCancelledError(lockId)
    throw e
  }
}
