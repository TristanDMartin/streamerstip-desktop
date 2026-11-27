// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runFixtureSuite } from '../../contracts/runner/run-fixtures.ts'

test('vendored tippy.contract-fixtures.v1 matches the recorded checksum', () => {
  const result = runFixtureSuite()
  assert.equal(result.schema, 'tippy.contract-fixtures.v1')
  assert.equal(result.version, 1)
  assert.equal(result.checksumOk, true)
  assert.equal(result.failed, 0)
  assert.equal(result.runs.length, 26)
})
