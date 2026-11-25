/**
 * Reads the action inputs and checks types and formats only. Whether the
 * combination makes sense (resource and label together, priority with
 * inversePrecedence, no target at all) is left to the server, which answers
 * with the same wording as a local lock() (PLAN §5.2).
 */
import { CORE_SCHEMA, load } from 'js-yaml'
import type { Connection } from './client.js'
import type { ExtraSelector, LockRequestInput } from './request.js'
import { TIME_UNITS } from './request.js'
import { errorMessage } from './util.js'

export type GetInput = (name: string) => string

export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

export const ENV_SERVER_URL = 'LOCKABLE_RESOURCES_SERVER_URL'
export const ENV_USERNAME = 'LOCKABLE_RESOURCES_USERNAME'

const INT_MIN = -2_147_483_648
const INT_MAX = 2_147_483_647
const RESOURCE_SELECT_STRATEGIES = ['SEQUENTIAL', 'RANDOM']
const EXTRA_KEYS = ['resource', 'label', 'quantity', 'group'] as const

export interface ConnectionInputs {
  connection: Connection
  warnings: string[]
}

export interface LockInputs extends ConnectionInputs {
  clientId: string
  request: LockRequestInput
}

export interface ReleaseInputs extends ConnectionInputs {
  lockId: string
}

export function readConnection(
  get: GetInput,
  env: NodeJS.ProcessEnv
): ConnectionInputs {
  const rawUrl = get('server-url').trim() || (env[ENV_SERVER_URL] ?? '').trim()
  if (!rawUrl) {
    throw new InputError(
      `Input 'server-url' is empty and ${ENV_SERVER_URL} is not set.`
    )
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new InputError(`Input 'server-url' is not a valid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InputError(
      `Input 'server-url' must start with https:// or http://: ${rawUrl}`
    )
  }
  if (url.username || url.password) {
    throw new InputError(
      "Input 'server-url' must not contain credentials; use 'username' and 'token'."
    )
  }
  if (url.search || url.hash) {
    throw new InputError(
      `Input 'server-url' must not contain a query or a fragment: ${rawUrl}`
    )
  }
  const warnings: string[] = []
  if (url.protocol === 'http:') {
    warnings.push(
      'server-url uses http://, so the API token is sent in clear text (Basic authentication). Use https:// outside closed test networks.'
    )
  }
  const serverUrl = (url.origin + url.pathname).replace(/\/+$/, '')

  const username = get('username').trim() || (env[ENV_USERNAME] ?? '').trim()
  if (!username) {
    throw new InputError(
      `Input 'username' is empty and ${ENV_USERNAME} is not set.`
    )
  }

  // The token is never read from the environment: a job-level env: entry
  // would expose it to every step, including third-party actions.
  const token = get('token').trim()
  if (!token) {
    throw new InputError(
      "Input 'token' is empty. Pass the Jenkins API token with `token: ${{ secrets.<NAME> }}`. " +
        'Note that secrets are not passed to workflows triggered from forks.'
    )
  }
  return { connection: { serverUrl, username, token }, warnings }
}

export function readLockInputs(
  get: GetInput,
  env: NodeJS.ProcessEnv
): LockInputs {
  const { connection, warnings } = readConnection(get, env)

  const variable = optionalString(get('variable'))
  if (variable !== undefined && /^(GITHUB_|RUNNER_)/i.test(variable)) {
    throw new InputError(
      `Input 'variable' must not start with GITHUB_ or RUNNER_ (GitHub does not let a step overwrite those): ${variable}`
    )
  }

  const request: LockRequestInput = {
    resource: optionalString(get('resource')),
    label: optionalString(get('label')),
    group: optionalString(get('group')),
    quantity: parseInteger('quantity', get('quantity'), 0, INT_MIN, INT_MAX),
    variable,
    inversePrecedence: parseBoolean(
      'inverse-precedence',
      get('inverse-precedence'),
      false
    ),
    resourceSelectStrategy: parseEnum(
      'resource-select-strategy',
      get('resource-select-strategy'),
      'SEQUENTIAL',
      RESOURCE_SELECT_STRATEGIES
    ),
    skipIfLocked: parseBoolean('skip-if-locked', get('skip-if-locked'), false),
    extra: parseExtra(get('extra')),
    priority: parseInteger('priority', get('priority'), 0, INT_MIN, INT_MAX),
    timeoutForAllocateResource: parseInteger(
      'timeout-for-allocate-resource',
      get('timeout-for-allocate-resource'),
      0,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    ),
    timeoutUnit: parseEnum(
      'timeout-unit',
      get('timeout-unit'),
      'MINUTES',
      TIME_UNITS
    ),
    reason: optionalString(get('reason')) ?? defaultReason(env)
  }
  const clientId = optionalString(get('client-id')) ?? defaultClientId(env)
  return { connection, warnings, clientId, request }
}

export function readReleaseInputs(
  get: GetInput,
  env: NodeJS.ProcessEnv
): ReleaseInputs {
  const lockId = get('lock-id').trim()
  if (!lockId) {
    throw new InputError(
      "Input 'lock-id' is empty. Pass the lock step's output: `lock-id: ${{ steps.<id>.outputs.lock-id }}`."
    )
  }
  return { ...readConnection(get, env), lockId }
}

/** `<workflow> #<run_number> (<job>) <run URL>` (PLAN §5.2). */
export function defaultReason(env: NodeJS.ProcessEnv): string {
  let reason = env.GITHUB_WORKFLOW || 'GitHub Actions'
  if (env.GITHUB_RUN_NUMBER) reason += ` #${env.GITHUB_RUN_NUMBER}`
  if (env.GITHUB_JOB) reason += ` (${env.GITHUB_JOB})`
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    reason += ` ${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  }
  return reason
}

export function defaultClientId(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_REPOSITORY
    ? `github-actions:${env.GITHUB_REPOSITORY}`
    : 'github-actions'
}

function optionalString(raw: string): string | undefined {
  const value = raw.trim()
  return value === '' ? undefined : value
}

export function parseInteger(
  name: string,
  raw: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = raw.trim()
  if (value === '') return defaultValue
  if (!/^[+-]?\d+$/.test(value)) {
    throw new InputError(`Input '${name}' must be an integer: '${value}'`)
  }
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new InputError(`Input '${name}' is out of range: ${value}`)
  }
  return n === 0 ? 0 : n
}

/** The YAML 1.2 core booleans, like core.getBooleanInput. */
export function parseBoolean(
  name: string,
  raw: string,
  defaultValue: boolean
): boolean {
  const value = raw.trim()
  if (value === '') return defaultValue
  if (['true', 'True', 'TRUE'].includes(value)) return true
  if (['false', 'False', 'FALSE'].includes(value)) return false
  throw new InputError(`Input '${name}' must be true or false: '${value}'`)
}

function parseEnum(
  name: string,
  raw: string,
  defaultValue: string,
  allowed: readonly string[]
): string {
  const value = raw.trim()
  if (value === '') return defaultValue
  const upper = value.toUpperCase()
  if (!allowed.includes(upper)) {
    throw new InputError(
      `Input '${name}' must be one of ${allowed.join(', ')}: '${value}'`
    )
  }
  return upper
}

export function parseExtra(raw: string): ExtraSelector[] {
  const text = raw.trim()
  if (text === '') return []
  let doc: unknown
  try {
    doc = load(text, { schema: CORE_SCHEMA })
  } catch (e) {
    const firstLine = errorMessage(e).split('\n')[0]
    throw new InputError(
      `Input 'extra' is not valid YAML or JSON: ${firstLine}`
    )
  }
  if (doc === null || doc === undefined) return []
  if (!Array.isArray(doc)) {
    throw new InputError(
      "Input 'extra' must be a list, for example:\n- resource: printer\n- label: gpu\n  quantity: 2"
    )
  }
  return doc.map((item, i) => parseExtraItem(item, i))
}

function parseExtraItem(item: unknown, i: number): ExtraSelector {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new InputError(
      `extra[${i}] must be a mapping with resource, label, quantity or group.`
    )
  }
  const entry = item as Record<string, unknown>
  for (const key of Object.keys(entry)) {
    if (!(EXTRA_KEYS as readonly string[]).includes(key)) {
      throw new InputError(
        `extra[${i}] has an unknown key '${key}'. Allowed keys: ${EXTRA_KEYS.join(', ')}.`
      )
    }
  }
  const selector: ExtraSelector = { quantity: 0 }
  for (const key of ['resource', 'label', 'group'] as const) {
    const value = entry[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      throw new InputError(
        `extra[${i}].${key} must be a string; quote values that YAML reads as numbers or booleans (for example "007").`
      )
    }
    const trimmed = value.trim()
    if (trimmed !== '') selector[key] = trimmed
  }
  const quantity = entry.quantity
  if (quantity !== undefined && quantity !== null) {
    const text = String(quantity).trim()
    const n = Number(text)
    if (
      (typeof quantity !== 'number' && typeof quantity !== 'string') ||
      (text !== '' && !/^[+-]?\d+$/.test(text)) ||
      n < INT_MIN ||
      n > INT_MAX
    ) {
      throw new InputError(`extra[${i}].quantity must be an integer: '${text}'`)
    }
    selector.quantity = n === 0 ? 0 : n
  }
  return selector
}
