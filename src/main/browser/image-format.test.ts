import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PNG_MAX_BASE64_LENGTH, shouldUsePng } from './image-format'

test('a small light image stays PNG', () => {
  assert.equal(shouldUsePng({ width: 800, height: 1000 }, 200_000), true)
})

test('the longest side decides, not the area: 1001 px goes to JPEG', () => {
  assert.equal(shouldUsePng({ width: 1001, height: 300 }, 1000), false)
  assert.equal(shouldUsePng({ width: 300, height: 1001 }, 1000), false)
})

test('a PNG of 1.5 MB of base64 or more goes to JPEG even when it is small in pixels', () => {
  assert.equal(shouldUsePng({ width: 900, height: 900 }, PNG_MAX_BASE64_LENGTH - 1), true)
  assert.equal(shouldUsePng({ width: 900, height: 900 }, PNG_MAX_BASE64_LENGTH), false)
})

test('an iPhone at 3x is decided by its real 1179 px side, not by the 393 px it asked for', () => {
  assert.equal(shouldUsePng({ width: 1179, height: 2556 }, 900_000), false)
})
