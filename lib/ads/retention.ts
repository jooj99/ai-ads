import "server-only";

import sharp from "sharp";

/**
 * Checks an edit against the image before it, on two counts:
 * - `kept`: the share of the ad outside the pinned spots that still looks
 *   the same (0–100), so we know the rest wasn't redrawn;
 * - `missed`: the pins where nothing changed, so we know each requested
 *   change actually happened (the model sometimes returns image 1 as is).
 *
 * Both images are shrunk to a 72×128 grid (slightly blurred, so tiny shifts
 * and compression don't count) and each cell is compared by color.
 * Calibrated on real edits:
 * - kept: unchanged copy 100, local edits 92–98, a different ad about 9;
 * - change near a pin: applied edits 54–92% of cells, a no-op 0%.
 */
const W = 72;
const H = 128;
/** Mean channel difference (0–255) above which a cell counts as changed. */
const CHANGED = 18;
/** Area around each pin that may change, excluded from `kept` (fraction of the width). */
const KEEP_RADIUS = 0.2;
/** Area around each pin where its change must show up. */
const PIN_RADIUS = 0.08;
/** A pin counts as applied when at least this share of its area changed. */
const APPLIED_MIN = 5;

export type EditCheck = {
  kept: number;
  /** Numbers of the pins whose spot didn't change. */
  missed: number[];
  /** With no pins: whether the whole ad is practically unchanged. */
  unchanged: boolean;
};

export async function checkEdit(
  before: Uint8Array,
  after: Uint8Array,
  pins: { n: number; x: number; y: number }[],
): Promise<EditCheck> {
  const grid = (img: Uint8Array) =>
    sharp(img).resize(W, H, { fit: "fill" }).blur(0.6).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([grid(before), grid(after)]);
  // Distances in width units: a 9:16 image is 16/9 widths tall.
  const dist = (x: number, y: number, p: { x: number; y: number }) => Math.hypot(x / W - p.x, ((y / H - p.y) * 16) / 9);

  let kept = 0;
  let outside = 0;
  let changedAll = 0;
  const near = pins.map(() => ({ changed: 0, total: 0 }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const changed =
        (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3 >= CHANGED;
      if (changed) changedAll++;
      pins.forEach((p, k) => {
        if (dist(x, y, p) < PIN_RADIUS) {
          near[k].total++;
          if (changed) near[k].changed++;
        }
      });
      if (pins.some((p) => dist(x, y, p) < KEEP_RADIUS)) continue;
      outside++;
      if (!changed) kept++;
    }
  }
  return {
    kept: outside ? Math.round((kept / outside) * 1000) / 10 : 100,
    missed: pins.filter((_, k) => !near[k].total || (near[k].changed / near[k].total) * 100 < APPLIED_MIN).map((p) => p.n),
    unchanged: (changedAll / (W * H)) * 100 < 0.5,
  };
}
