/**
 * The lock step (action.yml runs.main): validate the inputs, acquire, and
 * hand the lock over to the workflow. "Held" starts only once the hand-over is
 * complete: heartbeat daemon running, environment variables and outputs set
 * (PLAN §4.1). If anything fails or the step is cancelled before that, the
 * request is withdrawn, because no step has touched the resources yet.
 */
import type { Connection, LockApi } from './client.js'
import type { DaemonControl } from './daemon.js'
import { DAEMON_READY_TIMEOUT_MS, DAEMON_STOP_TIMEOUT_MS } from './defaults.js'
import type { Timing } from './defaults.js'
import { InputError, readLockInputs } from './inputs.js'
import type { Io } from './io.js'
import {
  allocateDeadline,
  buildAcquireBody,
  describeRequest
} from './request.js'
import {
  type AcquireOutcome,
  AcquireCancelledError,
  type Clock,
  acquireLock
} from './session.js'
import {
  type DaemonInfo,
  STATE_FILE,
  STATE_LOCK_ID,
  stateDir,
  stateFilePath,
  updateLockState,
  writeLockState
} from './state.js'
import { errorMessage } from './util.js'

export interface MainDeps {
  io: Io
  env: NodeJS.ProcessEnv
  clock: Clock
  timing: Timing
  /** Aborted when the runner cancels the step (SIGINT / SIGTERM). */
  signal: AbortSignal
  createApi(connection: Connection): LockApi
  daemon: DaemonControl
}

export async function runMain(d: MainDeps): Promise<void> {
  let inputs
  try {
    inputs = readLockInputs((name) => d.io.getInput(name), d.env)
  } catch (e) {
    if (e instanceof InputError) {
      d.io.setFailed(e.message)
      return
    }
    throw e
  }
  const { connection, request, clientId } = inputs
  d.io.setSecret(connection.token)
  for (const warning of inputs.warnings) d.io.warning(warning)

  const api = d.createApi(connection)
  const description = describeRequest(request)
  const dir = stateDir(d.env)
  d.io.info(
    `Requesting a lock on ${description} from ${connection.serverUrl} (clientId=${clientId})`
  )
  d.io.info(`Reason: ${request.reason}`)

  let lockId: string | undefined
  let stateFile: string | undefined
  try {
    const outcome = await acquireLock({
      api,
      body: buildAcquireBody(request, clientId),
      description,
      deadline: allocateDeadline(request, d.clock.now()),
      clock: d.clock,
      log: d.io,
      timing: d.timing,
      signal: d.signal,
      onEnqueued: (id) => {
        // Saved at once, so post can withdraw the request even if this step
        // is cancelled while it waits.
        lockId = id
        stateFile = stateFilePath(dir, id)
        writeLockState(stateFile, {
          version: 1,
          lockId: id,
          stage: 'enqueued',
          actionId: d.env.GITHUB_ACTION,
          serverUrl: connection.serverUrl,
          description,
          enqueuedAt: d.clock.now()
        })
        d.io.saveState(STATE_LOCK_ID, id)
        d.io.saveState(STATE_FILE, stateFile)
        d.io.setOutput('lock-id', id)
        d.io.info(`The server accepted the request (lockId=${id}).`)
      }
    })
    if (!stateFile) throw new Error('internal error: no state file')
    if (outcome.state === 'SKIPPED') {
      skip(d, outcome.lockId, stateFile, description)
    } else {
      await handOver(d, connection, outcome, stateFile, dir)
    }
  } catch (e) {
    let withdrawn = false
    if (lockId && stateFile)
      withdrawn = await withdraw(d, api, lockId, stateFile)
    let message = errorMessage(e)
    if (e instanceof AcquireCancelledError && withdrawn) {
      message += '; the request was withdrawn'
    }
    d.io.setFailed(message)
  }
}

function skip(
  d: MainDeps,
  lockId: string,
  stateFile: string,
  description: string
): void {
  updateLockState(stateFile, { stage: 'skipped', endedAt: d.clock.now() })
  d.io.setOutput('state', 'SKIPPED')
  d.io.setOutput('acquired', 'false')
  d.io.setOutput('resources', '[]')
  d.io.setOutput('env-vars', '{}')
  d.io.info(
    `Skipped: ${description} is locked by someone else (skip-if-locked). ` +
      'Guard the steps that need the lock with `if: steps.<id>.outputs.acquired == ' +
      "'true'`."
  )
}

async function handOver(
  d: MainDeps,
  connection: Connection,
  outcome: Extract<AcquireOutcome, { state: 'ACQUIRED' }>,
  stateFile: string,
  dir: string
): Promise<void> {
  const { lockId, resources, lockEnvVars } = outcome
  let daemon: DaemonInfo | undefined
  try {
    daemon = d.daemon.start({ lockId, connection, stateFile, dir })
    updateLockState(stateFile, { daemon })
    const status = await d.daemon.waitReady(daemon, DAEMON_READY_TIMEOUT_MS)
    if (status.terminal) {
      throw new Error(
        `The server rejected the first heartbeat for lock ${lockId} (${status.terminal})`
      )
    }
    if (status.okCount === 0 && status.lastError) {
      d.io.warning(
        `The first heartbeat for lock ${lockId} failed (${status.lastError}); the daemon keeps trying.`
      )
    }
    if (d.signal.aborted) throw new AcquireCancelledError(lockId)

    // Values may be secrets (resource properties): set them, never print them.
    for (const [name, value] of Object.entries(lockEnvVars)) {
      d.io.exportVariable(name, value)
    }
    d.io.setOutput('state', 'ACQUIRED')
    d.io.setOutput('acquired', 'true')
    d.io.setOutput('resources', JSON.stringify(resources))
    d.io.setOutput('env-vars', JSON.stringify(lockEnvVars))
    updateLockState(stateFile, {
      stage: 'held',
      acquiredAt: d.clock.now(),
      resources
    })
  } catch (e) {
    if (daemon) {
      await d.daemon.stop(daemon, 'hand-over failed', DAEMON_STOP_TIMEOUT_MS)
    }
    throw e
  }

  d.io.info(
    `Acquired ${resources.length > 0 ? resources.join(', ') : 'the lock'} (lockId=${lockId}). ` +
      `Heartbeats keep the lease alive (daemon pid ${daemon.pid}) until the release step runs.`
  )
  const names = Object.keys(lockEnvVars)
  if (names.length > 0) {
    d.io.info(`Environment variables for later steps: ${names.join(', ')}`)
  }
}

/** One attempt; post tries again if this fails. */
async function withdraw(
  d: MainDeps,
  api: LockApi,
  lockId: string,
  stateFile: string
): Promise<boolean> {
  try {
    await api.release(lockId)
    updateLockState(stateFile, { stage: 'withdrawn', endedAt: d.clock.now() })
    d.io.info(`Withdrew lock request ${lockId}.`)
    return true
  } catch (e) {
    d.io.warning(
      `Could not withdraw lock request ${lockId} (${errorMessage(e)}); the post step will try again.`
    )
    return false
  }
}
