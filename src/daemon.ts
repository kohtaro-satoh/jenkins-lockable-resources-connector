/**
 * Starting and stopping the heartbeat daemon (docs/design.md §4.3).
 *
 * The daemon is a detached Node process so it outlives the main step. It
 * inherits the environment (including RUNNER_TRACKING_ID, which is how the
 * runner finds and terminates orphan processes at the end of the job) except
 * the INPUT_* and STATE_* variables; the token goes in an environment variable,
 * never on the command line where `ps` would show it.
 *
 * Stopping is cooperative: the caller writes a stop file and waits for the
 * daemon to record stoppedAt. Once it has, no further heartbeat is sent. A
 * signal is only a fallback, and only after checking that the PID still
 * belongs to the daemon (PIDs are reused).
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Connection } from './client.js'
import type { Clock } from './session.js'
import {
  type DaemonInfo,
  type DaemonStatus,
  daemonFiles,
  readDaemonStatus
} from './state.js'

export const DAEMON_ENV = {
  serverUrl: 'LRRC_DAEMON_SERVER_URL',
  username: 'LRRC_DAEMON_USERNAME',
  token: 'LRRC_DAEMON_TOKEN',
  lockId: 'LRRC_DAEMON_LOCK_ID',
  stateFile: 'LRRC_DAEMON_STATE_FILE',
  statusFile: 'LRRC_DAEMON_STATUS_FILE',
  logFile: 'LRRC_DAEMON_LOG_FILE',
  stopFile: 'LRRC_DAEMON_STOP_FILE'
} as const

export interface StartDaemonOptions {
  lockId: string
  connection: Connection
  stateFile: string
  dir: string
}

export interface StopResult {
  /** stopped: confirmed; not-running: was not running; killed: stopped by signal; unconfirmed: could not confirm */
  outcome: 'stopped' | 'not-running' | 'killed' | 'unconfirmed'
  status?: DaemonStatus
}

export interface DaemonControl {
  start(o: StartDaemonOptions): DaemonInfo
  /** Resolves after the first heartbeat attempt; rejects if the daemon died or never got that far. */
  waitReady(info: DaemonInfo, timeoutMs: number): Promise<DaemonStatus>
  stop(info: DaemonInfo, reason: string, timeoutMs: number): Promise<StopResult>
  readStatus(info: DaemonInfo): DaemonStatus | undefined
}

export function daemonEnvironment(
  base: NodeJS.ProcessEnv,
  o: StartDaemonOptions,
  files: Omit<DaemonInfo, 'pid'>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^(INPUT|STATE)_/i.test(key)) continue
    env[key] = value
  }
  env[DAEMON_ENV.serverUrl] = o.connection.serverUrl
  env[DAEMON_ENV.username] = o.connection.username
  env[DAEMON_ENV.token] = o.connection.token
  env[DAEMON_ENV.lockId] = o.lockId
  env[DAEMON_ENV.stateFile] = o.stateFile
  env[DAEMON_ENV.statusFile] = files.statusFile
  env[DAEMON_ENV.logFile] = files.logFile
  env[DAEMON_ENV.stopFile] = files.stopFile
  return env
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function processDaemonControl(
  scriptPath: string,
  baseEnv: NodeJS.ProcessEnv,
  clock: Clock
): DaemonControl {
  return {
    start(o) {
      const files = daemonFiles(o.dir, o.lockId)
      fs.mkdirSync(o.dir, { recursive: true })
      fs.rmSync(files.stopFile, { force: true })
      fs.rmSync(files.statusFile, { force: true })
      const child = spawn(process.execPath, [scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: o.dir,
        env: daemonEnvironment(baseEnv, o, files)
      })
      // A spawn failure is reported by waitReady (no status file appears).
      child.on('error', () => undefined)
      child.unref()
      if (child.pid === undefined) {
        throw new Error(
          `Could not start the heartbeat daemon (${process.execPath} ${scriptPath})`
        )
      }
      return { pid: child.pid, ...files }
    },

    async waitReady(info, timeoutMs) {
      const deadline = clock.now() + timeoutMs
      for (;;) {
        const status = readDaemonStatus(info.statusFile)
        if (status && (status.attempts > 0 || status.stoppedAt)) return status
        if (!isAlive(info.pid)) {
          const last = readDaemonStatus(info.statusFile)
          if (last && (last.attempts > 0 || last.stoppedAt)) return last
          throw new Error(
            `The heartbeat daemon (pid ${info.pid}) exited before its first heartbeat; see ${info.logFile}`
          )
        }
        if (clock.now() >= deadline) {
          throw new Error(
            `The heartbeat daemon (pid ${info.pid}) did not send its first heartbeat within ${Math.round(timeoutMs / 1000)} s; see ${info.logFile}`
          )
        }
        await clock.sleep(100)
      }
    },

    async stop(info, reason, timeoutMs) {
      let status = readDaemonStatus(info.statusFile)
      if (status?.stoppedAt || !isAlive(info.pid)) {
        return { outcome: 'not-running', status }
      }
      try {
        fs.writeFileSync(info.stopFile, reason)
      } catch {
        // Fall through to the signal below.
      }
      const deadline = clock.now() + timeoutMs
      while (clock.now() < deadline) {
        await clock.sleep(100)
        status = readDaemonStatus(info.statusFile)
        if (status?.stoppedAt || !isAlive(info.pid)) {
          return { outcome: 'stopped', status }
        }
      }
      if (isAlive(info.pid) && looksLikeDaemon(info.pid, scriptPath)) {
        try {
          process.kill(info.pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
        const killDeadline = clock.now() + 2_000
        while (isAlive(info.pid) && clock.now() < killDeadline) {
          await clock.sleep(100)
        }
      }
      status = readDaemonStatus(info.statusFile)
      if (status?.stoppedAt) return { outcome: 'stopped', status }
      return { outcome: isAlive(info.pid) ? 'unconfirmed' : 'killed', status }
    },

    readStatus(info) {
      return readDaemonStatus(info.statusFile)
    }
  }
}

/** Whether pid still runs our daemon script (guards against PID reuse). */
function looksLikeDaemon(pid: number, scriptPath: string): boolean {
  const name = path.basename(scriptPath)
  try {
    if (process.platform === 'linux') {
      return fs
        .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .some((arg) => arg.endsWith(name))
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8'
      }).includes(name)
    }
  } catch {
    return false
  }
  // Windows: no cheap way to check; leave it to the runner's cleanup.
  return false
}
