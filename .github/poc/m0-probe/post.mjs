// Items 2, 3 and 6: post ran (also after a cancel), could read main's saved
// state, and what main saw of the cancellation. The daemon is left running
// on purpose: the "Complete job" log should show the runner terminating it
// (item 1, second half).
import fs from 'node:fs'
import { isAlive, read, ticks } from './lib.mjs'

const saved = process.env.STATE_probe
const main = read('main')
const signals = read('signals')
const grace = read('grace')
const result = {
  postRan: true,
  savedStateReadable: Boolean(saved),
  savedState: saved ?? null,
  githubActionInMain: main?.githubAction ?? null,
  githubActionInPost: process.env.GITHUB_ACTION ?? null,
  runnerTrackingIdInMain: main?.runnerTrackingId ?? null,
  daemonAliveInPost: main ? isAlive(main.daemonPid) : null,
  ticks: ticks(),
  mainMode: main?.mode ?? null,
  signalsReceivedByMain: signals ?? [],
  mainSurvivedAfterFirstSignalMs: grace?.afterFirstSignalMs ?? null
}
console.log(JSON.stringify(result, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = Object.entries(result)
    .map(([k, v]) => `| ${k} | \`${JSON.stringify(v)}\` |`)
    .join('\n')
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### M0 probe post (${process.platform}, mode ${main?.mode ?? '?'})\n\n| item | value |\n| --- | --- |\n${rows}\n\n`
  )
}
if (!saved) console.log('::warning::post could not read the state main saved')
