// Shared helpers for the M0 probe. Plain Node, no dependencies.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const probeDir = () =>
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'm0-probe')

export function writeCommandFile(variable, name, value) {
  const file = process.env[variable]
  if (!file) return
  const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`
  fs.appendFileSync(
    file,
    `${name}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`
  )
}

export function record(name, data) {
  fs.mkdirSync(probeDir(), { recursive: true })
  fs.writeFileSync(
    path.join(probeDir(), `${name}.json`),
    JSON.stringify(data, null, 2)
  )
}

export function read(name) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(probeDir(), `${name}.json`), 'utf8')
    )
  } catch {
    return undefined
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

export function ticks() {
  try {
    return fs
      .readFileSync(path.join(probeDir(), 'ticks'), 'utf8')
      .split('\n')
      .filter(Boolean).length
  } catch {
    return 0
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
