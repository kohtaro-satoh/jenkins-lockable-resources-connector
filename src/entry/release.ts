import { fileURLToPath } from 'node:url'
import { RemoteApiClient } from '../client.js'
import { coreIo } from '../core-io.js'
import { processDaemonControl } from '../daemon.js'
import { timingFromEnv } from '../defaults.js'
import { runRelease } from '../release.js'
import { systemClock } from '../session.js'
import { errorMessage } from '../util.js'

const daemonScript = fileURLToPath(new URL('./heartbeat.js', import.meta.url))

try {
  await runRelease({
    io: coreIo,
    env: process.env,
    clock: systemClock,
    timing: timingFromEnv(process.env),
    createApi: (connection) => new RemoteApiClient(connection),
    daemon: processDaemonControl(daemonScript, process.env, systemClock)
  })
} catch (e) {
  coreIo.setFailed(`Unexpected error: ${errorMessage(e)}`)
}
process.exit()
