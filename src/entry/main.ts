import { fileURLToPath } from 'node:url'
import { RemoteApiClient } from '../client.js'
import { coreIo } from '../core-io.js'
import { processDaemonControl } from '../daemon.js'
import { timingFromEnv } from '../defaults.js'
import { runMain } from '../main.js'
import { systemClock } from '../session.js'
import { errorMessage } from '../util.js'

const controller = new AbortController()
const onSignal = (signal: NodeJS.Signals): void => {
  if (!controller.signal.aborted) {
    coreIo.info(`Received ${signal}; stopping.`)
    controller.abort()
  }
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

const daemonScript = fileURLToPath(new URL('./heartbeat.js', import.meta.url))

try {
  await runMain({
    io: coreIo,
    env: process.env,
    clock: systemClock,
    timing: timingFromEnv(process.env),
    signal: controller.signal,
    createApi: (connection) => new RemoteApiClient(connection),
    daemon: processDaemonControl(daemonScript, process.env, systemClock)
  })
} catch (e) {
  coreIo.setFailed(`Unexpected error: ${errorMessage(e)}`)
}
// Do not wait for idle keep-alive sockets; the exit code is already set.
process.exit()
