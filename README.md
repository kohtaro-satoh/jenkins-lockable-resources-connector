# lockable-resources-remote-client-actions

English | [日本語](README.ja.md)

A GitHub Action that locks resources defined on a Jenkins controller
(the [lockable-resources plugin](https://plugins.jenkins.io/lockable-resources/))
from a GitHub Actions job. The request joins the **same queue** as Jenkins
`lock()` steps, with the same ordering rules (priority, inversePrecedence) and
the same mutual exclusion, so pipelines and workflows can share hardware,
test environments or licenses safely.

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
      - uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
        id: lock
        with:
          token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
          label: plc
          quantity: 1
          variable: PLC
          timeout-for-allocate-resource: 30

      - run: ./flash.sh "$PLC0" # holds the lock

      # Required. Without it the lock is not released (see below).
      - uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
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
- uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
  id: lock
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: printer
    skip-if-locked: true
- if: steps.lock.outputs.acquired == 'true'
  run: ./print.sh
- uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
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
- uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
  id: board
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    label: board
    quantity: 1
    variable: BOARD
- uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
  id: license
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: compiler-license
- run: ./build-and-flash.sh "$BOARD0"
- uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.license.outputs.lock-id }}
- uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.board.outputs.lock-id }}
```

To take several resources atomically, as one request, use `extra` instead.

## Inputs

| Input                           | `lock()`                     | Default                               |
| ------------------------------- | ---------------------------- | ------------------------------------- |
| `server-url`                    | —                            | `$LOCKABLE_RESOURCES_SERVER_URL`      |
| `username`                      | —                            | `$LOCKABLE_RESOURCES_USERNAME`        |
| `token`                         | —                            | required, never from the environment  |
| `client-id`                     | —                            | `github-actions:<owner>/<repo>`       |
| `resource`                      | `resource`                   |                                       |
| `label`                         | `label`                      |                                       |
| `group`                         | `group`                      |                                       |
| `quantity`                      | `quantity`                   | `0` (all matching)                    |
| `variable`                      | `variable`                   |                                       |
| `inverse-precedence`            | `inversePrecedence`          | `false`                               |
| `resource-select-strategy`      | `resourceSelectStrategy`     | `SEQUENTIAL`                          |
| `skip-if-locked`                | `skipIfLocked`               | `false`                               |
| `extra`                         | `extra`                      | YAML or JSON list                     |
| `priority`                      | `priority`                   | `0`                                   |
| `timeout-for-allocate-resource` | `timeoutForAllocateResource` | `0` (wait forever)                    |
| `timeout-unit`                  | `timeoutUnit`                | `MINUTES`                             |
| `reason`                        | `reason`                     | `<workflow> #<run> (<job>) <run URL>` |

The release step (`/release`) takes `lock-id` and the same `server-url`,
`username` and `token`.

The action checks types and formats only. Whether a combination makes sense
(`resource` with `label`, `priority` with `inverse-precedence`, no target at
all) is decided by the server, which answers with the same message as a local
`lock()`.

```yaml
extra: |
  - resource: resource4
  - label: gpu
    quantity: 2
```

Set `timeout-for-allocate-resource`: waiting counts towards the job's time
limit and billing, and a request left behind by a runner that vanished then
expires on its own.

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

- A lock lives within one job. Lock in each job that needs it.
- Taking the same resource twice in one job makes the second request wait for
  the first (there is no `shareId`). Set a timeout.
- `server-id` (peer mode) and `share-id` are not supported: all locks go to the
  one server configured (delegated mode).

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
