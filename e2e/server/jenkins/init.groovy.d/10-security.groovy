// Users, API tokens and permissions (docs/PLAN.md §10.3).
//
// The secrets come from the host (secrets.env, made by 04-jenkins.sh) rather
// than being generated here, so the Jenkins of either plugin version accepts
// the same tokens and the GitHub secrets do not change on a switch.
//
// Permissions are set first: with the setup wizard off, a Jenkins whose
// security script stops halfway is open to anyone. switch.sh also stops the
// container unless the last line below was printed.
import hudson.model.Item
import hudson.model.User
import hudson.security.GlobalMatrixAuthorizationStrategy
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.csrf.DefaultCrumbIssuer
import jenkins.model.Jenkins
import jenkins.model.JenkinsLocationConfiguration
import jenkins.security.ApiTokenProperty
import org.jenkins.plugins.lockableresources.actions.LockableResourcesRootAction
import org.jenkinsci.plugins.matrixauth.PermissionEntry

def env = System.getenv()
def need = { String name ->
  def value = env[name]
  if (!value) throw new IllegalStateException("${name} is not set (secrets.env)")
  value
}

def j = Jenkins.get()
def realm = j.securityRealm instanceof HudsonPrivateSecurityRealm ? j.securityRealm : new HudsonPrivateSecurityRealm(false)
j.securityRealm = realm

def account = { String id, String password ->
  if (User.getById(id, false) == null) realm.createAccount(id, password)
  def user = User.getById(id, false)
  user.addProperty(HudsonPrivateSecurityRealm.Details.fromPlainPassword(password))
  user
}

def ids = ['e2e-robot', 'e2e-ops', 'e2e-norights']
def strategy = new GlobalMatrixAuthorizationStrategy()
def entry = { String id -> PermissionEntry.user(id) }
strategy.add(Jenkins.ADMINISTER, entry('admin'))
ids.each { strategy.add(Jenkins.READ, entry(it)) }
// What README asks for: Overall/Read plus Lockable Resources/RemoteUse.
strategy.add(LockableResourcesRootAction.REMOTE, entry('e2e-robot'))
// Starts e2e-admin and e2e-holder; cannot change them (no Job/Configure).
strategy.add(Item.READ, entry('e2e-ops'))
strategy.add(Item.BUILD, entry('e2e-ops'))
j.authorizationStrategy = strategy
j.save()

account('admin', need('E2E_ADMIN_PASSWORD'))

def tokens = [
  'e2e-robot'   : need('E2E_ROBOT_TOKEN'),
  'e2e-ops'     : need('E2E_OPS_TOKEN'),
  'e2e-norights': need('E2E_NORIGHTS_TOKEN'),
]
tokens.each { id, token ->
  // Nobody logs in with these passwords; the users work with their tokens.
  def user = account(id, UUID.randomUUID().toString() + UUID.randomUUID().toString())
  def store = user.getProperty(ApiTokenProperty).tokenStore
  store.tokenListSortedByName.findAll { it.name == 'e2e' }.each { store.revokeToken(it.uuid) }
  // Jenkins 2.5xx added an expiry date; null means the token does not expire.
  if (store.metaClass.respondsTo(store, 'addFixedNewToken', String, String, java.time.LocalDate)) {
    store.addFixedNewToken('e2e', token, (java.time.LocalDate) null)
  } else {
    store.addFixedNewToken('e2e', token)
  }
  user.save()
}

j.crumbIssuer = new DefaultCrumbIssuer(true)
j.slaveAgentPort = -1
j.numExecutors = 2
j.save()

def location = JenkinsLocationConfiguration.get()
location.url = "https://${need('E2E_DOMAIN')}/jenkins/"
location.save()

println '[e2e] users, tokens and permissions set'
