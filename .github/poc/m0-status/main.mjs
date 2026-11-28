// Item 7: remember what the input says while main runs, for post to compare.
import fs from 'node:fs'
import os from 'node:os'

const status = process.env['INPUT_JOB-STATUS'] ?? '(unset)'
if (process.env.GITHUB_STATE) {
  fs.appendFileSync(process.env.GITHUB_STATE, `jobStatus=${status}${os.EOL}`)
}
console.log(`job-status in main: ${status}`)
