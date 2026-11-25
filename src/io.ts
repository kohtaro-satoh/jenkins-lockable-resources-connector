/**
 * The slice of @actions/core the steps use. The step logic takes this
 * interface so unit tests can run it without a runner; src/core-io.ts is the
 * real implementation.
 */
export interface Io {
  getInput(name: string): string
  setOutput(name: string, value: string): void
  exportVariable(name: string, value: string): void
  saveState(name: string, value: string): void
  getState(name: string): string
  setSecret(value: string): void
  debug(message: string): void
  info(message: string): void
  warning(message: string, title?: string): void
  error(message: string, title?: string): void
  setFailed(message: string): void
  /** Appends Markdown to $GITHUB_STEP_SUMMARY (no-op outside a runner). */
  appendSummary(markdown: string): Promise<void>
}
