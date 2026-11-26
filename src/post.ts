/**
 * The lock step's post (action.yml runs.post, post-if: always()).
 *
 * It never releases a held lock (docs/design.md §4.1). Per stage:
 * - enqueued: the request was never handed over -> withdraw it
 * - held:     the release step did not run -> stop the daemon, do NOT
 *             release, fail the step; the server marks the lease STALE
 * - stale:    the release step found it STALE -> make sure the daemon stopped
 * - skipped / released / withdrawn -> nothing to do
 * and it writes a line to the job summary.
 */
import type { Connection, LockApi } from './client.js'
import type { DaemonControl, StopResult } from './daemon.js'
import {
  DAEMON_STOP_TIMEOUT_MS,
  MAX_RELEASE_ATTEMPTS,
  SERVER_STALE_THRESHOLD_MS,
  type Timing
} from './defaults.js'
import { readConnection } from './inputs.js'
import type { Io } from './io.js'
import { reportHeartbeats } from './release.js'
import { withRetry } from './retry.js'
import type { Clock } from './session.js'
import {
  type DaemonStatus,
  type LockState,
  STATE_FILE,
  type Stage,
  findActiveStateFiles,
  readLockState,
  stateDir,
  updateLockState
} from './state.js'
import { errorMessage, formatDuration, isoTime } from './util.js'

export interface PostDeps {
  io: Io
  env: NodeJS.ProcessEnv
  clock: Clock
  timing: Timing
  createApi(connection: Connection): LockApi
  daemon: DaemonControl
}

export type PostAction = 'withdraw' | 'stop-and-fail' | 'stop-only' | 'none'

export function decidePostAction(stage: Stage): PostAction {
  switch (stage) {
    case 'enqueued':
      return 'withdraw'
    case 'held':
      return 'stop-and-fail'
    case 'stale':
      return 'stop-only'
    case 'skipped':
    case 'released':
    case 'withdrawn':
      return 'none'
  }
}

export async function runPost(d: PostDeps): Promise<void> {
  for (const file of locateStateFiles(d)) {
    await handleLock(d, file)
  }
}

function locateStateFiles(d: PostDeps): string[] {
  const saved = d.io.getState(STATE_FILE)
  if (saved) return [saved]
  // The runner may not have recorded main's saveState (main killed during
  // cancellation); main's state file names the step that wrote it.
  const actionId = d.env.GITHUB_ACTION
  if (!actionId) return []
  const found = findActiveStateFiles(stateDir(d.env), actionId)
  if (found.length > 0) {
    d.io.info(
      `The lock step's saved state is missing; found ${found.length} lock file(s) written by step ${actionId}.`
    )
  }
  return found
}

async function handleLock(d: PostDeps, file: string): Promise<void> {
  const state = readLockState(file)
  if (!state) {
    d.io.debug(`No lock state at ${file}; nothing to clean up.`)
    return
  }
  const action = decidePostAction(state.stage)

  let stop: StopResult | undefined
  if (action !== 'none' && state.daemon) {
    stop = await d.daemon.stop(
      state.daemon,
      `post (${state.stage})`,
      DAEMON_STOP_TIMEOUT_MS
    )
    if (stop.outcome === 'unconfirmed') {
      d.io.warning(
        `Could not confirm that the heartbeat daemon (pid ${state.daemon.pid}) stopped; the runner terminates it at the end of the job.`
      )
    }
  }
  const daemonStatus =
    stop?.status ??
    (state.daemon ? d.daemon.readStatus(state.daemon) : undefined)

  let result: string
  switch (action) {
    case 'withdraw':
      result = await withdraw(d, state, file)
      break
    case 'stop-and-fail':
      // No release here, on purpose. (A failed release step has already
      // reported the heartbeats.)
      if (!state.releaseError)
        reportHeartbeats(d.io, state.lockId, daemonStatus)
      d.io.setFailed(unreleasedMessage(d, state, daemonStatus))
      result = 'Not released: STALE, an administrator must release it'
      break
    case 'stop-only':
      result = 'STALE: left for an administrator'
      break
    case 'none':
      result = {
        skipped: 'Skipped (skip-if-locked)',
        released: 'Released',
        withdrawn: 'Withdrawn before hand-over',
        enqueued: '',
        held: '',
        stale: ''
      }[state.stage]
      break
  }
  await d.io.appendSummary(
    summary(d, readLockState(file) ?? state, result, daemonStatus)
  )
}

async function withdraw(
  d: PostDeps,
  state: LockState,
  file: string
): Promise<string> {
  let connection: Connection
  try {
    connection = readConnection((name) => d.io.getInput(name), d.env).connection
  } catch (e) {
    d.io.warning(
      `Could not withdraw lock request ${state.lockId}: ${errorMessage(e)}`
    )
    return 'Withdrawal failed'
  }
  d.io.setSecret(connection.token)
  try {
    await withRetry(() => d.createApi(connection).release(state.lockId), {
      attempts: MAX_RELEASE_ATTEMPTS,
      intervalMs: d.timing.releaseRetryIntervalMs,
      clock: d.clock,
      log: d.io,
      what: `Withdrawal of lock request ${state.lockId}`
    })
  } catch (e) {
    d.io.warning(
      `Could not withdraw lock request ${state.lockId} (${errorMessage(e)}). ` +
        'It stays queued on the server until timeout-for-allocate-resource expires, if one was set.'
    )
    return 'Withdrawal failed'
  }
  updateLockState(file, { stage: 'withdrawn', endedAt: d.clock.now() })
  d.io.info(`Withdrew lock request ${state.lockId} (it was never handed over).`)
  return 'Withdrawn before hand-over'
}

function unreleasedMessage(
  d: PostDeps,
  state: LockState,
  status: DaemonStatus | undefined
): string {
  const resources =
    state.resources && state.resources.length > 0
      ? ` (${state.resources.join(', ')})`
      : ''
  const why = state.releaseError
    ? `the release step failed: ${state.releaseError}`
    : 'the release step did not run (a previous step failed, the job was cancelled, or the release step is missing)'
  let when: string
  if (status?.terminal === 'LOCK_STALE') {
    when = 'The server already marked the lease STALE.'
  } else {
    const base = status?.lastOkAt ?? state.acquiredAt ?? d.clock.now()
    const eta = base + SERVER_STALE_THRESHOLD_MS
    when =
      eta > d.clock.now()
        ? `Heartbeats have stopped; the server marks the lease STALE at about ${isoTime(eta)}.`
        : `Heartbeats have stopped; the lease has been STALE since about ${isoTime(eta)}.`
  }
  return (
    `Lock ${state.lockId}${resources} was not released: ${why}. ${when} ` +
    'The server keeps the resources until an administrator checks them and releases the lease in Jenkins.'
  )
}

function summary(
  d: PostDeps,
  state: LockState,
  result: string,
  status: DaemonStatus | undefined
): string {
  const resources =
    state.resources && state.resources.length > 0
      ? state.resources.map(escapeCell).join(', ')
      : '—'
  const held =
    state.acquiredAt !== undefined
      ? formatDuration((state.endedAt ?? d.clock.now()) - state.acquiredAt)
      : '—'
  const heartbeats = status
    ? `${status.okCount} sent / ${status.failCount} failed`
    : '—'
  return [
    '### Lockable resources',
    '',
    '| Lock ID | Resources | Result | Held | Heartbeats |',
    '| --- | --- | --- | --- | --- |',
    `| \`${escapeCell(state.lockId)}\` | ${resources} | ${escapeCell(result)} | ${held} | ${heartbeats} |`,
    ''
  ].join('\n')
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}
