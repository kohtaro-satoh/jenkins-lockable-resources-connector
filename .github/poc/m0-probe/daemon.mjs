// Stand-in for the heartbeat daemon: one line per second into ticks.
import fs from 'node:fs'
import path from 'node:path'
import { probeDir } from './lib.mjs'

const file = path.join(probeDir(), 'ticks')
process.on('SIGHUP', () => undefined)
process.on('SIGTERM', () => {
  fs.appendFileSync(
    path.join(probeDir(), 'daemon-exit'),
    `SIGTERM at ${Date.now()}\n`
  )
  process.exit(0)
})
setInterval(() => {
  try {
    fs.appendFileSync(file, `${Date.now()}\n`)
  } catch {
    // RUNNER_TEMP removed: the job is over.
    process.exit(0)
  }
}, 1000)
