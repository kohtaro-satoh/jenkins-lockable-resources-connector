# E2E server

English | [日本語](README.ja.md)

The Jenkins that `.github/workflows/e2e.yml` tests against (design:
[docs/testing.md §4](../../docs/testing.md#4-end-to-end-tests)). A throwaway
VPS (Ubuntu 26.04, 1 GB of memory) that runs only while tests run.

## Build it

On a fresh VPS whose root accepts your SSH key, with the domain's A record
pointing at it and 22/80/443 open in the provider's firewall:

```sh
scp -r e2e/server root@<host>:lrrc-e2e
ssh root@<host> bash lrrc-e2e/01-bootstrap.sh   # user ops, ufw, updates
scp -r e2e/server ops@<host>:lrrc-e2e
ssh ops@<host> bash lrrc-e2e/02-lockdown.sh     # no root or password login
ssh ops@<host> bash lrrc-e2e/03-docker.sh       # Docker
ssh ops@<host> bash lrrc-e2e/04-jenkins.sh <domain> latest   # Caddy + Jenkins
```

Then register in the repository settings:

| Kind     | Name                 | Value                                         |
| -------- | -------------------- | --------------------------------------------- |
| Variable | `E2E_SERVER_URL`     | `https://<domain>/jenkins`                    |
| Secret   | `E2E_ROBOT_TOKEN`    | `E2E_ROBOT_TOKEN` in `~/lrrc-e2e/secrets.env` |
| Secret   | `E2E_OPS_TOKEN`      | `E2E_OPS_TOKEN` in the same file              |
| Secret   | `E2E_NORIGHTS_TOKEN` | `E2E_NORIGHTS_TOKEN` in the same file         |

`secrets.env` is made once on the server and never leaves it except into those
secrets. The admin password in it is for SSH-side maintenance only.

## Run the tests

```sh
ssh ops@<host> lrrc-e2e/switch.sh 1560      # or latest; REBUILD=1 for a newer latest
gh workflow run e2e.yml -f plugin=1560
```

Only one Jenkins fits in memory, so each plugin version is a separate run.

## Notes

- Jenkins listens on 127.0.0.1 only; Caddy (Let's Encrypt) is the way in.
- A new JENKINS_HOME starts locked (`jenkins/config.xml`); the init scripts
  then add the users and permissions. `switch.sh` stops Jenkins if they did not
  all finish, because the setup wizard is off and an unconfigured Jenkins
  would be open to anyone.
- `e2e-admin` is the only way CI gets administrator operations; see
  `jenkins/jobs/e2e-admin.groovy`.
- To watch a run on the Jenkins pages, log in as `admin`; the password is
  `E2E_ADMIN_PASSWORD` in `secrets.env` (read it over SSH). Do not lock,
  reserve or reset `e2e-` resources by hand during a run. Each version has its
  own JENKINS_HOME, so log in again after a switch.
