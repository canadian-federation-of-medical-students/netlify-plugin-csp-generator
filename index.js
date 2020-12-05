const fs = require('fs')
const { performance } = require('perf_hooks')
const globby = require('globby')

const ZONE_ID = '18dd9bb322c89b03ba35b377c84d33c0';

const { mergeWithDefaultPolicies, createFileProcessor, buildCSPArray, splitToGlobalAndLocal } = require('./functions.js')

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
      let res = `https://*.cfms.org/${path.split('.html')[0].split('serve/')[1]}`
      if (res.includes('/index')) {
        cloudflare_paths.push(res.split('/index')[0])
        cloudflare_paths.push(res.split('index')[0])
      } else {
        cloudflare_paths.push(res)
      }
    })

    console.info(`Found ${paths.length} HTML ${paths.length === 1 ? 'file' : 'files'}`)

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
