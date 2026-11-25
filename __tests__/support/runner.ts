/**
 * Plays the part of the Actions runner for the bundled steps in dist/:
 * INPUT_* variables in, GITHUB_OUTPUT / GITHUB_ENV / GITHUB_STATE files out,
 * main's saved state handed to post as STATE_* variables.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export type Script = 'main' | 'post' | 'release'

export interface StepResult {
  code: number | null
  output: string
  outputs: Record<string, string>
  env: Record<string, string>
  state: Record<string, string>
  summary: string
}

export interface RunningStep {
  child: ChildProcess
  done: Promise<StepResult>
}

export class FakeRunner {
  readonly temp: string
  private steps = 0

  private constructor(readonly root: string) {
    this.temp = path.join(root, '_temp')
    fs.mkdirSync(this.temp, { recursive: true })
  }

  static create(): FakeRunner {
    return new FakeRunner(fs.mkdtempSync(path.join(os.tmpdir(), 'lrrc-it-')))
  }

  start(
    script: Script,
    inputs: Record<string, string>,
    options: { state?: Record<string, string>; action?: string } = {}
  ): RunningStep {
    const n = ++this.steps
    const files = {
      GITHUB_OUTPUT: path.join(this.root, `output-${n}`),
      GITHUB_ENV: path.join(this.root, `env-${n}`),
      GITHUB_STATE: path.join(this.root, `state-${n}`),
      GITHUB_STEP_SUMMARY: path.join(this.root, `summary-${n}`)
    }
    for (const file of Object.values(files)) fs.writeFileSync(file, '')

    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      // Do not let a real runner's variables (when the tests run in CI) leak in.
      if (/^(GITHUB_|RUNNER_|INPUT_|STATE_|LOCKABLE_RESOURCES_)/i.test(key))
        continue
      env[key] = value
    }
    Object.assign(env, files, {
      RUNNER_TEMP: this.temp,
      RUNNER_TRACKING_ID: 'github_test',
      GITHUB_ACTION: options.action ?? 'lock',
      GITHUB_WORKFLOW: 'flash',
      GITHUB_RUN_NUMBER: '42',
      GITHUB_RUN_ID: '9001',
      GITHUB_JOB: 'build',
      GITHUB_REPOSITORY: 'octo/repo',
      GITHUB_SERVER_URL: 'https://github.com',
      LOCKABLE_RESOURCES_TEST_TIME_SCALE: '0.1'
    })
    for (const [name, value] of Object.entries(inputs)) {
      env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value
    }
    for (const [name, value] of Object.entries(options.state ?? {})) {
      env[`STATE_${name}`] = value
    }

    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'dist', `${script}.js`)],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const done = new Promise<StepResult>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) =>
        resolve({
          code,
          output,
          outputs: parseCommandFile(files.GITHUB_OUTPUT),
          env: parseCommandFile(files.GITHUB_ENV),
          state: parseCommandFile(files.GITHUB_STATE),
          summary: fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8')
        })
      )
    })
    return { child, done }
  }

  async run(
    script: Script,
    inputs: Record<string, string>,
    options: { state?: Record<string, string>; action?: string } = {}
  ): Promise<StepResult> {
    return await this.start(script, inputs, options).done
  }

  /** PIDs of the heartbeat daemons this job started. */
  daemonPids(): number[] {
    const dir = path.join(this.temp, 'lockable-resources')
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json') && !n.endsWith('.heartbeat.json'))
      .map(
        (n) =>
          JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as {
            daemon?: { pid: number }
          }
      )
      .flatMap((s) => (s.daemon ? [s.daemon.pid] : []))
  }

  readLockFile(lockId: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(
        path.join(this.temp, 'lockable-resources', `${lockId}.json`),
        'utf8'
      )
    ) as Record<string, unknown>
  }

  /** What the runner does at the end of the job: kill orphans, empty the temp dir. */
  cleanup(): void {
    for (const pid of this.daemonPids()) {
      try {
        process.kill(pid)
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(this.root, { recursive: true, force: true })
  }
}

/** Parses the `name<<delimiter` / `name=value` format of the runner's command files. */
export function parseCommandFile(file: string): Record<string, string> {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const result: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line)
    if (heredoc) {
      const [, name, delimiter] = heredoc
      const value: string[] = []
      for (i++; i < lines.length && lines[i] !== delimiter; i++)
        value.push(lines[i] ?? '')
      result[name ?? ''] = value.join('\n')
    } else if (line.includes('=')) {
      const at = line.indexOf('=')
      result[line.slice(0, at)] = line.slice(at + 1)
    }
  }
  return result
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
  what = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
