/**
 * A small anti-aliased rasteriser for glyph tiles (wind barbs, current
 * arrows, isobars): straight-alpha RGBA, source-over blending, lines by
 * distance to the segment, polygons by sub-sampled coverage. Enough for
 * 256-pixel tiles; no dependency.
 */

export type Rgba = [number, number, number, number];

export class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  /** Source-over one pixel; `a` is 0..1 (already multiplied by the coverage). */
  blend(x: number, y: number, c: Rgba, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    const d = this.data;
    const sa = Math.min(1, a * (c[3] / 255));
    const da = d[o + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let i = 0; i < 3; i++) d[o + i] = Math.round((c[i] * sa + d[o + i] * da * (1 - sa)) / oa);
    d[o + 3] = Math.round(oa * 255);
  }

  /** A line of `width` pixels from (x0, y0) to (x1, y1), anti-aliased. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, c: Rgba): void {
    const r = width / 2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x0, x1) + r + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1) + r + 1));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = x0 + t * dx - px;
        const ey = y0 + t * dy - py;
        const dist = Math.sqrt(ex * ex + ey * ey);
        const cov = Math.max(0, Math.min(1, r + 0.5 - dist));
        if (cov > 0) this.blend(x, y, c, cov);
      }
    }
  }

  /** A polyline. */
  polyline(pts: [number, number][], width: number, c: Rgba): void {
    for (let i = 1; i < pts.length; i++) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width, c);
  }

  /** A filled polygon (any winding), coverage from a 3 × 3 sub-sample per pixel. */
  polygon(pts: [number, number][], c: Rgba): void {
    if (pts.length < 3) return;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const minX = Math.max(0, Math.floor(Math.min(...xs)));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(...xs)));
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    const inside = (px: number, py: number): boolean => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let n = 0;
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) n++;
        if (n > 0) this.blend(x, y, c, n / 9);
      }
    }
  }

  /** A ring of radius `r` and stroke `width` around (cx, cy). */
  circle(cx: number, cy: number, r: number, width: number, c: Rgba): void {
    const w = width / 2;
    const minX = Math.max(0, Math.floor(cx - r - w - 1));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + r + w + 1));
    const minY = Math.max(0, Math.floor(cy - r - w - 1));
    const maxY = Math.min(this.height - 1, Math.ceil(cy + r + w + 1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r);
        const cov = Math.max(0, Math.min(1, w + 0.5 - dist));
        if (cov > 0) this.blend(x, y, c, cov);
      }
    }
  }
}

export function hexRgba(hex: string, alpha = 255): Rgba {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, alpha];
}
