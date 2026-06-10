import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const PACKAGE_ROOT = path.resolve(process.cwd())
const POLICY_FILE = path.join(PACKAGE_ROOT, 'license-policy.json')
const NOTICES_FILE = path.join(PACKAGE_ROOT, 'THIRD_PARTY_NOTICES.md')

function readJson(filePath) {
  return fs.readFile(filePath, 'utf8').then((content) => JSON.parse(content))
}

function toArray(value) {
  if (Array.isArray(value)) return value
  if (value == null) return []
  return [value]
}

function normalizeLicenseExpression(rawValue) {
  const text = String(rawValue || '').trim()
  if (!text) return 'UNKNOWN'
  return text
    .replace(/Apache License,? Version 2(?:\.0)?/gi, 'Apache-2.0')
    .replace(/Apache\s+2(?:\.0)?/gi, 'Apache-2.0')
    .replace(/LGPL\s*2\.1\+/gi, 'LGPL-2.1-or-later')
    .replace(/LGPL\s*2\.0\+/gi, 'LGPL-2.0-or-later')
    .replace(/LGPL\s*3(?:\.0)?\+/gi, 'LGPL-3.0-or-later')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeLicenseExpression(expression) {
  return expression
    .replace(/[()]/g, ' ')
    .replace(/\bAND\b/gi, ' ')
    .replace(/\bOR\b/gi, ' ')
    .replace(/\bWITH\b/gi, ' ')
    .split(/[^A-Za-z0-9.+-]+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function canonicalizeToken(token) {
  const upper = token.toUpperCase()
  if (upper === 'APACHE-2' || upper === 'APACHE2.0') return 'Apache-2.0'
  if (upper === 'BSD-2') return 'BSD-2-Clause'
  if (upper === 'BSD-3') return 'BSD-3-Clause'
  if (upper === 'LGPL-2.1+') return 'LGPL-2.1-or-later'
  if (upper === 'LGPL-2.0+') return 'LGPL-2.0-or-later'
  if (upper === 'LGPL-3.0+') return 'LGPL-3.0-or-later'
  if (upper === 'MIT') return 'MIT'
  if (upper === 'BSD') return 'BSD'
  if (upper === 'ISC') return 'ISC'
  if (upper === 'APACHE-2.0') return 'Apache-2.0'
  if (upper.startsWith('BSD-2-CLAUSE')) return 'BSD-2-Clause'
  if (upper.startsWith('BSD-3-CLAUSE')) return 'BSD-3-Clause'
  if (upper.startsWith('BSD-4-CLAUSE')) return 'BSD-4-Clause'
  if (upper.startsWith('LGPL-2.0-ONLY')) return 'LGPL-2.0-only'
  if (upper.startsWith('LGPL-2.0-OR-LATER')) return 'LGPL-2.0-or-later'
  if (upper.startsWith('LGPL-2.1-ONLY')) return 'LGPL-2.1-only'
  if (upper.startsWith('LGPL-2.1-OR-LATER')) return 'LGPL-2.1-or-later'
  if (upper.startsWith('LGPL-3.0-ONLY')) return 'LGPL-3.0-only'
  if (upper.startsWith('LGPL-3.0-OR-LATER')) return 'LGPL-3.0-or-later'
  if (upper === 'LGPL-2.0') return 'LGPL-2.0'
  if (upper === 'LGPL-2.1') return 'LGPL-2.1'
  if (upper === 'LGPL-3.0') return 'LGPL-3.0'
  return token
}

function packageDisplayName(pkg) {
  return `${pkg.name}@${pkg.version}`
}

function collectRuntimePackages(tree) {
  const collected = new Map()

  function walk(node) {
    if (!node || typeof node !== 'object' || !node.dependencies) return

    for (const [name, dep] of Object.entries(node.dependencies)) {
      if (!dep || typeof dep !== 'object' || !dep.version) continue
      const key = `${name}@${dep.version}`
      if (!collected.has(key)) {
        const licenseExpression = normalizeLicenseExpression(dep.license)
        collected.set(key, {
          name,
          version: dep.version,
          licenseExpression,
          path: dep.path ? String(dep.path) : '',
        })
      }
      walk(dep)
    }
  }

  walk(tree)
  return [...collected.values()].sort((a, b) => packageDisplayName(a).localeCompare(packageDisplayName(b)))
}

function readDependencyTree() {
  const npmArgs = ['ls', '--omit=dev', '--all', '--json', '--long']
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...npmArgs] : npmArgs
  const output = execFileSync(command, commandArgs, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(output)
}

function matchesDenyPattern(licenseExpression, denyPattern) {
  if (!denyPattern) return false
  const normalizedUpper = licenseExpression.toUpperCase()
  const denyRegex = new RegExp(denyPattern, 'i')
  if (!denyRegex.test(normalizedUpper)) return false
  return !normalizedUpper.includes('LGPL')
}

function isAllowedLicense(pkg, tokens, allowedSet, exceptions) {
  const packageException = toArray(exceptions[pkg.name]).map((item) => String(item).trim())
  const exceptionSet = new Set(packageException)

  if (tokens.length === 0) return false

  return tokens.every((token) => {
    if (allowedSet.has(token)) return true
    if (exceptionSet.has(token)) return true
    return false
  })
}

function evaluateCompliance(packages, policy) {
  const allowedSet = new Set((policy.allowedLicenses || []).map((license) => String(license).trim()))
  const exceptions = policy.packageExceptions || {}
  const violations = []

  for (const pkg of packages) {
    const rawTokens = tokenizeLicenseExpression(pkg.licenseExpression)
    const tokens = rawTokens.map(canonicalizeToken)

    if (matchesDenyPattern(pkg.licenseExpression, policy.denyPattern || '')) {
      violations.push({
        type: 'DENYLIST',
        pkg,
        details: `matches deny pattern: ${pkg.licenseExpression}`,
      })
      continue
    }

    if (!isAllowedLicense(pkg, tokens, allowedSet, exceptions)) {
      violations.push({
        type: 'ALLOWLIST',
        pkg,
        details: `not in allowlist: ${pkg.licenseExpression}`,
      })
    }
  }

  return violations
}

async function findLicenseText(packagePath) {
  if (!packagePath) return null

  const candidateFiles = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENCE',
    'LICENCE.md',
    'LICENCE.txt',
    'COPYING',
    'COPYING.md',
    'NOTICE',
    'NOTICE.md',
  ]

  for (const candidate of candidateFiles) {
    const filePath = path.join(packagePath, candidate)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) continue
      const text = await fs.readFile(filePath, 'utf8')
      if (!text.trim()) continue
      return { filePath, text: text.trimEnd() }
    } catch {
      // Continue trying other names.
    }
  }

  return null
}

async function generateNotices(packages) {
  const sections = []

  sections.push('# THIRD_PARTY_NOTICES')
  sections.push('')
  sections.push('Generated from runtime npm dependencies (`npm ls --omit=dev --all --json --long`).')
  sections.push('')

  for (const pkg of packages) {
    const licenseText = await findLicenseText(pkg.path)
    const details = [
      `## ${packageDisplayName(pkg)}`,
      '',
      `- License: ${pkg.licenseExpression || 'UNKNOWN'}`,
      '',
    ]

    if (!licenseText) {
      details.push('_License text file not found in installed package._')
      details.push('')
      sections.push(...details)
      continue
    }

    details.push('```text')
    details.push(licenseText.text)
    details.push('```')
    details.push('')
    sections.push(...details)
  }

  return `${sections.join('\n').trimEnd()}\n`
}

async function runCheck() {
  const policy = await readJson(POLICY_FILE)
  const tree = readDependencyTree()
  const packages = collectRuntimePackages(tree)
  const violations = evaluateCompliance(packages, policy)

  if (violations.length === 0) {
    console.log(`License check passed for ${packages.length} runtime packages.`)
    return
  }

  console.error(`License check failed with ${violations.length} violation(s).`)
  for (const violation of violations) {
    console.error(`- ${violation.type}: ${packageDisplayName(violation.pkg)} -> ${violation.details}`)
  }
  process.exitCode = 1
}

async function runNotices() {
  const tree = readDependencyTree()
  const packages = collectRuntimePackages(tree)
  const notices = await generateNotices(packages)
  await fs.writeFile(NOTICES_FILE, notices, 'utf8')
  console.log(`Wrote ${path.relative(PACKAGE_ROOT, NOTICES_FILE)} with ${packages.length} packages.`)
}

async function main() {
  const command = process.argv[2]
  if (!command || !['check', 'notices'].includes(command)) {
    console.error('Usage: node scripts/licenses.mjs <check|notices>')
    process.exit(1)
  }

  if (command === 'check') {
    await runCheck()
    return
  }

  await runNotices()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
