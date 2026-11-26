/**
 * The release sub-action (release/action.yml, docs/design.md §5.4). The only place that
 * frees a held lock.
 *
 * Order: check the lease, send release (retrying transient failures while the
 * daemon keeps heartbeating), and only then stop the daemon, so a short
 * network outage during the release cannot let the lease go STALE.
 *
 * A STALE lease is not released (docs/design.md §4.1): the server would allow it, but
 * STALE means heartbeats were missing while the job ran, so an administrator
 * should look at the resources first, just as for a failed job.
 */
import {
  type AcquireStatus,
  type Connection,
  type LockApi,
  RemoteApiError
} from './client.js'
import type { DaemonControl, StopResult } from './daemon.js'
import {
  DAEMON_STOP_TIMEOUT_MS,
  MAX_RELEASE_ATTEMPTS,
  type Timing
} from './defaults.js'
import { InputError, readReleaseInputs } from './inputs.js'
import type { Io } from './io.js'
import { withRetry } from './retry.js'
import type { Clock } from './session.js'
import {
  type DaemonStatus,
  type LockState,
  readLockState,
  stateDir,
  stateFilePath,
  updateLockState
} from './state.js'
import { errorMessage, formatDuration } from './util.js'

export interface ReleaseDeps {
  io: Io
  env: NodeJS.ProcessEnv
  clock: Clock
  timing: Timing
  createApi(connection: Connection): LockApi
  daemon: DaemonControl
}

const STALE_CONSEQUENCE =
  'Heartbeats have stopped; the server marks the lease STALE about 60 s after the last heartbeat and keeps the resources until an administrator checks them and releases the lease in Jenkins.'

export async function runRelease(d: ReleaseDeps): Promise<void> {
  let inputs
  try {
    inputs = readReleaseInputs((name) => d.io.getInput(name), d.env)
  } catch (e) {
    if (e instanceof InputError) {
      d.io.setFailed(e.message)
      return
    }
    throw e
  }
  const { lockId, connection } = inputs
  d.io.setSecret(connection.token)
  for (const warning of inputs.warnings) d.io.warning(warning)

  const file = stateFilePath(stateDir(d.env), lockId)
  const state = readLockState(file)
  if (!state) {
    d.io.info(
      `This job has no state for lock ${lockId} (acquired in another job?); sending the release only.`
    )
  } else if (
    state.stage === 'skipped' ||
    state.stage === 'released' ||
    state.stage === 'withdrawn'
  ) {
    d.io.info(`Lock ${lockId} is ${state.stage}; nothing to release.`)
    return
  } else if (state.stage === 'stale') {
    d.io.setFailed(staleMessage(lockId, state))
    return
  }

  const what = describe(lockId, state)
  const api = d.createApi(connection)
  const retry = {
    attempts: MAX_RELEASE_ATTEMPTS,
    intervalMs: d.timing.releaseRetryIntervalMs,
    clock: d.clock,
    log: d.io
  }
  const stopDaemon = async (reason: string): Promise<StopResult | undefined> =>
    state?.daemon
      ? await d.daemon.stop(state.daemon, reason, DAEMON_STOP_TIMEOUT_MS)
      : undefined
  const fail = async (message: string): Promise<void> => {
    const stop = await stopDaemon('release failed')
    if (state) updateLockState(file, { releaseError: message })
    reportHeartbeats(d.io, lockId, stop?.status)
    d.io.setFailed(`${message}. ${STALE_CONSEQUENCE}`)
  }

  let status: AcquireStatus | undefined
  try {
    status = await withRetry(() => api.status(lockId), {
      ...retry,
      what: `Checking lock ${lockId}`
    })
  } catch (e) {
    if (e instanceof RemoteApiError && (e.status === 404 || e.status === 410)) {
      d.io.warning(
        `The server has no record of lock ${lockId} (HTTP ${e.status}); it may have restarted or the record expired. Sending the release anyway.`
      )
    } else {
      await fail(
        `Could not check ${what} before releasing it: ${errorMessage(e)}`
      )
      return
    }
  }

  if (status?.state === 'STALE') {
    const stop = await stopDaemon('lease is STALE')
    if (state) updateLockState(file, { stage: 'stale', endedAt: d.clock.now() })
    reportHeartbeats(d.io, lockId, stop?.status)
    d.io.setFailed(staleMessage(lockId, state))
    return
  }
  if (status?.state === 'FAILED' && status.errorCode === 'RELEASED') {
    const stop = await stopDaemon('already released')
    if (state) {
      updateLockState(file, { stage: 'released', endedAt: d.clock.now() })
    }
    reportHeartbeats(d.io, lockId, stop?.status)
    d.io.warning(
      `${capitalize(what)} was already released on the server (by an administrator, or by an earlier release).`
    )
    return
  }

  const releaseStartedAt = d.clock.now()
  try {
    await withRetry(() => api.release(lockId), {
      ...retry,
      what: `Release of lock ${lockId}`
    })
  } catch (e) {
    await fail(`Release of ${what} failed: ${errorMessage(e)}`)
    return
  }

  const stop = await stopDaemon('released')
  const endedAt = d.clock.now()
  if (state) updateLockState(file, { stage: 'released', endedAt })
  const held =
    state?.acquiredAt !== undefined
      ? ` after holding it for ${formatDuration(endedAt - state.acquiredAt)}`
      : ''
  d.io.info(`Released ${what}${held}.`)
  // A heartbeat sent between the release and the daemon's stop is answered
  // 410 LOCK_NOT_FOUND; that is expected, not worth a warning.
  reportHeartbeats(d.io, lockId, stop?.status, releaseStartedAt)
  if (stop?.outcome === 'unconfirmed') {
    d.io.warning(
      `Could not confirm that the heartbeat daemon (pid ${state?.daemon?.pid}) stopped; the runner terminates it at the end of the job.`
    )
  }
}

function describe(lockId: string, state: LockState | undefined): string {
  const resources = state?.resources ?? []
  return resources.length > 0
    ? `lock ${lockId} (${resources.join(', ')})`
    : `lock ${lockId}`
}

function staleMessage(lockId: string, state: LockState | undefined): string {
  return (
    `${capitalize(describe(lockId, state))} is STALE on the server: its heartbeats were missing for 60 s or more while the job ran. ` +
    'It was not released; an administrator must check the resources and release the lease in Jenkins.'
  )
}

/** Heartbeat totals, plus a warning for anything that went wrong (docs/design.md §5.5). */
export function reportHeartbeats(
  io: Pick<Io, 'info' | 'warning'>,
  lockId: string,
  status: DaemonStatus | undefined,
  /** A LOCK_NOT_FOUND answer at or after this time is expected (lock released). */
  releasedFrom?: number
): void {
  if (!status) return
  io.info(
    `Heartbeats for lock ${lockId}: ${status.okCount} sent, ${status.failCount} failed.`
  )
  const expectedGone =
    releasedFrom !== undefined &&
    status.terminal === 'LOCK_NOT_FOUND' &&
    (status.terminalAt ?? 0) >= releasedFrom
  if (status.terminal && !expectedGone) {
    io.warning(
      `The server answered ${status.terminal} to a heartbeat for lock ${lockId}; the daemon stopped sending heartbeats.`
    )
  } else if (status.failCount > 0) {
    io.warning(
      `${status.failCount} of ${status.attempts} heartbeats for lock ${lockId} failed; last error: ${status.lastError ?? 'unknown'}`
    )
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
