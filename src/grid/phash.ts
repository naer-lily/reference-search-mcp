import sharp from "sharp";

/**
 * Average-hash (aHash) of an image buffer: resize to size×size greyscale,
 * bits are 1 where pixel >= mean. Returns a binary string of size*size bits.
 */
export async function averageHash(buf: Buffer, size = 8): Promise<string> {
  const { data } = await sharp(buf)
    .resize(size, size, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (const b of data) sum += b;
  const avg = sum / data.length;
  let bits = "";
  for (const b of data) bits += b >= avg ? "1" : "0";
  return bits;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Out of 64 bits. Average hashes of near-duplicates typically differ by < 10 bits. */
export const DEFAULT_DUP_THRESHOLD = 12;

export function isDuplicate(a: string, b: string, threshold = DEFAULT_DUP_THRESHOLD): boolean {
  return hammingDistance(a, b) <= threshold;
}
