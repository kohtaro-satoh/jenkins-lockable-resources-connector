import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RemoteApiError } from '../../src/client.js'
import { type PostDeps, decidePostAction, runPost } from '../../src/post.js'
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
  resource: 'printer'
}
const DAEMON = {
  pid: 4242,
  statusFile: '/x/status.json',
  logFile: '/x/log',
  stopFile: '/x/stop'
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrrc-post-'))
})
afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

function setup(
  stage: LockState['stage'] | undefined,
  options: { saved?: boolean; extra?: Partial<LockState> } = {}
) {
  const io = new FakeIo(INPUTS)
  const api = new ScriptedApi()
  const daemon = new FakeDaemon()
  const clock = new FakeClock()
  let created = 0
  const stateFile = stateFilePath(
    path.join(temp, 'lockable-resources'),
    'lock-1'
  )
  if (stage) {
    writeLockState(stateFile, {
      version: 1,
      lockId: 'lock-1',
      stage,
      actionId: 'lock',
      serverUrl: 'https://jenkins.example.com',
      description: "resource 'printer'",
      enqueuedAt: clock.now() - 60_000,
      ...(stage === 'enqueued'
        ? {}
        : { acquiredAt: clock.now() - 30_000, resources: ['printer'] }),
      daemon: DAEMON,
      ...options.extra
    })
    if (options.saved !== false) io.state['state-file'] = stateFile
  }
  const deps: PostDeps = {
    io,
    env: { RUNNER_TEMP: temp, GITHUB_ACTION: 'lock' },
    clock,
    timing: FAST_TIMING,
    createApi: () => {
      created++
      return api
    },
    daemon
  }
  return { io, api, daemon, clock, stateFile, deps, created: () => created }
}

describe('decidePostAction', () => {
  it.each([
    ['enqueued', 'withdraw'],
    ['held', 'stop-and-fail'],
    ['stale', 'stop-only'],
    ['skipped', 'none'],
    ['released', 'none'],
    ['withdrawn', 'none']
  ] as const)('%s -> %s', (stage, action) => {
    expect(decidePostAction(stage)).toBe(action)
  })
})

describe('runPost', () => {
  it('held: stops the daemon, sends NO release, fails the step', async () => {
    const t = setup('held')
    t.daemon.status = { ...t.daemon.status, lastOkAt: t.clock.now() - 5_000 }
    await runPost(t.deps)

    expect(t.api.count('release')).toBe(0)
    expect(t.api.calls).toEqual([])
    expect(t.created()).toBe(0)
    expect(t.daemon.stopped).toEqual([{ info: DAEMON, reason: 'post (held)' }])
    const eta = new Date(t.clock.now() - 5_000 + 60_000).toISOString()
    expect(t.io.failed).toBe(
      'Lock lock-1 (printer) was not released: the release step did not run ' +
        '(a previous step failed, the job was cancelled, or the release step is missing). ' +
        `Heartbeats have stopped; the server marks the lease STALE at about ${eta}. ` +
        'The server keeps the resources until an administrator checks them and releases the lease in Jenkins.'
    )
    expect(t.io.summaries.join('')).toMatch(
      /\| `lock-1` \| printer \| Not released: STALE, an administrator must release it \| 30s \| 1 sent \/ 0 failed \|/
    )
    expect(readLockState(t.stateFile)?.stage).toBe('held')
  })

  it('held after a failed release step: says so', async () => {
    const t = setup('held', {
      extra: { releaseError: 'Release of lock lock-1 failed: down' }
    })
    await runPost(t.deps)
    expect(t.api.calls).toEqual([])
    expect(t.io.failed).toMatch(
      /not released: the release step failed: Release of lock lock-1 failed: down/
    )
  })

  it('held, already STALE according to the daemon', async () => {
    const t = setup('held')
    t.daemon.status = { ...t.daemon.status, terminal: 'LOCK_STALE' }
    await runPost(t.deps)
    expect(t.api.calls).toEqual([])
    expect(t.io.failed).toMatch(/already marked the lease STALE/)
  })

  it('enqueued: withdraws the request', async () => {
    const t = setup('enqueued')
    await runPost(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.api.count('release')).toBe(1)
    expect(t.io.secrets).toContain('t0ken')
    expect(t.daemon.stopped).toHaveLength(1)
    expect(readLockState(t.stateFile)?.stage).toBe('withdrawn')
  })

  it('enqueued: a failed withdrawal is a warning, not a failure', async () => {
    const t = setup('enqueued')
    t.api.releaseSteps = [new RemoteApiError('down', -1)]
    await runPost(t.deps)
    expect(t.api.count('release')).toBe(20)
    expect(t.io.failed).toBeUndefined()
    expect(t.io.messages('warning').at(-1)).toMatch(
      /Could not withdraw lock request lock-1.*stays queued/
    )
    expect(readLockState(t.stateFile)?.stage).toBe('enqueued')
  })

  it('stale: makes sure the daemon stopped, nothing else', async () => {
    const t = setup('stale')
    await runPost(t.deps)
    expect(t.api.calls).toEqual([])
    expect(t.daemon.stopped).toHaveLength(1)
    expect(t.io.failed).toBeUndefined()
  })

  it.each(['released', 'skipped', 'withdrawn'] as const)(
    '%s: nothing to do',
    async (stage) => {
      const t = setup(stage)
      await runPost(t.deps)
      expect(t.api.calls).toEqual([])
      expect(t.daemon.stopped).toEqual([])
      expect(t.io.failed).toBeUndefined()
      expect(t.io.summaries).toHaveLength(1)
    }
  )

  it('finds the lock by step id when the saved state is missing', async () => {
    const t = setup('held', { saved: false })
    await runPost(t.deps)
    expect(t.daemon.stopped).toHaveLength(1)
    expect(t.io.failed).toMatch(/was not released/)
  })

  it('ignores lock files of other steps', async () => {
    const t = setup('held', { saved: false, extra: { actionId: 'other-step' } })
    await runPost(t.deps)
    expect(t.daemon.stopped).toEqual([])
    expect(t.io.failed).toBeUndefined()
  })

  it('does nothing when no request was made', async () => {
    const t = setup(undefined)
    await runPost(t.deps)
    expect(t.api.calls).toEqual([])
    expect(t.io.failed).toBeUndefined()
    expect(t.io.summaries).toEqual([])
  })
})
