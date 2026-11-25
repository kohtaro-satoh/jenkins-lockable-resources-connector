/**
 * The heartbeat daemon process, started detached by the lock step. All of its
 * configuration arrives in LRRC_DAEMON_* environment variables.
 */
import fs from 'node:fs'
import { RemoteApiClient } from '../client.js'
import { DAEMON_ENV } from '../daemon.js'
import { DAEMON_TICK_MS, timingFromEnv } from '../defaults.js'
import { runHeartbeatDaemon } from '../heartbeat.js'
import { systemClock } from '../session.js'
import { errorMessage, isoTime } from '../util.js'

const env = process.env
const read = (name: string): string => env[name] ?? ''

const config = {
  serverUrl: read(DAEMON_ENV.serverUrl),
  username: read(DAEMON_ENV.username),
  token: read(DAEMON_ENV.token),
  lockId: read(DAEMON_ENV.lockId),
  stateFile: read(DAEMON_ENV.stateFile),
  statusFile: read(DAEMON_ENV.statusFile),
  logFile: read(DAEMON_ENV.logFile),
  stopFile: read(DAEMON_ENV.stopFile)
}
delete env[DAEMON_ENV.token]

if (Object.values(config).some((v) => v === '')) {
  process.stderr.write(
    'heartbeat daemon: missing LRRC_DAEMON_* configuration\n'
  )
  process.exit(2)
}

const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT', () => controller.abort())
// Detached, but ignore a hang-up anyway: only a stop request or the job's end
// should end the heartbeats.
process.on('SIGHUP', () => undefined)

try {
  await runHeartbeatDaemon(
    {
      lockId: config.lockId,
      stateFile: config.stateFile,
      statusFile: config.statusFile,
      logFile: config.logFile,
      stopFile: config.stopFile,
      intervalMs: timingFromEnv(env).heartbeatIntervalMs,
      tickMs: DAEMON_TICK_MS
    },
    {
      api: new RemoteApiClient({
        serverUrl: config.serverUrl,
        username: config.username,
        token: config.token
      }),
      clock: systemClock,
      pid: process.pid,
      signal: controller.signal
    }
  )
  process.exit(0)
} catch (e) {
  try {
    fs.appendFileSync(
      config.logFile,
      `${isoTime(Date.now())} ERROR daemon crashed: ${errorMessage(e)}\n`
    )
  } catch {
    // Nothing else to do.
  }
  process.exit(1)
}
