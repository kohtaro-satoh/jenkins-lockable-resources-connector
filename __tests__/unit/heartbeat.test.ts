import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RemoteApiError } from '../../src/client.js'
import { daemonEnvironment, isAlive } from '../../src/daemon.js'
import { type DaemonConfig, runHeartbeatDaemon } from '../../src/heartbeat.js'
import { systemClock } from '../../src/session.js'
import {
  type LockState,
  daemonFiles,
  readDaemonStatus,
  writeLockState
} from '../../src/state.js'

let dir: string
let cfg: DaemonConfig

const state = (stage: LockState['stage']): LockState => ({
  version: 1,
  lockId: 'lock-1',
  stage,
  serverUrl: 'https://jenkins.example.com',
  description: "resource 'r1'",
  enqueuedAt: 0
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrrc-hb-'))
  cfg = {
    lockId: 'lock-1',
    stateFile: path.join(dir, 'lock-1.json'),
    ...daemonFiles(dir, 'lock-1'),
    intervalMs: 40,
    tickMs: 10,
    missingStateGraceMs: 50
  }
  writeLockState(cfg.stateFile, state('held'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function countingApi(
  answer: (n: number, signal?: AbortSignal) => Promise<void>
) {
  const calls: number[] = []
  return {
    calls,
    api: {
      heartbeat: async (_lockId: string, signal?: AbortSignal) => {
        calls.push(Date.now())
        return answer(calls.length, signal)
      }
    }
  }
}

describe('runHeartbeatDaemon', () => {
  it('sends the first heartbeat at once and keeps going until asked to stop', async () => {
    const { api, calls } = countingApi(async () => undefined)
    const run = runHeartbeatDaemon(cfg, { api, clock: systemClock, pid: 1 })
    await wait(15)
    expect(calls.length).toBe(1)
    await wait(150)
    fs.writeFileSync(cfg.stopFile, 'released')
    const status = await run
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(status.okCount).toBe(calls.length)
    expect(status.stopReason).toBe('stop requested (released)')
    expect(readDaemonStatus(cfg.statusFile)?.stoppedAt).toBeDefined()

    const after = calls.length
    await wait(100)
    expect(calls.length).toBe(after)
  })

  it('records failures and carries on', async () => {
    const { api } = countingApi(async (n) => {
      if (n <= 2) throw new RemoteApiError('HTTP 500', 500)
    })
    const run = runHeartbeatDaemon(cfg, { api, clock: systemClock, pid: 1 })
    await wait(200)
    fs.writeFileSync(cfg.stopFile, '')
    const status = await run
    expect(status.failCount).toBe(2)
    expect(status.okCount).toBeGreaterThan(0)
    expect(status.lastError).toBe('HTTP 500')
    expect(status.warnings).toEqual([
      'Heartbeat for lock lock-1 failed: HTTP 500'
    ])
    expect(fs.readFileSync(cfg.logFile, 'utf8')).toMatch(/recovered after 2/)
  })

  it.each(['LOCK_STALE', 'LOCK_NOT_FOUND'])(
    'stops sending after HTTP 410 %s',
    async (code) => {
      const { api, calls } = countingApi(async (n) => {
        if (n === 2) throw new RemoteApiError('gone', 410, code)
      })
      const status = await runHeartbeatDaemon(cfg, {
        api,
        clock: systemClock,
        pid: 1
      })
      expect(calls.length).toBe(2)
      expect(status.terminal).toBe(code)
      expect(status.stopReason).toBe(`server answered ${code}`)
    }
  )

  it('stops when the lock is no longer active', async () => {
    const { api } = countingApi(async () => undefined)
    const run = runHeartbeatDaemon(cfg, { api, clock: systemClock, pid: 1 })
    await wait(30)
    writeLockState(cfg.stateFile, state('released'))
    expect((await run).stopReason).toBe('lock is released')
  })

  it('stops when the state file disappears (end of job)', async () => {
    const { api } = countingApi(async () => undefined)
    const run = runHeartbeatDaemon(cfg, { api, clock: systemClock, pid: 1 })
    await wait(30)
    fs.rmSync(cfg.stateFile)
    expect((await run).stopReason).toBe('state file removed (job finished)')
  })

  it('does not recreate the directory once the temp dir is gone', async () => {
    const { api } = countingApi(async () => undefined)
    const run = runHeartbeatDaemon(cfg, { api, clock: systemClock, pid: 1 })
    await wait(30)
    fs.rmSync(dir, { recursive: true, force: true })
    expect((await run).stopReason).toBe('state file removed (job finished)')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('stops on a signal', async () => {
    const controller = new AbortController()
    const { api } = countingApi(async () => undefined)
    const run = runHeartbeatDaemon(cfg, {
      api,
      clock: systemClock,
      pid: 1,
      signal: controller.signal
    })
    await wait(30)
    controller.abort()
    expect((await run).stopReason).toBe('signal')
  })

  it('cuts short a heartbeat in flight when asked to stop', async () => {
    const { api } = countingApi(
      (_n, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const started = Date.now()
    const run = runHeartbeatDaemon(cfg, { api, clock: systemClock, pid: 1 })
    await wait(20)
    fs.writeFileSync(cfg.stopFile, 'post')
    const status = await run
    expect(Date.now() - started).toBeLessThan(1000)
    expect(status.failCount).toBe(0)
    expect(status.stopReason).toBe('stop requested (post)')
  })
})

describe('daemon process helpers', () => {
  it('passes the configuration in the environment, without INPUT_* / STATE_*', () => {
    const env = daemonEnvironment(
      {
        PATH: '/bin',
        RUNNER_TRACKING_ID: 'github_123',
        INPUT_TOKEN: 'secret',
        'INPUT_SERVER-URL': 'https://x',
        STATE_lock: 'x'
      },
      {
        lockId: 'lock-1',
        connection: {
          serverUrl: 'https://jenkins.example.com',
          username: 'robot',
          token: 'secret'
        },
        stateFile: '/tmp/s.json',
        dir: '/tmp'
      },
      daemonFiles('/tmp', 'lock-1')
    )
    expect(env.PATH).toBe('/bin')
    // The runner finds orphan processes to clean up by this variable.
    expect(env.RUNNER_TRACKING_ID).toBe('github_123')
    expect(env.INPUT_TOKEN).toBeUndefined()
    expect(env['INPUT_SERVER-URL']).toBeUndefined()
    expect(env.STATE_lock).toBeUndefined()
    expect(env.LRRC_DAEMON_TOKEN).toBe('secret')
    expect(env.LRRC_DAEMON_LOCK_ID).toBe('lock-1')
  })

  it('tells live processes from gone ones', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(2 ** 22 + 12345)).toBe(false)
  })
})
