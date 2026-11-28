// Item 7: the same input, read again by the post step. A mismatch is an error
// annotation, not a failure: a failing post would change what the post steps
// after this one see (which only fail-post wants).
import fs from 'node:fs'

const tag = process.env.INPUT_TAG
const expected = process.env.INPUT_EXPECT
const inMain = process.env.STATE_jobStatus ?? '(unset)'
const inPost = process.env['INPUT_JOB-STATUS'] ?? '(unset)'
const verdict = inPost === expected ? 'OK' : 'NG'
const line = `M0-STATUS tag=${tag} platform=${process.platform} main=${inMain} post=${inPost} expect=${expected} ${verdict}`
console.log(line)
if (verdict !== 'OK') console.log(`::error::${line}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### M0 item 7: ${tag} (${process.platform})\n\n` +
      `| main | post | expected | verdict |\n| --- | --- | --- | --- |\n` +
      `| ${inMain} | ${inPost} | ${expected} | ${verdict} |\n\n`
  )
}
if (process.env['INPUT_FAIL-POST'] === 'true') {
  console.log('failing this post step on purpose')
  process.exit(1)
}
