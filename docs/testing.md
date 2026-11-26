# Testing

English | [日本語](testing.ja.md)

Four layers, from fast and local to slow and real. The design they check is in
[design.md](design.md).

| Layer                                  | Runs                        | Where                                  |
| -------------------------------------- | --------------------------- | -------------------------------------- |
| [1. Unit tests](#1-unit-tests)         | `npm test`                  | every push and pull request (CI)       |
| [2. Integration tests](#2-integration-tests) | `npm run test:integration` | CI on ubuntu, windows and macos     |
| [3. Runner behaviour (M0)](#3-runner-behaviour-m0) | `m0-poc*.yml`, by hand | GitHub-hosted runners           |
| [4. End-to-end tests](#4-end-to-end-tests) | `e2e.yml`, by hand      | GitHub-hosted runners against a real Jenkins |

## 1. Unit tests

`__tests__/unit/`, with a fake clock, a fake HTTP API and a fake runner I/O.

- **Request JSON** (`request.ts`): a table of inputs to JSON that always
  includes defaults, unset values, 0, empty strings, blanks and negative
  values. On top of it, the action's JSON is compared with a transliteration
  of the plugin's `buildLockRequestJson` over about 2,100 input combinations;
  the two intended differences (`priority`, `reason`) have cases of their own.
- **Acquire state machine** (`session.ts`): QUEUED → ACQUIRED, SKIPPED,
  FAILED, 503 retries and their deadline, 404 / 410, 19 failed polls in a row
  carry on and 20 fail, cancel while waiting.
- **Post step:** per stage it withdraws (`enqueued`), stops the heartbeats and
  fails (`held`), or does nothing (`released`, `skipped`, `withdrawn`). That
  `held` never sends a release is a test of its own.
- **Release step:** the state check (STALE, already released, no record),
  retries up to the limit, stopping the heartbeats on success and on giving up.
- **Inputs:** type errors, a `variable` starting with `GITHUB_` / `RUNNER_`,
  unknown `extra` keys, an empty token.
- **Heartbeat process:** the stop file, the state-file watchdog, signals,
  aborting a heartbeat in flight, not recreating a removed directory.

## 2. Integration tests

`__tests__/integration/`: the bundles in `dist/` run as real processes, as
the runner would run them (inputs as `INPUT_*`, command files, saved state
passed to post), against a fake server that reproduces the API's state
machine: transitions out of QUEUED, terminal states, 404 / 410, failures in a
row, any heartbeat status, 503. The client's intervals are scaled by
`LOCKABLE_RESOURCES_TEST_TIME_SCALE` (0 < x ≤ 1) to keep it fast.

- lock → heartbeat process → release → post: heartbeats keep coming, stop
  after the release, and exactly one release arrives.
- A failed job: lock → heartbeat process → post, no release step. The post
  step stops the heartbeats and **no release arrives**.
- Post finds the lock even if the saved state did not reach it; skip; cancel
  while queued; a refused request; a paused server (503); a STALE lease the
  release step must not release.

CI runs them on ubuntu, windows and macos.

## 3. Runner behaviour (M0)

The design rests on runner behaviour that GitHub does not document. Before
anything else it was checked with a small probe action
(`.github/poc/m0-probe`) in `m0-poc.yml` and `m0-poc-cancel.yml`, by hand, on
GitHub-hosted ubuntu, windows and macos runners
([run 45711891191](https://github.com/kohtaro-satoh/lockable-resources-remote-client-actions/actions/runs/45711891191),
[run 45711909304](https://github.com/kohtaro-satoh/lockable-resources-remote-client-actions/actions/runs/45711909304),
2026-11-26). All six assumptions hold.

| Assumption                                                                 | Result                                                                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A detached process lives through later steps and is cleaned up at the end of the job | On all three OSes it lived through two later steps and kept working; `Complete job` terminated it as an orphan                                    |
| 2. After a cancel, post runs and reads main's saved state                  | After a step timeout and after cancelling the run, including when main ignored the signals and was killed, post ran and read the state on all three OSes      |
| 3. Main has time to withdraw after the cancel signal                       | Linux / macOS: SIGINT, SIGTERM about 7.5 s later, killed about 2.5 s after that (about 10 s). Windows: SIGINT, killed about 7 s later, no SIGTERM. One withdrawal (5 s request timeout) fits |
| 4. `runs.using: node24` works                                              | Every job ran on Node 24                                                                                                                                       |
| 5. Container jobs                                                          | The process lives through later steps. There is no `RUNNER_TRACKING_ID` inside the container, so no orphan clean-up, but the container is removed at the end of the job |
| 6. The post step of a JavaScript action inside a composite action runs     | Yes, on all three OSes                                                                                                                                         |

Also seen:

- The cancel signal reaches only main, not the detached process; stopping the
  heartbeats after a cancel while holding is the post step's job, as designed.
- If the cancel comes while `POST /acquire/` is still waiting for its answer
  (up to 5 s), main may run out of the 7 s on Windows; the post step then
  withdraws.
- `GITHUB_ACTION` is the same in main and post. The saved state always reached
  post, even when main was killed.
- Self-hosted runners were not checked; `node24` support depends on their
  version.

## 4. End-to-end tests

`.github/workflows/e2e.yml` runs the action on GitHub-hosted runners against
a real Jenkins: one shared Jenkins on a throwaway VPS, built by
[`e2e/server`](../e2e/server/README.md). Because every job reaches the same
server, jobs really contend for resources, what a failed job leaves on the
server can be checked after the job, and Windows and macOS runners talk to a
real Jenkins over https through a reverse proxy with a context path.

### 4.1 Server

| Item     | Setting                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Host     | Ubuntu 26.04, 1 GB of memory, 2 cores; runs only while tests run                                                                          |
| Access   | `https://<host>/jenkins/`; Caddy with Let's Encrypt in front, Jenkins listening on 127.0.0.1 only. The host name is a repository variable, not in the code |
| Jenkins  | LTS, one at a time (memory): an image and a JENKINS_HOME per plugin version (1560 and the latest), switched by `switch.sh`                  |
| Plugins  | lockable-resources (pinned), the minimal Pipeline set (the Jenkins side of E07), `matrix-auth`, `groovy` (the admin job)                  |
| Settings | remote API on, expose label `e2e`; each case has resources of its own, so parallel cases never wait for each other                        |

| User           | Permissions                                 | Used for                                              |
| -------------- | ------------------------------------------- | ----------------------------------------------------- |
| `e2e-robot`    | Overall/Read, Lockable Resources/RemoteUse  | the action: exactly what the README asks for          |
| `e2e-ops`      | Overall/Read, Job/Read, Job/Build           | starting the admin job and the Jenkins-side pipeline  |
| `e2e-norights` | Overall/Read                                | the 403 case (E13)                                    |
| `admin`        | everything                                  | maintenance over SSH only; never given to CI          |

**The admin job (`e2e-admin`).** The tests need administrator operations:
cleaning up STALE leases, pausing new requests, reading the audit trail and
the queue. An admin token in CI could, if leaked, take over the server through
the script console. Instead a Freestyle job with a fixed system Groovy script
offers only these operations, `e2e-ops` starts it with an `OP` parameter and
reads the result from the console, and cannot change the script (no
Job/Configure). Arguments are checked (`e2e-` resource names only, and so on).

| OP              | Does                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `version`       | the running lockable-resources version, compared with the workflow input                          |
| `reset`         | releases every remote lease and waiting request, stops the holder pipelines, accepts requests again |
| `queue`         | how many requests wait for a resource                                                             |
| `accept`        | sets `acceptNewAcquires`                                                                          |
| `release-stale` | releases STALE leases as an administrator would                                                   |
| `records`       | lists the remote records (debugging)                                                              |
| `audit`         | audit trail lines (`LRA|…`) since a time                                                          |

**The audit trail.** The plugin writes one line per change of hands to the
`org.jenkins.plugins.lockableresources.audit` logger (present in 1560) when it
is at FINE; the server writes it to a file. Whether a resource was ever held
twice cannot be shown from client logs, since the times a client logs lie
inside the real holding time, so the judge reads this trail instead.

**A new JENKINS_HOME starts locked** (anonymous denied, no users) until the
init scripts have set up users and permissions, and `switch.sh` stops Jenkins
if they did not all finish: with the setup wizard off, an unconfigured
Jenkins would be open to anyone.

### 4.2 Workflow

- Started by hand with the plugin version as input; `preflight` stops the run
  if the server runs another version.
- One run at a time (`concurrency`), since the Jenkins is shared.
- The server URL and tokens are repository variables and secrets
  (`E2E_SERVER_URL`, `E2E_ROBOT_TOKEN`, `E2E_OPS_TOKEN`, `E2E_NORIGHTS_TOKEN`).
- Order:
  1. `preflight`: version check, `OP=reset`, start time
  2. the cases below marked "parallel"
  3. E12 alone: pausing new requests affects the whole server
  4. `verify-failures`: the leases left by the failing cases (STALE or
     released), then `OP=release-stale`
  5. `judge`
  6. `cleanup` (always): `OP=reset`
- **Expected failures.** Several cases fail on purpose: a job that fails
  while holding must leave a STALE lease. Those jobs carry job-level
  `continue-on-error`, so the run is not failed by them, and the run's colour
  comes from the judge. The judge compares every job and the steps that
  matter, post steps included, with the expected conclusions through the API;
  reads the job logs for the messages users rely on; and checks the audit
  trail: no resource held twice, the priority order, the order between Jenkins
  and Actions, one acquisition and one release per simple lock.
- Cases whose order matters (E06p, E07) do not rely on job start times, which
  differ by tens of seconds: the holder takes the resource first, the waiters
  ask after it, and the holder releases only once `OP=queue` shows all of them
  waiting.

### 4.3 Cases

| ID   | Case                                                                                                         | Expected                                                                                                                       | Runners                    | Phase    |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | -------- |
| E01  | lock a resource → later step → release                                                                       | FREE on the server again; post does nothing; one acquisition and one release in the audit trail                               | ubuntu, windows, macos     | parallel |
| E02  | label + quantity + variable, resources with properties                                                       | `X`, `X0`, ..., `X0_<property>`, `X_<property>` in later steps, equal to the `env-vars` output; the lock step prints no property value | ubuntu, windows, macos | parallel |
| E03  | resource + extra                                                                                             | all acquired together                                                                                                          | ubuntu                     | parallel |
| E04  | skip-if-locked on a resource an earlier step holds                                                           | SKIPPED, `acquired=false`, the guarded step skipped                                                                            | ubuntu                     | parallel |
| E05  | 20 s allocation timeout on a held resource                                                                   | fails with `LOCK_WAIT_TIMEOUT` after 20–35 s (the server checks every 15 s)                                                    | ubuntu                     | parallel |
| E06  | four jobs on three OSes take turns on one resource (20 s each)                                               | all four get it; never two at once (audit trail)                                                                               | ubuntu ×2, windows, macos  | parallel |
| E06p | priority 0 asks, then priority 10 asks, while a third job holds the resource                                 | priority 10 is served first                                                                                                   | ubuntu ×3                  | parallel |
| E07  | a Jenkins pipeline holds a resource the action waits for, and the other way round                            | one queue for both, in order (audit trail)                                                                                    | ubuntu                     | parallel |
| E08  | a waiting lock step cut off by `timeout-minutes`                                                             | the lock step withdraws on the runner's signal; nothing left in the queue, before the post step runs                          | ubuntu, windows, macos     | parallel |
| E09  | a later step fails while holding                                                                             | no release; STALE after the job                                                                                               | ubuntu                     | parallel |
| E10  | a later step takes 75 s while holding                                                                        | not STALE: the heartbeats keep the lease                                                                                      | ubuntu, windows, macos     | parallel |
| E11  | a successful job without a release step                                                                      | the post step fails the job; STALE                                                                                            | ubuntu                     | parallel |
| E12  | new requests paused, resumed 30 s later                                                                      | the lock step waits through 503 and then acquires                                                                             | ubuntu                     | alone    |
| E13  | unexposed resource, wrong token, user without RemoteUse, `http://` URL (redirected), wrong context path      | 404 / 401 / 403 / redirect / 404, each at once and with its hint                                                              | ubuntu                     | parallel |
| E14  | —                                                                                                            | covered by running E01, E02, E08 and E10 on three OSes                                                                        | —                          | —        |
| E15  | a later step cut off by `timeout-minutes` while holding                                                      | like E09: no release; STALE                                                                                                   | ubuntu                     | parallel |
| E16  | release step with `if: always()`, a later step fails                                                         | released; FREE                                                                                                                | ubuntu                     | parallel |
| E17  | the heartbeat process is killed; release 70 s later                                                          | the release step finds the lease STALE and fails without releasing                                                            | ubuntu                     | parallel |
| E18  | the runner loses the server (iptables): 30 s while holding, 15 s during the release                          | heartbeat failures are recorded but the lease survives; the release retries and succeeds                                      | ubuntu                     | parallel |

Not covered: orderings other than priority (the server's job, covered by the
plugin's tests); behaviour across a Jenkins restart (remote records live in
memory and are lost, by the plugin's design); self-hosted runners (a
self-hosted runner on a public repository is a risk, so none is attached).

### 4.4 Results

| Plugin                        | Run                                                                                                           | Judge   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- |
| 1611.vd91dca_329d61 (latest)  | [45732853249](https://github.com/kohtaro-satoh/lockable-resources-remote-client-actions/actions/runs/45732853249) | 77 / 77 |
| 1560.va_b_cd589f23eb_         | [45733313311](https://github.com/kohtaro-satoh/lockable-resources-remote-client-actions/actions/runs/45733313311) | 77 / 77 |

(2026-11-26.) A run takes about 3 minutes. On both versions the audit trail
showed no resource held twice (76 events on 31 resources), and the priority
and Jenkins/Actions orders were as expected.

Learned on the way:

- The runner lists `GITHUB_ENV` variables, values included, in the log header
  of every later step. The first run's E02 check picked those up; the judge
  now looks only at the lock step's own lines, and the README warns about
  secrets in resource properties.
- Through the API, a step that failed on purpose concludes `failure`, a step
  cut off by `timeout-minutes` included. A job with job-level
  `continue-on-error` also concludes `failure`, while the run stays green.

### 4.5 Running them

See [e2e/server/README.md](../e2e/server/README.md): build the server, register
the variable and secrets, then

```sh
ssh ops@<host> lrrc-e2e/switch.sh 1560      # or latest
gh workflow run e2e.yml -f plugin=1560
```
