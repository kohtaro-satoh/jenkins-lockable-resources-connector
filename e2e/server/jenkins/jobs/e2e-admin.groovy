// The administrator operations the E2E tests need (docs/testing.md §4),
// started by CI as e2e-ops with OP and ARG. Results are lines starting with
// "E2E|" in the console output. Only the operations below exist, and ARG is
// checked before use: e2e-ops must not get more than this.
//
// Bindings (groovy plugin, system Groovy): build, listener, out.
import jenkins.model.Jenkins
import org.jenkins.plugins.lockableresources.LockableResourcesManager
import org.jenkins.plugins.lockableresources.remote.RemoteLockManager

def env = build.getEnvironment(listener)
def op = (env['OP'] ?: '').trim()
def arg = (env['ARG'] ?: '').trim()
def say = { String line -> out.println('E2E|' + line) }
def fail = { String message -> throw new IllegalArgumentException(message) }
def resourceArg = { ->
  if (!(arg ==~ /e2e-[a-z0-9-]{1,60}/)) fail("ARG must be an e2e- resource: ${arg}")
  arg
}

def lrm = LockableResourcesManager.get()
def rlm = RemoteLockManager.get()
// The plugin keeps the records in a private map and has no listing API.
def records = { -> rlm.@records.values().toList() }
def requested = { req -> ([req?.resource] + (req?.extra ?: []).collect { it.resource }).findAll { it } }
def e2eResources = { -> lrm.resources.findAll { it.name.startsWith('e2e-') } }

switch (op) {
  case 'version':
    say('version=' + Jenkins.get().pluginManager.getPlugin('lockable-resources').version)
    say('acceptNewAcquires=' + lrm.acceptNewAcquires)
    break

  case 'reset':
    // Back to a clean server between runs: no remote lease, no waiting
    // request, no holder build, nothing locked, new requests accepted.
    records().findAll { it.state.name() in ['QUEUED', 'ACQUIRED', 'STALE'] }.each {
      rlm.release(it.lockId)
      say("released=${it.lockId} state=${it.state}")
    }
    def holder = Jenkins.get().getItem('e2e-holder')
    holder?.builds?.findAll { it.building }?.each {
      it.doStop()
      say("stopped=e2e-holder#${it.number}")
    }
    sleep(2000)
    def stuck = e2eResources().findAll { it.locked || it.reserved }
    if (stuck) {
      lrm.reset(stuck)
      stuck.each { say("reset=${it.name}") }
    }
    lrm.acceptNewAcquires = true
    lrm.save()
    say('reset=done')
    break

  case 'queue':
    // Requests waiting for one resource: remote (QUEUED records) and local
    // (lock() steps of pipelines).
    def name = resourceArg()
    def remote = records().count { it.state.name() == 'QUEUED' && name in requested(it.lockRequest) }
    def local = lrm.currentQueuedContext.count { ctx -> ctx.resources.any { s -> s.required?.any { it.name == name } } }
    say("queue=${remote + local}")
    say("remote=${remote}")
    say("local=${local}")
    break

  case 'accept':
    if (!(arg in ['true', 'false'])) fail("ARG must be true or false: ${arg}")
    lrm.acceptNewAcquires = arg == 'true'
    lrm.save()
    say("acceptNewAcquires=${lrm.acceptNewAcquires}")
    break

  case 'release-stale':
    // The administrator's clean-up after E09, E11, E15 and E17.
    records().findAll { it.state.name() == 'STALE' }.each {
      rlm.release(it.lockId)
      say("released=${it.lockId} resources=${it.acquiredResourceNames}")
    }
    say('release-stale=done')
    break

  case 'records':
    records().sort { it.enqueuedAt }.each {
      say("record=${it.lockId} state=${it.state} errorCode=${it.errorCode} clientId=${it.clientId} resources=${it.acquiredResourceNames}")
    }
    break

  case 'audit':
    // Audit lines since ARG (epoch ms).
    if (!(arg ==~ /[0-9]{13}/)) fail("ARG must be epoch milliseconds: ${arg}")
    def since = Long.parseLong(arg)
    def file = new File(Jenkins.get().rootDir, 'lr-audit.log')
    if (file.exists()) {
      file.eachLine { line ->
        def parts = line.split('\\|')
        if (parts.length >= 6 && parts[0] == 'LRA' && Long.parseLong(parts[1]) >= since) say('audit=' + line)
      }
    }
    say('audit=done')
    break

  default:
    fail("unknown OP: ${op}")
}
