# The E2E Jenkins (docs/testing.md §4): Jenkins LTS with one version of
# lockable-resources and the few plugins the tests need. switch.sh builds one
# image per plugin version; only one runs at a time (1 GB of memory).
ARG JENKINS_TAG=lts-jdk21
FROM jenkins/jenkins:${JENKINS_TAG}

ARG LR_VERSION=latest
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt \
      --plugins "lockable-resources:${LR_VERSION}"

# Locked until the init scripts have set up users and permissions.
COPY config.xml /usr/share/jenkins/ref/config.xml

# .override: copied into JENKINS_HOME on every start, so a rebuilt image
# brings its settings along instead of keeping the first ones forever.
COPY init.groovy.d/ /usr/share/jenkins/ref/init.groovy.d/
RUN cd /usr/share/jenkins/ref/init.groovy.d && for f in *.groovy; do mv "$f" "$f.override"; done
COPY jobs/ /usr/share/jenkins/e2e/

ENV JENKINS_OPTS="--prefix=/jenkins"
