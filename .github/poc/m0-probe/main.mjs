// M0 items 1-4: start a detached daemon like the real action does, save
// state, and (mode wait / stubborn) wait to be cancelled.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeDir, record, sleep, writeCommandFile } from './lib.mjs'

const mode = process.env.INPUT_MODE || 'ready'
fs.mkdirSync(probeDir(), { recursive: true })

const daemon = spawn(
  process.execPath,
  [path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.mjs')],
  { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }
)
daemon.unref()

record('main', {
  mode,
  node: process.version,
  platform: process.platform,
  pid: process.pid,
  ppid: process.ppid,
  daemonPid: daemon.pid,
  githubAction: process.env.GITHUB_ACTION,
  runnerTrackingId: process.env.RUNNER_TRACKING_ID ?? null,
  startedAt: Date.now()
})
// Item 2: post must be able to read this, even when main is cancelled.
writeCommandFile(
  'GITHUB_STATE',
  'probe',
  JSON.stringify({ daemonPid: daemon.pid, savedAt: Date.now() })
)
console.log(
  `node ${process.version} on ${process.platform}; daemon pid ${daemon.pid}; RUNNER_TRACKING_ID=${process.env.RUNNER_TRACKING_ID ?? '(unset)'}`
)

if (mode === 'ready') process.exit(0)

// Item 3: how much time do we get after the cancel signal?
const signals = []
const onSignal = (signal) => {
  signals.push({ signal, at: Date.now() })
  record('signals', signals)
  console.log(`received ${signal}`)
  if (mode === 'wait' && signals.length === 1) {
    // Pretend to withdraw: count how long we survive, in 500 ms steps.
    ;(async () => {
      for (let i = 1; i <= 60; i++) {
        await sleep(500)
        record('grace', { afterFirstSignalMs: i * 500 })
      }
      process.exit(1)
    })()
  }
}
// In mode stubborn the handler only records: main never exits on its own,
// so the runner has to kill it.
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)
console.log(`waiting to be cancelled (mode ${mode})`)
await sleep(15 * 60 * 1000)
