import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildGrid, gridToJpegBase64 } from "../src/grid/builder.js";
import type { GridSpec } from "../src/types.js";

async function thumb(rgb: [number, number, number], w = 64, h = 48): Promise<{ buffer: Buffer }> {
  return {
    buffer: await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
      .png()
      .toBuffer(),
  };
}

const spec: GridSpec = { columns: 3, rows: 2, cellSize: 128, gap: 8, maxWidth: 2048 };

describe("buildGrid", () => {
  it("renders a deterministic composite with badges", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rs-grid-"));
    const out1 = path.join(dir, "a.png");
    const out2 = path.join(dir, "a2.png");
    const cells = [await thumb([255, 0, 0]), null, await thumb([0, 255, 0]), await thumb([0, 0, 255]), null, await thumb([255, 255, 0])];
    const r1 = await buildGrid({ spec, roundLabel: "a", outPath: out1, cells });
    const r2 = await buildGrid({ spec, roundLabel: "a", outPath: out2, cells });
    expect(r1.cellCount).toBe(6);
    expect(r2.cellCount).toBe(6);
    const meta = await sharp(out1).metadata();
    expect(meta.width).toBe(3 * 128 + 2 * 8 + 12);
    expect(meta.height).toBe(36 + 2 * 128 + 8 + 12);
    // deterministic output
    expect(readFileSync(out1).equals(readFileSync(out2))).toBe(true);
  });

  it("handles zero cells", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rs-grid-"));
    const out = path.join(dir, "empty.png");
    const r = await buildGrid({ spec, roundLabel: "a", outPath: out, cells: [] });
    expect(r.cellCount).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("truncates beyond capacity", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rs-grid-"));
    const cells = [];
    for (let i = 0; i < 10; i++) cells.push(await thumb([i * 10, 0, 0]));
    const r = await buildGrid({ spec, roundLabel: "a", outPath: path.join(dir, "x.png"), cells });
    expect(r.cellCount).toBe(6);
  });

  it("re-encodes to jpeg base64", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rs-grid-"));
    const out = path.join(dir, "a.png");
    await buildGrid({ spec, roundLabel: "a", outPath: out, cells: [await thumb([1, 2, 3])] });
    const jpeg = await gridToJpegBase64(out, 512, 80);
    expect(jpeg.mimeType).toBe("image/jpeg");
    expect(jpeg.data.length).toBeGreaterThan(100);
  });
});
