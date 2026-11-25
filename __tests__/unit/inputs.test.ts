import { describe, expect, it } from '@jest/globals'
import {
  InputError,
  defaultClientId,
  defaultReason,
  readConnection,
  readLockInputs,
  readReleaseInputs
} from '../../src/inputs.js'

const CONNECTION = {
  'server-url': 'https://jenkins.example.com/ci/',
  username: 'robot',
  token: 't0ken'
}
const getter =
  (inputs: Record<string, string>) =>
  (name: string): string =>
    inputs[name] ?? ''

function lockInputs(
  inputs: Record<string, string>,
  env: NodeJS.ProcessEnv = {}
) {
  return readLockInputs(getter({ ...CONNECTION, ...inputs }), env)
}

describe('type and format errors', () => {
  it.each<[string, Record<string, string>, RegExp]>([
    [
      'quantity not a number',
      { quantity: 'abc' },
      /'quantity' must be an integer/
    ],
    ['quantity decimal', { quantity: '1.5' }, /'quantity' must be an integer/],
    ['quantity exponent', { quantity: '1e3' }, /'quantity' must be an integer/],
    [
      'quantity beyond int',
      { quantity: '2147483648' },
      /'quantity' is out of range/
    ],
    [
      'priority not a number',
      { priority: 'high' },
      /'priority' must be an integer/
    ],
    [
      'timeout not a number',
      { 'timeout-for-allocate-resource': '5m' },
      /'timeout-for-allocate-resource' must be an integer/
    ],
    [
      'boolean yes',
      { 'skip-if-locked': 'yes' },
      /'skip-if-locked' must be true or false/
    ],
    [
      'boolean 1',
      { 'inverse-precedence': '1' },
      /'inverse-precedence' must be true or false/
    ],
    [
      'timeout-unit unknown',
      { 'timeout-unit': 'WEEKS' },
      /'timeout-unit' must be one of NANOSECONDS, .*DAYS/
    ],
    [
      'strategy unknown',
      { 'resource-select-strategy': 'fastest' },
      /must be one of SEQUENTIAL, RANDOM/
    ],
    [
      'variable GITHUB_',
      { variable: 'GITHUB_TOKEN' },
      /must not start with GITHUB_ or RUNNER_/
    ],
    [
      'variable runner_ (any case)',
      { variable: 'runner_x' },
      /must not start with GITHUB_ or RUNNER_/
    ],
    [
      'extra invalid YAML',
      { extra: '- resource: [unclosed' },
      /'extra' is not valid YAML or JSON/
    ],
    ['extra not a list', { extra: 'resource: r4' }, /'extra' must be a list/],
    [
      'extra item not a mapping',
      { extra: '- r4' },
      /extra\[0\] must be a mapping/
    ],
    [
      'extra unknown key',
      { extra: '- labels: gpu' },
      /extra\[0\] has an unknown key 'labels'/
    ],
    [
      'extra reason is not a key',
      { extra: '- resource: r4\n- label: gpu\n  reason: x' },
      /extra\[1\] has an unknown key 'reason'/
    ],
    [
      'extra resource read as a number',
      { extra: '- resource: 007' },
      /extra\[0\]\.resource must be a string/
    ],
    [
      'extra label read as a boolean',
      { extra: '- label: true' },
      /extra\[0\]\.label must be a string/
    ],
    [
      'extra quantity not a number',
      { extra: '- label: gpu\n  quantity: many' },
      /extra\[0\]\.quantity must be an integer/
    ],
    [
      'extra quantity decimal',
      { extra: '- label: gpu\n  quantity: 1.5' },
      /extra\[0\]\.quantity must be an integer/
    ]
  ])('%s', (_name, inputs, message) => {
    expect(() => lockInputs(inputs)).toThrow(InputError)
    expect(() => lockInputs(inputs)).toThrow(message)
  })

  it('accepts a quoted number as a resource name', () => {
    expect(lockInputs({ extra: '- resource: "007"' }).request.extra).toEqual([
      { resource: '007', quantity: 0 }
    ])
  })

  it('accepts a leading + on integers', () => {
    expect(lockInputs({ quantity: '+2' }).request.quantity).toBe(2)
  })

  it('reads -0 as 0', () => {
    expect(Object.is(lockInputs({ priority: '-0' }).request.priority, 0)).toBe(
      true
    )
  })
})

describe('connection', () => {
  it('strips the trailing slash and keeps the context path', () => {
    expect(readConnection(getter(CONNECTION), {}).connection).toEqual({
      serverUrl: 'https://jenkins.example.com/ci',
      username: 'robot',
      token: 't0ken'
    })
  })

  it('falls back to the environment for server-url and username', () => {
    const { connection } = readConnection(getter({ token: 't0ken' }), {
      LOCKABLE_RESOURCES_SERVER_URL: 'https://env.example.com',
      LOCKABLE_RESOURCES_USERNAME: 'env-user'
    })
    expect(connection.serverUrl).toBe('https://env.example.com')
    expect(connection.username).toBe('env-user')
  })

  it('prefers the inputs over the environment', () => {
    const { connection } = readConnection(getter(CONNECTION), {
      LOCKABLE_RESOURCES_SERVER_URL: 'https://env.example.com',
      LOCKABLE_RESOURCES_USERNAME: 'env-user'
    })
    expect(connection.serverUrl).toBe('https://jenkins.example.com/ci')
    expect(connection.username).toBe('robot')
  })

  it('never reads the token from the environment', () => {
    expect(() =>
      readConnection(getter({ ...CONNECTION, token: '' }), {
        LOCKABLE_RESOURCES_TOKEN: 'from-env',
        INPUT_TOKEN: 'from-env'
      })
    ).toThrow(/Input 'token' is empty.*forks/s)
  })

  it.each<[string, Record<string, string>, RegExp]>([
    [
      'no server-url anywhere',
      { 'server-url': '' },
      /'server-url' is empty and LOCKABLE_RESOURCES_SERVER_URL is not set/
    ],
    [
      'no username anywhere',
      { username: '' },
      /'username' is empty and LOCKABLE_RESOURCES_USERNAME is not set/
    ],
    ['not a URL', { 'server-url': 'jenkins.example.com' }, /not a valid URL/],
    [
      'wrong scheme',
      { 'server-url': 'ftp://jenkins.example.com' },
      /must start with https:\/\/ or http:\/\//
    ],
    [
      'credentials in the URL',
      { 'server-url': 'https://u:p@jenkins.example.com' },
      /must not contain credentials/
    ],
    [
      'query in the URL',
      { 'server-url': 'https://jenkins.example.com/?x=1' },
      /must not contain a query/
    ]
  ])('%s', (_name, inputs, message) => {
    expect(() =>
      readConnection(getter({ ...CONNECTION, ...inputs }), {})
    ).toThrow(message)
  })

  it('warns about http:// but accepts it', () => {
    const result = readConnection(
      getter({ ...CONNECTION, 'server-url': 'http://jenkins.lab:8080' }),
      {}
    )
    expect(result.connection.serverUrl).toBe('http://jenkins.lab:8080')
    expect(result.warnings).toEqual([expect.stringMatching(/clear text/)])
  })

  it('does not warn about https://', () => {
    expect(readConnection(getter(CONNECTION), {}).warnings).toEqual([])
  })
})

describe('defaults', () => {
  it('fills in reason and client-id from the run', () => {
    const env = {
      GITHUB_WORKFLOW: 'flash',
      GITHUB_RUN_NUMBER: '42',
      GITHUB_JOB: 'build',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'octo/repo',
      GITHUB_RUN_ID: '9001'
    }
    const inputs = lockInputs({ resource: 'r1' }, env)
    expect(inputs.request.reason).toBe(
      'flash #42 (build) https://github.com/octo/repo/actions/runs/9001'
    )
    expect(inputs.clientId).toBe('github-actions:octo/repo')
  })

  it('keeps an explicit client-id', () => {
    expect(lockInputs({ 'client-id': ' lab-ci ' }).clientId).toBe('lab-ci')
  })

  it('degrades gracefully outside a runner', () => {
    expect(defaultReason({})).toBe('GitHub Actions')
    expect(defaultClientId({})).toBe('github-actions')
  })
})

describe('readReleaseInputs', () => {
  it('requires lock-id', () => {
    expect(() => readReleaseInputs(getter(CONNECTION), {})).toThrow(
      /Input 'lock-id' is empty/
    )
  })

  it('reads lock-id and the connection', () => {
    const inputs = readReleaseInputs(
      getter({ ...CONNECTION, 'lock-id': ' lock-7 ' }),
      {}
    )
    expect(inputs.lockId).toBe('lock-7')
    expect(inputs.connection.username).toBe('robot')
  })
})
