const fs = require('fs')
const { performance } = require('perf_hooks')
const globby = require('globby')

const { mergeWithDefaultPolicies, createFileProcessor, buildCSPArray, splitToGlobalAndLocal, getCloudflareWorkerRoutes, updateCloudflareWorkerRoutes } = require('./functions.js')

module.exports = {
  onPostBuild: async ({ inputs }) => {
    const startTime = performance.now()

    const { buildDir, exclude, policies, disablePolicies, disableGeneratedPolicies } = inputs
    const mergedPolicies = mergeWithDefaultPolicies(policies)

    const htmlFiles = `${buildDir}/**/**.html`
    const excludeFiles = (exclude || []).map((filePath) => `!${filePath.replace(/^!/, '')}`)
    console.info(`Excluding ${excludeFiles.length} ${excludeFiles.length === 1 ? 'file' : 'files'}`)

    const lookup = [htmlFiles].concat(excludeFiles)
    const paths = await globby(lookup)
    const cloudflare_paths = []
    paths.forEach(path => {
      let res
      let pname = path.split('serve/')[1].split('.html')[0]
      if (pname.includes('/')) {
        res = `${pname.split('/')[0]}/*`
      } else {
        res = pname
      }
      if (!res.includes('index') && !res.includes('fonts') && !res.includes('files') && !res.includes('images')) {
        const staging_pattern = `staging.cfms.org/${res}`
        const production_pattern = `cfms.org/${res}`
        if (!cloudflare_paths.includes(staging_pattern)) {
          cloudflare_paths.push(staging_pattern)
          cloudflare_paths.push(`https://${staging_pattern}`)
        }
        if (!cloudflare_paths.includes(production_pattern)) {
          cloudflare_paths.push(production_pattern)
          cloudflare_paths.push(`https://${production_pattern}`)
        }
      }
    })

    console.info(`Found ${paths.length} HTML ${paths.length === 1 ? 'file' : 'files'}`)

    // const cloudflare_routes = await getCloudflareWorkerRoutes()
    // const updated_cloudflare_routes = cloudflare_paths.filter(function(path) {
    //   return this.findIndex(e => e.pattern === path) < 0
    // }, cloudflare_routes)
    //
    // if (Array.isArray(updated_cloudflare_routes) && updated_cloudflare_routes.length) {
    //   console.log(updated_cloudflare_routes)
    //   await updateCloudflareWorkerRoutes(updated_cloudflare_routes)
    // }

    const processFile = createFileProcessor(buildDir, disableGeneratedPolicies)

    const processedFileHeaders = await Promise.all(
      paths.map(path => fs.promises.readFile(path, 'utf-8').then(processFile(path)))
    )

    const { globalHeaders, localHeaders } = processedFileHeaders
      .reduce(splitToGlobalAndLocal, { globalHeaders: [], localHeaders: [] })

    const file = globalHeaders.concat(...localHeaders)
      .map(({ webPath, cspObject }) => {
        const cspString = buildCSPArray(mergedPolicies, disablePolicies, cspObject).join(' ')
        return `${webPath}\n  Content-Security-Policy: ${cspString}`
      }).join('\n')

    fs.appendFileSync(`${buildDir}/_headers`, file)

    const couplesMatchAppCSP = `\n/resources/couples-match-app/\n  Content-Security-Policy: default-src https: http: 'unsafe-eval' 'unsafe-inline'; object-src 'none';`
    fs.appendFileSync(`${buildDir}/_headers`, couplesMatchAppCSP)

    const completedTime = performance.now() - startTime
    console.info(`Saved at ${buildDir}/_headers - ${(completedTime / 1000).toFixed(2)} seconds`)
  },
}
