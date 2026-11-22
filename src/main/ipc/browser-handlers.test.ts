import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScreenshotOptions } from './browser-handlers'
import { validMaxDimension } from '../../shared/browser'

test('maxDimension is accepted only above 0 and up to 16384', () => {
  assert.deepEqual(parseScreenshotOptions({ maxDimension: 1600 }), { maxDimension: 1600 })
  assert.deepEqual(parseScreenshotOptions({ maxDimension: 16384 }), { maxDimension: 16384 })
  assert.deepEqual(parseScreenshotOptions({}), {})
  for (const bad of [0, -5, Infinity, -Infinity, NaN, 16385, '800', null]) {
    assert.throws(() => parseScreenshotOptions({ maxDimension: bad }), /maxDimension/, String(bad))
  }
})

test('validMaxDimension drops what cannot be a cap', () => {
  assert.equal(validMaxDimension(0), undefined)
  assert.equal(validMaxDimension(Infinity), undefined)
  assert.equal(validMaxDimension(NaN), undefined)
  assert.equal(validMaxDimension(512), 512)
})
