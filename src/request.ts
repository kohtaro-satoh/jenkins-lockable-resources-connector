/**
 * Inputs -> lockRequest JSON, following the Jenkins client's
 * RemoteApiClient.buildLockRequestJson (lockable-resources-plugin 82532cd).
 *
 * Deliberate differences, each pinned by its own test:
 * - priority is sent when it is not 0. Jenkins sends it only when it is
 *   positive, so a negative priority is lost on the remote path (PLAN §11-1).
 * - reason is always sent; when the input is empty it is filled in from the
 *   workflow run so an administrator can tell who holds the lock.
 * - resourceSelectStrategy is sent upper-cased (the server upper-cases it too).
 */
import type { AcquireBody } from './client.js'
import { DEFAULT_GROUP, HEARTBEAT_INTERVAL_SECONDS } from './defaults.js'

export interface ExtraSelector {
  resource?: string
  label?: string
  group?: string
  /** 0 = all matching (label), like lock(). */
  quantity: number
}

export interface LockRequestInput {
  resource?: string
  label?: string
  group?: string
  quantity: number
  variable?: string
  inversePrecedence: boolean
  resourceSelectStrategy: string
  skipIfLocked: boolean
  extra: ExtraSelector[]
  priority: number
  timeoutForAllocateResource: number
  timeoutUnit: string
  reason: string
}

export function buildLockRequestJson(
  r: LockRequestInput
): Record<string, unknown> {
  const json: Record<string, unknown> = {}
  // Jenkins: isGroupOnly() || resource != null || label != null || extra
  // non-empty -> put the normalized group, which defaults to "common".
  if (
    r.group !== undefined ||
    r.resource !== undefined ||
    r.label !== undefined ||
    r.extra.length > 0
  ) {
    json.group = r.group ?? DEFAULT_GROUP
  }
  if (r.resource !== undefined) json.resource = r.resource
  if (r.label !== undefined) json.label = r.label
  if (r.quantity > 0) json.quantity = r.quantity
  if (r.variable !== undefined) json.variable = r.variable
  json.inversePrecedence = r.inversePrecedence
  json.resourceSelectStrategy = r.resourceSelectStrategy
  json.skipIfLocked = r.skipIfLocked
  if (r.extra.length > 0) {
    json.extra = r.extra.map((e) => {
      const entry: Record<string, unknown> = {}
      if (e.group !== undefined) entry.group = e.group
      if (e.resource !== undefined) entry.resource = e.resource
      if (e.label !== undefined) entry.label = e.label
      if (e.quantity > 0) entry.quantity = e.quantity
      return entry
    })
  }
  if (r.priority !== 0) json.priority = r.priority
  if (r.timeoutForAllocateResource > 0) {
    json.timeoutForAllocateResource = r.timeoutForAllocateResource
  }
  json.timeoutUnit = r.timeoutUnit
  json.reason = r.reason
  return json
}

export function buildAcquireBody(
  r: LockRequestInput,
  clientId: string
): AcquireBody {
  const body: AcquireBody = {
    lockRequest: buildLockRequestJson(r),
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS
  }
  if (clientId) body.clientId = clientId
  return body
}

const UNIT_MS: Record<string, number> = {
  NANOSECONDS: 1e-6,
  MICROSECONDS: 1e-3,
  MILLISECONDS: 1,
  SECONDS: 1_000,
  MINUTES: 60_000,
  HOURS: 3_600_000,
  DAYS: 86_400_000
}

export const TIME_UNITS = Object.keys(UNIT_MS)

/**
 * Wall-clock deadline for retrying a paused server (503), like the Jenkins
 * client's acquireDeadline: 0 when the request may wait forever.
 */
export function allocateDeadline(r: LockRequestInput, now: number): number {
  if (r.timeoutForAllocateResource <= 0) return 0
  const factor = UNIT_MS[r.timeoutUnit]
  if (factor === undefined) return 0
  const ms = Math.floor(r.timeoutForAllocateResource * factor)
  return Math.min(Number.MAX_SAFE_INTEGER, now + ms)
}

function describeSelector(s: {
  resource?: string
  label?: string
  group?: string
  quantity: number
}): string {
  const parts: string[] = []
  if (s.resource !== undefined) parts.push(`resource '${s.resource}'`)
  if (s.label !== undefined) parts.push(`label '${s.label}'`)
  if (s.group !== undefined) parts.push(`group '${s.group}'`)
  if (s.quantity > 0) parts.push(`quantity ${s.quantity}`)
  return parts.join(', ')
}

/** Human-readable summary for logs, e.g. "label 'plc', quantity 1 + resource 'r4'". */
export function describeRequest(r: LockRequestInput): string {
  const parts = [describeSelector(r), ...r.extra.map(describeSelector)].filter(
    (p) => p !== ''
  )
  return parts.length > 0 ? parts.join(' + ') : '(no selector)'
}
