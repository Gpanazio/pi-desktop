import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageSize } from './image-size'

test('reads a PNG size from its IHDR', () => {
  const png = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(393, 16)
  png.writeUInt32BE(852, 20)
  assert.deepEqual(imageSize(png), { width: 393, height: 852 })
})

test('reads a JPEG size from its first frame header', () => {
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, // SOF0: height 300, width 200
  ])
  assert.deepEqual(imageSize(jpeg), { width: 200, height: 300 })
})

test('anything else has no size', () => {
  assert.equal(imageSize(Buffer.from('not an image')), null)
  assert.equal(imageSize(Buffer.alloc(0)), null)
})
