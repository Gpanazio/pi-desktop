import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stitchStrips, type BitmapImage } from './image-stitch'

function solid(width: number, height: number, value: number): BitmapImage {
  return { width, height, bitmap: Buffer.alloc(width * height * 4, value) }
}

test('strips are placed by their top row and a later strip overwrites a shared row', () => {
  const joined = stitchStrips([{ image: solid(2, 3, 1), top: 0 }, { image: solid(2, 3, 2), top: 2 }], 5)
  assert.deepEqual([joined.width, joined.height], [2, 5])
  const rows = Array.from({ length: 5 }, (_, row) => joined.bitmap[row * 8])
  assert.deepEqual(rows, [1, 1, 2, 2, 2])
})

test('rows outside the joined image are dropped', () => {
  const joined = stitchStrips([{ image: solid(1, 4, 9), top: 3 }], 5)
  assert.deepEqual(Array.from({ length: 5 }, (_, row) => joined.bitmap[row * 4]), [0, 0, 0, 9, 9])
})

test('strips of different widths cannot be joined', () => {
  assert.throws(() => stitchStrips([{ image: solid(2, 1, 1), top: 0 }, { image: solid(3, 1, 1), top: 1 }], 2), /different widths/)
})
