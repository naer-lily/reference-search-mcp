import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { averageHash, hammingDistance, isDuplicate } from "../src/grid/phash.js";

/** Deterministic patterned PNG; aHash is degenerate on uniform images. */
async function patternPng(seed: number, shift = 0): Promise<Buffer> {
  const w = 16;
  const h = 16;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = (x * (37 + seed * 11) + seed * 17 + shift) % 256;
      data[i + 1] = (y * (53 + seed * 13) + seed * 29 + shift) % 256;
      data[i + 2] = (x * y * (11 + seed * 7) + seed * 43 + shift) % 256;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

describe("averageHash", () => {
  it("is deterministic and same for identical bytes", async () => {
    const png = await patternPng(7);
    const h1 = await averageHash(png);
    const h2 = await averageHash(png);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("treats identical/near-identical images as duplicates, different patterns as distinct", async () => {
    const a = await averageHash(await patternPng(3));
    const aShifted = await averageHash(await patternPng(3, 2)); // +2 brightness shift: same bits
    const b = await averageHash(await patternPng(9));
    expect(isDuplicate(a, aShifted)).toBe(true);
    expect(isDuplicate(a, b)).toBe(false);
  });

  it("hammingDistance bounds", () => {
    expect(hammingDistance("0000", "0001")).toBe(1);
    expect(hammingDistance("0000", "1111")).toBe(4);
    expect(hammingDistance("0000", "000")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
