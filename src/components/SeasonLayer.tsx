import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSeason, type SeasonEffect } from "../season";
import { listen } from "@tauri-apps/api/event";
import "../season.css";

type Props = {
  /** Legacy count knobs kept compatible across Dock / App / preview callers. */
  density?: number;
  pile?: number;
  scatter?: boolean;
  paused?: boolean;
  /** Radius of corners facing into the screen (away from bezel). E.g. 18 on dock top, 18 or 28 on notch bottom */
  radius?: number;
  /** Radius of corners at the screen edge (bezel side). 0 when docked, 18 when floating stadium pill */
  edgeRadius?: number;
  /** Radius of concave flares where surface joins the screen edge (e.g. 13 for expanded dock/impacted notch) */
  flare?: number;
  /** Surface attachment edge: `"bottom"` = floating/bottom bar; `"top"` = top-of-screen bezel notch. */
  edge?: "top" | "bottom";
  className?: string;
};

type EdgeZone = "top" | "bottom" | "left" | "right" | "corner" | "flare";

interface ContourPoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
  tx: number;
  ty: number;
  zone: EdgeZone;
}

interface IcicleSpec {
  id: number;
  /** Anchor x in [0..W] */
  x: number;
  /** Anchor y in [0..H] (top lip or bottom lip depending on `edge`) */
  y: number;
  /** Base width in px */
  w: number;
  /** Max length in px */
  h: number;
  /** Gentle sway seed */
  phase: number;
}

interface FallingParticle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  scale: number;
  swayPhase: number;
  swayAmp: number;
  variant: number;
  alpha: number;
}

interface ScatteredParticle {
  active: boolean;
  kind: "snow" | "shard" | "droplet" | "leaf" | "petal";
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  scale: number;
  life: number;
  maxLife: number;
  variant: number;
}

interface RippleSpec {
  active: boolean;
  x: number;
  y: number;
  age: number;
  maxAge: number;
  maxR: number;
}

const MAX_FALLING = 18;
const MAX_SCATTERED = 36;
const MAX_RIPPLES = 8;
const DRIFT_BIN_PX = 2;
const PERIM_PAD = 16;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function seededNoise(i: number, seed: number): number {
  const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

interface ContourSegment {
  len: number;
  sample: (u: number) => ContourPoint; // u in [0, 1]
}

interface ContourGeometry {
  isClosed: boolean;
  totalLength: number;
  isBottomFlush: boolean;
  isTopFlush: boolean;
  rTop: number;
  rBottom: number;
  sample: (dist: number) => ContourPoint;
}

/**
 * Builds an exact, silhouette-aware contour matching SurfaceShape.tsx.
 * For docked surfaces, open contours cleanly suppress strokes along flush screen bezels.
 * For floating stadium pills, perfectly smooth rounded end caps are produced without facets.
 */
function buildContour(
  W: number,
  H: number,
  edge: "top" | "bottom",
  flareVal = 0,
  radiusVal = 18,
  edgeRadiusVal?: number
): ContourGeometry {
  const f = Math.max(0, flareVal);
  const segments: ContourSegment[] = [];

  if (edge === "bottom") {
    // Dock sitting at bottom screen bezel
    const rTop = clamp(radiusVal, 0, Math.min(W * 0.5, H));
    const er = f > 0 ? 0 : clamp(edgeRadiusVal ?? 0, 0, Math.min(W * 0.5, H));
    const isBottomFlush = f > 0 || er === 0;

    if (isBottomFlush) {
      // OPEN contour: Starts at bottom-left, goes up left edge, across top rim, down right edge.
      // NEVER strokes along y = H!

      // 1. Flare arc left (if flared)
      if (f > 0) {
        const len = 0.5 * Math.PI * f;
        segments.push({
          len,
          sample: (u) => {
            const a = 0.5 * Math.PI * (1 - u);
            return {
              x: -f + f * Math.cos(a),
              y: H - f + f * Math.sin(a),
              nx: -Math.cos(a),
              ny: -Math.sin(a),
              tx: Math.sin(a),
              ty: -Math.cos(a),
              zone: "flare",
            };
          },
        });
      }

      // 2. Left vertical edge
      const leftH = Math.max(0, H - f - rTop);
      if (leftH > 0) {
        segments.push({
          len: leftH,
          sample: (u) => ({
            x: 0,
            y: H - f - u * leftH,
            nx: -1,
            ny: 0,
            tx: 0,
            ty: -1,
            zone: "left",
          }),
        });
      }

      // 3. Top-left corner arc
      if (rTop > 0) {
        const len = 0.5 * Math.PI * rTop;
        segments.push({
          len,
          sample: (u) => {
            const nx = -Math.cos(0.5 * Math.PI * u);
            const ny = -Math.sin(0.5 * Math.PI * u);
            return {
              x: rTop + rTop * nx,
              y: rTop + rTop * ny,
              nx,
              ny,
              tx: -ny,
              ty: nx,
              zone: "corner",
            };
          },
        });
      }

      // 4. Top horizontal edge (snow drift sits here)
      const topW = Math.max(0, W - 2 * rTop);
      if (topW > 0) {
        segments.push({
          len: topW,
          sample: (u) => ({
            x: rTop + u * topW,
            y: 0,
            nx: 0,
            ny: -1,
            tx: 1,
            ty: 0,
            zone: "top",
          }),
        });
      }

      // 5. Top-right corner arc
      if (rTop > 0) {
        const len = 0.5 * Math.PI * rTop;
        segments.push({
          len,
          sample: (u) => {
            const nx = Math.sin(0.5 * Math.PI * u);
            const ny = -Math.cos(0.5 * Math.PI * u);
            return {
              x: W - rTop + rTop * nx,
              y: rTop + rTop * ny,
              nx,
              ny,
              tx: -ny,
              ty: nx,
              zone: "corner",
            };
          },
        });
      }

      // 6. Right vertical edge
      const rightH = Math.max(0, H - f - rTop);
      if (rightH > 0) {
        segments.push({
          len: rightH,
          sample: (u) => ({
            x: W,
            y: rTop + u * rightH,
            nx: 1,
            ny: 0,
            tx: 0,
            ty: 1,
            zone: "right",
          }),
        });
      }

      // 7. Flare arc right (if flared)
      if (f > 0) {
        const len = 0.5 * Math.PI * f;
        segments.push({
          len,
          sample: (u) => {
            const a = 0.5 * Math.PI * u;
            return {
              x: W + f - f * Math.cos(a),
              y: H - f + f * Math.sin(a),
              nx: Math.cos(a),
              ny: -Math.sin(a),
              tx: Math.sin(a),
              ty: Math.cos(a),
              zone: "flare",
            };
          },
        });
      }

      const totalLength = segments.reduce((sum, s) => sum + s.len, 0);
      return {
        isClosed: false,
        totalLength,
        isBottomFlush: true,
        isTopFlush: false,
        rTop,
        rBottom: 0,
        sample: makeSampler(segments, totalLength, false),
      };
    } else {
      // Floating closed dock (all 4 corners rounded)
      return buildClosedContour(W, H, rTop, er);
    }
  } else {
    // Top Notch (edge === "top")
    const rBottom = clamp(radiusVal, 0, Math.min(W * 0.5, H));
    const er = f > 0 ? 0 : clamp(edgeRadiusVal ?? (f > 0 ? 0 : 18), 0, Math.min(W * 0.5, H));
    const isTopFlush = f > 0 || er === 0;

    if (isTopFlush) {
      // OPEN contour: Starts at top-left, goes down left side, across bottom, up right side.
      // NEVER strokes along y = 0!

      // 1. Flare arc left (if flared)
      if (f > 0) {
        const len = 0.5 * Math.PI * f;
        segments.push({
          len,
          sample: (u) => {
            const a = 0.5 * Math.PI * (1 - u);
            return {
              x: -f + f * Math.cos(a),
              y: f - f * Math.sin(a),
              nx: -Math.cos(a),
              ny: Math.sin(a),
              tx: Math.sin(a),
              ty: Math.cos(a),
              zone: "flare",
            };
          },
        });
      }

      // 2. Left vertical edge
      const leftH = Math.max(0, H - f - rBottom);
      if (leftH > 0) {
        segments.push({
          len: leftH,
          sample: (u) => ({
            x: 0,
            y: f + u * leftH,
            nx: -1,
            ny: 0,
            tx: 0,
            ty: 1,
            zone: "left",
          }),
        });
      }

      // 3. Bottom-left corner arc
      if (rBottom > 0) {
        const len = 0.5 * Math.PI * rBottom;
        segments.push({
          len,
          sample: (u) => {
            const nx = -Math.cos(0.5 * Math.PI * u);
            const ny = Math.sin(0.5 * Math.PI * u);
            return {
              x: rBottom + rBottom * nx,
              y: H - rBottom + rBottom * ny,
              nx,
              ny,
              tx: -ny,
              ty: nx,
              zone: "corner",
            };
          },
        });
      }

      // 4. Bottom horizontal edge
      const bottomW = Math.max(0, W - 2 * rBottom);
      if (bottomW > 0) {
        segments.push({
          len: bottomW,
          sample: (u) => ({
            x: rBottom + u * bottomW,
            y: H,
            nx: 0,
            ny: 1,
            tx: 1,
            ty: 0,
            zone: "bottom",
          }),
        });
      }

      // 5. Bottom-right corner arc
      if (rBottom > 0) {
        const len = 0.5 * Math.PI * rBottom;
        segments.push({
          len,
          sample: (u) => {
            const nx = Math.sin(0.5 * Math.PI * u);
            const ny = Math.cos(0.5 * Math.PI * u);
            return {
              x: W - rBottom + rBottom * nx,
              y: H - rBottom + rBottom * ny,
              nx,
              ny,
              tx: -ny,
              ty: nx,
              zone: "corner",
            };
          },
        });
      }

      // 6. Right vertical edge
      const rightH = Math.max(0, H - f - rBottom);
      if (rightH > 0) {
        segments.push({
          len: rightH,
          sample: (u) => ({
            x: W,
            y: H - rBottom - u * rightH,
            nx: 1,
            ny: 0,
            tx: 0,
            ty: -1,
            zone: "right",
          }),
        });
      }

      // 7. Flare arc right (if flared)
      if (f > 0) {
        const len = 0.5 * Math.PI * f;
        segments.push({
          len,
          sample: (u) => {
            const a = 0.5 * Math.PI * u;
            return {
              x: W + f - f * Math.cos(a),
              y: f - f * Math.sin(a),
              nx: Math.cos(a),
              ny: Math.sin(a),
              tx: Math.sin(a),
              ty: -Math.cos(a),
              zone: "flare",
            };
          },
        });
      }

      const totalLength = segments.reduce((sum, s) => sum + s.len, 0);
      return {
        isClosed: false,
        totalLength,
        isBottomFlush: false,
        isTopFlush: true,
        rTop: 0,
        rBottom,
        sample: makeSampler(segments, totalLength, false),
      };
    } else {
      // Floating collapsed stadium pill (e.g. er = 18, rBottom = 18, H = 36)
      return buildClosedContour(W, H, er, rBottom);
    }
  }
}

function buildClosedContour(W: number, H: number, rTop: number, rBottom: number): ContourGeometry {
  const segments: ContourSegment[] = [];

  // 1. Top horizontal edge
  const topW = Math.max(0, W - 2 * rTop);
  if (topW > 0) {
    segments.push({
      len: topW,
      sample: (u) => ({
        x: rTop + u * topW,
        y: 0,
        nx: 0,
        ny: -1,
        tx: 1,
        ty: 0,
        zone: "top",
      }),
    });
  }

  // 2. Top-right corner arc
  if (rTop > 0) {
    const len = 0.5 * Math.PI * rTop;
    segments.push({
      len,
      sample: (u) => {
        const nx = Math.sin(0.5 * Math.PI * u);
        const ny = -Math.cos(0.5 * Math.PI * u);
        return {
          x: W - rTop + rTop * nx,
          y: rTop + rTop * ny,
          nx,
          ny,
          tx: -ny,
          ty: nx,
          zone: "corner",
        };
      },
    });
  }

  // 3. Right vertical edge
  const rightH = Math.max(0, H - rTop - rBottom);
  if (rightH > 0) {
    segments.push({
      len: rightH,
      sample: (u) => ({
        x: W,
        y: rTop + u * rightH,
        nx: 1,
        ny: 0,
        tx: 0,
        ty: 1,
        zone: "right",
      }),
    });
  }

  // 4. Bottom-right corner arc
  if (rBottom > 0) {
    const len = 0.5 * Math.PI * rBottom;
    segments.push({
      len,
      sample: (u) => {
        const nx = Math.cos(0.5 * Math.PI * u);
        const ny = Math.sin(0.5 * Math.PI * u);
        return {
          x: W - rBottom + rBottom * nx,
          y: H - rBottom + rBottom * ny,
          nx,
          ny,
          tx: -ny,
          ty: nx,
          zone: "corner",
        };
      },
    });
  }

  // 5. Bottom horizontal edge
  const bottomW = Math.max(0, W - 2 * rBottom);
  if (bottomW > 0) {
    segments.push({
      len: bottomW,
      sample: (u) => ({
        x: W - rBottom - u * bottomW,
        y: H,
        nx: 0,
        ny: 1,
        tx: -1,
        ty: 0,
        zone: "bottom",
      }),
    });
  }

  // 6. Bottom-left corner arc
  if (rBottom > 0) {
    const len = 0.5 * Math.PI * rBottom;
    segments.push({
      len,
      sample: (u) => {
        const nx = -Math.sin(0.5 * Math.PI * u);
        const ny = Math.cos(0.5 * Math.PI * u);
        return {
          x: rBottom + rBottom * nx,
          y: H - rBottom + rBottom * ny,
          nx,
          ny,
          tx: -ny,
          ty: nx,
          zone: "corner",
        };
      },
    });
  }

  // 7. Left vertical edge
  const leftH = Math.max(0, H - rTop - rBottom);
  if (leftH > 0) {
    segments.push({
      len: leftH,
      sample: (u) => ({
        x: 0,
        y: H - rBottom - u * leftH,
        nx: -1,
        ny: 0,
        tx: 0,
        ty: -1,
        zone: "left",
      }),
    });
  }

  // 8. Top-left corner arc
  if (rTop > 0) {
    const len = 0.5 * Math.PI * rTop;
    segments.push({
      len,
      sample: (u) => {
        const nx = -Math.cos(0.5 * Math.PI * u);
        const ny = -Math.sin(0.5 * Math.PI * u);
        return {
          x: rTop + rTop * nx,
          y: rTop + rTop * ny,
          nx,
          ny,
          tx: -ny,
          ty: nx,
          zone: "corner",
        };
      },
    });
  }

  const totalLength = segments.reduce((sum, s) => sum + s.len, 0);
  return {
    isClosed: true,
    totalLength,
    isBottomFlush: false,
    isTopFlush: false,
    rTop,
    rBottom,
    sample: makeSampler(segments, totalLength, true),
  };
}

function makeSampler(
  segments: ContourSegment[],
  total: number,
  closed: boolean
): (dist: number) => ContourPoint {
  if (segments.length === 0 || total <= 0) {
    return () => ({ x: 0, y: 0, nx: 0, ny: -1, tx: 1, ty: 0, zone: "top" });
  }

  return (dist: number) => {
    let d = closed ? ((dist % total) + total) % total : clamp(dist, 0, total);
    for (const seg of segments) {
      if (d <= seg.len) {
        const u = seg.len > 0 ? d / seg.len : 0;
        return seg.sample(u);
      }
      d -= seg.len;
    }
    const last = segments[segments.length - 1];
    return last.sample(1);
  };
}

/**
 * Generates an organic double-strand SVG vine or crystalline frost contour wrapping
 * all exposed borders & rounded corners while leaving interior clocks/icons unobstructed.
 */
function buildPerimeterMarkup(
  season: SeasonEffect,
  contour: ContourGeometry,
  W: number,
  H: number,
  edge: "top" | "bottom"
): string {
  const total = contour.totalLength;
  if (total < 30 || W < 24 || H < 18) return "";

  const fmt = (n: number) => n.toFixed(1);

  if (season === "snow") {
    // Delicate crystal frost glaze wrapping exposed edges + sparkling corner crystals.
    const step = 4.5;
    const count = Math.max(24, Math.round(total / step));
    const ptsOuter: string[] = [];
    const crystals: string[] = [];

    for (let i = 0; i <= count; i++) {
      const d = (i / count) * total;
      const p = contour.sample(d);
      // Gentle, smooth organic micro-crystallization (no coarse polygonal spikes)
      const rough = 0.5 + 0.35 * Math.sin(d * 0.22) + 0.25 * Math.cos(d * 0.54 + 1.2);
      ptsOuter.push(`${fmt(p.x + p.nx * rough)},${fmt(p.y + p.ny * rough)}`);
    }

    // Place crystal stars ONLY on exposed corners / ends away from bezel
    const starDists: number[] = [];
    if (contour.isClosed) {
      // Stadium pill: 2 delicate stars at curved end caps
      starDists.push(total * 0.25, total * 0.75);
    } else if (edge === "bottom") {
      // Dock: only place stars at top corners, NEVER at bottom bezel
      const rTop = contour.rTop;
      const leftCornerDist = (contour.totalLength > 100) ? rTop * 1.2 : total * 0.3;
      const rightCornerDist = (contour.totalLength > 100) ? total - rTop * 1.2 : total * 0.7;
      starDists.push(leftCornerDist, rightCornerDist);
      if (W > 300) starDists.push(total * 0.5); // subtle midpoint star
    } else {
      // Top Notch: only place stars on bottom corners, NEVER at top bezel
      starDists.push(total * 0.35, total * 0.65);
    }

    starDists.forEach((d) => {
      const p = contour.sample(d);
      if (edge === "bottom" && p.y > H - 12) return; // safety: never on bottom bezel
      if (edge === "top" && contour.isTopFlush && p.y < 10) return; // safety: never on top bezel

      const cx = p.x + p.nx * 2.8;
      const cy = p.y + p.ny * 2.8;
      const size = 4.2;
      const deg = (Math.atan2(p.ny, p.nx) * 180) / Math.PI;
      crystals.push(
        `<g transform="translate(${fmt(cx)},${fmt(cy)}) rotate(${fmt(deg)})" opacity="0.85">` +
          `<path d="M-${size},0 L${size},0 M0,-${size} L0,${size} M-${size * 0.65},-${size * 0.65} L${size * 0.65},${size * 0.65} M-${size * 0.65},${size * 0.65} L${size * 0.65},-${size * 0.65}" ` +
          `stroke="#eaf5ff" stroke-width="1.0" stroke-linecap="round" fill="none"/>` +
          `<circle cx="0" cy="0" r="1.2" fill="#ffffff"/>` +
        `</g>`
      );
    });

    const ringPath = `M ${ptsOuter.join(" L ")}${contour.isClosed ? " Z" : ""}`;

    // Notice: innerRingPath (stroke-dasharray="3 2.5") is permanently removed!
    return (
      `<g class="season-perim-frost">` +
        `<path d="${ringPath}" fill="none" stroke="rgba(218,238,255,0.48)" stroke-width="2.2" stroke-linejoin="round"/>` +
        crystals.join("") +
      `</g>`
    );
  }

  // Vine-based perimeters: blossom (sakura branch), leaves (autumn vine), rain (lush ivy).
  const step = 5.0;
  const segCount = Math.max(36, Math.round(total / step));
  const strandA: string[] = [];
  const strandB: string[] = [];

  for (let i = 0; i <= segCount; i++) {
    const d = (i / segCount) * total;
    const p = contour.sample(d);
    // Smooth harmonic strand offsets hugging the curved contour
    const wA = 1.1 * Math.sin(d * 0.14) + 0.6;
    const wB = 0.9 * Math.cos(d * 0.14 + 0.8) + 1.0;
    strandA.push(`${fmt(p.x + p.nx * wA)},${fmt(p.y + p.ny * wA)}`);
    strandB.push(`${fmt(p.x + p.nx * wB)},${fmt(p.y + p.ny * wB)}`);
  }

  const pathA = `M ${strandA.join(" L ")}${contour.isClosed ? " Z" : ""}`;
  const pathB = `M ${strandB.join(" L ")}${contour.isClosed ? " Z" : ""}`;

  const ornaments: string[] = [];
  const spacing = season === "rain" ? 18 : season === "leaves" ? 20 : 22;
  const itemCount = Math.max(10, Math.floor(total / spacing));

  const leafShades =
    season === "rain"
      ? ["#52c41a", "#73d13d", "#389e0d"]
      : season === "leaves"
        ? ["#e05428", "#f39c2b", "#ffca3a"]
        : ["#ff9fc5", "#ffaec9", "#ffffff"];

  for (let i = 0; i < itemCount; i++) {
    const d = ((i + 0.5) / itemCount) * total;
    const p = contour.sample(d);
    // Don't place heavy ornaments on flush bezel edge
    if (edge === "bottom" && p.y > H - 8) continue;
    if (edge === "top" && contour.isTopFlush && p.y < 8) return "";

    const deg = (Math.atan2(p.ny, p.nx) * 180) / Math.PI;
    const color = leafShades[i % leafShades.length];
    const off = 1.2 + seededNoise(i, 11) * 1.8;
    const ox = p.x + p.nx * off;
    const oy = p.y + p.ny * off;

    if (season === "blossom") {
      // Delicate sakura petal cluster & buds
      ornaments.push(
        `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(deg)})" opacity="0.92">` +
          `<circle cx="-2.2" cy="0" r="1.8" fill="#ffd1e3"/>` +
          `<circle cx="2.2" cy="0" r="1.8" fill="#ffd1e3"/>` +
          `<circle cx="0" cy="-2.2" r="1.8" fill="#ffc2dc"/>` +
          `<circle cx="0" cy="2.2" r="1.8" fill="#ffaec9"/>` +
          `<circle cx="0" cy="0" r="1.2" fill="#fff5fa"/>` +
        `</g>`
      );
    } else {
      // Leaf / droplet bud
      ornaments.push(
        `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(deg)})" opacity="0.88">` +
          `<ellipse cx="0" cy="0" rx="3.0" ry="1.6" fill="${color}"/>` +
        `</g>`
      );
    }
  }

  const stemColor =
    season === "rain"
      ? "rgba(82, 196, 26, 0.58)"
      : season === "leaves"
        ? "rgba(180, 85, 30, 0.65)"
        : "rgba(165, 80, 105, 0.68)";

  return (
    `<g class="season-perim-vines">` +
      `<path d="${pathA}" fill="none" stroke="${stemColor}" stroke-width="1.3" stroke-linecap="round"/>` +
      `<path d="${pathB}" fill="none" stroke="${stemColor}" stroke-width="1.0" stroke-linecap="round" opacity="0.75"/>` +
      ornaments.join("") +
    `</g>`
  );
}

/**
 * Builds icicle frost teeth.
 * Restrained to very short lengths (3-6px) on the dock so they NEVER cover application shortcut icons!
 */
function buildIcicles(W: number, H: number, rTop: number, edge: "top" | "bottom"): IcicleSpec[] {
  if (W < 80) return [];
  const specs: IcicleSpec[] = [];
  // For dock, icicles hang from top rim y = 0 pointing down into the glass
  const yAnchor = edge === "bottom" ? 0.5 : H - 0.5;
  const shoulderStart = Math.max(12, rTop * 0.6);
  const isNarrow = W < 320;
  const count = isNarrow ? 6 : clamp(Math.floor(W / 46), 6, 12);

  let idx = 0;
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    // Keep central band clean on narrow pills
    if (isNarrow && u > 0.28 && u < 0.72) continue;
    const x = shoulderStart + u * (W - 2 * shoulderStart);

    // Restrain max icicle length strictly: 3.5 to 6.0 px, never obscuring icons!
    const maxLen = edge === "bottom" ? 5.5 : 4.5;
    const h = clamp(maxLen - Math.abs(u - 0.5) * 1.5 + seededNoise(i, 19) * 2.0, 3.0, 6.0);
    const w = 3.2 + seededNoise(i, 23) * 1.4;
    specs.push({ id: idx++, x, y: yAnchor, w, h, phase: seededNoise(i, 29) * Math.PI * 2 });
  }
  return specs;
}

/**
 * Generates soft, pillowy undulating snow drift seated on top rim matching snowy.aauburn.com.
 * Smooth cubic curves smoothly crest above the surface without jitter or harsh facets.
 */
function buildSnowDriftPath(
  bins: Float32Array,
  W: number,
  rTop: number,
  pileKnob = 10
): { driftPath: string; shinePath: string } {
  const n = bins.length;
  if (n < 4 || W < 30) return { driftPath: "", shinePath: "" };

  const lip = 1.2;
  const crestPts: string[] = [];
  const basePts: string[] = [];
  const shinePts: string[] = [];
  const pileScale = clamp(pileKnob / 10, 0.5, 2.0);

  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    const distLeft = x;
    const distRight = W - x;
    const cornerFade =
      rTop > 2
        ? clamp(Math.min(distLeft, distRight) / (rTop * 0.95), 0, 1)
        : clamp(Math.min(distLeft, distRight) / 6, 0, 1);
    const smoothFade = cornerFade * cornerFade * (3 - 2 * cornerFade);

    // Pillowy, undulating snow drifts (soft sine wave combination)
    const undulating =
      2.4 * Math.sin(x * 0.048 + 0.3) +
      1.5 * Math.cos(x * 0.088 + 1.1) +
      0.9 * Math.sin(x * 0.15) +
      4.8;
    const dynamicLanding = bins[i] * 0.6;
    const h = (undulating + dynamicLanding) * smoothFade * pileScale;

    // Resting on top rim y = 0, cresting into negative y (above the bar)
    const yCrest = -h + lip;
    const yBase = lip;

    crestPts.push(`${x.toFixed(1)},${yCrest.toFixed(1)}`);
    basePts.unshift(`${x.toFixed(1)},${yBase.toFixed(1)}`);
    if (i % 2 === 0 || i === n - 1) {
      shinePts.push(`${x.toFixed(1)},${(yCrest + 0.6).toFixed(1)}`);
    }
  }

  const driftPath = `M ${crestPts.join(" L ")} L ${basePts.join(" L ")} Z`;
  const shinePath = `M ${shinePts.join(" L ")}`;
  return { driftPath, shinePath };
}

export function SeasonLayer({
  density,
  pile,
  scatter = true,
  paused = false,
  className,
  radius = 18,
  edgeRadius,
  flare = 0,
  edge = "bottom",
}: Props) {
  const season = useSeason();
  const uid = useId().replace(/:/g, "");
  const snowGradId = `kiroSnowFill-${uid}`;
  const iceGradId = `kiroIceFill-${uid}`;
  const layerRef = useRef<HTMLDivElement>(null);
  const driftPathRef = useRef<SVGPathElement>(null);
  const driftShineRef = useRef<SVGPathElement>(null);

  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const icicleRefs = useRef<(SVGGElement | null)[]>([]);
  const fallingRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const scatteredRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const rippleRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // FPS Boost & Resource Throttling: halts rAF loop and detaches listeners
  const [isThrottled, setIsThrottled] = useState(() => {
    if (typeof document === "undefined") return false;
    return (
      document.documentElement.classList.contains("perf-lite") ||
      localStorage.getItem("kiro-fps-boost-throttled") === "true"
    );
  });

  useEffect(() => {
    const unlistenPerf = listen<boolean>("perf-mode", (e) => {
      setIsThrottled(!!e.payload || localStorage.getItem("kiro-fps-boost-throttled") === "true");
    });
    const unlistenSettings = listen<{ key: string; value: any }>("settings-changed", (e) => {
      if (e.payload.key === "kiro-fps-boost-throttled") {
        setIsThrottled(e.payload.value === true || e.payload.value === "true");
      }
    });
    return () => {
      unlistenPerf.then((f) => f()).catch(() => {});
      unlistenSettings.then((f) => f()).catch(() => {});
    };
  }, []);

  const simRef = useRef<{
    bins: Float32Array;
    icicles: IcicleSpec[];
    iceHealth: Float32Array;
    falling: FallingParticle[];
    scattered: ScatteredParticle[];
    ripples: RippleSpec[];
    lastPointerX: number;
    lastPointerY: number;
    hasPointer: boolean;
    dirtyDrift: boolean;
    season: SeasonEffect | null;
    edge: "top" | "bottom";
    w: number;
    h: number;
  }>({
    bins: new Float32Array(0),
    icicles: [],
    iceHealth: new Float32Array(0),
    falling: [],
    scattered: [],
    ripples: [],
    lastPointerX: 0,
    lastPointerY: 0,
    hasPointer: false,
    dirtyDrift: false,
    season: null,
    edge: "bottom",
    w: 0,
    h: 0,
  });

  // Track parent container dimensions via ResizeObserver
  useEffect(() => {
    const parent = layerRef.current?.parentElement;
    if (!parent) return;

    const measure = () => {
      const rect = parent.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };

    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(parent);
    return () => obs.disconnect();
  }, []);

  // Silhouette-aware contour geometry
  const contour = useMemo(
    () => buildContour(size.w, size.h, edge, flare, radius, edgeRadius),
    [size.w, size.h, edge, flare, radius, edgeRadius]
  );

  const icicles = useMemo(() => {
    if (season !== "snow" || size.w < 50) return [];
    return buildIcicles(size.w, size.h, contour.rTop, edge);
  }, [season, size.w, size.h, contour.rTop, edge]);

  const perimeterMarkup = useMemo(() => {
    if (!season || size.w < 20 || size.h < 15) return "";
    return buildPerimeterMarkup(season, contour, size.w, size.h, edge);
  }, [season, contour, size.w, size.h, edge]);

  // Reinitialize simulation arrays on resize or season change
  useEffect(() => {
    if (!season || size.w <= 0 || size.h <= 0) return;

    const binCount = Math.max(16, Math.floor(size.w / DRIFT_BIN_PX));
    const bins = new Float32Array(binCount);
    const iceHealth = new Float32Array(icicles.length);
    iceHealth.fill(1);

    const targetFalling = density ? clamp(density, 6, MAX_FALLING) : 14;
    const falling: FallingParticle[] = [];
    for (let i = 0; i < MAX_FALLING; i++) {
      const active = i < targetFalling;
      const speed = season === "rain" ? 180 + seededNoise(i, 1) * 90 : 38 + seededNoise(i, 2) * 32;
      falling.push({
        active,
        x: Math.random() * size.w,
        y: Math.random() * (size.h + 60) - 40,
        vx: (Math.random() - 0.5) * (season === "rain" ? 8 : 18),
        vy: speed,
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 80,
        scale: 0.75 + Math.random() * 0.5,
        swayPhase: Math.random() * Math.PI * 2,
        swayAmp: season === "rain" ? 0 : 12 + Math.random() * 14,
        variant: i % 4,
        alpha: 0.85 + Math.random() * 0.15,
      });
    }

    const scattered: ScatteredParticle[] = [];
    for (let i = 0; i < MAX_SCATTERED; i++) {
      scattered.push({
        active: false,
        kind: "snow",
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        rot: 0,
        vr: 0,
        scale: 1,
        life: 0,
        maxLife: 1,
        variant: 0,
      });
    }

    const ripples: RippleSpec[] = [];
    for (let i = 0; i < MAX_RIPPLES; i++) {
      ripples.push({ active: false, x: 0, y: 0, age: 0, maxAge: 1, maxR: 18 });
    }

    simRef.current = {
      bins,
      icicles,
      iceHealth,
      falling,
      scattered,
      ripples,
      lastPointerX: -9999,
      lastPointerY: -9999,
      hasPointer: false,
      dirtyDrift: true,
      season,
      edge,
      w: size.w,
      h: size.h,
    };
  }, [season, size.w, size.h, icicles, density, edge]);

  // Interactive cursor interaction
  useEffect(() => {
    if (!season || paused || isThrottled || !scatter || size.w <= 0) return;

    const emitScattered = (
      kind: ScatteredParticle["kind"],
      x: number,
      y: number,
      vxBias: number,
      vyBias: number,
      count: number
    ) => {
      const sim = simRef.current;
      let spawned = 0;
      for (let i = 0; i < MAX_SCATTERED && spawned < count; i++) {
        const p = sim.scattered[i];
        if (p.active) continue;
        p.active = true;
        p.kind = kind;
        p.x = x + (Math.random() - 0.5) * 8;
        p.y = y + (Math.random() - 0.5) * 6;
        const speed = 25 + Math.random() * 55;
        const angle = (Math.random() - 0.5) * Math.PI * 0.9;
        p.vx = vxBias * 0.25 + Math.sin(angle) * speed;
        p.vy = vyBias * 0.25 - Math.abs(Math.cos(angle)) * speed * 0.6;
        p.rot = Math.random() * 360;
        p.vr = (Math.random() - 0.5) * 220;
        p.scale = 0.7 + Math.random() * 0.6;
        p.life = 0;
        p.maxLife = 0.45 + Math.random() * 0.45;
        p.variant = Math.floor(Math.random() * 2);
        spawned++;
      }
    };

    const onMove = (e: PointerEvent) => {
      if (isThrottled || paused) return;
      const host = layerRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const rx = e.clientX - rect.left;
      const ry = e.clientY - rect.top;

      if (rx < -15 || rx > rect.width + 15 || ry < -15 || ry > rect.height + 15) return;

      const sim = simRef.current;
      const dx = sim.hasPointer ? rx - sim.lastPointerX : 0;
      const dy = sim.hasPointer ? ry - sim.lastPointerY : 0;
      sim.lastPointerX = rx;
      sim.lastPointerY = ry;
      sim.hasPointer = true;

      const dist = Math.hypot(dx, dy);
      if (dist > 4) {
        const vxBias = (dx / dist) * 25;
        const vyBias = (dy / dist) * 25;
        if (sim.season === "snow") {
          emitScattered("snow", rx, ry, vxBias, vyBias, 2);
        } else if (sim.season === "blossom") {
          emitScattered("petal", rx, ry, vxBias, vyBias, 2);
        }
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
    };
  }, [season, paused, isThrottled, scatter, size.w]);

  // Single unified compositor-friendly rAF loop. Halts immediately when throttled or paused!
  useEffect(() => {
    if (!season || paused || isThrottled || size.w <= 0) return;

    let rafId = 0;
    let lastTs = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;
      const sim = simRef.current;

      // 1. Snow icicle regrowth + scale transform
      if (sim.season === "snow" && sim.icicles.length > 0) {
        for (let i = 0; i < sim.icicles.length; i++) {
          let h = sim.iceHealth[i];
          if (h < 1) {
            h = Math.min(1, h + dt * 0.08);
            sim.iceHealth[i] = h;
          }
          const g = icicleRefs.current[i];
          if (g) {
            const sway = Math.sin(now * 0.0016 + sim.icicles[i].phase) * 1.2;
            const sy = h <= 0.02 ? 0 : h;
            const sx = 0.75 + 0.25 * h;
            g.style.opacity = h <= 0.02 ? "0" : String(0.3 + 0.7 * h);
            g.style.transform = `scale(${sx.toFixed(3)}, ${sy.toFixed(3)}) rotate(${sway.toFixed(2)}deg)`;
          }
        }
      }

      // 2. Falling particles simulation + landing
      const resetBottom = sim.h + 30;

      for (let i = 0; i < MAX_FALLING; i++) {
        const p = sim.falling[i];
        const el = fallingRefs.current[i];
        if (!p.active || !el) {
          if (el) el.style.opacity = "0";
          continue;
        }

        p.swayPhase += dt * (sim.season === "leaves" ? 2.1 : 1.7);
        const swayX = p.swayAmp > 0 ? Math.sin(p.swayPhase) * p.swayAmp : 0;
        p.x += (p.vx + swayX) * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;

        // Wrap or reset at bottom
        if (p.y > resetBottom || p.x < -30 || p.x > sim.w + 30) {
          p.x = Math.random() * sim.w;
          p.y = -15 - Math.random() * 20;
          p.swayPhase = Math.random() * Math.PI * 2;
        }

        el.style.opacity = String(p.alpha);
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(${p.rot.toFixed(1)}deg) scale(${p.scale.toFixed(2)})`;
      }

      // 3. Scattered cursor burst particles
      for (let i = 0; i < MAX_SCATTERED; i++) {
        const p = sim.scattered[i];
        const el = scatteredRefs.current[i];
        if (!p.active || !el) {
          if (el) el.style.opacity = "0";
          continue;
        }
        p.life += dt;
        if (p.life >= p.maxLife) {
          p.active = false;
          el.style.opacity = "0";
          continue;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 85 * dt; // gravity
        p.vx *= 1 - 0.9 * dt; // air friction
        p.rot += p.vr * dt;

        const lifeFrac = p.life / p.maxLife;
        const alpha = Math.max(0, 1 - lifeFrac);
        const curScale = p.scale * (1 - lifeFrac * 0.4);

        el.dataset.kind = p.kind;
        el.dataset.variant = String(p.variant);
        el.style.opacity = alpha.toFixed(3);
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(${p.rot.toFixed(1)}deg) scale(${curScale.toFixed(2)})`;
      }

      // 4. Update snow drift paths if dirty
      if (sim.season === "snow" && sim.dirtyDrift && driftPathRef.current) {
        const { driftPath, shinePath } = buildSnowDriftPath(sim.bins, sim.w, contour.rTop, pile);
        driftPathRef.current.setAttribute("d", driftPath);
        if (driftShineRef.current) {
          driftShineRef.current.setAttribute("d", shinePath);
        }
        sim.dirtyDrift = false;
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [season, paused, isThrottled, size.w, contour.rTop, pile]);

  // Initial snow drift path generation
  useEffect(() => {
    if (season === "snow" && size.w > 0 && driftPathRef.current) {
      const bins = simRef.current.bins.length > 0 ? simRef.current.bins : new Float32Array(Math.max(16, Math.floor(size.w / DRIFT_BIN_PX)));
      const { driftPath, shinePath } = buildSnowDriftPath(bins, size.w, contour.rTop, pile);
      driftPathRef.current.setAttribute("d", driftPath);
      if (driftShineRef.current) {
        driftShineRef.current.setAttribute("d", shinePath);
      }
    }
  }, [season, size.w, contour.rTop, pile]);

  if (!season) return null;

  return (
    <div
      ref={layerRef}
      className={`season-layer season-${season} ${edge === "bottom" ? "season-edge-bottom" : "season-edge-top"} ${paused ? "is-paused" : ""} ${className ?? ""}`}
      style={{ "--season-radius": `${radius}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      {/* Full-perimeter border wrap hugging the exact silhouette */}
      {size.w > 0 && size.h > 0 && (
        <svg
          className="season-perimeter"
          viewBox={`${-PERIM_PAD} ${-PERIM_PAD} ${size.w + PERIM_PAD * 2} ${size.h + PERIM_PAD * 2}`}
          style={{
            left: -PERIM_PAD,
            top: -PERIM_PAD,
            width: size.w + PERIM_PAD * 2,
            height: size.h + PERIM_PAD * 2,
          }}
        >
          <g dangerouslySetInnerHTML={{ __html: perimeterMarkup }} />
        </svg>
      )}

      {/* Smooth pillowy snow drift on top rim + restrained delicate icicles */}
      {season === "snow" && size.w > 0 && (
        <svg
          className="season-snow-svg"
          viewBox={`0 -22 ${size.w} ${size.h + 44}`}
          style={{
            top: -22,
            left: 0,
            width: size.w,
            height: size.h + 44,
          }}
        >
          <defs>
            <linearGradient id={snowGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.98" />
              <stop offset="65%" stopColor="#e8f3ff" stopOpacity="0.96" />
              <stop offset="100%" stopColor="#bdd7f4" stopOpacity="0.88" />
            </linearGradient>
            <linearGradient id={iceGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
              <stop offset="55%" stopColor="#cfe8ff" stopOpacity="0.78" />
              <stop offset="100%" stopColor="#8bc0ee" stopOpacity="0.62" />
            </linearGradient>
          </defs>

          <path ref={driftPathRef} fill={`url(#${snowGradId})`} className="season-drift-path" />
          <path
            ref={driftShineRef}
            fill="none"
            stroke="rgba(255,255,255,0.92)"
            strokeWidth="1.1"
            className="season-drift-shine"
          />

          <g className="season-icicle-group">
            {icicles.map((ic, idx) => (
              <g
                key={ic.id}
                ref={(el) => {
                  icicleRefs.current[idx] = el;
                }}
                className="season-icicle-node"
                style={{ transformOrigin: `${ic.x.toFixed(1)}px ${ic.y.toFixed(1)}px` }}
              >
                <polygon
                  points={`${(ic.x - ic.w * 0.5).toFixed(1)},${ic.y.toFixed(1)} ${(ic.x + ic.w * 0.5).toFixed(1)},${ic.y.toFixed(1)} ${(ic.x + 0.3).toFixed(1)},${(ic.y + ic.h).toFixed(1)}`}
                  fill={`url(#${iceGradId})`}
                  stroke="rgba(255,255,255,0.6)"
                  strokeWidth="0.45"
                />
              </g>
            ))}
          </g>
        </svg>
      )}

      {/* Falling particles stage - hidden in perf-lite / FPS boost */}
      <div className="season-stage">
        {Array.from({ length: MAX_FALLING }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              fallingRefs.current[i] = el;
            }}
            className={`season-flake season-variant-${i % 4}`}
          />
        ))}

        {Array.from({ length: MAX_SCATTERED }, (_, i) => (
          <span
            key={`s-${i}`}
            ref={(el) => {
              scatteredRefs.current[i] = el;
            }}
            className="season-scattered"
          />
        ))}

        {Array.from({ length: MAX_RIPPLES }, (_, i) => (
          <span
            key={`r-${i}`}
            ref={(el) => {
              rippleRefs.current[i] = el;
            }}
            className="season-ripple"
          />
        ))}
      </div>
    </div>
  );
}
