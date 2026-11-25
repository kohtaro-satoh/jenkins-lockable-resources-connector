export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 3725000 -> "1h 2m 5s", 65000 -> "1m 5s", 900 -> "0s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString()
}
