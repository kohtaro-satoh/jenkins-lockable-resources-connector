import { describe, expect, it } from '@jest/globals'
import { type AcquireStatus, RemoteApiError } from '../../src/client.js'
import {
  AcquireCancelledError,
  AcquireError,
  type AcquireOptions,
  acquireLock
} from '../../src/session.js'
import {
  FAST_TIMING,
  FakeClock,
  FakeIo,
  ScriptedApi
} from '../support/fakes.js'

const queued: AcquireStatus = { lockId: 'lock-1', state: 'QUEUED' }
const acquired: AcquireStatus = {
  lockId: 'lock-1',
  state: 'ACQUIRED',
  resources: ['printer'],
  lockEnvVars: { PLC: 'printer', PLC0: 'printer' }
}
const http = (status: number, errorCode?: string) =>
  new RemoteApiError(`HTTP ${status}`, status, errorCode)
const network = () => new RemoteApiError('connection refused', -1)

function setup(overrides: Partial<AcquireOptions> = {}) {
  const api = new ScriptedApi()
  const clock = new FakeClock()
  const io = new FakeIo()
  const enqueued: string[] = []
  const options = (): AcquireOptions => ({
    api,
    body: { lockRequest: { resource: 'printer' } },
    description: "resource 'printer'",
    deadline: 0,
    clock,
    log: io,
    timing: FAST_TIMING,
    onEnqueued: (id) => enqueued.push(id),
    ...overrides
  })
  return { api, clock, io, enqueued, options }
}

describe('acquireLock', () => {
  it('waits while QUEUED and returns ACQUIRED with resources and env vars', async () => {
    const t = setup()
    t.api.statusSteps = [queued, queued, acquired]
    const outcome = await acquireLock(t.options())
    expect(outcome).toEqual({
      state: 'ACQUIRED',
      lockId: 'lock-1',
      resources: ['printer'],
      lockEnvVars: { PLC: 'printer', PLC0: 'printer' }
    })
    // First poll at once, then every 3 s.
    expect(t.clock.sleeps).toEqual([3000, 3000])
    expect(t.api.count('status')).toBe(3)
  })

  it('reports the lockId before the first poll', async () => {
    const t = setup()
    t.api.statusSteps = [
      () => {
        expect(t.enqueued).toEqual(['lock-1'])
        return acquired
      }
    ]
    await acquireLock(t.options())
    expect(t.enqueued).toEqual(['lock-1'])
  })

  it('returns SKIPPED', async () => {
    const t = setup()
    t.api.statusSteps = [{ lockId: 'lock-1', state: 'SKIPPED' }]
    await expect(acquireLock(t.options())).resolves.toEqual({
      state: 'SKIPPED',
      lockId: 'lock-1'
    })
  })

  it.each(['FAILED', 'EXPIRED', 'CANCELLED', 'UNKNOWN', 'STALE'] as const)(
    'fails on %s',
    async (state) => {
      const t = setup()
      t.api.statusSteps = [queued, { lockId: 'lock-1', state }]
      const error = await acquireLock(t.options()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AcquireError)
      expect((error as AcquireError).lockId).toBe('lock-1')
      expect((error as Error).message).toContain(`state=${state}`)
    }
  )

  it('names LOCK_WAIT_TIMEOUT', async () => {
    const t = setup()
    t.api.statusSteps = [
      { lockId: 'lock-1', state: 'FAILED', errorCode: 'LOCK_WAIT_TIMEOUT' }
    ]
    await expect(acquireLock(t.options())).rejects.toThrow(
      /errorCode=LOCK_WAIT_TIMEOUT.*timeout-for-allocate-resource expired/
    )
  })

  describe('enqueue', () => {
    it('retries 503 every 3 s until the server accepts', async () => {
      const t = setup()
      t.api.acquireSteps = [http(503, 'ACQUIRES_PAUSED'), http(503), 'lock-1']
      await acquireLock(t.options())
      expect(t.api.count('acquire')).toBe(3)
      expect(t.clock.sleeps).toEqual([3000, 3000])
      expect(t.io.messages('info')).toEqual([
        expect.stringMatching(/not accepting new acquire requests/)
      ])
    })

    it('gives up on 503 at the allocation deadline', async () => {
      const t = setup()
      t.api.acquireSteps = [http(503, 'ACQUIRES_PAUSED')]
      const error = await acquireLock({
        ...t.options(),
        deadline: t.clock.now() + 10_000
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AcquireError)
      expect((error as Error).message).toMatch(/ACQUIRES_PAUSED/)
      expect((error as AcquireError).lockId).toBeUndefined()
      // 0, 3, 6, 9 s: still before the deadline; 12 s: past it.
      expect(t.api.count('acquire')).toBe(5)
      expect(t.enqueued).toEqual([])
    })

    it('keeps retrying 503 without a deadline', async () => {
      const t = setup()
      t.api.acquireSteps = [
        (n) => (n < 50 ? Promise.reject(http(503)) : 'lock-1')
      ]
      await acquireLock(t.options())
      expect(t.api.count('acquire')).toBe(51)
    })

    it.each([
      ['400', http(400, 'INVALID_REQUEST')],
      ['403', http(403)],
      ['404', http(404, 'UNKNOWN_LABEL')],
      ['500', http(500)],
      ['network failure', network()]
    ])('fails closed at once on %s', async (_name, error) => {
      const t = setup()
      t.api.acquireSteps = [error]
      await expect(acquireLock(t.options())).rejects.toThrow(
        /Lock request failed/
      )
      expect(t.api.count('acquire')).toBe(1)
      expect(t.api.count('status')).toBe(0)
    })
  })

  describe('polling failures', () => {
    it.each([404, 410])('fails at once on %d', async (status) => {
      const t = setup()
      t.api.statusSteps = [queued, http(status, 'LOCK_NOT_FOUND')]
      const error = await acquireLock(t.options()).catch((e: unknown) => e)
      expect((error as Error).message).toMatch(/no record of lock lock-1/)
      expect((error as AcquireError).lockId).toBe('lock-1')
      expect(t.api.count('status')).toBe(2)
    })

    it('carries on after 19 consecutive failures', async () => {
      const t = setup()
      t.api.statusSteps = [
        (n) => (n < 19 ? Promise.reject(network()) : acquired)
      ]
      await expect(acquireLock(t.options())).resolves.toMatchObject({
        state: 'ACQUIRED'
      })
      expect(t.io.messages('warning')).toHaveLength(19)
    })

    it('fails after 20 consecutive failures', async () => {
      const t = setup()
      t.api.statusSteps = [network()]
      await expect(acquireLock(t.options())).rejects.toThrow(
        /failed 20 times in a row/
      )
      expect(t.api.count('status')).toBe(20)
    })

    it('counts other HTTP errors as transient, like the Jenkins client', async () => {
      const t = setup()
      t.api.statusSteps = [http(500), http(403), acquired]
      await expect(acquireLock(t.options())).resolves.toMatchObject({
        state: 'ACQUIRED'
      })
    })

    it('resets the count after a successful poll', async () => {
      const t = setup()
      const steps: Array<AcquireStatus | Error> = []
      for (let i = 0; i < 15; i++) steps.push(network())
      steps.push(queued)
      for (let i = 0; i < 15; i++) steps.push(network())
      steps.push(acquired)
      t.api.statusSteps = steps
      await expect(acquireLock(t.options())).resolves.toMatchObject({
        state: 'ACQUIRED'
      })
    })
  })

  describe('cancellation', () => {
    it('stops while QUEUED with the lockId', async () => {
      const controller = new AbortController()
      const t = setup({ signal: controller.signal })
      t.api.statusSteps = [
        (n) => {
          if (n === 2) controller.abort()
          return queued
        }
      ]
      const error = await acquireLock(t.options()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AcquireCancelledError)
      expect((error as AcquireError).lockId).toBe('lock-1')
    })

    it('stops before the request is accepted, without a lockId', async () => {
      const controller = new AbortController()
      controller.abort()
      const t = setup({ signal: controller.signal })
      const error = await acquireLock(t.options()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AcquireCancelledError)
      expect((error as AcquireError).lockId).toBeUndefined()
      expect(t.api.count('acquire')).toBe(0)
    })

    it('stops while retrying a paused server', async () => {
      const controller = new AbortController()
      const t = setup({ signal: controller.signal })
      t.api.acquireSteps = [
        (n) => {
          if (n === 1) controller.abort()
          return Promise.reject(http(503))
        }
      ]
      await expect(acquireLock(t.options())).rejects.toBeInstanceOf(
        AcquireCancelledError
      )
    })

    it('lets the acquire request finish, so the request can be withdrawn', async () => {
      const controller = new AbortController()
      const t = setup({ signal: controller.signal })
      t.api.acquireSteps = [
        () => {
          // Cancelled while the server is accepting the request.
          controller.abort()
          return 'lock-1'
        }
      ]
      const error = await acquireLock(t.options()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AcquireCancelledError)
      expect((error as AcquireError).lockId).toBe('lock-1')
      expect(t.enqueued).toEqual(['lock-1'])
      expect(t.api.count('status')).toBe(0)
    })
  })

  it('keeps the accepted lockId even if the status names another', async () => {
    const t = setup()
    t.api.statusSteps = [{ ...acquired, lockId: 'something-else' }]
    await expect(acquireLock(t.options())).resolves.toMatchObject({
      lockId: 'lock-1'
    })
  })

  it('prints the elapsed time every 60 s while waiting, not every poll', async () => {
    const t = setup()
    t.api.statusSteps = [(n) => (n < 45 ? queued : acquired)]
    await acquireLock(t.options())
    expect(t.io.messages('info')).toEqual([
      expect.stringMatching(/Still waiting for resource 'printer' \(1m 0s/),
      expect.stringMatching(/Still waiting for resource 'printer' \(2m 0s/)
    ])
  })
})
