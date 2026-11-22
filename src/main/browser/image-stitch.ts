// Full-page screenshots of a <webview> guest are taken strip by strip and joined here: a capture
// taller than the guest's own widget comes back as the widget's surface repeated, so the page is
// scrolled and each screenful captured on its own.

export interface BitmapImage {
  width: number
  height: number
  /** Raw 4-bytes-per-pixel rows, top to bottom. */
  bitmap: Buffer
}

export interface ImageCodec {
  decode(png: Buffer): BitmapImage
  encode(image: BitmapImage, format: 'png' | 'jpeg', quality: number): Buffer
}

export interface Strip {
  image: BitmapImage
  /** Row of the joined image where the strip's first row goes. */
  top: number
}

/** Join strips into one image of `height` rows. A later strip overwrites the rows it shares with an earlier one. */
export function stitchStrips(strips: readonly Strip[], height: number): BitmapImage {
  const width = strips[0]?.image.width ?? 0
  const bitmap = Buffer.alloc(width * height * 4)
  for (const { image, top } of strips) {
    if (image.width !== width) throw new Error('Strips of different widths cannot be joined')
    const rowBytes = width * 4
    for (let row = 0; row < image.height; row++) {
      const target = top + row
      if (target < 0 || target >= height) continue
      image.bitmap.copy(bitmap, target * rowBytes, row * rowBytes, (row + 1) * rowBytes)
    }
  }
  return { width, height, bitmap }
}

/** The codec the app uses: Electron's nativeImage, loaded when first needed so plain Node tests never import `electron`. */
export async function electronImageCodec(): Promise<ImageCodec> {
  const { nativeImage } = await import('electron')
  return {
    decode(png) {
      const image = nativeImage.createFromBuffer(png)
      const { width, height } = image.getSize()
      return { width, height, bitmap: image.toBitmap() }
    },
    encode(image, format, quality) {
      const native = nativeImage.createFromBitmap(image.bitmap, { width: image.width, height: image.height })
      return format === 'jpeg' ? native.toJPEG(quality) : native.toPNG()
    },
  }
}
