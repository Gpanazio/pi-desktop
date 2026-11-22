// Pixel size of a PNG or JPEG from its header, so a screenshot reports its size
// without decoding the image.

export function imageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]
      if (marker === 0xff) {
        offset += 1
        continue
      }
      // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) }
      }
      offset += 2 + data.readUInt16BE(offset + 2)
    }
  }
  return null
}
