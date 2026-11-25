import { afterEach, describe, expect, it } from '@jest/globals'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { RemoteApiClient, RemoteApiError } from '../../src/client.js'
import { FakeServer } from '../support/fake-server.js'

let server: FakeServer | undefined
let raw: http.Server | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
  if (raw) {
    raw.closeAllConnections()
    await new Promise((resolve) => raw!.close(resolve))
    raw = undefined
  }
})

async function rawServer(
  handler: http.RequestListener
): Promise<{ serverUrl: string; username: string; token: string }> {
  raw = http.createServer(handler)
  await new Promise<void>((resolve) => raw!.listen(0, '127.0.0.1', resolve))
  const { port } = raw.address() as AddressInfo
  return { serverUrl: `http://127.0.0.1:${port}`, username: 'u', token: 't' }
}

async function caught(promise: Promise<unknown>): Promise<RemoteApiError> {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RemoteApiError)
  return error as RemoteApiError
}

describe('RemoteApiClient', () => {
  it('acquires under the context path with Basic authentication', async () => {
    server = await FakeServer.start()
    const client = new RemoteApiClient(server.connection())
    const lockId = await client.acquire({
      lockRequest: { resource: 'printer' },
      heartbeatIntervalSeconds: 10,
      clientId: 'github-actions:octo/repo'
    })
    expect(lockId).toBe('lock-1')
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/jenkins/lockable-resources/remote/v1/acquire/',
      status: 202,
      authorized: true
    })
    expect(server.acquireBodies[0]).toEqual({
      lockRequest: { resource: 'printer' },
      heartbeatIntervalSeconds: 10,
      clientId: 'github-actions:octo/repo'
    })
  })

  it('reads the status: resources, lockEnvVars, STALE', async () => {
    server = await FakeServer.start({
      outcome: {
        state: 'ACQUIRED',
        resources: ['plc-1', 'plc-2'],
        lockEnvVars: { PLC: 'plc-1,plc-2', PLC0: 'plc-1' }
      }
    })
    const client = new RemoteApiClient(server.connection())
    const lockId = await client.acquire({ lockRequest: {} })
    await expect(client.status(lockId)).resolves.toEqual({
      lockId,
      state: 'ACQUIRED',
      resources: ['plc-1', 'plc-2'],
      lockEnvVars: { PLC: 'plc-1,plc-2', PLC0: 'plc-1' }
    })
    server.markStale(lockId)
    await expect(client.status(lockId)).resolves.toMatchObject({
      state: 'STALE'
    })
  })

  it('maps an unknown state to UNKNOWN', async () => {
    server = await FakeServer.start({ outcome: { state: 'BOGUS' } })
    const client = new RemoteApiClient(server.connection())
    const lockId = await client.acquire({ lockRequest: {} })
    await expect(client.status(lockId)).resolves.toMatchObject({
      state: 'UNKNOWN'
    })
  })

  it('URL-encodes the lockId', async () => {
    const paths: string[] = []
    const connection = await rawServer((req, res) => {
      paths.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ state: 'QUEUED' }))
    })
    const status = await new RemoteApiClient(connection).status('a/b c')
    // No lockId in the answer: the requested one is kept, like the Jenkins client.
    expect(status.lockId).toBe('a/b c')
    expect(paths).toEqual(['/lockable-resources/remote/v1/acquire/a%2Fb%20c/'])
  })

  it('passes errorCode and message through, with a hint for unknown labels', async () => {
    server = await FakeServer.start({
      acquireFailures: [
        {
          status: 404,
          errorCode: 'UNKNOWN_LABEL',
          message: 'No lockable resource matches the request'
        }
      ]
    })
    const error = await caught(
      new RemoteApiClient(server.connection()).acquire({ lockRequest: {} })
    )
    expect(error.status).toBe(404)
    expect(error.errorCode).toBe('UNKNOWN_LABEL')
    expect(error.transient).toBe(false)
    expect(error.message).toBe(
      'Remote API request failed: POST /acquire/ returned HTTP 404 ' +
        '(errorCode=UNKNOWN_LABEL, message=No lockable resource matches the request). ' +
        'Verify that the resource or label exists and is exposed by exposeLabel.'
    )
  })

  it('explains 401', async () => {
    server = await FakeServer.start()
    const error = await caught(
      new RemoteApiClient({ ...server.connection(), token: 'wrong' }).acquire({
        lockRequest: {}
      })
    )
    expect(error.status).toBe(401)
    expect(error.message).toMatch(/API token, not a password/)
  })

  it('explains a 403 HTML page (permission or crumb)', async () => {
    const connection = await rawServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/html' })
      res.end('<html>No valid crumb was included in the request</html>')
    })
    const error = await caught(
      new RemoteApiClient(connection).acquire({ lockRequest: {} })
    )
    expect(error.message).toMatch(/RemoteUse permission.*CSRF crumb/)
  })

  it('treats 503 as transient', async () => {
    server = await FakeServer.start({
      acquireFailures: [{ status: 503, errorCode: 'ACQUIRES_PAUSED' }]
    })
    const error = await caught(
      new RemoteApiClient(server.connection()).acquire({ lockRequest: {} })
    )
    expect(error.status).toBe(503)
    expect(error.transient).toBe(true)
  })

  it('reports a refused connection as status -1', async () => {
    const connection = await rawServer(() => undefined)
    raw!.close()
    raw = undefined
    const error = await caught(new RemoteApiClient(connection).heartbeat('x'))
    expect(error.status).toBe(-1)
    expect(error.transient).toBe(true)
    expect(error.message).toMatch(
      /communication failure: POST \/lease\/x\/heartbeat/
    )
  })

  it('times out', async () => {
    const connection = await rawServer(() => undefined) // never answers
    const error = await caught(
      new RemoteApiClient(connection, { timeoutMs: 200 }).release('x')
    )
    expect(error.status).toBe(-1)
    expect(error.message).toMatch(/timed out after 200 ms/)
  })

  it('does not follow redirects', async () => {
    const connection = await rawServer((_req, res) => {
      res.writeHead(302, { Location: 'https://jenkins.example.com/login' })
      res.end()
    })
    const error = await caught(
      new RemoteApiClient(connection).acquire({ lockRequest: {} })
    )
    expect(error.status).toBe(302)
    expect(error.message).toMatch(
      /redirected to https:\/\/jenkins.example.com\/login; set server-url to the final URL/
    )
  })

  it('rejects an acquire answer without lockId', async () => {
    const connection = await rawServer((_req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end('{"state":"QUEUED"}')
    })
    const error = await caught(
      new RemoteApiClient(connection).acquire({ lockRequest: {} })
    )
    expect(error.errorCode).toBe('INVALID_RESPONSE')
  })

  it('rejects a non-JSON success answer', async () => {
    const connection = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>login</html>')
    })
    const error = await caught(new RemoteApiClient(connection).status('x'))
    expect(error.errorCode).toBe('INVALID_JSON')
  })

  it('reports heartbeat 410 LOCK_STALE', async () => {
    server = await FakeServer.start()
    const client = new RemoteApiClient(server.connection())
    const lockId = await client.acquire({ lockRequest: {} })
    await client.status(lockId)
    await client.heartbeat(lockId)
    server.markStale(lockId)
    const error = await caught(client.heartbeat(lockId))
    expect(error.status).toBe(410)
    expect(error.errorCode).toBe('LOCK_STALE')
  })
})
