import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RemoteApiError } from '../../src/client.js'
import { type MainDeps, runMain } from '../../src/main.js'
import { readLockState, stateFilePath } from '../../src/state.js'
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
  label: 'plc',
  variable: 'PLC'
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jlrc-main-'))
})
afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

function setup(inputs: Record<string, string> = INPUTS) {
  const io = new FakeIo(inputs)
  const api = new ScriptedApi()
  api.statusSteps = [
    {
      lockId: 'lock-1',
      state: 'ACQUIRED',
      resources: ['plc-1'],
      lockEnvVars: { PLC: 'plc-1', PLC0: 'plc-1', PLC0_PROP_PASSWORD: 's3cret' }
    }
  ]
  const daemon = new FakeDaemon()
  const controller = new AbortController()
  const deps: MainDeps = {
    io,
    env: { RUNNER_TEMP: temp, GITHUB_ACTION: 'lock' },
    clock: new FakeClock(),
    timing: FAST_TIMING,
    signal: controller.signal,
    createApi: () => api,
    daemon
  }
  const stateFile = stateFilePath(
    path.join(temp, 'lockable-resources'),
    'lock-1'
  )
  return { io, api, daemon, controller, deps, stateFile }
}

describe('runMain', () => {
  it('hands the lock over: env vars, outputs, state, daemon', async () => {
    const t = setup()
    await runMain(t.deps)

    expect(t.io.failed).toBeUndefined()
    expect(t.io.secrets).toContain('t0ken')
    expect(t.io.env).toEqual({
      PLC: 'plc-1',
      PLC0: 'plc-1',
      PLC0_PROP_PASSWORD: 's3cret'
    })
    expect(t.io.outputs).toEqual({
      'lock-id': 'lock-1',
      state: 'ACQUIRED',
      acquired: 'true',
      resources: '["plc-1"]',
      'env-vars': JSON.stringify({
        PLC: 'plc-1',
        PLC0: 'plc-1',
        PLC0_PROP_PASSWORD: 's3cret'
      })
    })
    expect(t.io.state).toEqual({
      'lock-id': 'lock-1',
      'state-file': t.stateFile
    })
    expect(readLockState(t.stateFile)).toMatchObject({
      lockId: 'lock-1',
      stage: 'held',
      actionId: 'lock',
      resources: ['plc-1'],
      daemon: { pid: 4242 }
    })
    expect(t.daemon.started).toEqual([
      {
        lockId: 'lock-1',
        connection: {
          serverUrl: 'https://jenkins.example.com',
          username: 'robot',
          token: 't0ken'
        }
      }
    ])
    expect(t.daemon.stopped).toEqual([])
    expect(t.api.count('release')).toBe(0)
  })

  it('never prints property values', async () => {
    const t = setup()
    await runMain(t.deps)
    const printed = t.io.logs.map((l) => l.message).join('\n')
    expect(printed).not.toContain('s3cret')
    expect(printed).toContain('PLC0_PROP_PASSWORD')
  })

  it('reports SKIPPED as a success with acquired=false', async () => {
    const t = setup({ ...INPUTS, 'skip-if-locked': 'true' })
    t.api.statusSteps = [{ lockId: 'lock-1', state: 'SKIPPED' }]
    await runMain(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.io.outputs).toMatchObject({
      state: 'SKIPPED',
      acquired: 'false',
      resources: '[]',
      'env-vars': '{}'
    })
    expect(readLockState(t.stateFile)?.stage).toBe('skipped')
    expect(t.daemon.started).toEqual([])
    expect(t.io.env).toEqual({})
  })

  it('stops on invalid inputs before contacting the server', async () => {
    const t = setup({ ...INPUTS, quantity: 'two' })
    await runMain(t.deps)
    expect(t.io.failed).toMatch(/'quantity' must be an integer/)
    expect(t.api.calls).toEqual([])
  })

  it('fails on an empty token (fork pull requests)', async () => {
    const t = setup({ ...INPUTS, token: '' })
    await runMain(t.deps)
    expect(t.io.failed).toMatch(/'token' is empty/)
    expect(t.api.calls).toEqual([])
  })

  it('withdraws the request when acquiring fails after enqueue', async () => {
    const t = setup()
    t.api.statusSteps = [
      { lockId: 'lock-1', state: 'FAILED', errorCode: 'LOCK_WAIT_TIMEOUT' }
    ]
    await runMain(t.deps)
    expect(t.io.failed).toMatch(/LOCK_WAIT_TIMEOUT/)
    expect(t.api.count('release')).toBe(1)
    expect(readLockState(t.stateFile)?.stage).toBe('withdrawn')
  })

  it('withdraws the request when cancelled while queued', async () => {
    const t = setup()
    t.api.statusSteps = [
      (n) => {
        if (n === 1) t.controller.abort()
        return { lockId: 'lock-1', state: 'QUEUED' }
      }
    ]
    await runMain(t.deps)
    expect(t.io.failed).toBe(
      'Cancelled while waiting for lock lock-1; the request was withdrawn'
    )
    expect(t.api.count('release')).toBe(1)
    expect(readLockState(t.stateFile)?.stage).toBe('withdrawn')
  })

  it('leaves the withdrawal to post when it fails', async () => {
    const t = setup()
    t.api.statusSteps = [{ lockId: 'lock-1', state: 'FAILED' }]
    t.api.releaseSteps = [new RemoteApiError('down', -1)]
    await runMain(t.deps)
    expect(readLockState(t.stateFile)?.stage).toBe('enqueued')
    expect(t.io.messages('warning')).toEqual([
      expect.stringMatching(/the post step will try again/)
    ])
  })

  it('rolls back when the daemon does not start: stop it, withdraw, no env vars', async () => {
    const t = setup()
    t.daemon.readyError = new Error('daemon exited before its first heartbeat')
    await runMain(t.deps)
    expect(t.io.failed).toMatch(/daemon exited/)
    expect(t.daemon.stopped).toHaveLength(1)
    expect(t.api.count('release')).toBe(1)
    expect(t.io.env).toEqual({})
    expect(t.io.outputs.acquired).toBeUndefined()
    expect(readLockState(t.stateFile)?.stage).toBe('withdrawn')
  })

  it('rolls back when the first heartbeat answers 410', async () => {
    const t = setup()
    t.daemon.status = {
      ...t.daemon.status,
      okCount: 0,
      terminal: 'LOCK_NOT_FOUND'
    }
    await runMain(t.deps)
    expect(t.io.failed).toMatch(/rejected the first heartbeat.*LOCK_NOT_FOUND/)
    expect(t.api.count('release')).toBe(1)
  })

  it('rolls back when cancelled during the hand-over', async () => {
    const t = setup()
    t.daemon.waitReady = async () => {
      t.controller.abort()
      return t.daemon.status
    }
    await runMain(t.deps)
    expect(t.io.failed).toMatch(/Cancelled.*withdrawn/)
    expect(t.daemon.stopped).toHaveLength(1)
    expect(t.api.count('release')).toBe(1)
    expect(t.io.env).toEqual({})
  })

  it('warns when the first heartbeat failed but keeps the lock', async () => {
    const t = setup()
    t.daemon.status = {
      ...t.daemon.status,
      okCount: 0,
      failCount: 1,
      lastError: 'timed out'
    }
    await runMain(t.deps)
    expect(t.io.failed).toBeUndefined()
    expect(t.io.messages('warning')).toEqual([
      expect.stringMatching(/first heartbeat .* failed \(timed out\)/)
    ])
  })

  it('warns about http:// URLs', async () => {
    const t = setup({ ...INPUTS, 'server-url': 'http://jenkins.lab' })
    await runMain(t.deps)
    expect(t.io.messages('warning')).toEqual([
      expect.stringMatching(/clear text/)
    ])
  })
})
