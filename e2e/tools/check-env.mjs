#!/usr/bin/env node
// E02 (docs/PLAN.md §10.3): the lock step's environment variables reached this
// later step, match its env-vars output, and follow the Jenkins lock() naming:
// POOL, POOL0/POOL1, POOL0_<property>, POOL_<property> (first resource).
// Prints names only, never values.
//
// Environment: ENV_VARS (the lock step's env-vars output), KEY (ubuntu|windows|macos).
const want = JSON.parse(process.env.ENV_VARS ?? '{}')
const key = process.env.KEY
const osIndex = ['ubuntu', 'windows', 'macos'].indexOf(key)
const problems = []

for (const [name, value] of Object.entries(want)) {
  if (process.env[name] !== value)
    problems.push(`${name} is missing or differs from the env-vars output`)
}

const pool = [`e2e-pool-${key}-1`, `e2e-pool-${key}-2`]
const names = (process.env.POOL ?? '').split(',').sort()
if (JSON.stringify(names) !== JSON.stringify(pool))
  problems.push('POOL does not list both pool resources')
const ip = (name) => `203.0.113.${osIndex * 10 + Number(name.slice(-1))}`
for (const i of [0, 1]) {
  const name = process.env[`POOL${i}`]
  if (!pool.includes(name)) {
    problems.push(`POOL${i} is not a pool resource`)
    continue
  }
  if (process.env[`POOL${i}_IP`] !== ip(name))
    problems.push(`POOL${i}_IP is not the IP of POOL${i}`)
  if (process.env[`POOL${i}_ROLE`] !== `e2e-role-${key}-${name.slice(-1)}`)
    problems.push(`POOL${i}_ROLE is wrong`)
}
if (process.env.POOL_IP !== process.env.POOL0_IP)
  problems.push("POOL_IP is not the first resource's IP")

if (problems.length > 0) {
  for (const p of problems) console.log(`::error::${p}`)
  process.exit(1)
}
console.log(`ok: ${Object.keys(want).sort().join(', ')}`)
