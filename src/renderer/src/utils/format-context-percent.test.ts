import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatContextPercent } from './format-context-percent'

test('shows one decimal below 10% (real pi 1.6.0 value on a 1M window)', () => {
  assert.equal(formatContextPercent(1.8344), '1.8%')
  assert.equal(formatContextPercent(0), '0.0%')
})

test('rounds to an integer from 10% up and clamps to 0..100', () => {
  assert.equal(formatContextPercent(42.4), '42%')
  assert.equal(formatContextPercent(130), '100%')
  assert.equal(formatContextPercent(-3), '0.0%')
})

test('null or non-finite percent is unknown, not 0%', () => {
  assert.equal(formatContextPercent(null), null)
  assert.equal(formatContextPercent(undefined), null)
  assert.equal(formatContextPercent(Number.NaN), null)
})
