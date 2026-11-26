#!/usr/bin/env node
// The judge of .github/workflows/e2e.yml (docs/PLAN.md §10.3). Some cases fail
// on purpose (a held job that fails must leave a STALE lease), so the run's
// colour cannot come from the jobs themselves. This compares every job and the
// steps that matter (post steps included) with what the design expects, reads
// the job logs for the messages users rely on, and checks the server's audit
// trail: no resource was ever held twice, and the queue order was kept.
//
// Environment: GH_TOKEN (actions: read), GITHUB_REPOSITORY, GITHUB_RUN_ID,
// GITHUB_RUN_ATTEMPT, GITHUB_STEP_SUMMARY, E2E_SINCE, E06P_HIGH, E06P_LOW,
// E2E_VERSION, plus what e2e.mjs needs for the audit trail.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OSES = ['ubuntu', 'windows', 'macos']
const PROPERTY_VALUE = /203\.0\.113\.\d+/g

// Expected conclusions. Jobs that fail on purpose carry job-level
// continue-on-error in the workflow, so the run stays green when they do.
const EXPECTED = [
  { job: 'preflight' },
  ...OSES.map((os) => ({
    job: `E01 E02 E10 (${os})`,
    steps: {
      'Post E01 lock': 'success',
      'Post E02 lock': 'success',
      'Post E10 lock': 'success'
    },
    logs: [
      {
        what: 'E02: the lock step prints no property value',
        from: 'E02-lock',
        to: 'E02-lock-end',
        excludes: [PROPERTY_VALUE]
      }
    ]
  })),
  {
    job: 'E03 E04 E05 E13',
    steps: { 'E04 must be skipped': 'skipped' },
    logs: [
      {
        what: 'E05: LOCK_WAIT_TIMEOUT named',
        from: 'E05-lock',
        to: 'E05-lock-end',
        includes: [/LOCK_WAIT_TIMEOUT/]
      },
      {
        what: 'E13: unexposed resource -> 404 + exposeLabel hint',
        from: 'E13-unexposed',
        to: 'E13-bad-token',
        includes: [/HTTP 404/, /exposeLabel/]
      },
      {
        what: 'E13: wrong token -> 401 + API token hint',
        from: 'E13-bad-token',
        to: 'E13-norights',
        includes: [/HTTP 401/, /API token, not a password/]
      },
      {
        what: 'E13: no RemoteUse -> 403 + permission hint',
        from: 'E13-norights',
        to: 'E13-http',
        includes: [/HTTP 403/, /RemoteUse/]
      },
      {
        what: 'E13: http:// -> redirect hint',
        from: 'E13-http',
        to: 'E13-context-path',
        includes: [/redirected/, /set server-url to the final URL/]
      },
      {
        what: 'E13: wrong context path -> 404 + server-url hint',
        from: 'E13-context-path',
        to: 'E13-end',
        includes: [/HTTP 404/, /context path/]
      }
    ]
  },
  ...[1, 2, 3, 4].map((n) => ({ job: `E06 (${n})` })),
  { job: 'E06p holder' },
  { job: 'E06p low (priority 0)' },
  { job: 'E06p high (priority 10)' },
  { job: 'E07' },
  ...OSES.map((os) => ({
    job: `E08 (${os})`,
    steps: { 'E08 check withdrawn': 'success' }
  })),
  {
    job: 'E09',
    conclusion: 'failure',
    steps: {
      'E09 fail on purpose': 'failure',
      'E09 release (skipped)': 'skipped',
      'Post E09 lock': 'failure'
    }
  },
  {
    job: 'E11',
    conclusion: 'failure',
    steps: {
      'E11 work, no release step': 'success',
      'Post E11 lock': 'failure'
    }
  },
  {
    job: 'E15',
    conclusion: 'failure',
    steps: {
      'E15 held step times out': 'failure',
      'E15 release (skipped)': 'skipped',
      'Post E15 lock': 'failure'
    }
  },
  {
    job: 'E16',
    conclusion: 'failure',
    steps: {
      'E16 fail on purpose': 'failure',
      'E16 release (always)': 'success',
      'E16 check free': 'success',
      'Post E16 lock': 'success'
    }
  },
  {
    job: 'E17',
    conclusion: 'failure',
    steps: {
      'E17 wait for STALE': 'success',
      'E17 release (must refuse)': 'failure',
      'E17 check still STALE': 'success',
      'Post E17 lock': 'success'
    },
    logs: [
      {
        what: 'E17: release refuses a STALE lease',
        from: 'E17-release',
        to: 'E17-release-end',
        includes: [/is STALE on the server/]
      }
    ]
  },
  {
    job: 'E18',
    logs: [
      {
        what: 'E18: heartbeat failures while cut off',
        from: 'E18-cut',
        to: 'E18-release',
        includes: [/failCount=[1-9]/]
      },
      {
        what: 'E18: release retried until the network was back',
        from: 'E18-release',
        to: 'E18-release-end',
        includes: [/failed \(attempt \d+\/\d+\); retrying/]
      }
    ]
  },
  {
    job: 'E12',
    logs: [
      {
        what: 'E12: waited out the paused server',
        from: 'E12-lock',
        to: 'E12-lock-end',
        includes: [/not accepting new acquire requests/]
      }
    ]
  },
  { job: 'verify-failures' }
]

const results = []
const record = (what, ok, detail = '') => results.push({ what, ok, detail })

async function gh(url) {
  const res = await fetch(`https://api.github.com${url}`, {
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json'
    }
  })
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`)
  return url.endsWith('/logs') ? await res.text() : await res.json()
}

/**
 * The steps between the "E2E-MARK <from>" output line and the step that prints
 * "E2E-MARK <to>". It ends where that step begins (its "##[group]Run" header):
 * the runner lists the GITHUB_ENV variables in every step's header, and those
 * lines are the runner's, not the action's.
 */
function section(log, from, to) {
  const lines = log.split(/\r?\n/)
  const isMark = (line, name) =>
    new RegExp(`E2E-MARK ${name}$`).test(line) && !line.includes('echo')
  const start = lines.findIndex((l) => isMark(l, from))
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && isMark(l, to))
  if (end < 0) return lines.slice(start).join('\n')
  for (let i = end; i > start; i--) {
    if (lines[i].includes('##[group]Run ')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

async function checkJobs() {
  const { repo, run, attempt } = {
    repo: process.env.GITHUB_REPOSITORY,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? 1
  }
  const { jobs } = await gh(
    `/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`
  )
  for (const exp of EXPECTED) {
    const job = jobs.find((j) => j.name === exp.job)
    if (!job) {
      record(`${exp.job}: ran`, false, 'job not found')
      continue
    }
    const want = exp.conclusion ?? 'success'
    record(
      `${exp.job}: job ${want}`,
      job.conclusion === want,
      `got ${job.conclusion}`
    )
    for (const [name, wantStep] of Object.entries(exp.steps ?? {})) {
      const step = job.steps.find((s) => s.name === name)
      record(
        `${exp.job}: "${name}" ${wantStep}`,
        step?.conclusion === wantStep,
        step ? `got ${step.conclusion}` : 'step not found'
      )
    }
    if (exp.logs || exp.job.startsWith('E01 E02 E10')) {
      const log = await gh(`/repos/${repo}/actions/jobs/${job.id}/logs`)
      for (const l of exp.logs ?? []) {
        const text = section(log, l.from, l.to)
        if (text === undefined) {
          record(
            `${exp.job}: ${l.what}`,
            false,
            `marker ${l.from} not in the log`
          )
          continue
        }
        const missing = (l.includes ?? [])
          .filter((re) => !re.test(text))
          .map(String)
        const present = (l.excludes ?? [])
          .filter((re) => re.test(text))
          .map(String)
        record(
          `${exp.job}: ${l.what}`,
          missing.length === 0 && present.length === 0,
          [
            ...missing.map((m) => `missing ${m}`),
            ...present.map((p) => `found ${p}`)
          ].join('; ')
        )
      }
      if (exp.job.startsWith('E01 E02 E10')) {
        // Not the action's doing, but users should know: the runner lists the
        // variables of GITHUB_ENV in the header of every later step.
        const after = section(log, 'E02-lock-end', 'NO-SUCH-MARK') ?? ''
        const n = (after.match(PROPERTY_VALUE) ?? []).length
        record(
          `${exp.job}: (info) property values in later steps' log headers`,
          true,
          `${n} occurrence(s)`
        )
      }
    }
  }
}

function audit() {
  const tool = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'e2e.mjs'
  )
  const out = execFileSync(
    process.execPath,
    [tool, 'admin', 'audit', process.env.E2E_SINCE],
    { encoding: 'utf8' }
  )
  return out
    .split('\n')
    .filter((l) => l.startsWith('audit=LRA|'))
    .map((l) => {
      const [, ts, kind, event, resource, holder] = l
        .slice('audit='.length)
        .split('|')
      return { ts: Number(ts), kind, event, resource, holder }
    })
}

function checkAudit() {
  const events = audit()
  const byResource = new Map()
  for (const e of events) {
    if (!byResource.has(e.resource)) byResource.set(e.resource, [])
    byResource.get(e.resource).push(e)
  }

  // Never held twice: per resource, ACQUIRED and RELEASED alternate.
  const overlaps = []
  for (const [resource, list] of byResource) {
    let holder
    for (const e of list) {
      if (e.event === 'ACQUIRED') {
        if (holder)
          overlaps.push(
            `${resource}: ${e.holder} acquired while ${holder} held it`
          )
        holder = e.holder
      } else if (e.event === 'RELEASED') {
        if (holder && holder !== e.holder)
          overlaps.push(
            `${resource}: ${e.holder} released while ${holder} held it`
          )
        holder = undefined
      }
    }
  }
  record(
    'audit: no resource held twice at once',
    overlaps.length === 0,
    overlaps.join('; ') ||
      `${events.length} events on ${byResource.size} resources`
  )

  const acquired = (resource) =>
    (byResource.get(resource) ?? []).filter((e) => e.event === 'ACQUIRED')
  const shared = acquired('e2e-shared-1')
  record(
    'E06: four jobs each got e2e-shared-1',
    shared.length === 4 && new Set(shared.map((e) => e.holder)).size === 4,
    `${shared.length} acquisitions`
  )

  const order = acquired('e2e-shared-2').map((e) => e.holder)
  const high = process.env.E06P_HIGH
  const low = process.env.E06P_LOW
  record(
    'E06p: priority 10 served before priority 0',
    high &&
      low &&
      order.indexOf(high) > 0 &&
      order.indexOf(high) < order.indexOf(low),
    `order ${order.join(' -> ')}`
  )

  const kinds = (resource) =>
    (byResource.get(resource) ?? [])
      .map((e) => `${e.kind} ${e.event}`)
      .join(', ')
  record(
    'E07: Actions waited for the Jenkins pipeline',
    kinds('e2e-interop-1') ===
      'LOCAL ACQUIRED, LOCAL RELEASED, REMOTE ACQUIRED, REMOTE RELEASED',
    kinds('e2e-interop-1')
  )
  record(
    'E07: the Jenkins pipeline waited for Actions',
    kinds('e2e-interop-2') ===
      'REMOTE ACQUIRED, REMOTE RELEASED, LOCAL ACQUIRED, LOCAL RELEASED',
    kinds('e2e-interop-2')
  )
  for (const os of OSES) {
    const k = kinds(`e2e-basic-${os}`)
    record(
      `E01 (${os}): acquired and released exactly once`,
      k === 'REMOTE ACQUIRED, REMOTE RELEASED',
      k
    )
  }
}

try {
  await checkJobs()
} catch (e) {
  record('jobs and logs', false, e.message)
}
try {
  checkAudit()
} catch (e) {
  record('audit trail', false, e.message)
}

const failed = results.filter((r) => !r.ok)
const escape = (s) => String(s).replace(/\|/g, '\\|')
const table = [
  `## E2E judge (lockable-resources ${process.env.E2E_VERSION ?? '?'})`,
  '',
  `${results.length - failed.length} of ${results.length} checks passed.`,
  '',
  '| | Check | Detail |',
  '| --- | --- | --- |',
  ...results.map(
    (r) => `| ${r.ok ? '✅' : '❌'} | ${escape(r.what)} | ${escape(r.detail)} |`
  )
].join('\n')
console.log(table)
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n')
process.exit(failed.length > 0 ? 1 : 0)
