import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addGenerationTurn, formatTokensPerSecond } from './generation-speed'

// Real pi 1.6.0 (anthropic/claude-haiku-5-5) assistant message_end usage:
// output 155 tokens, reasoning 0, durationMs 2354 (includes the wait for the first token).
const realUsage = { input: 4, output: 155, cacheRead: 6404, cacheWrite: 33894, reasoning: 0 }

test('no measured turn is unknown', () => {
  assert.equal(formatTokensPerSecond(null), null)
})

test('one turn: tokens over first-delta-to-end time', () => {
  const acc = addGenerationTurn(null, realUsage.output, 10_000, 11_550)
  assert.deepEqual(acc, { tokens: 155, ms: 1550 })
  assert.equal(formatTokensPerSecond(acc), '100')
})

test('average is total tokens over total time, not mean of rates', () => {
  let acc = addGenerationTurn(null, 100, 0, 1000)
  acc = addGenerationTurn(acc, 100, 5000, 10_000)
  assert.equal(formatTokensPerSecond(acc), '33') // 200 tokens / 6 s; mean of rates would be 55
})

test('turns under 200 ms, without tokens or without a first delta are skipped', () => {
  const base = { tokens: 50, ms: 1000 }
  assert.equal(addGenerationTurn(base, 30, 0, 199), base)
  assert.equal(addGenerationTurn(base, 0, 0, 1000), base)
  assert.equal(addGenerationTurn(base, undefined, 0, 1000), base)
  assert.equal(addGenerationTurn(base, 30, null, 1000), base)
  assert.equal(addGenerationTurn(null, 30, 0, 100), null)
})

test('one decimal below 10 tk/s', () => {
  assert.equal(formatTokensPerSecond({ tokens: 37, ms: 5000 }), '7.4')
})
