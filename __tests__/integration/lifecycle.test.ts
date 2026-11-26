/**
 * main -> heartbeat daemon -> release -> post as real processes, against the
 * fake server (docs/testing.md §2). Runs the bundles in dist/, so `npm run package`
 * first. The client's intervals are scaled by 0.1 (poll 300 ms, heartbeat 1 s).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals'
import { FakeServer } from '../support/fake-server.js'
import { FakeRunner, isAlive, sleep, waitFor } from '../support/runner.js'

jest.setTimeout(60_000)

let server: FakeServer
let runner: FakeRunner

beforeEach(async () => {
  server = await FakeServer.start({
    outcome: {
      state: 'ACQUIRED',
      resources: ['printer'],
      lockEnvVars: { PLC: 'printer', PLC0: 'printer', PLC0_PROP_IP: '10.0.0.7' }
    }
  })
  runner = FakeRunner.create()
})

afterEach(async () => {
  try {
    await runner.cleanup()
  } finally {
    // Always: a server left listening keeps Jest from exiting.
    await server.stop()
  }
})

function connection(): Record<string, string> {
  return {
    'server-url': server.url,
    username: server.options.username,
    token: server.options.token
  }
}
const lockInputs = (extra: Record<string, string> = {}) => ({
  ...connection(),
  resource: 'printer',
  variable: 'PLC',
  ...extra
})
const releaseInputs = (lockId: string) => ({
  ...connection(),
  'lock-id': lockId
})

describe('lock -> later steps -> release -> post', () => {
  it('holds the lock with heartbeats and releases it exactly once', async () => {
    const main = await runner.run('main', lockInputs())
    expect(main.code).toBe(0)
    expect(main.outputs).toMatchObject({
      'lock-id': 'lock-1',
      state: 'ACQUIRED',
      acquired: 'true',
      resources: '["printer"]'
    })
    expect(main.env).toEqual({
      PLC: 'printer',
      PLC0: 'printer',
      PLC0_PROP_IP: '10.0.0.7'
    })
    // ::add-mask:: registers the secret with the runner and is not displayed.
    const visible = main.output
      .split('\n')
      .filter((line) => !line.startsWith('::add-mask::'))
      .join('\n')
    expect(main.output).toContain(`::add-mask::${server.options.token}`)
    expect(visible).not.toContain(server.options.token)
    expect(visible).not.toContain('10.0.0.7')

    const [pid] = runner.daemonPids()
    expect(pid).toBeDefined()
    // The daemon outlives the main step and keeps the lease alive.
    expect(isAlive(pid!)).toBe(true)
    await sleep(2_500)
    expect(server.heartbeats('lock-1')).toBeGreaterThanOrEqual(3)
    expect(server.releases()).toBe(0)

    const release = await runner.run('release', releaseInputs('lock-1'), {
      action: 'release'
    })
    expect(release.code).toBe(0)
    expect(release.output).toMatch(/Released lock lock-1 \(printer\)/)
    // (The fake server is http://, so the clear-text warning is expected.)
    expect(release.output).not.toMatch(/::warning::.*heartbeat/i)
    expect(server.releases('lock-1')).toBe(1)
    await waitFor(() => !isAlive(pid!), 5_000, 'daemon to exit')

    const heartbeats = server.heartbeats('lock-1')
    await sleep(1_500)
    expect(server.heartbeats('lock-1')).toBe(heartbeats)

    const post = await runner.run('post', lockInputs(), { state: main.state })
    expect(post.code).toBe(0)
    expect(server.releases('lock-1')).toBe(1)
    expect(post.summary).toMatch(/\| `lock-1` \| printer \| Released \|/)
    expect(runner.readLockFile('lock-1').stage).toBe('released')
  })

  it('a failed job: post stops the heartbeats and sends no release', async () => {
    const main = await runner.run('main', lockInputs())
    expect(main.code).toBe(0)
    const [pid] = runner.daemonPids()
    await sleep(1_500)
    expect(server.heartbeats('lock-1')).toBeGreaterThanOrEqual(2)

    // A later step failed, so the release step did not run.
    const post = await runner.run('post', lockInputs(), { state: main.state })
    expect(post.code).toBe(1)
    expect(post.output).toMatch(
      /::error::Lock lock-1 \(printer\) was not released: the release step did not run/
    )
    expect(server.releases()).toBe(0)
    await waitFor(() => !isAlive(pid!), 5_000, 'daemon to exit')

    const heartbeats = server.heartbeats('lock-1')
    await sleep(1_500)
    expect(server.heartbeats('lock-1')).toBe(heartbeats)
    expect(server.record('lock-1').state).toBe('ACQUIRED') // -> STALE on a real server
  })

  it('post finds the lock even when the saved state did not reach it', async () => {
    const main = await runner.run('main', lockInputs())
    expect(main.code).toBe(0)
    const post = await runner.run('post', lockInputs(), { state: {} })
    expect(post.code).toBe(1)
    expect(post.output).toMatch(/saved state is missing/)
    expect(server.releases()).toBe(0)
  })
})

describe('skip-if-locked', () => {
  it('succeeds with acquired=false; release and post do nothing', async () => {
    server.options.outcome = { state: 'SKIPPED' }
    const main = await runner.run(
      'main',
      lockInputs({ 'skip-if-locked': 'true' })
    )
    expect(main.code).toBe(0)
    expect(main.outputs).toMatchObject({ state: 'SKIPPED', acquired: 'false' })
    expect(main.env).toEqual({})
    expect(runner.daemonPids()).toEqual([])

    const release = await runner.run('release', releaseInputs('lock-1'))
    expect(release.code).toBe(0)
    const post = await runner.run('post', lockInputs(), { state: main.state })
    expect(post.code).toBe(0)
    expect(server.releases()).toBe(0)
  })
})

describe('before the hand-over', () => {
  it('a cancelled wait leaves nothing queued on the server', async () => {
    server.options.queuedPolls = Number.POSITIVE_INFINITY
    const step = runner.start('main', lockInputs())
    await waitFor(
      () => server.count('GET', /\/acquire\/lock-1\/$/) >= 2,
      10_000,
      'polling'
    )
    step.child.kill('SIGTERM')
    const main = await step.done
    expect(main.code).not.toBe(0)

    const post = await runner.run('post', lockInputs(), { state: main.state })
    expect(post.code).toBe(0)
    if (process.platform !== 'win32') {
      // main withdrew the request itself on SIGTERM.
      expect(main.output).toMatch(/the request was withdrawn/)
      expect(server.releases('lock-1')).toBe(1)
    }
    // On Windows the process is killed outright and post withdraws instead.
    expect(server.releases('lock-1')).toBeGreaterThanOrEqual(1)
    expect(server.record('lock-1')).toMatchObject({
      state: 'FAILED',
      errorCode: 'RELEASED'
    })
  })

  it('a refused request fails at once and leaves nothing behind', async () => {
    server.options.acquireFailures = [
      {
        status: 404,
        errorCode: 'UNKNOWN_RESOURCE',
        message: 'No lockable resource matches the request'
      }
    ]
    const main = await runner.run('main', lockInputs())
    expect(main.code).toBe(1)
    expect(main.output).toMatch(/UNKNOWN_RESOURCE.*exposeLabel/)
    expect(runner.daemonPids()).toEqual([])
    const post = await runner.run('post', lockInputs(), { state: main.state })
    expect(post.code).toBe(0)
  })

  it('waits out a paused server (503)', async () => {
    server.options.acquireFailures = [
      { status: 503, errorCode: 'ACQUIRES_PAUSED' },
      { status: 503, errorCode: 'ACQUIRES_PAUSED' }
    ]
    const main = await runner.run('main', lockInputs())
    expect(main.code).toBe(0)
    expect(main.output).toMatch(/not accepting new acquire requests/)
    expect(server.count('POST', /\/acquire\/$/)).toBe(3)
  })
})

describe('a STALE lease (docs/design.md §4.1)', () => {
  it('the release step refuses to release it and fails', async () => {
    const main = await runner.run('main', lockInputs())
    expect(main.code).toBe(0)
    server.markStale('lock-1')

    const release = await runner.run('release', releaseInputs('lock-1'))
    expect(release.code).toBe(1)
    expect(release.output).toMatch(/is STALE on the server/)
    expect(server.releases()).toBe(0)

    const post = await runner.run('post', lockInputs(), { state: main.state })
    expect(post.code).toBe(0)
    expect(server.releases()).toBe(0)
    expect(server.record('lock-1').state).toBe('STALE')
  })
})
