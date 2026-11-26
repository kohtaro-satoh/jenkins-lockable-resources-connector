// The two jobs CI starts as e2e-ops (docs/testing.md §4). Their scripts come
// from the image (/usr/share/jenkins/e2e), so e2e-ops can run them but not
// change them.
//
//   e2e-admin   system Groovy: the few administrator operations the tests need
//   e2e-holder  Pipeline: holds a resource with lock() (E07's Jenkins side)
import hudson.model.FreeStyleProject
import hudson.model.ParametersDefinitionProperty
import hudson.model.StringParameterDefinition
import hudson.plugins.groovy.StringSystemScriptSource
import hudson.plugins.groovy.SystemGroovy
import jenkins.model.Jenkins
import org.jenkinsci.plugins.scriptsecurity.sandbox.groovy.SecureGroovyScript
import org.jenkinsci.plugins.scriptsecurity.scripts.ScriptApproval
import org.jenkinsci.plugins.scriptsecurity.scripts.languages.GroovyLanguage
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
import org.jenkinsci.plugins.workflow.job.WorkflowJob

def j = Jenkins.get()
def dir = new File('/usr/share/jenkins/e2e')
def params = { List<String> names ->
  new ParametersDefinitionProperty(names.collect { new StringParameterDefinition(it, '', '') })
}

def adminScript = new File(dir, 'e2e-admin.groovy').text
def admin = j.getItem('e2e-admin') ?: j.createProject(FreeStyleProject, 'e2e-admin')
admin.removeProperty(ParametersDefinitionProperty)
// NONCE keeps Jenkins from merging two identical requests into one build.
admin.addProperty(params(['OP', 'ARG', 'NONCE']))
admin.buildersList.clear()
admin.buildersList.add(new SystemGroovy(new StringSystemScriptSource(new SecureGroovyScript(adminScript, false, null))))
admin.concurrentBuild = true
admin.quietPeriod = 0
admin.buildDiscarder = new hudson.tasks.LogRotator(-1, 500, -1, -1)
admin.save()
// Written by an administrator (this image), so approved up front.
ScriptApproval.get().preapprove(adminScript, GroovyLanguage.get())

def holder = j.getItem('e2e-holder') ?: j.createProject(WorkflowJob, 'e2e-holder')
holder.removeProperty(ParametersDefinitionProperty)
holder.addProperty(params(['RESOURCE', 'SECONDS', 'NONCE']))
holder.definition = new CpsFlowDefinition(new File(dir, 'e2e-holder.groovy').text, true)
holder.quietPeriod = 0
holder.buildDiscarder = new hudson.tasks.LogRotator(-1, 200, -1, -1)
holder.save()

println '[e2e] jobs e2e-admin and e2e-holder ready'
