// Remote API, the resources each E2E case uses, and the audit trail
// (docs/PLAN.md §10.3). Each case has resources of its own, so cases running
// in parallel never wait for each other.
import java.util.logging.FileHandler
import java.util.logging.Formatter
import java.util.logging.Level
import java.util.logging.LogRecord
import java.util.logging.Logger
import org.jenkins.plugins.lockableresources.LockableResourceProperty
import org.jenkins.plugins.lockableresources.LockableResourcesManager

def lrm = LockableResourcesManager.get()
lrm.remoteApiEnabled = true
lrm.exposeLabel = 'e2e'
lrm.acceptNewAcquires = true

def oses = ['ubuntu', 'windows', 'macos']
def defs = []
def add = { String name, String labels = 'e2e', Map props = [:] -> defs << [name: name, labels: labels, props: props] }

oses.each { os ->
  add("e2e-basic-${os}")                        // E01
  // E02: a pool with properties. The values are distinctive so the judge can
  // check the lock step never prints them.
  (1..2).each { i ->
    add("e2e-pool-${os}-${i}", "e2e e2e-pool-${os}", [IP: "203.0.113.${oses.indexOf(os) * 10 + i}", ROLE: "e2e-role-${os}-${i}"])
  }
  add("e2e-cancel-${os}")                       // E08
  add("e2e-long-${os}")                         // E10
}
add('e2e-extra-1')                               // E03
(1..2).each { add("e2e-xpool-${it}", 'e2e e2e-xpool') }
add('e2e-busy-1')                                // E04
add('e2e-busy-2')                                // E05
add('e2e-shared-1')                              // E06
add('e2e-shared-2')                              // E06p
add('e2e-interop-1')                             // E07: Actions waits for Jenkins
add('e2e-interop-2')                             // E07: Jenkins waits for Actions
(1..5).each { add("e2e-fail-${it}") }            // E09, E11, E15, E16, E17
add('e2e-maint-1')                               // E12
add('e2e-net-1')                                 // E18
add('private-1', 'not-exposed')                  // E13: exists, but has no e2e label

defs.each { d ->
  if (lrm.fromName(d.name) == null) lrm.createResource(d.name)
  def r = lrm.fromName(d.name)
  r.ephemeral = false
  r.labels = d.labels
  r.properties = d.props.collect { k, v ->
    def p = new LockableResourceProperty()
    p.name = k
    p.value = v
    p
  }
}
lrm.save()

// The plugin writes one line per change of hands (LRA|epochMs|kind|event|resource|holder)
// to this logger when it is at FINE. The judge reads it through e2e-admin to show
// that no resource was ever held twice; client logs cannot show that.
def audit = Logger.getLogger('org.jenkins.plugins.lockableresources.audit')
audit.level = Level.FINE
audit.useParentHandlers = false
audit.handlers.each { audit.removeHandler(it) }
def handler = new FileHandler(new File(System.getenv('JENKINS_HOME'), 'lr-audit.log').path, 0, 1, true)
handler.level = Level.FINE
handler.formatter = new Formatter() {
  String format(LogRecord record) { record.message + System.lineSeparator() }
}
audit.addHandler(handler)

println "[e2e] remote API on, ${defs.size()} resources, audit trail on"
