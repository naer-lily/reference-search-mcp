import sharp from "sharp";
import type { GridSpec } from "../types.js";

export interface GridCellImage {
  buffer: Buffer;
}

export interface BuildGridOptions {
  spec: GridSpec;
  /** Round letter shown in the header, e.g. "a". */
  roundLabel: string;
  outPath: string;
  /** Grid cells in order; null renders an "unavailable" placeholder. */
  cells: (GridCellImage | null)[];
}

const PAD = 6;
const HEADER_H = 36;
const BADGE_W = 34;
const BADGE_H = 24;
const BADGE_OFFSET = 4;

/** Digits/letters only — no CJK font dependency for badges. */
function badgeSvg(n: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_W}" height="${BADGE_H}">
<rect x="0" y="0" width="${BADGE_W}" height="${BADGE_H}" rx="5" fill="rgba(0,0,0,0.72)"/>
<text x="${BADGE_W / 2}" y="${BADGE_H / 2 + 4}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${n}</text>
</svg>`;
  return Buffer.from(svg);
}

function placeholderSvg(w: number, h: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<rect x="0" y="0" width="${w}" height="${h}" fill="#eeeeee"/>
<text x="${w / 2}" y="${h / 2 + 4}" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="#999999" text-anchor="middle">unavailable</text>
</svg>`;
  return Buffer.from(svg);
}

function headerSvg(label: string, width: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEADER_H}">
<text x="${PAD}" y="${HEADER_H / 2 + 6}" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="bold" fill="#333333">Round ${label.toUpperCase()}</text>
</svg>`;
  return Buffer.from(svg);
}

export interface GridBuildResult {
  width: number;
  height: number;
  /** Number of cells actually rendered (<= spec.columns*rows). */
  cellCount: number;
}

export async function buildGrid(opts: BuildGridOptions): Promise<GridBuildResult> {
  const { spec, roundLabel, outPath, cells } = opts;
  const cellW = spec.cellSize;
  const cellH = spec.cellSize;
  const max = spec.columns * spec.rows;
  const count = Math.min(cells.length, max);
  const width = spec.columns * cellW + (spec.columns - 1) * spec.gap + PAD * 2;
  const height = HEADER_H + spec.rows * cellH + (spec.rows - 1) * spec.gap + PAD * 2;

  const layers: sharp.OverlayOptions[] = [{ input: headerSvg(roundLabel, width), top: 0, left: 0 }];

  for (let i = 0; i < count; i++) {
    const col = i % spec.columns;
    const row = Math.floor(i / spec.columns);
    const x = PAD + col * (cellW + spec.gap);
    const y = HEADER_H + PAD + row * (cellH + spec.gap);
    const img = cells[i];
    if (img) {
      const resized = await sharp(img.buffer)
        .resize(cellW, cellH, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();
      layers.push({ input: resized, top: y, left: x });
    } else {
      layers.push({ input: placeholderSvg(cellW, cellH), top: y, left: x });
    }
    layers.push({ input: badgeSvg(i + 1), top: y + BADGE_OFFSET, left: x + BADGE_OFFSET });
  }

  const canvas = sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  });
  await canvas.composite(layers).png({ compressionLevel: 9 }).toFile(outPath);
  return { width, height, cellCount: count };
}

/**
 * Re-encode a rendered grid as JPEG (smaller payload for vision APIs).
 */
export async function gridToJpegBase64(gridPath: string, maxWidth = 1536, quality = 85): Promise<{ data: string; mimeType: string }> {
  const meta = await sharp(gridPath).metadata();
  const width = Math.min(meta.width ?? maxWidth, maxWidth);
  const buf = await sharp(gridPath).resize({ width }).jpeg({ quality }).toBuffer();
  return { data: buf.toString("base64"), mimeType: "image/jpeg" };
}
