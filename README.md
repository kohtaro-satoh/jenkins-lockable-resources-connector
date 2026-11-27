# jenkins-lockable-resources-connector

English | [日本語](README.ja.md)

A GitHub Action that locks resources defined on a Jenkins controller
(the [lockable-resources plugin](https://plugins.jenkins.io/lockable-resources/))
from a GitHub Actions job. The request joins the **same queue** as Jenkins
`lock()` steps, with the same ordering rules (priority, inversePrecedence) and
the same mutual exclusion, so GitHub Actions workflows and Jenkins pipelines
can share hardware, test environments or licenses safely.

> **Status: pre-release (0.x).** Tested end to end against lockable-resources
> 1560 and 1611 from GitHub-hosted Linux, Windows and macOS runners
> ([docs/testing.md](docs/testing.md)). Inputs and behaviour may still change
> before 1.0.

## Requirements

- lockable-resources **1560.va_b_cd589f23eb_** or later on the Jenkins side
  (1588 or later for the `group` input).
- A runner that can reach Jenkins over the network (a self-hosted runner for
  an internal Jenkins).

### Jenkins set-up

As described in the plugin README's remote section:

1. Turn the remote API on and set an **expose label**; add that label to the
   resources GitHub Actions may lock.
2. Create a dedicated user with **Overall/Read** and **Lockable
   Resources/RemoteUse**, nothing more.
3. Create an **API token** for that user. A password does not work (it fails
   the CSRF crumb check).

## Usage

```yaml
jobs:
  flash:
    runs-on: [self-hosted, lab]
    env:
      LOCKABLE_RESOURCES_SERVER_URL: ${{ vars.LOCKABLE_RESOURCES_SERVER_URL }}
      LOCKABLE_RESOURCES_USERNAME: ${{ vars.LOCKABLE_RESOURCES_USERNAME }}
    steps:
      - uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
        id: lock
        with:
          token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
          label: plc
          quantity: 1
          variable: PLC
          timeout-for-allocate-resource: 30

      - run: ./flash.sh "$PLC0" # holds the lock

      # Required. Without it the lock is not released (see below).
      - uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
        with:
          token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
          lock-id: ${{ steps.lock.outputs.lock-id }}

      - run: ./report.sh # lock released
```

Put the server URL and user in organization or repository **variables** and
let the action read them from the environment, so workflows do not each name a
server. The token is the exception: it is only read from the `token` input, so
it never sits in a job-level `env:` where every step (third-party actions
included) could read it.

### What happens when a job fails

**Only the release step frees a lock.** If a step fails, or the job is
cancelled, while the lock is held, the release step does not run, and the
action's post step stops the heartbeats **without releasing**. About 60 s later
Jenkins marks the lease **STALE** and keeps the resources until an
administrator has checked them and releases the lease on the Jenkins page.
Nobody knows what state a failed job left the hardware in, so a person looks
before the next job gets it.

This differs from Jenkins `lock()`, which releases when its block ends, even on
failure. To get that behaviour, run the release step with `if: always()`. Do
this only where the resources need no checking after a failure.

The release step also refuses to release a lease that is already STALE (its
heartbeats were missing for 60 s while the job ran) and fails instead.

A request still waiting in the queue when the job fails or is cancelled is
withdrawn, since no step has touched the resources yet.

### skip-if-locked

```yaml
- uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
  id: lock
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: printer
    skip-if-locked: true
- if: steps.lock.outputs.acquired == 'true'
  run: ./print.sh
- uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.lock.outputs.lock-id }}
```

The step succeeds with `acquired=false` when the resource is busy; the release
step accepts that lock ID and does nothing.

### Several locks

Call the action once per lock, each with its own `id`, `variable` and release
step:

```yaml
- uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
  id: board
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    label: board
    quantity: 1
    variable: BOARD
- uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
  id: license
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: compiler-license
- run: ./build-and-flash.sh "$BOARD0"
- uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.license.outputs.lock-id }}
- uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.board.outputs.lock-id }}
```

To take several resources atomically, as one request, use `extra` instead.

## Inputs

Defaults and choices are those of lockable-resources 1611.vd91dca_329d61.
Choice values are not case sensitive (`random` works too).

| Input                           | Default                               | Description                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connection**                  |                                       |                                                                                                                                                                                                                                                                                                            |
| `server-url`                    | `$LOCKABLE_RESOURCES_SERVER_URL`      | Root URL of Jenkins, including the context path, for example `https://ci.example.com/jenkins`.                                                                                                                                                                                                             |
| `username`                      | `$LOCKABLE_RESOURCES_USERNAME`        | Jenkins user with the **Overall/Read** and **Lockable Resources/RemoteUse** permissions.                                                                                                                                                                                                                   |
| `token`                         | (required)                            | API token of that user, not its password. Pass it from a secret: it is never read from the environment.                                                                                                                                                                                                    |
| **What to lock**                |                                       | Set `resource`, `label` or `group`, or list everything in `extra`.                                                                                                                                                                                                                                         |
| `resource`                      |                                       | Name of the resource to lock, as listed on the Jenkins _Lockable Resources_ page. It must exist there and carry the expose label: unlike a `lock()` in a pipeline, a missing resource is not created. Cannot be combined with `label`.                                                                     |
| `label`                         |                                       | Choose resources by label instead of by name. A label expression works too, such as `gpu && linux` or `board-a \|\| board-b`. Only resources that carry the expose label are considered. Set `quantity` to say how many. Cannot be combined with `resource`.                                               |
| `quantity`                      | `0`                                   | How many of the resources matching `label` (or `group`) to lock. `0` locks **all** of them, so the step waits until every one is free. To take one free resource out of a pool, set `1`.                                                                                                                   |
| `group`                         | `common`                              | Choose resources only from this resource group (lockable-resources 1588 or later). `resource` and `label` are matched within the group, with no fallback to other groups. With `group` alone (no `resource` or `label`), the whole group is the pool and `quantity` counts its members.                    |
| `extra`                         |                                       | More resources to lock in the same request, all at once or none: a YAML (or JSON) list of entries, each with `resource` or `label`, and optionally `quantity` and `group` (an entry without `group` uses the main `group`). See the example below.                                                         |
| `resource-select-strategy`      | `SEQUENTIAL`                          | Which free resources to take when more match than needed. `SEQUENTIAL`: in the order of the Jenkins resources list. `RANDOM`: in random order.                                                                                                                                                             |
| **Waiting in the queue**        |                                       |                                                                                                                                                                                                                                                                                                            |
| `priority`                      | `0`                                   | Order among requests waiting for the same resources: the highest number is served first, equal numbers in order of arrival. Negative numbers wait behind the default `0`. Cannot be combined with `inverse-precedence`.                                                                                    |
| `inverse-precedence`            | `false`                               | `true`: jump the queue. Requests with `true` are served before the others, and among them the newest first. Cannot be combined with `priority`.                                                                                                                                                            |
| `skip-if-locked`                | `false`                               | `true`: do not wait. If the resources cannot be locked at once, the step locks nothing and succeeds with the output `acquired` set to `false`. Check it in later steps: `if: steps.<id>.outputs.acquired == 'true'`.                                                                                       |
| `timeout-for-allocate-resource` | `0`                                   | Stop waiting after this long, in `timeout-unit`; the step then fails with `LOCK_WAIT_TIMEOUT`. `0` waits without limit. Setting it is recommended: waiting counts towards the job's time limit and billing, and a request left behind by a runner that vanished then expires on its own.                   |
| `timeout-unit`                  | `MINUTES`                             | Unit of `timeout-for-allocate-resource`: `SECONDS`, `MINUTES` or `HOURS`. The other Java `TimeUnit` names (`DAYS`, `MILLISECONDS`, ...) work too, but the plugin documents only these three.                                                                                                               |
| **While the lock is held**      |                                       |                                                                                                                                                                                                                                                                                                            |
| `variable`                      |                                       | Name of an environment variable for later steps. It gets the names of the locked resources, comma separated; `<variable>0`, `<variable>1`, ... get each name and its properties (see [Outputs and environment variables](#outputs-and-environment-variables)). Must not start with `GITHUB_` or `RUNNER_`. |
| `reason`                        | `<workflow> #<run> (<job>) <run URL>` | Shown on the Jenkins _Lockable Resources_ page while the lock is held, so that others can see why the resource is busy.                                                                                                                                                                                    |
| `client-id`                     | `github-actions:<owner>/<repo>`       | Shown next to the lock on the Jenkins page, to tell which client holds it.                                                                                                                                                                                                                                 |

The release step (`/release`) takes `lock-id` and the same `server-url`,
`username` and `token`.

The action checks types and formats only. Whether a combination makes sense
(`resource` with `label`, `priority` with `inverse-precedence`, nothing to
lock) is decided by the server, which answers with the same message as a local
`lock()`.

`extra` example: lock `resource4` and two resources labelled `gpu`, together
with the main `resource` or `label`:

```yaml
extra: |
  - resource: resource4
  - label: gpu
    quantity: 2
```

## Outputs and environment variables

| Output      | Content                                   |
| ----------- | ----------------------------------------- |
| `lock-id`   | lock ID issued by the server              |
| `state`     | `ACQUIRED` or `SKIPPED`                   |
| `acquired`  | `true` / `false`                          |
| `resources` | JSON array of the locked resource names   |
| `env-vars`  | JSON object of the server's `lockEnvVars` |

With `variable: PLC`, later steps get `PLC`, `PLC0`, `PLC0_<property>` and
`PLC_<property>` (the first resource's properties), ... as environment
variables, as in a Jenkins `lock()` block.

The action never prints property values, but the runner lists every variable
set through `GITHUB_ENV` in the log header of each later step, values
included. They are not masked, so keep secrets out of resource properties.

## Limits

- A lock is valid within one job (one entry under `jobs:`).
  - The heartbeats stop automatically when the job ends. If the job has not
    run the release step by then, the lease becomes STALE.
  - Put all the steps that need to hold the locked resources without a break
    into one job.
- Some `lock()` parameters have no input here, because the remote API does not
  take them: `serverId` (all locks go to the one configured server, as in
  delegated mode), `shareId`, and, since 1611, `candidates`, `onReleaseDelay`
  and `onCancelDelay`.

## Troubleshooting

| Failure                                        | Usual cause                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| HTTP 401                                       | wrong user name or token, or a password instead of an API token                             |
| HTTP 403                                       | the user lacks Overall/Read or Lockable Resources/RemoteUse, or the remote API is off       |
| HTTP 404 `UNKNOWN_RESOURCE` / `UNKNOWN_LABEL`  | the resource or label does not exist or lacks the expose label                              |
| HTTP 404 without an error code                 | `server-url` is wrong (check the context path, such as `/jenkins`) or the plugin is too old |
| "The server redirected"                        | `server-url` is not the final URL (for example `http://` redirected to `https://`)          |
| `LOCK_WAIT_TIMEOUT`                            | `timeout-for-allocate-resource` expired before the resources were free                      |
| "not accepting new acquire requests" (503)     | the server is paused for maintenance; the action waits until it resumes or the timeout      |
| "is STALE on the server" from the release step | heartbeats were missing for 60 s; an administrator must check and release the lease         |
| the post step fails: lock not released         | the release step did not run; the lease becomes STALE (see above)                           |
| empty `token`                                  | secrets are not passed to pull requests from forks                                          |

## Security

- The token is masked in logs, never written to disk, and handed to the
  heartbeat process through its environment, not its command line.
- `http://` URLs work but print a warning: Basic authentication sends the
  token in clear text.
- Redirects are not followed, so credentials never go to another URL.
- For a self-signed certificate set `NODE_EXTRA_CA_CERTS`; there is no option
  to turn certificate checks off.
- Pin the action to a commit SHA rather than a tag.

## How it works

The lock step enqueues the request, polls every 3 s until it is granted, then
starts a detached heartbeat process (one heartbeat every 10 s) that outlives
the step, exports the environment variables and ends. The release step checks
that the lease is not STALE, sends the release, retrying for about 60 s while
heartbeats continue, and then stops the heartbeat process. The post step stops
the heartbeat process if it is still running and withdraws a request that was
never handed over.

- [docs/design.md](docs/design.md): the design and the reasons behind it
- [docs/testing.md](docs/testing.md): unit, integration, runner-behaviour and
  end-to-end tests, with results
- [CHANGELOG.md](CHANGELOG.md)

## Development

```sh
npm ci
npm run lint && npm run typecheck
npm test                 # unit tests
npm run package          # bundle dist/ (commit it)
npm run test:integration # main -> daemon -> release -> post against a fake server
```

The end-to-end tests need a Jenkins of their own; see
[e2e/server/README.md](e2e/server/README.md).

## License

[MIT](LICENSE). The bundle in `dist/` includes third-party packages, all under
the MIT License; their notices are in [dist/licenses.txt](dist/licenses.txt),
which `npm run package` regenerates. A bundled package under a licence outside
a short permissive list (MIT, ISC, BSD, Apache-2.0) fails the build.
