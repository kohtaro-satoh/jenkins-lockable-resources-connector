/**
 * Client constants. The first group mirrors the Jenkins client's
 * RemoteClientDefaults and RemoteLockSession (lockable-resources-plugin
 * 82532cd) so that this action behaves like a remote lock() in Jenkins.
 */

export const API_BASE_PATH = '/lockable-resources/remote/v1'

export const POLL_INTERVAL_MS = 3_000
/** Sent as heartbeatIntervalSeconds; the server validates it but uses its own constant. */
export const HEARTBEAT_INTERVAL_SECONDS = 10
export const REQUEST_TIMEOUT_MS = 5_000
/** About 60 s at the 3 s poll interval. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 20

/** Release retries: 3 s apart, 20 attempts (about 60 s), the same budget as polling. */
export const RELEASE_RETRY_INTERVAL_MS = 3_000
export const MAX_RELEASE_ATTEMPTS = 20

/** Server side: an ACQUIRED lease without a heartbeat for this long becomes STALE. */
export const SERVER_STALE_THRESHOLD_MS = 60_000

/** How often the main step prints that it is still waiting. */
export const WAIT_LOG_INTERVAL_MS = 60_000

/** Group a Jenkins lock() sends when none is given (ResourceGroup.DEFAULT_NAME). */
export const DEFAULT_GROUP = 'common'

/** How long the main step waits for the heartbeat daemon's first heartbeat. */
export const DAEMON_READY_TIMEOUT_MS = 15_000
/** How long release / post wait for the daemon to confirm that it stopped. */
export const DAEMON_STOP_TIMEOUT_MS = 5_000
/** How often the daemon checks for a stop request and that its job is still running. */
export const DAEMON_TICK_MS = 250

/**
 * Test hook: scales the client's own intervals (poll, heartbeat, release retry,
 * wait log) down so the integration tests run in seconds. Values outside
 * (0, 1] are ignored, so it can only make the client faster, never slower than
 * the server's STALE threshold allows.
 */
export const TIME_SCALE_ENV = 'LOCKABLE_RESOURCES_TEST_TIME_SCALE'

export interface Timing {
  pollIntervalMs: number
  heartbeatIntervalMs: number
  releaseRetryIntervalMs: number
  waitLogIntervalMs: number
}

export function timingFromEnv(env: NodeJS.ProcessEnv): Timing {
  const raw = Number(env[TIME_SCALE_ENV])
  const scale = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1
  return {
    pollIntervalMs: Math.round(POLL_INTERVAL_MS * scale),
    heartbeatIntervalMs: Math.round(HEARTBEAT_INTERVAL_SECONDS * 1000 * scale),
    releaseRetryIntervalMs: Math.round(RELEASE_RETRY_INTERVAL_MS * scale),
    waitLogIntervalMs: Math.round(WAIT_LOG_INTERVAL_MS * scale)
  }
}

export const DEFAULT_TIMING: Timing = timingFromEnv({})
