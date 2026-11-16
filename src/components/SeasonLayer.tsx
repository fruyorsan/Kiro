import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSeason, type SeasonEffect } from "../season";
import "../season.css";

type Props = {
  /** Legacy count knobs kept compatible across Dock / App / preview callers. */
  density?: number;
  pile?: number;
  scatter?: boolean;
  paused?: boolean;
  /** Host corner radius in px; perimeter vines & frost wrap this exact contour. */
  radius?: number;
  /** Surface attachment edge: `"top"` = floating/bottom bar; `"bottom"` = top-of-screen bezel notch. */
  edge?: "top" | "bottom";
  /** Dock sits flush at screen bottom: omit bottom edge strokes & bottom hanging ornaments. */
  openBottom?: boolean;
  className?: string;
};

type EdgeZone = "top" | "bottom" | "left" | "right" | "corner";

interface PerimSample {
  x: number;
  y: number;
  nx: number;
  ny: number;
  tx: number;
  ty: number;
  zone: EdgeZone;
}

interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

interface IcicleSpec {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
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

const MAX_FALLING = 20;
const MAX_SCATTERED = 38;
const MAX_RIPPLES = 8;
const DRIFT_BIN_PX = 2;
const PERIM_PAD = 18;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function seededNoise(i: number, seed: number): number {
  const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Snow amount (in "bin units") that counts as a completely full bank. */
const DRIFT_FULL = 24;

/**
 * The silhouette of a settled bank: broad lobes, drifts and dips. This is what
 * the crest follows, so it stays wavy for ever. Deriving the height straight
 * from the accumulated amount used to flatten the whole bank into one level
 * plateau once every bin had reached its cap.
 */
function buildDriftProfile(count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = i / Math.max(1, count - 1);
    out[i] = clamp(
      0.5 +
        0.28 * Math.sin(u * Math.PI * 2.6 + 0.4) +
        0.18 * Math.cos(u * Math.PI * 6.1 + 1.1) +
        0.09 * Math.sin(u * Math.PI * 11.3 + 2.4) +
        0.045 * Math.cos(u * Math.PI * 19.4 + 0.7),
      0.04,
      1
    );
  }
  return out;
}

/** Linear resample, so the bank survives the surface changing width. */
function resampleBins(src: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count);
  if (src.length === 0) return out;
  if (src.length === count) {
    out.set(src);
    return out;
  }
  for (let i = 0; i < count; i++) {
    const u = (i / Math.max(1, count - 1)) * (src.length - 1);
    const a = Math.floor(u);
    const b = Math.min(src.length - 1, a + 1);
    const f = u - a;
    out[i] = src[a] * (1 - f) + src[b] * f;
  }
  return out;
}

/**
 * Accumulated snow lives outside React state: the shell hides and re-creates the
 * notch/dock windows, so a remount would otherwise start the bank over from a
 * fresh dusting. The map is per webview, so one key per season is enough.
 */
const driftStore = new Map<string, Float32Array>();

function resolveCorners(W: number, H: number, fallbackR: number, hostCorners?: CornerRadii): CornerRadii {
  const maxR = Math.min(W, H) * 0.5;
  const base = hostCorners ?? { tl: fallbackR, tr: fallbackR, br: fallbackR, bl: fallbackR };
  return {
    tl: clamp(base.tl, 0, maxR),
    tr: clamp(base.tr, 0, maxR),
    br: clamp(base.br, 0, maxR),
    bl: clamp(base.bl, 0, maxR),
  };
}

interface ContourModel {
  /** Closed rounded rectangle: the whole border is drawn around the surface. */
  closed: boolean;
  edge: "top" | "bottom";
  openBottom: boolean;
}

/**
 * Computes clockwise point, outward normal `(nx, ny)`, and tangent `(tx, ty)`
 * around a rounded rectangle `(0, 0, W, H)` supporting independent corner radii.
 * When the surface is a panel that touches the screen edge (`closed === false`),
 * the attachment edge is skipped so nothing is stroked into empty space or cut
 * off at the monitor border.
 */
function samplePerimeter(dist: number, W: number, H: number, c: CornerRadii, m: ContourModel): PerimSample {
  void m;
  // Always walk the FULL border: `contourSpan` decides which part of it is
  // visible, so distances stay consistent no matter which edge is attached.
  const topLen = Math.max(0, W - c.tl - c.tr);
  const rightLen = Math.max(0, H - c.tr - c.br);
  const botLen = Math.max(0, W - c.br - c.bl);
  const leftLen = Math.max(0, H - c.bl - c.tl);

  const arcTR = 0.5 * Math.PI * c.tr;
  const arcBR = 0.5 * Math.PI * c.br;
  const arcBL = 0.5 * Math.PI * c.bl;
  const arcTL = 0.5 * Math.PI * c.tl;

  const total = topLen + rightLen + botLen + leftLen + arcTR + arcBR + arcBL + arcTL;
  if (total <= 0) {
    return { x: 0, y: 0, nx: 0, ny: -1, tx: 1, ty: 0, zone: "top" };
  }

  let d = ((dist % total) + total) % total;

  if (d <= topLen) {
    return { x: c.tl + d, y: 0, nx: 0, ny: -1, tx: 1, ty: 0, zone: "top" };
  }
  d -= topLen;

  if (d <= arcTR && c.tr > 0) {
    const a = -Math.PI * 0.5 + (d / arcTR) * (Math.PI * 0.5);
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    return { x: W - c.tr + c.tr * nx, y: c.tr + c.tr * ny, nx, ny, tx: -ny, ty: nx, zone: "corner" };
  }
  d -= arcTR;

  if (d <= rightLen) {
    return { x: W, y: c.tr + d, nx: 1, ny: 0, tx: 0, ty: 1, zone: "right" };
  }
  d -= rightLen;

  if (d <= arcBR && c.br > 0) {
    const a = (d / arcBR) * (Math.PI * 0.5);
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    return { x: W - c.br + c.br * nx, y: H - c.br + c.br * ny, nx, ny, tx: -ny, ty: nx, zone: "corner" };
  }
  d -= arcBR;

  if (d <= botLen) {
    return { x: W - c.br - d, y: H, nx: 0, ny: 1, tx: -1, ty: 0, zone: "bottom" };
  }
  d -= botLen;

  if (d <= arcBL && c.bl > 0) {
    const a = Math.PI * 0.5 + (d / arcBL) * (Math.PI * 0.5);
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    return { x: c.bl + c.bl * nx, y: H - c.bl + c.bl * ny, nx, ny, tx: -ny, ty: nx, zone: "corner" };
  }
  d -= arcBL;

  if (d <= leftLen) {
    return { x: 0, y: H - c.bl - d, nx: -1, ny: 0, tx: 0, ty: -1, zone: "left" };
  }
  d -= leftLen;

  if (c.tl > 0) {
    const a = Math.PI + (d / Math.max(1e-4, arcTL)) * (Math.PI * 0.5);
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    return { x: c.tl + c.tl * nx, y: c.tl + c.tl * ny, nx, ny, tx: -ny, ty: nx, zone: "corner" };
  }

  return { x: 0, y: 0, nx: 0, ny: -1, tx: 1, ty: 0, zone: "top" };
}

function perimeterLength(W: number, H: number, c: CornerRadii, m: ContourModel): number {
  void m;
  // Full rounded-rectangle perimeter; see `samplePerimeter`. Each rounded corner
  // replaces two straight segments (2r) with a quarter arc (πr/2).
  const rSum = c.tl + c.tr + c.br + c.bl;
  return 2 * Math.max(0, W) + 2 * Math.max(0, H) - 2 * rSum + 0.5 * Math.PI * rSum;
}

/**
 * The open "U" that hugs a panel which touches the screen edge: it starts on one
 * side of the attachment edge and ends on the other, going through both corners.
 * Returns `[startDistance, spanLength]` along the perimeter walk.
 */
function contourSpan(W: number, H: number, c: CornerRadii, m: ContourModel): [number, number] {
  const total = perimeterLength(W, H, c, m);
  if (m.closed) return [0, total];

  const topLen = Math.max(0, W - c.tl - c.tr);
  const rightLen = Math.max(0, H - c.tr - c.br);
  const botLen = Math.max(0, W - c.br - c.bl);
  const leftLen = Math.max(0, H - c.bl - c.tl);
  const arcTR = 0.5 * Math.PI * c.tr;
  const arcBR = 0.5 * Math.PI * c.br;
  const arcBL = 0.5 * Math.PI * c.bl;
  const arcTL = 0.5 * Math.PI * c.tl;

  // Dock / bottom-attached panel: start low on the left flank, end low on the right.
  // The left flank is the LAST walk segment (right before the top-left arc), so
  // "78% up the flank" must be measured from the flank start, not from `total`.
  const dockStart = total - arcTL - leftLen * 0.22;
  const dockSpan = leftLen * 0.22 + arcTL + topLen + arcTR + rightLen * 0.78;

  // Notch hanging from the top edge: the free edge is the bottom one, so start
  // high on the right flank, sweep through bottom corners, end high on the left.
  const notchStart = topLen + arcTR + rightLen * 0.12;
  const notchSpan = rightLen * 0.88 + arcBR + botLen + arcBL + leftLen * 0.88;

  return m.edge === "bottom" && !m.openBottom ? [notchStart, notchSpan] : [dockStart, dockSpan];
}

/**
 * The vine wraps the WHOLE visible border of the surface, not a decorative arc.
 * Only the straight edge glued to the monitor bezel is skipped (the notch's top
 * edge / the dock's bottom edge); the two corners that meet that bezel are still
 * covered, so the stem climbs up the flanks and turns over the corner instead of
 * stopping halfway and leaving a bare gap.
 */
function vineSpan(W: number, H: number, c: CornerRadii, m: ContourModel): [number, number] {
  const total = perimeterLength(W, H, c, m);
  if (m.closed) return [0, total];

  const topLen = Math.max(0, W - c.tl - c.tr);
  const botLen = Math.max(0, W - c.br - c.bl);
  const leftLen = Math.max(0, H - c.bl - c.tl);
  const rightLen = Math.max(0, H - c.tr - c.br);
  const arcTR = 0.5 * Math.PI * c.tr;
  const arcBR = 0.5 * Math.PI * c.br;
  const arcBL = 0.5 * Math.PI * c.bl;
  const arcTL = 0.5 * Math.PI * c.tl;

  if (m.edge === "bottom" && !m.openBottom) {
    // Notch: its top edge is against the top bezel. Walk from the top-right
    // corner, all the way around the free bottom edge, and finish on the
    // top-left corner.
    return [topLen, arcTR + rightLen + arcBR + botLen + arcBL + leftLen + arcTL];
  }

  // Dock: its bottom edge is against the bottom bezel. Walk up the left flank
  // from the screen edge, over the top, and down the right flank back to it.
  return [total - arcTL - leftLen, leftLen + arcTL + topLen + arcTR + rightLen];
}

/**
 * Natural organic vine growth for the notch: NOT a symmetrical frame. The vine
 * enters from one side, meanders along the free edge with varying density, then
 * trails off before reaching the other corner. Some patches dense with leaves,
 * others bare stem, like real ivy climbing a garden wall.
 */
function naturalVineSpan(W: number, H: number, c: CornerRadii, m: ContourModel): [number, number] {
  const total = perimeterLength(W, H, c, m);
  if (m.closed) return [0, total];

  const topLen = Math.max(0, W - c.tl - c.tr);
  const botLen = Math.max(0, W - c.br - c.bl);
  const leftLen = Math.max(0, H - c.bl - c.tl);
  const rightLen = Math.max(0, H - c.tr - c.br);
  const arcTR = 0.5 * Math.PI * c.tr;
  const arcBR = 0.5 * Math.PI * c.br;
  const arcBL = 0.5 * Math.PI * c.bl;
  const arcTL = 0.5 * Math.PI * c.tl;

  if (m.edge === "bottom" && !m.openBottom) {
    // Notch hanging from the top bezel: the free bottom edge is where the vine
    // grows. It also climbs into both bottom corners and a little way up each
    // flank, so the growth looks like ivy that came over the edge instead of a
    // garland glued to one line. Asymmetric entry/exit keeps it grown, not drawn.
    const cornerRun = clamp(H * 0.26, 22, 140);
    const startRun = Math.min(rightLen, cornerRun * (0.7 + seededNoise(W, 3) * 0.9));
    const endRun = Math.min(leftLen, cornerRun * (0.5 + seededNoise(H, 7) * 0.8));
    const start = topLen + arcTR + Math.max(0, rightLen - startRun);
    const span = startRun + arcBR + botLen + arcBL + endRun;
    return [start, Math.min(span, total)];
  }

  if (m.edge === "top" && !m.openBottom) {
    // Same panel, but docked to the bottom-right corner of the screen: now the
    // free edge is the TOP one. Mirrored walk: come up the left flank, over the
    // top edge, drop down the right flank.
    const cornerRun = clamp(H * 0.26, 22, 140);
    const startRun = Math.min(leftLen, cornerRun * (0.6 + seededNoise(W, 5) * 0.9));
    const endRun = Math.min(rightLen, cornerRun * (0.5 + seededNoise(H, 9) * 0.8));
    const start = topLen + arcTR + rightLen + arcBR + botLen + arcBL + Math.max(0, leftLen - startRun);
    const span = startRun + arcTL + topLen + arcTR + endRun;
    return [start, Math.min(span, total)];
  }

  // Dock: full wrap as before.
  return vineSpan(W, H, c, m);
}

/**
 * Generates an organic open or closed border path with smooth Catmull-Rom-like quadratic curves
 * and natural botanical clusters (varied cluster spacing + buds + leaves) rather than uniform stickers.
 */
function buildPerimeterMarkup(
  season: SeasonEffect,
  W: number,
  H: number,
  c: CornerRadii,
  m: ContourModel,
  uid: string
): string {
  if (W < 24 || H < 18) return "";
  const total = perimeterLength(W, H, c, m);
  if (total < 40) return "";

  const { closed, edge, openBottom } = m;
  // `topFlush` = the surface hangs from the top of the screen (notch). Its top
  // edge is against the monitor bezel, so nothing may stick out above it.
  const topFlush = edge === "bottom" && !closed;
  // `isNotch` = any panel glued to a screen edge but NOT the dock: the notch,
  // whichever corner it is docked to. Both variants get the same natural,
  // end-dissolving vine.
  const isNotch = !closed && !openBottom;
  const fmt = (n: number) => n.toFixed(1);

  if (season === "snow") {
    const frostId = `kiroFrostRim-${uid}`;
    const blurId = `kiroFrostBlur-${uid}`;

    // The rim fades away from the free edge, so the surface reads as "frosted
    // glass" instead of having a grey 1px border drawn around it.
    //  - Dock (ridge on top): strongest at the top, gone before the screen edge.
    //  - Notch (free edge is the bottom): strongest at the bottom, gone upward.
    const rimGrad = openBottom
      ? `<linearGradient id="${frostId}" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0%" stop-color="#ffffff" stop-opacity="0.72"/>
           <stop offset="38%" stop-color="#dcefff" stop-opacity="0.4"/>
           <stop offset="72%" stop-color="#c3e2ff" stop-opacity="0.12"/>
           <stop offset="100%" stop-color="#b8dcff" stop-opacity="0"/>
         </linearGradient>`
      : `<linearGradient id="${frostId}" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0%" stop-color="#b8dcff" stop-opacity="0"/>
           <stop offset="42%" stop-color="#c9e5ff" stop-opacity="0.16"/>
           <stop offset="78%" stop-color="#e6f4ff" stop-opacity="0.44"/>
           <stop offset="100%" stop-color="#ffffff" stop-opacity="0.74"/>
         </linearGradient>`;

    const defs =
      `<defs>` +
      rimGrad +
      // A real blur makes the frost read as light, not as a stroke.
      `<filter id="${blurId}" x="-30%" y="-30%" width="160%" height="160%">` +
      `<feGaussianBlur stdDeviation="2.1"/>` +
      `</filter>` +
      `</defs>`;

    const [spanStart, spanLen] = contourSpan(W, H, c, m);

    // Sample the visible contour once and reuse it for every stroke.
    const step = 3;
    const count = Math.max(36, Math.round(spanLen / step));
    const rimPts: string[] = [];
    for (let i = 0; i <= count; i++) {
      const p = samplePerimeter(spanStart + (i / count) * spanLen, W, H, c, m);
      rimPts.push(`${fmt(p.x)},${fmt(p.y)}`);
    }
    const rimD = `M ${rimPts.join(" L ")}${closed ? " Z" : ""}`;

    // Soft halo underneath, plus a hairline highlight only where it reads as a
    // wet edge (the dock's ridge). The notch keeps just the halo so it never
    // looks like a border drawn around the pill.
    const rim =
      `<path d="${rimD}" fill="none" stroke="url(#${frostId})" stroke-width="5.4" stroke-linejoin="round" stroke-linecap="round" filter="url(#${blurId})" opacity="${openBottom ? "0.55" : "0.3"}"/>` +
      (openBottom
        ? `<path d="${rimD}" fill="none" stroke="url(#${frostId})" stroke-width="1.15" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"/>`
        : "");

    return `<g class="season-perim-frost">${defs}${rim}</g>`;
  }

  // Organic winding vine stems with uneven, natural botanical clusters (NEVER mechanical equidistant soldiers!).
  // The notch gets an asymmetric, naturally-grown stretch instead of a full frame.
  const [spanStart, spanLen] = isNotch ? naturalVineSpan(W, H, c, m) : vineSpan(W, H, c, m);
  // A span that reaches the end of the walk is a closed ring: close the stem
  // path so the two ends join instead of meeting in a butt cap.
  const vineClosed = spanLen >= total - 0.5;
  const step = 2.5;
  const segCount = Math.max(48, Math.round(spanLen / step));
  const aPts: { x: number; y: number; zone: string }[] = [];
  const bPts: { x: number; y: number }[] = [];

  for (let i = 0; i <= segCount; i++) {
    const d = spanStart + (i / segCount) * spanLen;
    const p = samplePerimeter(d, W, H, c, m);
    const wA = 1.45 * Math.sin(d * 0.115) + 0.45 * Math.sin(d * 0.29) + 0.35;
    const wB = 1.25 * Math.cos(d * 0.115 + 0.9) + 0.35 * Math.cos(d * 0.23) + 0.7;
    const clampInward = (off: number) => {
      if (topFlush && p.zone === "top") return clamp(off, -0.3, 0.7);
      if (p.zone === "corner") return clamp(off, -0.35, 1.35);
      if (p.zone === "top" || p.zone === "bottom") return clamp(off, -0.45, 2.0);
      return clamp(off, -0.7, 2.5);
    };
    aPts.push({ x: p.x + p.nx * clampInward(wA), y: p.y + p.ny * clampInward(wA), zone: p.zone });
    bPts.push({ x: p.x + p.nx * clampInward(wB), y: p.y + p.ny * clampInward(wB) });
  }

  // Saturated stem colours: the previous palette read as grey-brown wire next to
  // the dark glass, so each theme now gets a richer primary plus a real highlight.
  const stemPrimary =
    season === "rain" ? "#1f6b31" : season === "blossom" ? "#5a3a2c" : "#6b3d1c";
  const stemSecondary =
    season === "rain" ? "#43a556" : season === "blossom" ? "#8a5c47" : "#a2682f";
  const stemHighlight =
    season === "rain" ? "#b6f5c2" : season === "blossom" ? "#d9b8a2" : "#f0bd7a";

  const stemClose = vineClosed ? " Z" : "";
  // Absolute fade distance: a tall panel walks a much longer contour, so a
  // percentage ramp would swallow half the vine before it reached full strength.
  const fadePx = clamp(H * 0.55, 40, 210);
  const spanRamp = (t: number) => {
    const d = t * spanLen;
    const head = clamp(d / fadePx, 0, 1);
    const tail = clamp((spanLen - d) / fadePx, 0, 1);
    const sm = (v: number) => v * v * (3 - 2 * v);
    return sm(head) * sm(tail);
  };
  const fadeAt = isNotch ? spanRamp : () => 1;

  // Runs are split at contour-zone boundaries (flank / corner / free edge) so
  // each run is a near-straight chord that a single linear gradient can fade
  // smoothly. Neighbouring runs meet at the SAME alpha, so there is no seam:
  // constant-alpha chunks used to show up as stripes across the stem.
  const runs: { from: number; to: number }[] = [];
  {
    const MAX_PTS = 26; // ~65 px
    let start = 0;
    for (let i = 1; i < aPts.length; i++) {
      if (aPts[i].zone !== aPts[start].zone || i - start >= MAX_PTS) {
        runs.push({ from: start, to: i });
        start = i;
      }
    }
    runs.push({ from: start, to: aPts.length - 1 });
  }

  const stemDefs: string[] = [];
  const stemChunks: string[] = [];
  const pathOf = (pts: { x: number; y: number }[], g: { from: number; to: number }, close: string) =>
    "M " + pts.slice(g.from, g.to + 1).map((q) => `${fmt(q.x)},${fmt(q.y)}`).join(" L ") + close;

  for (const g of runs) {
    const o0 = fadeAt(g.from / segCount);
    const o1 = fadeAt(g.to / segCount);
    if (Math.max(o0, o1) <= 0.012) continue;
    const dA = pathOf(aPts, g, g.to === aPts.length - 1 ? stemClose : "");
    const dB = pathOf(bPts, g, g.to === bPts.length - 1 ? stemClose : "");
    const layers =
      `<path d="${dA}" fill="none" stroke="rgba(16,10,5,0.26)" stroke-width="5.2" stroke-linejoin="round"/>` +
      `<path d="${dA}" fill="none" stroke="${stemPrimary}" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<path d="${dB}" fill="none" stroke="${stemSecondary}" stroke-width="1.4" stroke-linejoin="round" opacity="0.95"/>` +
      `<path d="${dB}" fill="none" stroke="${stemHighlight}" stroke-width="0.55" stroke-linejoin="round" opacity="0.6"/>`;

    const A = aPts[g.from];
    const B = aPts[g.to];
    const chord = Math.hypot(B.x - A.x, B.y - A.y);
    if (o0 >= 0.995 && o1 >= 0.995) {
      stemChunks.push(`<g>${layers}</g>`);
    } else if (chord < 0.6) {
      const op = Math.max(o0, o1);
      stemChunks.push(`<g opacity="${op.toFixed(3)}">${layers}</g>`);
    } else {
      const k = stemDefs.length;
      const gid = `sv${uid}-${k}`;
      const mid = `sm${uid}-${k}`;
      stemDefs.push(
        `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${fmt(A.x)}" y1="${fmt(A.y)}" x2="${fmt(B.x)}" y2="${fmt(B.y)}">` +
          `<stop offset="0" stop-color="#ffffff" stop-opacity="${o0.toFixed(3)}"/>` +
          `<stop offset="1" stop-color="#ffffff" stop-opacity="${o1.toFixed(3)}"/>` +
          `</linearGradient>` +
          `<mask id="${mid}" maskUnits="userSpaceOnUse" x="-48" y="-48" width="${W + 96}" height="${H + 96}">` +
          `<path d="${dA}" fill="none" stroke="url(#${gid})" stroke-width="18" stroke-linejoin="round"/>` +
          `</mask>`
      );
      stemChunks.push(`<g mask="url(#${mid})">${layers}</g>`);
    }
  }
  const stemsSvg =
    (stemDefs.length ? `<defs>${stemDefs.join("")}</defs>` : "") + stemChunks.join("");

  // Natural asymmetric botanical cluster walker (clusters of 1-3 blooms/leaves separated by organic stem gaps!).
  const ornaments: string[] = [];
  // Ornaments fade with the stem they sit on: `ornT` is the position along the
  // vine for whatever is being pushed right now.
  let ornT = 0;
  const pushOrn = (html: string) => {
    const op = fadeAt(ornT);
    ornaments.push(op >= 0.995 ? html : `<g opacity="${op.toFixed(3)}">${html}</g>`);
  };
  const leafShades =
    season === "rain"
      ? ["#2f9c43", "#3cb552", "#4ccb63", "#5fdd77", "#2a8f3d"]
      : season === "leaves"
      ? ["#ee6b26", "#ffa32b", "#d6401f", "#ffd12f", "#e85c22"]
      : ["#4f9a46", "#68b457", "#3f8a3b"];
  // A brown outline on a green leaf muddies it into olive at 1:1. Each theme
  // gets its own edge tone instead.
  const leafEdge =
    season === "rain" ? "rgba(9,48,20,0.6)" : season === "blossom" ? "rgba(64,30,20,0.5)" : "rgba(72,26,8,0.55)";
  const leafVein = season === "rain" ? "rgba(225,255,232,0.72)" : "rgba(255,245,225,0.6)";

  // The walker walks the visible contour, not the whole rectangle.
  let cursorD = spanStart + 8 + seededNoise(1, 5) * 14;
  const walkEnd = spanStart + spanLen - 6;
  let clusterIdx = 0;

  // On the notch the vine grows like ivy on a wall: dense patches separated by
  // bare stem runs, and it thins out at BOTH ends so the growth never looks cut
  // off. Position along the stretch, 0 = entry, 1 = exit.
  const growthProfile = isNotch
    ? (t: number) => {
        // Organic swells in the middle.
        const swell = 0.55 + 0.45 * Math.sin(t * Math.PI * 2.3 + seededNoise(W, 11) * 2.0);
        // Smooth ends: nothing strange happens at the very first or last pixel.
        // `smoothstep` keeps the ramp continuous instead of a visible step.
        const ramp = (v: number) => {
          const c2 = clamp(v, 0, 1);
          return c2 * c2 * (3 - 2 * c2);
        };
        const head = ramp(t / 0.2);
        const tail = ramp((1 - t) / 0.28);
        return swell * head * tail;
      }
    : null;

  while (cursorD < walkEnd) {
    if (growthProfile) {
      const t = (cursorD - spanStart) / Math.max(1e-3, spanLen);
      const density = growthProfile(t);
      // Bare run: skip forward through this patch so long stems stay visible.
      if (seededNoise(clusterIdx, 83) > density) {
        cursorD += 14 + seededNoise(clusterIdx, 89) * 26;
        clusterIdx++;
        continue;
      }
    }

    const clusterSize = 1 + Math.floor(seededNoise(clusterIdx, 13) * 3); // 1 to 3 items grouped organically
    for (let pick = 0; pick < clusterSize; pick++) {
      const localD = cursorD + pick * (6.5 + seededNoise(clusterIdx * 7 + pick, 17) * 5.5);
      if (localD >= walkEnd) break;
      ornT = (localD - spanStart) / Math.max(1e-3, spanLen);
      const p = samplePerimeter(localD, W, H, c, m);

      if (topFlush && p.zone === "top" && (clusterIdx + pick) % 3 !== 0) continue;

      const idxSeed = clusterIdx * 11 + pick;
      // Where the ornament sits relative to the FREE edge (the side away from the
      // bezel). The stem wraps the whole border, but the ornaments belong on the
      // free edge and its corners: lining a tall panel with flowers down both
      // flanks turns a garland into a picture frame.
      const freeZone = topFlush ? "bottom" : "top";
      const onFreeEdge = p.zone === freeZone;
      const onCorner = p.zone === "corner";
      // The stem wraps everything, and every part of it carries foliage; only the
      // free edge carries full-size blooms. A bare flank reads as a wire frame.
      const ornamentKeep = onFreeEdge ? 1 : onCorner ? 0.8 : 0.46;
      if (seededNoise(idxSeed, 71) > ornamentKeep) continue;

      const isCornerOrSide = onCorner || p.zone === "left" || p.zone === "right";
      const outAng = (Math.atan2(p.ny, p.nx) * 180) / Math.PI;
      const swingSign = seededNoise(idxSeed, 19) > 0.5 ? 1 : -1;
      const tilt = swingSign * (18 + seededNoise(idxSeed, 23) * 44);
      const zoneScale = onFreeEdge ? 1 : onCorner ? 0.82 : 0.58;
      const sizeRand = (0.68 + seededNoise(idxSeed, 29) * 0.62) * zoneScale; // Genuine size hierarchy!
      const pushOut = topFlush && p.zone === "top" ? 0.45 : (1.2 + seededNoise(idxSeed, 31) * 2.2) * (onFreeEdge ? 1 : 0.75);
      const ox = p.x + p.nx * pushOut;
      const oy = p.y + p.ny * pushOut;
      // Flowers are a free-edge statement; deeper flanks only get foliage.
      const allowBloom = onFreeEdge || onCorner;

      if (season === "rain") {
        const fill = leafShades[idxSeed % leafShades.length];
        pushOrn(
          `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + tilt)}) scale(${fmt(sizeRand)})">` +
            `<path d="M0,0 C1.8,-3.6 5.2,-4.4 6.8,-1.8 C8.8,-2.8 11.2,-1.1 11.8,0 C11.2,1.1 8.8,2.8 6.8,1.8 C5.2,4.4 1.8,3.6 0,0 Z" ` +
            `fill="${fill}" stroke="#123d1c" stroke-width="0.62"/>` +
            `<path d="M0.6,0 L8.5,0 M3.5,0 L5.8,-1.8 M3.5,0 L5.8,1.8" stroke="#8ce89a" stroke-opacity="0.52" stroke-width="0.52" fill="none" stroke-linecap="round"/>` +
            `</g>`
        );
        if (pick === 0 && seededNoise(idxSeed, 37) > 0.58) {
          const tx = p.x + p.nx * 2.8;
          const ty = p.y + p.ny * 2.8;
          pushOrn(
            `<path d="M0,0 Q3.2,-3.2 5.4,0.2 T8.5,2.4 Q9.8,3.5 8.4,4.8" transform="translate(${fmt(tx)},${fmt(ty)}) rotate(${fmt(outAng - swingSign * 22)})" ` +
              `fill="none" stroke="#459d52" stroke-width="0.95" stroke-linecap="round" opacity="0.84"/>`
          );
        }
        if (pick === clusterSize - 1 && seededNoise(idxSeed, 41) > 0.55) {
          const dx = ox + p.nx * 3.8 + p.tx * swingSign * 2;
          const dy = oy + p.ny * 3.8 + p.ty * swingSign * 2;
          pushOrn(
            `<g transform="translate(${fmt(dx)},${fmt(dy)})">` +
              `<circle cx="0" cy="0" r="1.8" fill="rgba(195,236,255,0.78)" stroke="rgba(255,255,255,0.82)" stroke-width="0.4"/>` +
              `<circle cx="-0.55" cy="-0.55" r="0.58" fill="#ffffff"/>` +
              `</g>`
          );
        }
      } else if (season === "leaves") {
        const fill = leafShades[idxSeed % leafShades.length];
        const highlight = idxSeed % 2 === 0 ? "#ffd97d" : "#ffb066";
        const isMaple = seededNoise(idxSeed, 43) > 0.42;
        const leafPath = isMaple
          ? "M0,0 L2.5,-2.6 L4.6,-4.4 L5.4,-1.8 L8.5,-2.8 L7.4,-0.5 L10.6,0 L7.4,0.5 L8.5,2.8 L5.4,1.8 L4.6,4.4 L2.5,2.6 Z"
          : "M0,0 C2.6,-3.4 7.4,-3.8 10.6,0 C7.4,3.8 2.6,3.4 0,0 Z";

        pushOrn(
          `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + tilt)}) scale(${fmt(sizeRand)})">` +
            `<path d="${leafPath}" fill="${fill}" stroke="rgba(72,24,10,0.65)" stroke-width="0.55" stroke-linejoin="round"/>` +
            `<path d="M1.2,0 L8.2,0" stroke="${highlight}" stroke-opacity="0.48" stroke-width="0.55" stroke-linecap="round"/>` +
            `</g>`
        );
        if (isCornerOrSide && pick === 0 && seededNoise(idxSeed, 47) > 0.6) {
          pushOrn(
            `<circle cx="${fmt(ox + p.nx * 3.4)}" cy="${fmt(oy + p.ny * 3.4)}" r="1.45" fill="#d43f26" stroke="#ffad85" stroke-width="0.4"/>`
          );
        }
      } else if (season === "blossom") {
        // Tuck 1-2 natural sage leaves beneath buds, then render either a rich open flower or a small closed bud!
        const leafColor = leafShades[idxSeed % leafShades.length];
        if (pick === 0 || seededNoise(idxSeed, 53) > 0.48) {
          pushOrn(
            `<path d="M0,0 C2.2,-2.2 5.4,-2.0 7.4,0 C5.4,2.0 2.2,2.2 0,0 Z" ` +
              `transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + swingSign * 42)}) scale(${fmt(sizeRand * 0.88)})" ` +
              `fill="${leafColor}" stroke="#274f24" stroke-width="0.48"/>`
          );
        }

        const isBud = pick > 0 && seededNoise(idxSeed, 59) > 0.45;
        const bx = ox + p.nx * (isCornerOrSide ? 3.2 : 2.1);
        const by = oy + p.ny * (isCornerOrSide ? 3.2 : 2.1);
        if (!allowBloom) {
          // Deep flank: foliage only, so no flower heads float beside the content.
        } else if (isBud) {
          pushOrn(
            `<ellipse cx="0" cy="0" rx="2.5" ry="1.5" transform="translate(${fmt(bx)},${fmt(by)}) rotate(${fmt(outAng + tilt)})" ` +
              `fill="#ff96bf" stroke="#b9567d" stroke-width="0.4"/>`
          );
        } else {
          const fScale = sizeRand * 0.92;
          const rot = outAng + idxSeed * 31;
          const petals = [0, 72, 144, 216, 288]
            .map(
              (deg) =>
                `<ellipse cx="3.2" cy="0" rx="2.6" ry="1.8" transform="rotate(${deg})" fill="${
                  idxSeed % 3 === 0 ? "#ffe0ec" : "#ffb5cf"
                }" stroke="rgba(255,255,255,0.58)" stroke-width="0.35"/>`
            )
            .join("");
          pushOrn(
            `<g transform="translate(${fmt(bx)},${fmt(by)}) rotate(${fmt(rot)}) scale(${fmt(fScale)})">` +
              petals +
              `<circle cx="0" cy="0" r="1.35" fill="#fff099" stroke="#e68a5c" stroke-width="0.4"/>` +
              `</g>`
          );
        }
      }
    }

    // Irregular organic breathing room between clusters (so flowers/leaves don't look stamped!).
    const baseGap = season === "blossom" ? 24 : 20;
    const randomGap = seededNoise(clusterIdx, 61) * (season === "blossom" ? 30 : 24);
    cursorD += clusterSize * 8 + baseGap + randomGap;
    clusterIdx++;
  }

  // Foliage pass: a stem carrying only bloom clusters still reads as wire.
  // Small paired leaves grow along the WHOLE vine (notch and dock alike so both
  // surfaces look equally cared for), and every season gets its own small stem
  // detail: dew for rain, berries for autumn, closed buds for blossom.
  {
    const leafStep = season === "blossom" ? 19 : 17;
    const leafCount = Math.max(3, Math.round(spanLen / leafStep));
    for (let li = 0; li < leafCount; li++) {
      const t = (li + 0.2 + seededNoise(li, 601) * 0.6) / leafCount;
      // The stem thins out at the ends, so the foliage must thin out with it:
      // a full leaf row over a dissolving stem reads as a hard cut.
      const leafDensity = growthProfile ? growthProfile(t) : 1;
      if (leafDensity < 0.24) continue;
      ornT = t;
      const p = samplePerimeter(spanStart + t * spanLen, W, H, c, m);
      if (seededNoise(li, 603) > 0.78) continue; // a few gaps keep it organic
      // Sparse ends: leaves themselves shrink and thin out, not just disappear.
      if (seededNoise(li, 627) > 0.28 + leafDensity * 0.95) continue;

      const outAng = (Math.atan2(p.ny, p.nx) * 180) / Math.PI;
      const side = seededNoise(li, 605) > 0.5 ? 1 : -1;
      const off = 1.1 + seededNoise(li, 609) * 1.7;
      const x = p.x + p.nx * off;
      const y = p.y + p.ny * off;
      const shade = leafShades[li % leafShades.length];
      const sc = (0.66 + seededNoise(li, 607) * 0.5) * (0.55 + 0.45 * leafDensity);

      // A leaf with a lighter midrib reads as a leaf even at 1:1 zoom.
      pushOrn(
        `<g transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(outAng + side * (46 + seededNoise(li, 611) * 26))}) scale(${fmt(sc)})">` +
          `<path d="M0,0 C1.9,-2.1 4.9,-1.9 6.6,0 C4.9,1.9 1.9,2.1 0,0 Z" fill="${shade}" stroke="${leafEdge}" stroke-width="0.42"/>` +
          `<path d="M0.7,0 L5.6,0" stroke="${leafVein}" stroke-width="0.4" stroke-linecap="round"/>` +
          `<path d="M0.9,-0.9 L3.4,-1.5 M0.9,0.9 L3.4,1.5" stroke="${leafVein}" stroke-width="0.26" stroke-linecap="round" opacity="0.6"/>` +
          `</g>`
      );

      // A second, smaller leaf tucked behind: real sprigs are never one leaf.
      if (seededNoise(li, 613) > 0.42) {
        pushOrn(
          `<g transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(outAng - side * (30 + seededNoise(li, 617) * 22))}) scale(${fmt(sc * 0.66)})">` +
            `<path d="M0,0 C1.7,-1.9 4.4,-1.7 6,0 C4.4,1.7 1.7,1.9 0,0 Z" fill="${leafShades[(li + 2) % leafShades.length]}" stroke="${leafEdge}" stroke-width="0.3" opacity="0.95"/>` +
            `</g>`
        );
      }

      // Season-specific detail sitting on the leaf/stem.
      if (season === "rain" && seededNoise(li, 619) > 0.5) {
        pushOrn(
          `<circle cx="${fmt(x + p.nx * 1.6)}" cy="${fmt(y + p.ny * 1.6)}" r="${fmt(0.85 + seededNoise(li, 621) * 0.5)}" fill="rgba(214,242,255,0.9)" stroke="rgba(255,255,255,0.85)" stroke-width="0.3"/>`
        );
      } else if (season === "leaves" && seededNoise(li, 623) > 0.62) {
        pushOrn(
          `<circle cx="${fmt(x + p.nx * 1.4)}" cy="${fmt(y + p.ny * 1.4)}" r="1.05" fill="#c4381f" stroke="#ffb08a" stroke-width="0.32"/>`
        );
      } else if (season === "blossom" && seededNoise(li, 625) > 0.58) {
        pushOrn(
          `<ellipse rx="1.7" ry="1.05" transform="translate(${fmt(x + p.nx * 1.8)},${fmt(y + p.ny * 1.8)}) rotate(${fmt(outAng + side * 24)})" fill="#ff9fc5" stroke="#a94f72" stroke-width="0.3"/>`
        );
      }
    }
  }

  // Rain gets a "wet glass" sheen along the free edge, under the vine: a soft
  // blue halo plus a thin bright water line that fades toward the bezel.
  let wetRim = "";
  if (season === "rain") {
    const wetId = `kiroWetRim-${uid}`;
    const wetBlur = `kiroWetBlur-${uid}`;
    // The notch sheen follows the vine span (and its fade), so the wet edge
    // never draws a green frame up both flanks either.
    const [wetStart, wetLen] = isNotch ? [spanStart, spanLen] : contourSpan(W, H, c, m);
    const wetCount = Math.max(40, Math.round(wetLen / 3));
    const wetPts: string[] = [];
    for (let i = 0; i <= wetCount; i++) {
      const p = samplePerimeter(wetStart + (i / wetCount) * wetLen, W, H, c, m);
      wetPts.push(`${fmt(p.x)},${fmt(p.y)}`);
    }
    const wetChunk = Math.max(4, Math.round(wetCount / 26));
    const wetChunks: string[] = [];
    for (let from = 0; from < wetPts.length - 1; from += wetChunk) {
      const to = Math.min(wetPts.length - 1, from + wetChunk);
      const op = isNotch ? fadeAt((from + to) / (2 * wetPts.length)) : 1;
      if (op <= 0.02) continue;
      const d = `M ${wetPts.slice(from, to + 1).join(" L ")}`;
      wetChunks.push(
        `<g opacity="${op.toFixed(3)}">` +
          `<path d="${d}" fill="none" stroke="url(#${wetId})" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round" filter="url(#${wetBlur})"/>` +
          `<path d="${d}" fill="none" stroke="url(#${wetId})" stroke-width="0.85" stroke-linejoin="round" stroke-linecap="round" opacity="0.6"/>` +
          `</g>`
      );
    }
    const wetGrad = topFlush
      ? `<linearGradient id="${wetId}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="#cdeeff" stop-opacity="0"/>` +
        `<stop offset="58%" stop-color="#bfe7ff" stop-opacity="0.2"/>` +
        `<stop offset="100%" stop-color="#eaf8ff" stop-opacity="0.55"/>` +
        `</linearGradient>`
      : `<linearGradient id="${wetId}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="#eaf8ff" stop-opacity="0.5"/>` +
        `<stop offset="42%" stop-color="#bfe7ff" stop-opacity="0.18"/>` +
        `<stop offset="100%" stop-color="#cdeeff" stop-opacity="0"/>` +
        `</linearGradient>`;
    wetRim =
      `<defs>${wetGrad}` +
      `<filter id="${wetBlur}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.9"/></filter>` +
      `</defs>` +
      wetChunks.join("");
  }

  // The stems and ornaments already carry their own opacity ramp along the vine
  // (see `fadeAt`), so no extra mask is needed here: a group-level mask would
  // slice across the flanks of a tall panel.
  return `<g class="season-perim-vine">${wetRim}${stemsSvg}${ornaments.join("")}</g>`;
}

/**
 * Icicles hanging from the ridge, generated as small CLUSTERS (2-3 neighbours a
 * few pixels apart) separated by long bare stretches. An even row of identical
 * teeth reads as a comb, which is exactly what this avoids. Lengths follow a
 * three-step hierarchy: one hero icicle per cluster, medium siblings, tiny tips.
 */
function buildIcicles(W: number, H: number, c: CornerRadii, ridgeEdge: "top" | "bottom"): IcicleSpec[] {
  if (W < 95) return [];
  const yAnchor = ridgeEdge === "bottom" ? H - 1.6 : 0.2;
  const shoulderStart = Math.max(14, Math.max(c.tl, c.tr) * 0.95);
  const usableW = W - 2 * shoulderStart;
  if (usableW < 30) return [];

  const maxLen = ridgeEdge === "bottom" ? 14 : 17;
  // A short pill needs more clusters than a wide dock ridge, otherwise only two
  // lonely groups appear and the crest looks unfinished.
  const clusterCount = clamp(Math.round(usableW / (ridgeEdge === "bottom" ? 62 : 118)), 2, 8);
  const specs: IcicleSpec[] = [];
  let id = 0;

  for (let ci = 0; ci < clusterCount; ci++) {
    // Cluster centres wander off the even grid so nothing lines up.
    const cu = (ci + 0.22 + seededNoise(ci, 307) * 0.56) / clusterCount;
    const cx = shoulderStart + cu * usableW;
    const size = 1 + Math.floor(seededNoise(ci, 311) * 3);
    const spread = 5.5 + seededNoise(ci, 313) * 6.5;

    for (let k = 0; k < size; k++) {
      const x = clamp(cx + (k - (size - 1) / 2) * spread, shoulderStart + 2, shoulderStart + usableW - 2);
      const rank = seededNoise(id, 317);
      const h =
        rank > 0.74
          ? maxLen * (0.82 + seededNoise(id, 331) * 0.22)
          : rank > 0.42
            ? maxLen * (0.4 + seededNoise(id, 337) * 0.26)
            : maxLen * (0.14 + seededNoise(id, 347) * 0.16);
      specs.push({
        id,
        x,
        y: yAnchor,
        w: 2.8 + seededNoise(id, 349) * 3.4,
        h: clamp(h, 2.6, maxLen),
        phase: seededNoise(id, 353) * Math.PI * 2,
      });
      id++;
    }
  }

  return specs.sort((a, b) => a.x - b.x);
}

/**
 * Snow drift that hugs the ridge it rests on.
 *
 * `ridgeEdge` is the edge the snow actually rests on:
 *  - `"top"`    → a ridge piled on the surface's top border (dock, bottom-right
 *                 notch): it grows OUTWARD, over the rim.
 *  - `"bottom"` → a snow bank settled on the surface's free bottom border (top
 *                 notch pill, whose top border is glued to the monitor bezel so
 *                 anything drawn above it is simply off-screen). It grows INWARD
 *                 so it never pokes through the rounded silhouette.
 *
 * Both cases follow the rounded corners of the contour instead of using a
 * straight chord, which used to leave white wedges sticking out past the corners.
 * Returns the closed fill and the open crest line (the fill's outline must never
 * be stroked, or the surface gets a bright "border" again).
 */
function buildSnowDriftPath(
  bins: Float32Array,
  profile: Float32Array,
  W: number,
  H: number,
  c: CornerRadii,
  ridgeEdge: "top" | "bottom"
): { fill: string; crest: string } {
  const n = bins.length;
  const empty = { fill: "", crest: "" };
  if (n < 4 || W < 24) return empty;

  const pts = ridgeSamples(W, H, c, ridgeEdge);
  if (pts.length < 4) return empty;

  const bottomRidge = ridgeEdge === "bottom";
  // `dir` = +1 grows outward from the border, -1 grows inward.
  const dir = bottomRidge ? -1 : 1;
  // Peak depth of a fully settled bank. The notch band grows inward, so it is
  // also capped by the surface height: a 44 px pill must not disappear under snow.
  const maxThickness = bottomRidge ? Math.min(15 * 1.45, H * 0.36) : 24;

  const thicknessAt = (x: number) => {
    const idx = clamp(Math.round((x / W) * (n - 1)), 0, n - 1);
    // Taper the very ends so the bank melts into the surface edges.
    const taper = clamp(Math.min(x, W - x) / 7, 0, 1);
    const smoothTaper = taper * taper * (3 - 2 * taper);
    // How much snow has settled here (0 = bare, 1 = full bank).
    const fill = clamp(bins[idx] / DRIFT_FULL, 0, 1);
    // Static dune silhouette, always applied: a full bank keeps its lobes and
    // dips instead of settling into a flat white bar.
    const shape = 0.42 + 0.58 * (profile[idx] ?? 0.6);
    // Starts as a light dusting and thickens as flakes land on the ridge.
    const grow = 0.35 + 0.65 * fill;
    return maxThickness * smoothTaper * shape * grow;
  };

  const crest = pts.map((p) => {
    const h = thicknessAt(p.x);
    return { x: p.x + p.nx * h * dir, y: p.y + p.ny * h * dir };
  });

  // Fluffy crest: quadratic segments through the midpoints of the samples.
  const f = (v: number) => v.toFixed(1);
  let crestD = `M ${f(crest[0].x)},${f(crest[0].y)}`;
  for (let i = 1; i < crest.length - 1; i++) {
    const mx = (crest[i].x + crest[i + 1].x) * 0.5;
    const my = (crest[i].y + crest[i + 1].y) * 0.5;
    crestD += ` Q ${f(crest[i].x)},${f(crest[i].y)} ${f(mx)},${f(my)}`;
  }
  const last = crest[crest.length - 1];
  crestD += ` L ${f(last.x)},${f(last.y)}`;

  // Close the fill along the border itself (reversed sample order).
  let fillD = crestD;
  for (let i = pts.length - 1; i >= 0; i--) {
    fillD += ` L ${f(pts[i].x)},${f(pts[i].y)}`;
  }
  fillD += " Z";

  return { fill: fillD, crest: crestD };
}

/**
 * Ice glints scattered in the snow bank: tiny four-point stars that twinkle on
 * their own CSS timeline. Purely decorative and static in position, so they cost
 * one painted node each and never re-render.
 */
interface SnowSparkle {
  id: number;
  x: number;
  y: number;
  r: number;
  delay: number;
  duration: number;
}

function buildSnowSparkles(W: number, H: number, ridgeEdge: "top" | "bottom"): SnowSparkle[] {
  if (W < 70) return [];
  const count = clamp(Math.round(W / 74), 2, 12);
  const out: SnowSparkle[] = [];
  for (let i = 0; i < count; i++) {
    // Deliberately uneven spacing, hugging the middle where the bank is thickest.
    const u = (i + 0.15 + seededNoise(i, 401) * 0.7) / count;
    const x = 12 + u * (W - 24);
    const inBand = clamp(Math.min(x, W - x) / 16, 0, 1);
    if (inBand < 0.35) continue;
    const inset = 2.2 + seededNoise(i, 403) * 1.9;
    out.push({
      id: i,
      x,
      y: ridgeEdge === "bottom" ? H - inset : -inset,
      r: 1.05 + seededNoise(i, 405) * 1.5,
      delay: seededNoise(i, 407) * 6.5,
      duration: 2.6 + seededNoise(i, 409) * 2.8,
    });
  }
  return out;
}

/**
 * Sample the contour along one free edge of the rounded rectangle, in
 * left-to-right order, each sample carrying its outward normal.
 */
function ridgeSamples(
  W: number,
  H: number,
  c: CornerRadii,
  edge: "top" | "bottom"
): Array<{ x: number; y: number; nx: number; ny: number }> {
  const pts: Array<{ x: number; y: number; nx: number; ny: number }> = [];
  const arcSteps = 8;
  const maxR = Math.min(W * 0.45, H * 0.95);

  if (edge === "bottom") {
    const br = clamp(c.br, 0, maxR);
    const bl = clamp(c.bl, 0, maxR);
    // Right corner arc: (W, H - br) → (W - br, H), walked right to left.
    for (let k = 0; k <= arcSteps; k++) {
      const a = (k / arcSteps) * (Math.PI / 2);
      pts.push({ x: W - br + br * Math.cos(a), y: H - br + br * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
    const straight = Math.max(4, Math.round((W - br - bl) / 7));
    for (let k = 1; k < straight; k++) {
      pts.push({ x: W - br - (W - br - bl) * (k / straight), y: H, nx: 0, ny: 1 });
    }
    // Left corner arc: (bl, H) → (0, H - bl).
    for (let k = 0; k <= arcSteps; k++) {
      const a = Math.PI / 2 + (k / arcSteps) * (Math.PI / 2);
      pts.push({ x: bl + bl * Math.cos(a), y: H - bl + bl * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
    return pts.reverse();
  }

  const tl = clamp(c.tl, 0, maxR);
  const tr = clamp(c.tr, 0, maxR);
  // Left corner arc: (0, tl) → (tl, 0), walked left to right.
  for (let k = 0; k <= arcSteps; k++) {
    const a = Math.PI + (k / arcSteps) * (Math.PI / 2);
    pts.push({ x: tl + tl * Math.cos(a), y: tl + tl * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  }
  const straight = Math.max(4, Math.round((W - tl - tr) / 7));
  for (let k = 1; k < straight; k++) {
    pts.push({ x: tl + (W - tl - tr) * (k / straight), y: 0, nx: 0, ny: -1 });
  }
  // Right corner arc: (W - tr, 0) → (W, tr).
  for (let k = 0; k <= arcSteps; k++) {
    const a = -Math.PI / 2 + (k / arcSteps) * (Math.PI / 2);
    pts.push({ x: W - tr + tr * Math.cos(a), y: tr + tr * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  }
  return pts;
}

export function SeasonLayer({
  density,
  pile,
  scatter = true,
  paused = false,
  className,
  radius = 18,
  edge = "top",
  openBottom = false,
}: Props) {
  const season = useSeason();
  const uid = useId().replace(/:/g, "");
  const snowGradId = `kiroSnowFill-${uid}`;
  const iceGradId = `kiroIceFill-${uid}`;
  const layerRef = useRef<HTMLDivElement>(null);
  const driftPathRef = useRef<SVGPathElement>(null);
  const driftShadowRef = useRef<SVGPathElement>(null);
  const driftShineRef = useRef<SVGPathElement>(null);

  // `open` tracks whether the host surface is currently a full panel (expanded)
  // or the collapsed pill. The perimeter must switch contour models with it.
  const [geom, setGeom] = useState<{ w: number; h: number; open: boolean; corners?: CornerRadii }>({
    w: 0,
    h: 0,
    open: false,
  });
  const [perfLite, setPerfLite] = useState<boolean>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("perf-lite")
  );

  const icicleRefs = useRef<(SVGGElement | null)[]>([]);
  const fallingRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const scatteredRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const rippleRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const simRef = useRef<{
    bins: Float32Array;
    profile: Float32Array;
    storeKey: string;
    icicles: IcicleSpec[];
    iceHealth: Float32Array;
    falling: FallingParticle[];
    scattered: ScatteredParticle[];
    ripples: RippleSpec[];
    lastPointerX: number;
    lastPointerY: number;
    hasPointer: boolean;
    dirtyDrift: boolean;
    w: number;
    h: number;
    corners: CornerRadii;
    ridgeEdge: "top" | "bottom";
    season: SeasonEffect | null;
  }>({
    bins: new Float32Array(0),
    profile: new Float32Array(0),
    storeKey: "",
    icicles: [],
    iceHealth: new Float32Array(0),
    falling: Array.from({ length: MAX_FALLING }, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rot: 0,
      vr: 0,
      scale: 1,
      swayPhase: 0,
      swayAmp: 0,
      variant: 0,
      alpha: 0,
    })),
    scattered: Array.from({ length: MAX_SCATTERED }, () => ({
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
    })),
    ripples: Array.from({ length: MAX_RIPPLES }, () => ({
      active: false,
      x: 0,
      y: 0,
      age: 0,
      maxAge: 0.7,
      maxR: 12,
    })),
    lastPointerX: 0,
    lastPointerY: 0,
    hasPointer: false,
    dirtyDrift: true,
    w: 0,
    h: 0,
    corners: { tl: radius, tr: radius, br: radius, bl: radius },
    ridgeEdge: edge === "bottom" && !openBottom ? "bottom" : "top",
    season: null,
  });

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setPerfLite(root.classList.contains("perf-lite"));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const sync = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w > 0 && h > 0) {
        let hostCorners: CornerRadii | undefined;
        const host = el.parentElement;
        if (host) {
          const cs = getComputedStyle(host);
          const tl = parseFloat(cs.borderTopLeftRadius) || 0;
          const tr = parseFloat(cs.borderTopRightRadius) || 0;
          const br = parseFloat(cs.borderBottomRightRadius) || 0;
          const bl = parseFloat(cs.borderBottomLeftRadius) || 0;
          if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
            hostCorners = { tl, tr, br, bl };
          }
        }
        setGeom((prev) => {
          const sameSize = prev.w === w && prev.h === h;
          const sameCorners =
            prev.corners?.tl === hostCorners?.tl &&
            prev.corners?.tr === hostCorners?.tr &&
            prev.corners?.br === hostCorners?.br &&
            prev.corners?.bl === hostCorners?.bl;
          // A surface that touches the screen edge on one side is a "panel":
          // it must not be drawn as a closed rounded rectangle. The notch pill
          // (36-48 px tall) is the only closed shape, everything taller hugs
          // the attachment edge instead of faking corners in empty space.
          const isOpen = openBottom || h > 60;
          if (sameSize && sameCorners && prev.open === isOpen) return prev;
          return { w, h, open: isOpen, corners: hostCorners };
        });
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [season, openBottom]);

  const corners = useMemo(
    () => resolveCorners(geom.w, geom.h, radius, geom.corners),
    [geom.w, geom.h, radius, geom.corners]
  );

  // Every surface this layer decorates is attached to a screen edge (the notch
  // to the top bezel, the dock to the bottom), so the border is never a closed
  // ring: `contourSpan` picks the visible "U".
  const contour = useMemo<ContourModel>(
    () => ({ closed: false, edge, openBottom }),
    [openBottom, edge]
  );

  // Where the snow ridge actually sits. The notch pill hangs from the top of the
  // screen, so its TOP border is against the bezel and cannot carry a ridge;
  // only its free bottom edge can. Everything else keeps the ridge on top.
  const ridgeEdge: "top" | "bottom" = edge === "bottom" && !openBottom ? "bottom" : "top";

  const icicles = useMemo(
    () => (season === "snow" && geom.w > 0 ? buildIcicles(geom.w, geom.h, corners, ridgeEdge) : []),
    [season, geom.w, geom.h, corners, ridgeEdge]
  );

  const sparkles = useMemo(
    () => (season === "snow" && geom.w > 0 ? buildSnowSparkles(geom.w, geom.h, ridgeEdge) : []),
    [season, geom.w, geom.h, ridgeEdge]
  );

  const perimeterMarkup = useMemo(
    () => (season && geom.w > 0 ? buildPerimeterMarkup(season, geom.w, geom.h, corners, contour, uid) : ""),
    [season, geom.w, geom.h, corners, contour, uid]
  );

  useEffect(() => {
    const sim = simRef.current;
    sim.w = geom.w;
    sim.h = geom.h;
    sim.corners = corners;
    sim.ridgeEdge = ridgeEdge;
    sim.season = season;
    sim.icicles = icicles;

    if (!season || geom.w <= 0) return;

    const binCount = clamp(Math.round(geom.w / DRIFT_BIN_PX), 20, 320);
    const storeKey = season ?? "";
    if (sim.bins.length !== binCount || sim.storeKey !== storeKey) {
      const saved = season === "snow" ? driftStore.get(storeKey) : undefined;
      const next = new Float32Array(binCount);
      if (season === "snow") {
        sim.profile = buildDriftProfile(binCount);
        if (saved && saved.length > 0) {
          // Resume exactly where the bank was: the surface may have changed
          // width (collapsed pill → expanded panel), so the accumulation is
          // resampled instead of being thrown away.
          next.set(resampleBins(saved, binCount));
        } else {
          // A light dusting that slowly thickens while flakes land.
          const startDepth = clamp((pile ?? 14) / 14, 0.7, 1.3);
          for (let i = 0; i < binCount; i++) {
            next[i] = DRIFT_FULL * (0.16 + 0.1 * seededNoise(i, 311)) * startDepth;
          }
        }
      } else {
        sim.profile = new Float32Array(0);
      }
      sim.bins = next;
      sim.storeKey = storeKey;
      if (season === "snow") driftStore.set(storeKey, sim.bins);
    }

    if (sim.iceHealth.length !== icicles.length) {
      const nextHealth = new Float32Array(icicles.length);
      nextHealth.fill(1);
      sim.iceHealth = nextHealth;
    }

    sim.dirtyDrift = true;
    const count = clamp(density ?? 14, 6, MAX_FALLING);
    for (let i = 0; i < MAX_FALLING; i++) {
      const p = sim.falling[i];
      if (i < count) {
        if (!p.active) {
          p.active = true;
          p.x = Math.random() * geom.w;
          p.y = -15 - Math.random() * 65;
          p.vy = season === "rain" ? 135 + Math.random() * 60 : 22 + Math.random() * 24;
          p.vx = season === "rain" ? -16 : (Math.random() - 0.5) * 14;
          p.rot = Math.random() * 360;
          p.vr = (Math.random() - 0.5) * 90;
          p.scale = 0.72 + Math.random() * 0.48;
          p.swayPhase = Math.random() * Math.PI * 2;
          p.swayAmp = season === "rain" ? 0 : 12 + Math.random() * 14;
          p.variant = i % 4;
          p.alpha = season === "rain" ? 0.35 + Math.random() * 0.2 : 0.72 + Math.random() * 0.25;
        }
      } else {
        p.active = false;
      }
    }
  }, [season, geom.w, geom.h, corners, edge, ridgeEdge, icicles, density, pile]);

  const effectivePaused = paused || perfLite;

  useEffect(() => {
    if (!season || effectivePaused || !scatter || geom.w <= 0) return;

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
        const sp = sim.scattered[i];
        if (sp.active) continue;
        sp.active = true;
        sp.kind = kind;
        sp.x = x + (Math.random() - 0.5) * 8;
        sp.y = y + (Math.random() - 0.5) * 6;
        sp.vx = vxBias * 0.35 + (Math.random() - 0.5) * 78;
        sp.vy =
          kind === "shard"
            ? 25 + Math.random() * 55
            : vyBias * 0.25 - 32 - Math.random() * 48;
        sp.rot = Math.random() * 360;
        sp.vr = (Math.random() - 0.5) * 420;
        sp.scale = kind === "shard" ? 0.75 + Math.random() * 0.45 : 0.65 + Math.random() * 0.55;
        sp.life = 0;
        sp.maxLife = 0.55 + Math.random() * 0.45;
        sp.variant = spawned % 3;
        spawned++;
      }
    };

    const emitRipple = (x: number, y: number) => {
      const sim = simRef.current;
      for (let i = 0; i < MAX_RIPPLES; i++) {
        const rp = sim.ripples[i];
        if (rp.active) continue;
        rp.active = true;
        rp.x = x;
        rp.y = y;
        rp.age = 0;
        rp.maxAge = 0.65;
        rp.maxR = 11 + Math.random() * 6;
        break;
      }
    };

    const onMove = (e: PointerEvent) => {
      const el = layerRef.current;
      const sim = simRef.current;
      if (!el || sim.w <= 0) return;

      const rect = el.getBoundingClientRect();
      const rx = e.clientX - rect.left;
      const ry = e.clientY - rect.top;

      if (rx < -22 || rx > sim.w + 22 || ry < -26 || ry > sim.h + 24) {
        sim.hasPointer = false;
        return;
      }

      const dx = sim.hasPointer ? rx - sim.lastPointerX : 0;
      const dy = sim.hasPointer ? ry - sim.lastPointerY : 0;
      sim.lastPointerX = rx;
      sim.lastPointerY = ry;
      sim.hasPointer = true;

      const speed = Math.hypot(dx, dy);
      if (speed < 1.5 && e.type === "pointermove") return;

      const vxBias = clamp(dx * 16, -150, 150);
      const vyBias = clamp(dy * 16, -120, 120);

      const nearTop = Math.abs(ry) < 22;
      const nearBottom = Math.abs(ry - sim.h) < 18;
      const nearLeft = Math.abs(rx) < 18;
      const nearRight = Math.abs(rx - sim.w) < 18;
      const onRim = nearTop || (!openBottom && nearBottom) || nearLeft || nearRight;
      // Only the edge that is really on screen reacts; the other one is off-screen.
      const ridgeY = sim.ridgeEdge === "bottom" ? sim.h : 0;

      if (sim.season === "snow") {
        for (let i = 0; i < sim.icicles.length; i++) {
          const ic = sim.icicles[i];
          if (sim.iceHealth[i] <= 0.25) continue;
          const dist = Math.hypot(rx - ic.x, ry - (ic.y + ic.h * 0.45));
          if (dist < 24) {
            sim.iceHealth[i] = 0;
            emitScattered("shard", ic.x, ic.y + ic.h * 0.5, vxBias * 0.4, 20, 4);
            emitScattered("snow", ic.x, ic.y + 2, vxBias * 0.5, -18, 2);
          }
        }

        if (Math.abs(ry - ridgeY) < 24 && rx >= 0 && rx <= sim.w && sim.bins.length > 0) {
          const idxCenter = (rx / sim.w) * (sim.bins.length - 1);
          const carveRadiusBins = 9;
          let removed = 0;
          for (let k = -carveRadiusBins; k <= carveRadiusBins; k++) {
            const idx = Math.round(idxCenter + k);
            if (idx < 0 || idx >= sim.bins.length) continue;
            const falloff = 1 - Math.abs(k) / (carveRadiusBins + 1);
            const drop = Math.min(sim.bins[idx], falloff * (2.6 + speed * 0.08));
            if (drop > 0) {
              sim.bins[idx] -= drop;
              removed += drop;
              sim.dirtyDrift = true;
            }
          }
          if (removed > 0.6) {
            emitScattered("snow", rx, ridgeY, vxBias, vyBias, clamp(Math.round(removed * 0.7), 1, 5));
          }
        }
      } else if (onRim) {
        if (sim.season === "rain") {
          emitScattered("droplet", rx, ry, vxBias, vyBias, 2);
          if (nearTop && Math.random() < 0.6) emitRipple(rx, 0);
        } else if (sim.season === "leaves") {
          emitScattered("leaf", rx, ry, vxBias, vyBias, 2);
        } else if (sim.season === "blossom") {
          emitScattered("petal", rx, ry, vxBias, vyBias, 2);
        }
      }
    };

    const onDown = (e: PointerEvent) => onMove(e);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [season, effectivePaused, scatter, geom.w, openBottom]);

  useEffect(() => {
    if (!season || effectivePaused || geom.w <= 0) return;

    // The surface may have been hidden and shown again (or the SVG remounted),
    // so repaint the bank from the stored accumulation on the first frame
    // instead of leaving the previous `d` on screen.
    simRef.current.dirtyDrift = true;

    let rafId = 0;
    let lastTs = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;
      const sim = simRef.current;

      if (sim.season === "snow" && sim.icicles.length > 0) {
        for (let i = 0; i < sim.icicles.length; i++) {
          let h = sim.iceHealth[i];
          if (h < 1) {
            h = Math.min(1, h + dt * 0.09);
            sim.iceHealth[i] = h;
          }
          const g = icicleRefs.current[i];
          if (g) {
            const sway = Math.sin(now * 0.0018 + sim.icicles[i].phase) * 1.3;
            const sy = h <= 0.02 ? 0 : h;
            const sx = 0.72 + 0.28 * h;
            g.style.opacity = h <= 0.02 ? "0" : String(0.25 + 0.75 * h);
            g.style.transform = `scale(${sx.toFixed(3)}, ${sy.toFixed(3)}) rotate(${sway.toFixed(2)}deg)`;
          }
        }
      }

      const resetBottom = sim.h + 44;

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

        if (sim.season === "snow" && sim.bins.length > 0) {
          // Flakes only pile on the ridge that is actually on screen: the top
          // border for the dock, the free bottom border for the top notch.
          const ridgeY = sim.ridgeEdge === "bottom" ? sim.h : 0;
          const hitRidge = p.y >= ridgeY - 6 && p.y <= ridgeY + 5;
          const cornerMargin = Math.max(sim.corners.tl, sim.corners.tr) * 0.68;
          if (hitRidge && p.x > cornerMargin && p.x < sim.w - cornerMargin && Math.random() < 0.45) {
            const bIdx = clamp(Math.round((p.x / sim.w) * (sim.bins.length - 1)), 2, sim.bins.length - 3);
            // Slow accumulation: a dusting thickens into a full bank over a few
            // minutes, so the growth is something to watch instead of a burst.
            const cap = DRIFT_FULL * (0.92 + 0.08 * seededNoise(bIdx, 997));
            if (sim.bins[bIdx] < cap) {
              sim.bins[bIdx] = Math.min(cap, sim.bins[bIdx] + 0.4);
              sim.bins[bIdx - 1] = Math.min(cap, sim.bins[bIdx - 1] + 0.22);
              sim.bins[bIdx + 1] = Math.min(cap, sim.bins[bIdx + 1] + 0.22);
              sim.bins[bIdx - 2] = Math.min(cap, sim.bins[bIdx - 2] + 0.1);
              sim.bins[bIdx + 2] = Math.min(cap, sim.bins[bIdx + 2] + 0.1);
              sim.dirtyDrift = true;
            }
            // Recycle the flake above the surface so it keeps falling onto the ridge.
            p.y = ridgeY - 24 - Math.random() * 40;
            p.x = Math.random() * sim.w;
          }
        } else if (sim.season === "rain" && p.y >= 0 && p.y <= 3 && p.x >= 0 && p.x <= sim.w && Math.random() < 0.08) {
          for (let r = 0; r < MAX_RIPPLES; r++) {
            const rp = sim.ripples[r];
            if (!rp.active) {
              rp.active = true;
              rp.x = p.x;
              rp.y = 0;
              rp.age = 0;
              rp.maxAge = 0.55;
              rp.maxR = 9;
              break;
            }
          }
        }

        if (p.y > resetBottom || p.x < -36 || p.x > sim.w + 36) {
          p.x = Math.random() * sim.w;
          p.y = -20 - Math.random() * 55;
        }

        const fadeY = p.y < -12 ? clamp((p.y + 50) / 38, 0, 1) : p.y > sim.h + 18 ? clamp((resetBottom - p.y) / 26, 0, 1) : 1;
        el.style.opacity = (p.alpha * fadeY).toFixed(2);
        el.style.transform =
          sim.season === "rain"
            ? `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(9deg) scale(${p.scale.toFixed(2)})`
            : `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(${p.rot.toFixed(0)}deg) scale(${p.scale.toFixed(2)})`;
      }

      if (sim.season === "snow" && sim.dirtyDrift) {
        sim.dirtyDrift = false;
        const { fill, crest } = buildSnowDriftPath(
          sim.bins,
          sim.profile,
          sim.w,
          sim.h,
          sim.corners,
          sim.ridgeEdge
        );
        if (driftPathRef.current) driftPathRef.current.setAttribute("d", fill);
        if (driftShadowRef.current) driftShadowRef.current.setAttribute("d", fill);
        if (driftShineRef.current) driftShineRef.current.setAttribute("d", crest);
      }

      for (let i = 0; i < MAX_SCATTERED; i++) {
        const sp = sim.scattered[i];
        const el = scatteredRefs.current[i];
        if (!sp.active || !el) {
          if (el) el.style.opacity = "0";
          continue;
        }

        sp.life += dt;
        if (sp.life >= sp.maxLife) {
          sp.active = false;
          el.style.opacity = "0";
          continue;
        }

        const grav = sp.kind === "shard" ? 310 : sp.kind === "droplet" ? 270 : 155;
        sp.vy += grav * dt;
        sp.vx *= 1 - 0.9 * dt;
        sp.x += sp.vx * dt;
        sp.y += sp.vy * dt;
        sp.rot += sp.vr * dt;

        const t = sp.life / sp.maxLife;
        const alpha = clamp(1 - t * t, 0, 1);
        el.dataset.kind = sp.kind;
        el.dataset.variant = String(sp.variant);
        el.style.opacity = alpha.toFixed(2);
        el.style.transform = `translate3d(${sp.x.toFixed(1)}px, ${sp.y.toFixed(1)}px, 0) rotate(${sp.rot.toFixed(0)}deg) scale(${(sp.scale * (1 - 0.25 * t)).toFixed(2)})`;
      }

      for (let i = 0; i < MAX_RIPPLES; i++) {
        const rp = sim.ripples[i];
        const el = rippleRefs.current[i];
        if (!rp.active || !el) {
          if (el) el.style.opacity = "0";
          continue;
        }

        rp.age += dt;
        if (rp.age >= rp.maxAge) {
          rp.active = false;
          el.style.opacity = "0";
          continue;
        }

        const p = rp.age / rp.maxAge;
        const rad = rp.maxR * p;
        el.style.opacity = ((1 - p) * 0.55).toFixed(2);
        el.style.transform = `translate3d(${rp.x.toFixed(1)}px, ${rp.y.toFixed(1)}px, 0) scale(${(rad / 10).toFixed(2)}, ${(rad / 24).toFixed(2)})`;
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [season, effectivePaused, geom.w, geom.h]);

  if (!season) return null;

  return (
    <div
      ref={layerRef}
      className={`season-layer season-${season} ${edge === "bottom" ? "season-edge-bottom" : "season-edge-top"} ${paused ? "is-paused" : ""} ${className ?? ""}`}
      style={{ "--season-radius": `${radius}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      {geom.w > 0 && geom.h > 0 && (
        <svg
          className="season-perimeter"
          viewBox={`${-PERIM_PAD} ${-PERIM_PAD} ${geom.w + PERIM_PAD * 2} ${geom.h + PERIM_PAD * 2}`}
          style={{
            left: -PERIM_PAD,
            top: -PERIM_PAD,
            width: geom.w + PERIM_PAD * 2,
            height: geom.h + PERIM_PAD * 2,
          }}
        >
          <g dangerouslySetInnerHTML={{ __html: perimeterMarkup }} />
        </svg>
      )}

      {season === "snow" && geom.w > 0 && (
        <svg
          className="season-snow-svg"
          viewBox={`0 -24 ${geom.w} ${geom.h + 48}`}
          style={{
            top: -24,
            left: 0,
            width: geom.w,
            height: geom.h + 48,
          }}
        >
          <defs>
            <linearGradient id={snowGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="58%" stopColor="#f6fbff" stopOpacity="1" />
              <stop offset="100%" stopColor="#dcefff" stopOpacity="0.97" />
            </linearGradient>
            <linearGradient id={iceGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.96" />
              <stop offset="50%" stopColor="#e8f5ff" stopOpacity="0.88" />
              <stop offset="100%" stopColor="#a9d4f7" stopOpacity="0.6" />
            </linearGradient>
          </defs>

          {/* Soft shadow the bank casts on the glass, so the snow reads as a
              raised layer and not as a painted white shape. */}
          <path ref={driftShadowRef} className="season-drift-shadow" transform="translate(0 1.6)" />

          <path ref={driftPathRef} fill={`url(#${snowGradId})`} className="season-drift-path" />
          <path
            ref={driftShineRef}
            fill="none"
            stroke="rgba(255,255,255,0.92)"
            strokeWidth="1.2"
            className="season-drift-shine"
          />

          {/* Ice crystals twinkling inside the bank: the detail that makes snow
              read as snowy rather than as a plain white shape. */}
          <g className="season-snow-sparkles">
            {sparkles.map((sp) => {
              const cx = sp.x.toFixed(1);
              const cy = sp.y.toFixed(1);
              const top = (sp.y - sp.r).toFixed(1);
              const bottom = (sp.y + sp.r).toFixed(1);
              const left = (sp.x - sp.r).toFixed(1);
              const right = (sp.x + sp.r).toFixed(1);
              return (
                <path
                  key={sp.id}
                  className="season-sparkle"
                  d={`M ${cx},${top} Q ${cx},${cy} ${right},${cy} Q ${cx},${cy} ${cx},${bottom} Q ${cx},${cy} ${left},${cy} Q ${cx},${cy} ${cx},${top} Z`}
                  style={{
                    animationDelay: `${sp.delay.toFixed(2)}s`,
                    animationDuration: `${sp.duration.toFixed(2)}s`,
                  }}
                />
              );
            })}
          </g>

          <g className="season-icicle-group">
            {icicles.map((ic, idx) => {
              const half = ic.w * 0.5;
              const x0 = ic.x;
              const y0 = ic.y;
              // Translucent tapered ice-droplet curve + crisp highlight glint (never flat harsh teeth).
              const icePath =
                `M ${(x0 - half).toFixed(1)},${y0.toFixed(1)} ` +
                `Q ${(x0 - half * 0.58).toFixed(1)},${(y0 + ic.h * 0.62).toFixed(1)} ${(x0 - 0.7).toFixed(1)},${(y0 + ic.h - 1.0).toFixed(1)} ` +
                `Q ${x0.toFixed(1)},${(y0 + ic.h + 0.5).toFixed(1)} ${(x0 + 0.7).toFixed(1)},${(y0 + ic.h - 1.0).toFixed(1)} ` +
                `Q ${(x0 + half * 0.58).toFixed(1)},${(y0 + ic.h * 0.62).toFixed(1)} ${(x0 + half).toFixed(1)},${y0.toFixed(1)} Z`;

              return (
                <g
                  key={ic.id}
                  ref={(el) => {
                    icicleRefs.current[idx] = el;
                  }}
                  className="season-icicle-node"
                  style={{ transformOrigin: `${x0.toFixed(1)}px ${y0.toFixed(1)}px` }}
                >
                  <path
                    d={icePath}
                    fill={`url(#${iceGradId})`}
                    stroke="rgba(255,255,255,0.45)"
                    strokeWidth="0.4"
                  />
                  <line
                    x1={(x0 - half * 0.25).toFixed(1)}
                    y1={(y0 + 1.2).toFixed(1)}
                    x2={(x0 - 0.2).toFixed(1)}
                    y2={(y0 + ic.h * 0.72).toFixed(1)}
                    stroke="rgba(255,255,255,0.78)"
                    strokeWidth="0.55"
                    strokeLinecap="round"
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}

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
