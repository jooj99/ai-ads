import "server-only";

import sharp from "sharp";

/**
 * Draws numbered markers on an ad: a pin at a spot (a user's comment) or,
 * when a box is given, a numbered rectangle around an area (a problem the
 * check found). Edits send this marked-up copy next to the clean ad so the
 * model sees exactly where each change applies (a position in words alone
 * is vague). The model is told never to draw the markers.
 */
export type Marker = {
  n: number;
  /** Center, as fractions of width and height. */
  x: number;
  y: number;
  /** The area, as fractions (left, top, right, bottom). */
  box?: { left: number; top: number; right: number; bottom: number };
};

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
        // The number sits on the box's top-left corner, inside the frame.
        const tx = Math.min(width - r, Math.max(r, left));
        const ty = Math.min(height - r, Math.max(r, top));
        return `<g>
  <rect x="${left}" y="${top}" width="${w}" height="${h}" fill="none" stroke="#FF2D55" stroke-width="${stroke}" stroke-dasharray="${stroke * 3} ${stroke * 1.5}" />
  <circle cx="${tx}" cy="${ty}" r="${r}" fill="#FF2D55" stroke="#FFFFFF" stroke-width="${Math.max(2, r * 0.14)}" />
  <text x="${tx}" y="${ty}" dy="0.36em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(r * 1.15)}" fill="#FFFFFF">${n}</text>
</g>`;
      }
      const cx = Math.round(x * width);
      const cy = Math.round(y * height);
      return `<g>
  <circle cx="${cx}" cy="${cy}" r="${r * 1.9}" fill="none" stroke="#FF2D55" stroke-width="${Math.max(3, r * 0.16)}" />
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#FF2D55" stroke="#FFFFFF" stroke-width="${Math.max(2, r * 0.14)}" />
  <text x="${cx}" y="${cy}" dy="0.36em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(r * 1.15)}" fill="#FFFFFF">${n}</text>
</g>`;
    })
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes}</svg>`;
  return sharp(image)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
