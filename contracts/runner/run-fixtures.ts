import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_SUITE_SCHEMA, FIXTURE_SUITE_VERSION, evaluateFixture } from './evaluate.ts'

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const DIRECTORIES = ['clip-contract.v1', 'sample-manifest.v1']

export interface FixtureRun {
  id: string
  file: string
  ok: boolean
  detail: string
}

export interface FixtureSuiteResult {
  schema: typeof FIXTURE_SUITE_SCHEMA
  version: number
  runs: FixtureRun[]
  passed: number
  failed: number
  checksumOk: boolean
}

export function runFixtureSuite(): FixtureSuiteResult {
  const runs: FixtureRun[] = []
  for (const directory of DIRECTORIES) {
    const folder = join(FIXTURE_ROOT, directory)
    const files = readdirSync(folder).filter((name) => name.endsWith('.json')).sort()
    for (const name of files) {
      const file = join(folder, name)
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        id?: string
        expect?: string
        code?: string
      }
      const decision = evaluateFixture(parsed)
      const id = typeof parsed.id === 'string' ? parsed.id : name
      const rel = relative(FIXTURE_ROOT, file)
      if (parsed.expect === 'accept') {
        runs.push(decision.ok
          ? { id, file: rel, ok: true, detail: 'accept' }
          : { id, file: rel, ok: false, detail: `expected accept, got ${decision.code}` })
        continue
      }
      const code = decision.ok ? 'accept' : decision.code
      runs.push(!decision.ok && code === parsed.code
        ? { id, file: rel, ok: true, detail: code }
        : { id, file: rel, ok: false, detail: `expected ${parsed.code}, got ${code}` })
    }
  }
  const failed = runs.filter((run) => !run.ok).length
  return {
    schema: FIXTURE_SUITE_SCHEMA,
    version: FIXTURE_SUITE_VERSION,
    runs,
    passed: runs.length - failed,
    failed,
    checksumOk: checksumsMatch(),
  }
}

export function checksumsMatch(): boolean {
  const expected = readFileSync(join(FIXTURE_ROOT, 'SHA256SUMS'), 'utf8').trim().split('\n').sort()
  const actual = fixtureChecksumLines().sort()
  if (expected.length !== actual.length || expected.some((line, index) => line !== actual[index])) {
    return false
  }
  const version = readFileSync(join(FIXTURE_ROOT, 'VERSION'), 'utf8')
  const suiteLine = version.split('\n').find((line) => line.startsWith('suiteSha256: '))
  const suiteHash = createHash('sha256').update(readFileSync(join(FIXTURE_ROOT, 'SHA256SUMS'))).digest('hex')
  return suiteLine === `suiteSha256: ${suiteHash}` && version.includes(`schema: ${FIXTURE_SUITE_SCHEMA}`) && version.includes(`version: ${FIXTURE_SUITE_VERSION}`)
}

function fixtureChecksumLines(): string[] {
  const lines: string[] = []
  for (const directory of DIRECTORIES) {
    const folder = join(FIXTURE_ROOT, directory)
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith('.json')).sort()) {
      const rel = `${directory}/${name}`
      const hash = createHash('sha256').update(readFileSync(join(FIXTURE_ROOT, rel))).digest('hex')
      lines.push(`${hash}  ${rel}`)
    }
  }
  return lines
}

function printSuite(result: FixtureSuiteResult): number {
  for (const run of result.runs) {
    console.log(`${run.ok ? 'pass' : 'fail'} ${run.file} ${run.detail}`)
  }
  console.log(`# suite ${result.schema} version ${result.version}`)
  console.log(`# checksum ${result.checksumOk ? 'ok' : 'mismatch'}`)
  console.log(`# tests ${result.runs.length}`)
  console.log(`# pass ${result.passed}`)
  console.log(`# fail ${result.failed}`)
  return result.failed === 0 && result.checksumOk ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(printSuite(runFixtureSuite()))
}
