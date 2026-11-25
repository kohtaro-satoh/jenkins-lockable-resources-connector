import * as core from '@actions/core'
import type { Io } from './io.js'

export const coreIo: Io = {
  getInput: (name) => core.getInput(name),
  setOutput: (name, value) => core.setOutput(name, value),
  exportVariable: (name, value) => core.exportVariable(name, value),
  saveState: (name, value) => core.saveState(name, value),
  getState: (name) => core.getState(name),
  setSecret: (value) => core.setSecret(value),
  debug: (message) => core.debug(message),
  info: (message) => core.info(message),
  warning: (message, title) =>
    core.warning(message, title ? { title } : undefined),
  error: (message, title) => core.error(message, title ? { title } : undefined),
  setFailed: (message) => core.setFailed(message),
  appendSummary: async (markdown) => {
    if (!process.env.GITHUB_STEP_SUMMARY) return
    await core.summary.addRaw(markdown, true).write()
  }
}
