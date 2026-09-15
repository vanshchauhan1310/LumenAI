import { Jimp } from "jimp";

/**
 * Resizes (if wider than maxWidth) and re-encodes an image as JPEG at the
 * given quality. Shared by contentTools.ts's normal get_view_image path and
 * chat.ts's "shrink further and retry" fallback when a provider rejects an
 * image as too large for its token/rate-limit tier.
 */
export async function resizeAndCompress(buffer: Buffer, maxWidth: number, quality: number): Promise<Buffer> {
  const image = await Jimp.fromBuffer(buffer);
  if (image.width > maxWidth) {
    const targetHeight = Math.round(image.height * (maxWidth / image.width));
    image.resize({ w: maxWidth, h: targetHeight });
  }
  return image.getBuffer("image/jpeg", { quality });
}
