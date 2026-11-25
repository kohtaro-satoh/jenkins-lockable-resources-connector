import { RemoteApiError } from './client.js'
import type { Clock, Logger } from './session.js'
import { errorMessage } from './util.js'

export interface RetryOptions {
  attempts: number
  intervalMs: number
  clock: Clock
  log: Pick<Logger, 'warning'>
  /** For log lines, e.g. "Release of lock abc". */
  what: string
}

/** Retries transient RemoteApiErrors (no response, 5xx, 408, 429); anything else is thrown at once. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  o: RetryOptions
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (
        !(e instanceof RemoteApiError) ||
        !e.transient ||
        attempt >= o.attempts
      ) {
        throw e
      }
      o.log.warning(
        `${o.what} failed (attempt ${attempt}/${o.attempts}); retrying: ${errorMessage(e)}`
      )
      await o.clock.sleep(o.intervalMs)
    }
  }
}
