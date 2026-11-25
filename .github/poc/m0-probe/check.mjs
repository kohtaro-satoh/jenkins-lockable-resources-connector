// Item 1 (and 5 in a container job): run as a later step. The daemon started
// by the probe's main must still be alive and still ticking.
import fs from 'node:fs'
import { isAlive, read, sleep, ticks } from './lib.mjs'

const main = read('main')
if (!main) {
  console.log('::error::probe main did not record anything')
  process.exit(1)
}
const before = ticks()
await sleep(5000)
const after = ticks()
const alive = isAlive(main.daemonPid)
const result = {
  daemonPid: main.daemonPid,
  alive,
  ticksBefore: before,
  ticksAfter: after
}
console.log(JSON.stringify(result))
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### M0 item 1: daemon survives later steps (${process.platform})\n\n` +
      `| daemon pid | alive | ticks 5 s apart |\n| --- | --- | --- |\n` +
      `| ${main.daemonPid} | ${alive} | ${before} -> ${after} |\n\n`
  )
}
if (!alive || after <= before) {
  console.log('::error::the detached daemon did not survive into a later step')
  process.exit(1)
}
