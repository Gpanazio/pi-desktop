// Which format a screenshot for the model goes out in. The call is made on the
// image that came back (its real size), not on the viewport asked for: a pixel
// ratio above 1 or a full page makes the image far bigger than the CSS size.

/** A PNG up to this longest side stays crisp and small enough. */
export const PNG_MAX_SIDE = 1000
/** Base64 length at which a PNG is too heavy to send. */
export const PNG_MAX_BASE64_LENGTH = 1_500_000

export function shouldUsePng(image: { width: number; height: number }, pngBase64Length: number): boolean {
  return Math.max(image.width, image.height) <= PNG_MAX_SIDE && pngBase64Length < PNG_MAX_BASE64_LENGTH
}
