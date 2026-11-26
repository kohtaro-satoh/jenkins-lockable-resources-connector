#!/usr/bin/env node
// Helper for .github/workflows/e2e.yml (docs/testing.md §4): talks to the E2E
// Jenkins as e2e-robot (remote API, read-only use here) and as e2e-ops (the
// e2e-admin and e2e-holder jobs). Plain Node, no dependencies.
//
//   e2e.mjs preflight <1560|latest>            check the plugin version, reset, print since=<epoch ms>
//   e2e.mjs admin <op> [arg]                   run e2e-admin, print its E2E| lines
//   e2e.mjs holder <resource> <seconds> <held|waiting>
//                                              start e2e-holder, wait until it holds / waits, print number=<n>
//   e2e.mjs holder-done <number>               wait for that e2e-holder build to succeed
//   e2e.mjs wait-queue <resource> <n>          wait until n requests wait for the resource
//   e2e.mjs resource <name> <FREE|LOCKED>      wait until the resource is in that state
//   e2e.mjs lock <lockId> <STATE[,STATE...]>   wait until the lease is in one of the states (GONE = 404)
//
// Environment: E2E_SERVER_URL, E2E_ROBOT_TOKEN, E2E_OPS_TOKEN, E2E_TIMEOUT (s, default 120).
import fs from 'node:fs'

const base = (process.env.E2E_SERVER_URL ?? '').replace(/\/+$/, '')
const timeoutMs = Number(process.env.E2E_TIMEOUT ?? 120) * 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function auth(user, tokenEnv) {
  const token = process.env[tokenEnv]
  if (!token) throw new Error(`${tokenEnv} is not set`)
  return 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64')
}
const robot = () => auth('e2e-robot', 'E2E_ROBOT_TOKEN')
const ops = () => auth('e2e-ops', 'E2E_OPS_TOKEN')

async function http(
  method,
  url,
  authorization,
  { ok = [200], text = false } = {}
) {
  const res = await fetch(url, {
    method,
    headers: { authorization, accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000)
  })
  if (!ok.includes(res.status)) {
    throw new Error(
      `${method} ${url.replace(base, '')}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
    )
  }
  return {
    status: res.status,
    headers: res.headers,
    body: text
      ? await res.text()
      : res.status === 204
        ? null
        : await res.json().catch(() => null)
  }
}

async function until(what, probe) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      const result = await probe()
      if (result.done) return result.value
      last = result.value
    } catch (e) {
      last = e.message
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what} (last: ${last})`)
    await sleep(1000)
  }
}

/** Starts a build of an e2e job as e2e-ops; resolves with its number. */
async function startBuild(job, params) {
  const query = new URLSearchParams({
    ...params,
    NONCE: `${Date.now()}-${Math.random()}`
  })
  const { headers } = await http(
    'POST',
    `${base}/job/${job}/buildWithParameters?${query}`,
    ops(),
    { ok: [201] }
  )
  const item = headers.get('location')
  if (!item) throw new Error('no queue item in the response')
  return await until(`${job} to start`, async () => {
    const { body } = await http(
      'GET',
      `${item.replace(/\/?$/, '/')}api/json`,
      ops()
    )
    if (body.cancelled) throw new Error(`${job} was cancelled in the queue`)
    return body.executable
      ? { done: true, value: body.executable.number }
      : { done: false, value: 'queued' }
  })
}

const console_ = async (job, n) =>
  (
    await http('GET', `${base}/job/${job}/${n}/consoleText`, ops(), {
      text: true
    })
  ).body

async function finished(job, n) {
  return await until(`${job} #${n} to finish`, async () => {
    const { body } = await http(
      'GET',
      `${base}/job/${job}/${n}/api/json?tree=building,result`,
      ops()
    )
    return body.building
      ? { done: false, value: 'building' }
      : { done: true, value: body.result }
  })
}

/** Runs e2e-admin; returns its E2E| lines without the prefix. */
async function admin(op, arg = '') {
  const n = await startBuild('e2e-admin', { OP: op, ARG: arg })
  const result = await finished('e2e-admin', n)
  const text = await console_('e2e-admin', n)
  if (result !== 'SUCCESS')
    throw new Error(
      `e2e-admin OP=${op} ARG=${arg}: ${result}\n${text.slice(-1500)}`
    )
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('E2E|'))
    .map((line) => line.slice(4))
}
const field = (lines, key) =>
  lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1)

function output(name, value) {
  console.log(`${name}=${value}`)
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

const commands = {
  async preflight(plugin) {
    const since = Date.now()
    const version = field(await admin('version'), 'version')
    const is1560 = version?.startsWith('1560.')
    if ((plugin === '1560') !== is1560) {
      throw new Error(
        `the server runs lockable-resources ${version}, not ${plugin}; run switch.sh ${plugin} on the server`
      )
    }
    console.log(`lockable-resources ${version}`)
    for (const line of await admin('reset')) console.log(line)
    output('since', since)
    output('version', version)
  },

  async admin(op, arg) {
    for (const line of await admin(op, arg)) console.log(line)
  },

  async holder(resource, seconds, wait) {
    const n = await startBuild('e2e-holder', {
      RESOURCE: resource,
      SECONDS: seconds
    })
    const marker =
      wait === 'held' ? `E2E|held=${resource}` : `E2E|waiting=${resource}`
    await until(`e2e-holder #${n} to log ${marker}`, async () => ({
      done: (await console_('e2e-holder', n)).includes(marker),
      value: 'not yet'
    }))
    output('number', n)
  },

  async 'holder-done'(n) {
    const result = await finished('e2e-holder', n)
    if (result !== 'SUCCESS')
      throw new Error(
        `e2e-holder #${n}: ${result}\n${(await console_('e2e-holder', n)).slice(-1500)}`
      )
    console.log(`e2e-holder #${n}: ${result}`)
  },

  async 'wait-queue'(resource, n) {
    const count = await until(
      `${n} requests waiting for ${resource}`,
      async () => {
        const queued = Number(field(await admin('queue', resource), 'queue'))
        return { done: queued >= Number(n), value: queued }
      }
    )
    console.log(`${resource}: ${count} waiting`)
  },

  async resource(name, want) {
    const state = await until(`${name} to be ${want}`, async () => {
      const { body } = await http(
        'GET',
        `${base}/lockable-resources/remote/v1/resources/`,
        robot()
      )
      const r = body.resources.find((x) => x.name === name)
      if (!r) throw new Error(`${name} is not exposed`)
      const state =
        r.state === 'LOCKED' || r.state === 'RESERVED' ? r.state : 'FREE'
      return { done: state === want, value: state }
    })
    console.log(`${name}: ${state}`)
  },

  async lock(lockId, states) {
    const wanted = states.split(',')
    const seen = await until(`lock ${lockId} to be ${states}`, async () => {
      const { status, body } = await http(
        'GET',
        `${base}/lockable-resources/remote/v1/acquire/${encodeURIComponent(lockId)}/`,
        robot(),
        { ok: [200, 404] }
      )
      const state = status === 404 ? 'GONE' : body.state
      const label = body?.errorCode ? `${state}/${body.errorCode}` : state
      return {
        done: wanted.includes(state) || wanted.includes(label),
        value: label
      }
    })
    console.log(`lock ${lockId}: ${seen}`)
  }
}

const [command, ...args] = process.argv.slice(2)
if (!base) {
  console.error('E2E_SERVER_URL is not set')
  process.exit(2)
}
if (!commands[command]) {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
try {
  await commands[command](...args)
} catch (e) {
  console.error(`::error::${e.message}`)
  process.exit(1)
}
