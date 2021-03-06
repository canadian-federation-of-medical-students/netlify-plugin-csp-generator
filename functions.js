const { sha256 } = require('js-sha256')
const { JSDOM } = require('jsdom')
const fs = require('fs')
const axios = require('axios')

const ZONE_ID = process.env.ZONE_ID;
const CLOUDFLARE_TOKEN = process.env.CLOUDFLARE_TOKEN;

console.log(`Using cloudflare zone: ${ZONE_ID}`)
console.log(`Using cloudflare token: ${CLOUDFLARE_TOKEN}`)

function mergeWithDefaultPolicies (policies) {
  const defaultPolicies = {
    defaultSrc: '',
    childSrc: '',
    connectSrc: '',
    fontSrc: '',
    frameSrc: '',
    imgSrc: '',
    manifestSrc: '',
    mediaSrc: '',
    objectSrc: '',
    prefetchSrc: '',
    scriptSrc: '',
    scriptSrcElem: '',
    scriptSrcAttr: '',
    styleSrc: '',
    styleSrcElem: '',
    styleSrcAttr: '',
    workerSrc: '',
    baseUri: '',
    formAction: '',
    frameAncestors: '',
  }

  return {...defaultPolicies, ...policies}
}

function createFileProcessor (buildDir, disableGeneratedPolicies) {
  return path => file => {
    const dom = new JSDOM(file)
    const shouldGenerate = (key) => !(disableGeneratedPolicies || []).includes(key)
    const generateHashesFromElement = generateHashes(dom, element => element.innerHTML)
    const generateHashesFromStyle = generateHashes(dom, element => element.getAttribute('style'))
    const generateNonce = insertNonce(dom)

    generateNonce('script')
    generateNonce('link[rel=stylesheet]')
    generateNonce('style')
    generateNonce('[style]')
    const styles = shouldGenerate('styleSrc') ? generateHashesFromElement('style') : []
    const inlineStyles = shouldGenerate('styleSrc') ? generateHashesFromStyle('[style]') : []

    const indexMatcher = new RegExp(`^${buildDir}(.*)index\\.html$`)
    const nonIndexMatcher = new RegExp(`^${buildDir}(.*\\/).*?\\.html$`)

    let webPath = null
    let globalCSP = null
    if (path.match(indexMatcher)) {
      webPath = path.replace(indexMatcher, '$1')
      globalCSP = false
    } else {
      webPath = path.replace(nonIndexMatcher, '$1*')
      globalCSP = true
    }

    const cspObject = {
      scriptSrc: [],
      styleSrc: [...inlineStyles, ...styles],
    }

    fs.writeFile(path, dom.serialize(), ()=>{});

    return {
      webPath,
      cspObject,
      globalCSP,
    }
  }
}

function generateHashes (dom, getPropertyValue) {
  return selector => {
    const hashes = new Set()
    for (const matchedElement of dom.window.document.querySelectorAll(selector)) {
      const value = getPropertyValue(matchedElement)
      if (value.length) {
        const hash = sha256.arrayBuffer(value)
        const base64hash = Buffer.from(hash).toString('base64')
        hashes.add(`'sha256-${base64hash}'`)
      }
    }
    return Array.from(hashes)
  }
}

function insertNonce (dom) {
  return selector => {
    for (const matchedElement of dom.window.document.querySelectorAll(selector)) {
      let att = dom.window.document.createAttribute('nonce');
      att.value = '41SWRENqnTUAb6n3';
      matchedElement.setAttributeNode(att);
    }
  }
}

function buildCSPArray (allPolicies, disablePolicies, hashes) {
  const disabled = disablePolicies || []

  return Object.entries(allPolicies).reduce((final, [key, defaultPolicy]) => {
    const policyHashes = hashes[key]
    const generatedOrDefault = (policyHashes && policyHashes.length) || defaultPolicy
    const notDisabled = !disabled.includes(key)

    if (notDisabled && generatedOrDefault) {
      const policy = `${policyHashes && policyHashes.join(' ') || ''} ${defaultPolicy}`
      final.push(`${camelCaseToKebabCase(key)} ${policy.trim()};`)
    }

    return final
  }, [])
}

function camelCaseToKebabCase (string) {
  return string.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function splitToGlobalAndLocal (final, header) {
  if (header.globalCSP) {
    const existingIndex = final.globalHeaders.findIndex(({ webPath }) => webPath === header.webPath)
    if (existingIndex !== -1) {
      final.globalHeaders[existingIndex].cspObject = mergeCSPObjects(final.globalHeaders, existingIndex, header.cspObject)
    } else {
      final.globalHeaders.push(header)
    }
  } else {
    final.localHeaders.push(header)
  }

  return final
}

function mergeCSPObjects (mergeInto, index, mergeFrom) {
  const newObject = {}
  Object.keys(mergeInto[index].cspObject)
    .forEach(key => {
      newObject[key] = [].concat(...mergeInto[index].cspObject[key], ...mergeFrom[key])
    })
  return newObject
}

async function getCloudflareWorkerRoutes() {
  const config = {
    method: 'get',
    url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': CLOUDFLARE_TOKEN,
    }
  };

  const res = await axios(config)

  return res.data.result
}

async function updateCloudflareWorkerRoutes(routes) {
  const requests = [];

  for (const route of routes) {
    const data = JSON.stringify({"pattern":route,"script":"nonce"});
    const config = {
      method: 'post',
      url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': CLOUDFLARE_TOKEN,
      },
      data : data
    };
    requests.push(axios(config))
  }
  return await axios.all(requests)
}

module.exports = {
  mergeWithDefaultPolicies,
  createFileProcessor,
  buildCSPArray,
  splitToGlobalAndLocal,
  getCloudflareWorkerRoutes,
  updateCloudflareWorkerRoutes,
}
