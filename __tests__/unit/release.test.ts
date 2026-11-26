import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RemoteApiError } from '../../src/client.js'
import { type ReleaseDeps, runRelease } from '../../src/release.js'
import {
  type LockState,
  readLockState,
  stateFilePath,
  writeLockState
} from '../../src/state.js'
import {
  FAST_TIMING,
  FakeClock,
  FakeDaemon,
  FakeIo,
  ScriptedApi
} from '../support/fakes.js'

let temp: string
const INPUTS = {
  'server-url': 'https://jenkins.example.com',
  username: 'robot',
  token: 't0ken',
  'lock-id': 'lock-1'
}
const DAEMON = {
  pid: 4242,
  statusFile: '/x/status.json',
  logFile: '/x/log',
  stopFile: '/x/stop'
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrrc-release-'))
})
afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

function setup(stage?: LockState['stage']) {
  const io = new FakeIo(INPUTS)
  const api = new ScriptedApi()
  api.statusSteps = [{ lockId: 'lock-1', state: 'ACQUIRED' }]
  const daemon = new FakeDaemon()
  const clock = new FakeClock()
  const events: string[] = []
  const origRelease = api.release.bind(api)
  api.release = async (id) => {
    events.push('release')
    return origRelease(id)
  }
  const origStop = daemon.stop.bind(daemon)
  daemon.stop = async (info, reason) => {
    events.push(`stop:${reason}`)
    return origStop(info, reason)
  }
  const stateFile = stateFilePath(
    path.join(temp, 'lockable-resources'),
    'lock-1'
  )
  if (stage) {
    writeLockState(stateFile, {
      version: 1,
      lockId: 'lock-1',
      stage,
      serverUrl: 'https://jenkins.example.com',
      description: "resource 'printer'",
      enqueuedAt: clock.now() - 120_000,
      acquiredAt: clock.now() - 90_000,
      resources: ['printer'],
      daemon: DAEMON
    })
  }
  const deps: ReleaseDeps = {
    io,
    env: { RUNNER_TEMP: temp },
    clock,
    timing: FAST_TIMING,
    createApi: () => api,
    daemon
  }
  return { io, api, daemon, clock, events, stateFile, deps }
}

describe('runRelease', () => {
  it('releases, then stops the daemon (in that order)', async () => {
    const t = setup('held')
    await runRelease(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.events).toEqual(['release', 'stop:released'])
    expect(t.api.count('status')).toBe(1)
    expect(t.api.count('release')).toBe(1)
    expect(readLockState(t.stateFile)?.stage).toBe('released')
    expect(t.io.messages('info')).toEqual(
      expect.arrayContaining([
        'Released lock lock-1 (printer) after holding it for 1m 30s.',
        'Heartbeats for lock lock-1: 1 sent, 0 failed.'
      ])
    )
  })

  it.each(['skipped', 'released', 'withdrawn'] as const)(
    'does nothing for a %s lock',
    async (stage) => {
      const t = setup(stage)
      await runRelease(t.deps)
      expect(t.io.failed).toBeUndefined()
      expect(t.api.calls).toEqual([])
      expect(t.daemon.stopped).toEqual([])
    }
  )

  it('sends the release only when this job has no state for the lock', async () => {
    const t = setup()
    await runRelease(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.api.count('release')).toBe(1)
    expect(t.daemon.stopped).toEqual([])
  })

  it('does not release a STALE lease (docs/design.md §4.1)', async () => {
    const t = setup('held')
    t.api.statusSteps = [{ lockId: 'lock-1', state: 'STALE' }]
    await runRelease(t.deps)
    expect(t.api.count('release')).toBe(0)
    expect(t.daemon.stopped).toHaveLength(1)
    expect(t.io.failed).toMatch(
      /lock-1 \(printer\) is STALE on the server.*not released; an administrator must/
    )
    expect(readLockState(t.stateFile)?.stage).toBe('stale')
  })

  it('fails again for a lock it already found STALE', async () => {
    const t = setup('stale')
    await runRelease(t.deps)
    expect(t.api.calls).toEqual([])
    expect(t.io.failed).toMatch(/is STALE/)
  })

  it('accepts a lease already released on the server', async () => {
    const t = setup('held')
    t.api.statusSteps = [
      { lockId: 'lock-1', state: 'FAILED', errorCode: 'RELEASED' }
    ]
    await runRelease(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.api.count('release')).toBe(0)
    expect(t.daemon.stopped).toHaveLength(1)
    expect(t.io.messages('warning')).toEqual([
      expect.stringMatching(/already released on the server/)
    ])
    expect(readLockState(t.stateFile)?.stage).toBe('released')
  })

  it('withdraws a request that is still QUEUED', async () => {
    const t = setup('enqueued')
    t.api.statusSteps = [{ lockId: 'lock-1', state: 'QUEUED' }]
    await runRelease(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.api.count('release')).toBe(1)
  })

  it('sends the release anyway when the server has no record (404)', async () => {
    const t = setup('held')
    t.api.statusSteps = [new RemoteApiError('gone', 404, 'LOCK_NOT_FOUND')]
    await runRelease(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.api.count('release')).toBe(1)
    expect(t.io.messages('warning')).toEqual([
      expect.stringMatching(/no record of lock lock-1/)
    ])
  })

  it('retries transient release failures, heartbeating meanwhile', async () => {
    const t = setup('held')
    const down = new RemoteApiError('down', -1)
    t.api.releaseSteps = [
      down,
      new RemoteApiError('busy', 503),
      down,
      undefined
    ]
    await runRelease(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.api.count('release')).toBe(4)
    expect(t.clock.sleeps).toEqual([3000, 3000, 3000])
    // The daemon is stopped only after the release went through.
    expect(t.events).toEqual([
      'release',
      'release',
      'release',
      'release',
      'stop:released'
    ])
  })

  it('gives up after 20 attempts: stops the daemon and fails (-> STALE)', async () => {
    const t = setup('held')
    t.api.releaseSteps = [new RemoteApiError('down', -1)]
    await runRelease(t.deps)
    expect(t.api.count('release')).toBe(20)
    expect(t.events.at(-1)).toBe('stop:release failed')
    expect(t.io.failed).toMatch(
      /Release of lock lock-1 \(printer\) failed.*STALE/
    )
    expect(readLockState(t.stateFile)).toMatchObject({
      stage: 'held',
      releaseError: expect.stringMatching(/Release of lock lock-1/)
    })
  })

  it('does not retry a permanent refusal (403)', async () => {
    const t = setup('held')
    t.api.releaseSteps = [new RemoteApiError('forbidden', 403)]
    await runRelease(t.deps)
    expect(t.api.count('release')).toBe(1)
    expect(t.io.failed).toMatch(/forbidden/)
  })

  it('fails without releasing when the lease cannot be checked', async () => {
    const t = setup('held')
    t.api.statusSteps = [new RemoteApiError('down', -1)]
    await runRelease(t.deps)
    expect(t.api.count('status')).toBe(20)
    expect(t.api.count('release')).toBe(0)
    expect(t.daemon.stopped).toHaveLength(1)
    expect(t.io.failed).toMatch(/Could not check lock lock-1/)
  })

  it('warns about failed heartbeats', async () => {
    const t = setup('held')
    t.daemon.status = {
      ...t.daemon.status,
      attempts: 9,
      okCount: 7,
      failCount: 2,
      lastError: 'timed out'
    }
    await runRelease(t.deps)
    expect(t.io.messages('warning')).toEqual([
      '2 of 9 heartbeats for lock lock-1 failed; last error: timed out'
    ])
  })

  it('does not warn about a 410 that followed its own release', async () => {
    const t = setup('held')
    t.daemon.status = {
      ...t.daemon.status,
      terminal: 'LOCK_NOT_FOUND',
      terminalAt: t.clock.now()
    }
    await runRelease(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.io.messages('warning')).toEqual([])
  })

  it('warns about a 410 that came before the release', async () => {
    const t = setup('held')
    t.daemon.status = {
      ...t.daemon.status,
      terminal: 'LOCK_NOT_FOUND',
      terminalAt: t.clock.now() - 1
    }
    await runRelease(t.deps)
    expect(t.io.messages('warning')).toEqual([
      expect.stringMatching(/answered LOCK_NOT_FOUND to a heartbeat/)
    ])
  })

  it('needs lock-id', async () => {
    const t = setup('held')
    t.io.inputs['lock-id'] = ''
    await runRelease(t.deps)
    expect(t.io.failed).toMatch(/'lock-id' is empty/)
    expect(t.api.calls).toEqual([])
  })
})
