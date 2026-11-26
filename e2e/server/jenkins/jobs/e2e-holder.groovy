// E07's Jenkins side: hold one E2E resource with lock(), the way a pipeline
// sharing hardware with GitHub Actions would. Runs in the sandbox.
if (!(params.RESOURCE ==~ /e2e-[a-z0-9-]{1,60}/)) error "RESOURCE must be an e2e- resource: ${params.RESOURCE}"
if (!(params.SECONDS ==~ /[0-9]{1,3}/)) error "SECONDS must be 0..999: ${params.SECONDS}"

echo "E2E|waiting=${params.RESOURCE}"
lock(resource: params.RESOURCE) {
  echo "E2E|held=${params.RESOURCE}"
  sleep(time: Integer.parseInt(params.SECONDS), unit: 'SECONDS')
}
echo "E2E|released=${params.RESOURCE}"
