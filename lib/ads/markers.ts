import "server-only";

import sharp from "sharp";

/**
 * Where an edit applies, shown to the image model on a copy of the ad: a
 * numbered pin per comment, or a dashed outline around the area a repair
 * should change (`drawMarkers`, below), with the position also in words.
 * The model is told never to draw them; the leftover-mark check catches and
 * removes any it copies. `cropRegion` cuts a close-up of an area.
 */

export type Region = { left: number; top: number; right: number; bottom: number };

/** The smallest crop, as a fraction of the ad's width, so the model sees some context. */
const MIN_SIDE = 0.22;
/** Context added around a region, as a fraction of its own size. */
const PAD = 0.15;

/** A region around a point (a pinned comment), as fractions of the ad. */
export function regionAround(x: number, y: number, aspect: number, side = 0.3): Region {
  const half = side / 2;
  const halfY = half * aspect; // same pixel size across and down
  return clampRegion({ left: x - half, top: y - halfY, right: x + half, bottom: y + halfY });
}

function clampRegion(r: Region): Region {
  return {
    left: Math.max(0, Math.min(1, r.left)),
    top: Math.max(0, Math.min(1, r.top)),
    right: Math.max(0, Math.min(1, r.right)),
    bottom: Math.max(0, Math.min(1, r.bottom)),
  };
}

/** A close-up crop of the ad around a region (padded, at least MIN_SIDE wide), as PNG. */
export async function cropRegion(image: Uint8Array, region: Region): Promise<Buffer> {
  const { width = 1536, height = 2752 } = await sharp(image).metadata();
  const w = region.right - region.left;
  const h = region.bottom - region.top;
  let left = (region.left - w * PAD) * width;
  let top = (region.top - h * PAD) * height;
  let right = (region.right + w * PAD) * width;
  let bottom = (region.bottom + h * PAD) * height;
  const min = MIN_SIDE * width;
  if (right - left < min) {
    const grow = (min - (right - left)) / 2;
    left -= grow;
    right += grow;
  }
  if (bottom - top < min) {
    const grow = (min - (bottom - top)) / 2;
    top -= grow;
    bottom += grow;
  }
  const x0 = Math.max(0, Math.round(left));
  const y0 = Math.max(0, Math.round(top));
  const x1 = Math.min(width, Math.round(right));
  const y1 = Math.min(height, Math.round(bottom));
  return sharp(image)
    .extract({ left: x0, top: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) })
    .png()
    .toBuffer();
}

/** "from 45% to 89% across and 44% to 81% down" */
export function describeRegion(r: Region): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return `from ${pct(r.left)} to ${pct(r.right)} across and ${pct(r.top)} to ${pct(r.bottom)} down`;
}

/** A marker on a copy of the ad: a numbered pin at a spot, or an outline around an area. */
export type Marker = {
  /** Shown on pins (comments); an outline for a single repair needs no number. */
  n?: number;
  /** Center, as fractions of width and height. */
  x: number;
  y: number;
  /** The area to outline, as fractions; pins have none. */
  box?: Region;
};

/**
 * Draws markers on a copy of the ad: where each comment is pinned (a
 * numbered pin) or the area a repair should change (a dashed outline). Edits
 * send this copy next to the clean ad so the model sees exactly where to
 * work. The model is told never to draw them; if it copies one anyway, the
 * leftover-mark check (`findArtifacts` / the `artifact` issue in verify.ts)
 * catches it and a removal edit cleans it up.
 */
export async function drawMarkers(image: Uint8Array, markers: Marker[]): Promise<Buffer> {
  const { width = 1080, height = 1920 } = await sharp(image).metadata();
  const r = Math.round(width * 0.032);
  const stroke = Math.max(4, Math.round(r * 0.22));
  const shapes = markers
    .map(({ n, x, y, box }) => {
      if (box) {
        const left = Math.round(box.left * width);
        const top = Math.round(box.top * height);
        const w = Math.max(stroke * 4, Math.round((box.right - box.left) * width));
        const h = Math.max(stroke * 4, Math.round((box.bottom - box.top) * height));
        const label =
          n === undefined
            ? ""
            : `<circle cx="${left}" cy="${top}" r="${r}" fill="#FF2D55" stroke="#FFFFFF" stroke-width="${Math.max(2, r * 0.14)}" />
  <text x="${left}" y="${top}" dy="0.36em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(r * 1.15)}" fill="#FFFFFF">${n}</text>`;
        return `<g>
  <rect x="${left}" y="${top}" width="${w}" height="${h}" fill="none" stroke="#FF2D55" stroke-width="${stroke}" stroke-dasharray="${stroke * 3} ${stroke * 1.5}" />
  ${label}
</g>`;
      }
      const cx = Math.round(x * width);
      const cy = Math.round(y * height);
      return `<g>
  <circle cx="${cx}" cy="${cy}" r="${r * 1.9}" fill="none" stroke="#FF2D55" stroke-width="${Math.max(3, r * 0.16)}" />
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#FF2D55" stroke="#FFFFFF" stroke-width="${Math.max(2, r * 0.14)}" />
  <text x="${cx}" y="${cy}" dy="0.36em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(r * 1.15)}" fill="#FFFFFF">${n ?? ""}</text>
</g>`;
    })
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes}</svg>`;
  return sharp(image)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
