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

/**
 * Computes clockwise point, outward normal `(nx, ny)`, and tangent `(tx, ty)`
 * around a rounded rectangle `(0, 0, W, H)` supporting independent corner radii.
 */
function samplePerimeter(dist: number, W: number, H: number, c: CornerRadii): PerimSample {
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

function perimeterLength(W: number, H: number, c: CornerRadii): number {
  return (
    2 * Math.max(0, W) -
    2 * (c.tl + c.tr + c.br + c.bl) +
    2 * Math.max(0, H) +
    0.5 * Math.PI * (c.tl + c.tr + c.br + c.bl)
  );
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
  edge: "top" | "bottom",
  openBottom: boolean,
  uid: string
): string {
  if (W < 24 || H < 18) return "";
  const total = perimeterLength(W, H, c);
  if (total < 40) return "";

  const topFlush = edge === "bottom";
  const fmt = (n: number) => n.toFixed(1);

  if (season === "snow") {
    // Snow perimeter:
    // - Dock (`openBottom`): soft icy shoulder frost wrapping ONLY top-left/right down the sides (zero bottom line!).
    // - Notch (`!openBottom`): soft ambient frosted rim + cozy corner snow pockets on bottom corners too.
    const fadeId = `kiroFrostFade-${uid}`;
    const pocketId = `kiroSnowPocket-${uid}`;

    const defs =
      `<defs>` +
      `<linearGradient id="${fadeId}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="#eaf5ff" stop-opacity="0.58"/>` +
      `<stop offset="55%" stop-color="#cde7ff" stop-opacity="0.28"/>` +
      `<stop offset="100%" stop-color="#b8dcff" stop-opacity="0"/>` +
      `</linearGradient>` +
      `<linearGradient id="${pocketId}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="#ffffff" stop-opacity="0.92"/>` +
      `<stop offset="100%" stop-color="#b7d7f7" stop-opacity="0.72"/>` +
      `</linearGradient>` +
      `</defs>`;

    if (openBottom) {
      // Dock open U-arch framing left shoulder -> top -> right shoulder, fading cleanly away before bottom!
      const sideReach = clamp(H * 0.72, 16, H - 6);
      const archPath =
        `M 0.5,${fmt(sideReach)} L 0.5,${fmt(c.tl)} ` +
        `A ${fmt(c.tl)},${fmt(c.tl)} 0 0 1 ${fmt(c.tl)},0.5 ` +
        `L ${fmt(W - c.tr)},0.5 ` +
        `A ${fmt(c.tr)},${fmt(c.tr)} 0 0 1 ${fmt(W - 0.5)},${fmt(c.tr)} ` +
        `L ${fmt(W - 0.5)},${fmt(sideReach)}`;

      return (
        `<g class="season-perim-frost">` +
        defs +
        `<path d="${archPath}" fill="none" stroke="url(#${fadeId})" stroke-width="2.6" stroke-linecap="round"/>` +
        `</g>`
      );
    }

    // Notch (collapsed & expanded): soft continuous frosted glow + soft organic snow drifts on bottom corners & sides.
    const topLen = Math.max(0, W - c.tl - c.tr);
    const rightLen = Math.max(0, H - c.tr - c.br);
    const botLen = Math.max(0, W - c.br - c.bl);
    const arcTR = 0.5 * Math.PI * c.tr;
    const arcBR = 0.5 * Math.PI * c.br;
    const arcBL = 0.5 * Math.PI * c.bl;

    // Soft organic rounded snow frost border path hugging exact corners.
    const step = 3;
    const count = Math.max(40, Math.round(total / step));
    const outerPts: string[] = [];
    for (let i = 0; i <= count; i++) {
      const p = samplePerimeter((i / count) * total, W, H, c);
      outerPts.push(`${fmt(p.x)},${fmt(p.y)}`);
    }

    // Small cozy corner snow drifts on bottom-left & bottom-right corners + mid-side frost patches on expanded panel.
    const pockets: string[] = [];
    const buildArcSnowCap = (startD: number, spanD: number, maxThick: number, outSign = 1) => {
      const steps = 12;
      const topSide: string[] = [];
      const botSide: string[] = [];
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const p = samplePerimeter(startD + u * spanD, W, H, c);
        const env = Math.sin(u * Math.PI);
        const mound = maxThick * env * env * (0.85 + 0.15 * Math.sin(u * Math.PI * 3));
        topSide.push(`${fmt(p.x + p.nx * (outSign * mound - 0.8))},${fmt(p.y + p.ny * (outSign * mound - 0.8))}`);
        botSide.unshift(`${fmt(p.x - p.nx * 0.8)},${fmt(p.y - p.ny * 0.8)}`);
      }
      return `M ${topSide.join(" L ")} L ${botSide.join(" L ")} Z`;
    };

    if (W > 200) {
      // Bottom corner snow pillows + expanded side snow patches so expanded notch feels wintry all around.
      pockets.push(
        `<path d="${buildArcSnowCap(topLen + arcTR + rightLen - 8, arcBR + Math.min(28, botLen * 0.25), 5.5)}" fill="url(#${pocketId})"/>`
      );
      pockets.push(
        `<path d="${buildArcSnowCap(topLen + arcTR + rightLen + arcBR + botLen * 0.75, arcBL + Math.min(28, botLen * 0.25), 5.5)}" fill="url(#${pocketId})"/>`
      );
      if (H > 95) {
        pockets.push(
          `<path d="${buildArcSnowCap(topLen + arcTR + rightLen * 0.25, Math.min(55, rightLen * 0.45), 4.2)}" fill="url(#${pocketId})" opacity="0.88"/>`
        );
        pockets.push(
          `<path d="${buildArcSnowCap(topLen + arcTR + rightLen + arcBR + botLen + arcBL + Math.max(0, H - c.bl - c.tl) * 0.3, Math.min(55, Math.max(20, (H - c.bl - c.tl) * 0.45)), 4.2)}" fill="url(#${pocketId})" opacity="0.88"/>`
        );
      }
    }

    return (
      `<g class="season-perim-frost">` +
      defs +
      `<path d="M ${outerPts.join(" L ")} Z" fill="none" stroke="rgba(214,237,255,0.34)" stroke-width="2.4" stroke-linejoin="round"/>` +
      `<path d="M ${outerPts.join(" L ")} Z" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="5.2" stroke-linejoin="round" opacity="0.35"/>` +
      pockets.join("") +
      `</g>`
    );
  }

  // Organic winding vine stems with uneven, natural botanical clusters (NEVER mechanical equidistant soldiers!).
  const step = 2.5;
  const segCount = Math.max(48, Math.round(total / step));
  const strandA: string[] = [];
  const strandB: string[] = [];

  for (let i = 0; i <= segCount; i++) {
    const d = (i / segCount) * total;
    const p = samplePerimeter(d, W, H, c);
    // Skip lower vine bulge on Dock bottom edge so nothing gets cut off at monitor bottom edge.
    const hideDockBottom = openBottom && p.zone === "bottom";
    const wA = 1.45 * Math.sin(d * 0.115) + 0.45 * Math.sin(d * 0.29) + 0.35;
    const wB = 1.25 * Math.cos(d * 0.115 + 0.9) + 0.35 * Math.cos(d * 0.23) + 0.7;
    const clampInward = (off: number) => {
      if (hideDockBottom) return -0.8;
      if (topFlush && p.zone === "top") return clamp(off, -0.3, 0.7);
      if (p.zone === "corner") return clamp(off, -0.35, 1.35);
      if (p.zone === "top" || p.zone === "bottom") return clamp(off, -0.45, 2.0);
      return clamp(off, -0.7, 2.5);
    };
    strandA.push(`${fmt(p.x + p.nx * clampInward(wA))},${fmt(p.y + p.ny * clampInward(wA))}`);
    strandB.push(`${fmt(p.x + p.nx * clampInward(wB))},${fmt(p.y + p.ny * clampInward(wB))}`);
  }

  const stemPrimary =
    season === "rain" ? "#1d5829" : season === "blossom" ? "#4e3328" : "#5c361a";
  const stemSecondary =
    season === "rain" ? "#348943" : season === "blossom" ? "#724c3c" : "#865429";

  let stemsSvg = "";
  if (openBottom) {
    // Open U-arch for Dock so the bottom screen-touching edge stays totally clean.
    const leftD = perimeterLength(W, H, c) - Math.max(0, H - c.bl - c.tl) * 0.2;
    const rightD = Math.max(0, W - c.tl - c.tr) + 0.5 * Math.PI * c.tr + Math.max(0, H - c.tr - c.br) * 0.88;
    const openPtsA: string[] = [];
    const openPtsB: string[] = [];
    const span = (total - leftD) + rightD;
    const steps = Math.max(36, Math.round(span / 2.5));
    for (let i = 0; i <= steps; i++) {
      const d = leftD + (i / steps) * span;
      const p = samplePerimeter(d, W, H, c);
      const wA = 1.45 * Math.sin(d * 0.115) + 0.45 * Math.sin(d * 0.29) + 0.35;
      const wB = 1.25 * Math.cos(d * 0.115 + 0.9) + 0.7;
      openPtsA.push(`${fmt(p.x + p.nx * clamp(wA, -0.4, 2.1))},${fmt(p.y + p.ny * clamp(wA, -0.4, 2.1))}`);
      openPtsB.push(`${fmt(p.x + p.nx * clamp(wB, -0.4, 2.1))},${fmt(p.y + p.ny * clamp(wB, -0.4, 2.1))}`);
    }
    stemsSvg =
      `<path d="M ${openPtsA.join(" L ")}" fill="none" stroke="${stemPrimary}" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M ${openPtsB.join(" L ")}" fill="none" stroke="${stemSecondary}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
  } else {
    stemsSvg =
      `<path d="M ${strandA.join(" L ")} Z" fill="none" stroke="${stemPrimary}" stroke-width="2.15" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<path d="M ${strandB.join(" L ")} Z" fill="none" stroke="${stemSecondary}" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round" opacity="0.92"/>`;
  }

  // Natural asymmetric botanical cluster walker (clusters of 2-4 blooms/leaves separated by organic stem gaps!).
  const ornaments: string[] = [];
  const leafShades =
    season === "rain"
      ? ["#1d5e2d", "#297a3b", "#37964a", "#4aad5a", "#246c35"]
      : season === "leaves"
      ? ["#d95826", "#eb8a24", "#b83622", "#e8b32a", "#c94c24"]
      : ["#4f8a48", "#65a358", "#3f743b"];

  let cursorD = 8 + seededNoise(1, 5) * 14;
  let clusterIdx = 0;

  while (cursorD < total - 6) {
    const clusterSize = 1 + Math.floor(seededNoise(clusterIdx, 13) * 3); // 1 to 3 items grouped organically
    for (let m = 0; m < clusterSize; m++) {
      const localD = cursorD + m * (6.5 + seededNoise(clusterIdx * 7 + m, 17) * 5.5);
      if (localD >= total) break;
      const p = samplePerimeter(localD, W, H, c);

      if (openBottom && p.zone === "bottom") continue;
      if (topFlush && p.zone === "top" && (clusterIdx + m) % 3 !== 0) continue;

      const idxSeed = clusterIdx * 11 + m;
      const isCornerOrSide = p.zone === "corner" || p.zone === "left" || p.zone === "right";
      const outAng = (Math.atan2(p.ny, p.nx) * 180) / Math.PI;
      const swingSign = seededNoise(idxSeed, 19) > 0.5 ? 1 : -1;
      const tilt = swingSign * (18 + seededNoise(idxSeed, 23) * 44);
      const sizeRand = 0.68 + seededNoise(idxSeed, 29) * 0.62; // Genuine size hierarchy (0.68..1.30)!
      const pushOut = topFlush && p.zone === "top" ? 0.45 : (1.2 + seededNoise(idxSeed, 31) * 2.2);
      const ox = p.x + p.nx * pushOut;
      const oy = p.y + p.ny * pushOut;

      if (season === "rain") {
        const fill = leafShades[idxSeed % leafShades.length];
        ornaments.push(
          `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + tilt)}) scale(${fmt(sizeRand)})">` +
            `<path d="M0,0 C1.8,-3.6 5.2,-4.4 6.8,-1.8 C8.8,-2.8 11.2,-1.1 11.8,0 C11.2,1.1 8.8,2.8 6.8,1.8 C5.2,4.4 1.8,3.6 0,0 Z" ` +
            `fill="${fill}" stroke="#123d1c" stroke-width="0.62"/>` +
            `<path d="M0.6,0 L8.5,0 M3.5,0 L5.8,-1.8 M3.5,0 L5.8,1.8" stroke="#8ce89a" stroke-opacity="0.52" stroke-width="0.52" fill="none" stroke-linecap="round"/>` +
            `</g>`
        );
        if (m === 0 && seededNoise(idxSeed, 37) > 0.58) {
          const tx = p.x + p.nx * 2.8;
          const ty = p.y + p.ny * 2.8;
          ornaments.push(
            `<path d="M0,0 Q3.2,-3.2 5.4,0.2 T8.5,2.4 Q9.8,3.5 8.4,4.8" transform="translate(${fmt(tx)},${fmt(ty)}) rotate(${fmt(outAng - swingSign * 22)})" ` +
              `fill="none" stroke="#459d52" stroke-width="0.95" stroke-linecap="round" opacity="0.84"/>`
          );
        }
        if (m === clusterSize - 1 && seededNoise(idxSeed, 41) > 0.55) {
          const dx = ox + p.nx * 3.8 + p.tx * swingSign * 2;
          const dy = oy + p.ny * 3.8 + p.ty * swingSign * 2;
          ornaments.push(
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

        ornaments.push(
          `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + tilt)}) scale(${fmt(sizeRand)})">` +
            `<path d="${leafPath}" fill="${fill}" stroke="rgba(72,24,10,0.65)" stroke-width="0.55" stroke-linejoin="round"/>` +
            `<path d="M1.2,0 L8.2,0" stroke="${highlight}" stroke-opacity="0.48" stroke-width="0.55" stroke-linecap="round"/>` +
            `</g>`
        );
        if (isCornerOrSide && m === 0 && seededNoise(idxSeed, 47) > 0.6) {
          ornaments.push(
            `<circle cx="${fmt(ox + p.nx * 3.4)}" cy="${fmt(oy + p.ny * 3.4)}" r="1.45" fill="#d43f26" stroke="#ffad85" stroke-width="0.4"/>`
          );
        }
      } else if (season === "blossom") {
        // Tuck 1-2 natural sage leaves beneath buds, then render either a rich open flower or a small closed bud!
        const leafColor = leafShades[idxSeed % leafShades.length];
        if (m === 0 || seededNoise(idxSeed, 53) > 0.48) {
          ornaments.push(
            `<path d="M0,0 C2.2,-2.2 5.4,-2.0 7.4,0 C5.4,2.0 2.2,2.2 0,0 Z" ` +
              `transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + swingSign * 42)}) scale(${fmt(sizeRand * 0.88)})" ` +
              `fill="${leafColor}" stroke="#274f24" stroke-width="0.48"/>`
          );
        }

        const isBud = m > 0 && seededNoise(idxSeed, 59) > 0.45;
        const bx = ox + p.nx * (isCornerOrSide ? 3.2 : 2.1);
        const by = oy + p.ny * (isCornerOrSide ? 3.2 : 2.1);
        if (isBud) {
          ornaments.push(
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
          ornaments.push(
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

  return `<g class="season-perim-vine">${stemsSvg}${ornaments.join("")}</g>`;
}

/** Asymmetric natural groups of translucent curved ice droplets along shoulder edges. */
function buildIcicles(W: number, c: CornerRadii, edge: "top" | "bottom"): IcicleSpec[] {
  if (W < 95) return [];
  const specs: IcicleSpec[] = [];
  const yAnchor = 0.5;
  const shoulderStart = Math.max(12, Math.max(c.tl, c.tr) * 0.85);
  const usableW = W - 2 * shoulderStart;
  if (usableW < 30) return [];

  // Natural asymmetric positions rather than identical equidistant teeth.
  const anchors =
    W < 280
      ? [0.06, 0.14, 0.86, 0.93]
      : [0.04, 0.09, 0.15, 0.31, 0.36, 0.67, 0.72, 0.85, 0.91, 0.96];

  anchors.forEach((u, idx) => {
    const x = shoulderStart + u * usableW;
    const isOuter = u < 0.22 || u > 0.78;
    const maxLen = edge === "bottom" ? 6.5 : isOuter ? 12.5 : 8.5;
    const h = clamp(maxLen * (0.65 + seededNoise(idx, 19) * 0.55), 5, 14);
    const w = 3.4 + seededNoise(idx, 23) * 1.8;
    specs.push({ id: idx, x, y: yAnchor, w, h, phase: seededNoise(idx, 29) * Math.PI * 2 });
  });
  return specs;
}

/** Smooth `snowy.aauburn.com`-style fluffy snow drift path using cubic quadratic midpoint curves. */
function buildSnowDriftPath(bins: Float32Array, W: number, c: CornerRadii, edge: "top" | "bottom"): string {
  const n = bins.length;
  if (n < 4 || W < 40) return "";
  const r = Math.max(c.tl, c.tr);
  const lip = 1.6;
  const capScale = edge === "bottom" ? 0.45 : 1.0;

  const xs: number[] = [];
  const ys: number[] = [];
  const sampleStep = Math.max(1, Math.floor(n / 44));

  for (let i = 0; i < n; i += sampleStep) {
    const x = (i / (n - 1)) * W;
    const cornerFade =
      r > 2
        ? clamp(Math.min(x, W - x) / (r * 0.94), 0, 1)
        : clamp(Math.min(x, W - x) / 6, 0, 1);
    const smoothFade = cornerFade * cornerFade * (3 - 2 * cornerFade);
    const h = bins[i] * smoothFade * capScale;
    const yCrest = edge === "bottom" ? Math.max(-3.0, 2.2 - h * 0.5) : -(h - lip);
    xs.push(x);
    ys.push(yCrest);
  }
  if (xs[xs.length - 1] !== W) {
    xs.push(W);
    ys.push(edge === "bottom" ? 2.2 : lip);
  }

  let d = `M ${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 1; i < xs.length - 1; i++) {
    const mx = (xs[i] + xs[i + 1]) * 0.5;
    const my = (ys[i] + ys[i + 1]) * 0.5;
    d += ` Q ${xs[i].toFixed(1)},${ys[i].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const yBase = edge === "bottom" ? 2.8 : lip;
  d += ` L ${W.toFixed(1)},${yBase.toFixed(1)} L 0,${yBase.toFixed(1)} Z`;
  return d;
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
  const driftShineRef = useRef<SVGPathElement>(null);

  const [geom, setGeom] = useState<{ w: number; h: number; corners?: CornerRadii }>({ w: 0, h: 0 });
  const [perfLite, setPerfLite] = useState<boolean>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("perf-lite")
  );

  const icicleRefs = useRef<(SVGGElement | null)[]>([]);
  const fallingRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const scatteredRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const rippleRefs = useRef<(HTMLSpanElement | null)[]>([]);

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
    w: number;
    h: number;
    corners: CornerRadii;
    edge: "top" | "bottom";
    season: SeasonEffect | null;
  }>({
    bins: new Float32Array(0),
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
    edge,
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
          return sameSize && sameCorners ? prev : { w, h, corners: hostCorners };
        });
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [season]);

  const corners = useMemo(
    () => resolveCorners(geom.w, geom.h, radius, geom.corners),
    [geom.w, geom.h, radius, geom.corners]
  );

  const icicles = useMemo(
    () => (season === "snow" && geom.w > 0 ? buildIcicles(geom.w, corners, edge) : []),
    [season, geom.w, corners, edge]
  );

  const perimeterMarkup = useMemo(
    () =>
      season && geom.w > 0
        ? buildPerimeterMarkup(season, geom.w, geom.h, corners, edge, openBottom, uid)
        : "",
    [season, geom.w, geom.h, corners, edge, openBottom, uid]
  );

  useEffect(() => {
    const sim = simRef.current;
    sim.w = geom.w;
    sim.h = geom.h;
    sim.corners = corners;
    sim.edge = edge;
    sim.season = season;
    sim.icicles = icicles;

    if (!season || geom.w <= 0) return;

    const binCount = clamp(Math.round(geom.w / DRIFT_BIN_PX), 20, 320);
    if (sim.bins.length !== binCount) {
      const next = new Float32Array(binCount);
      if (season === "snow") {
        // Generous pillowy snow mounds matching snowy.aauburn.com proportions!
        const baseTarget = clamp(pile ? pile * 0.92 : 12.2, 8.5, 14.5);
        for (let i = 0; i < binCount; i++) {
          const u = i / Math.max(1, binCount - 1);
          const wave =
            0.52 +
            0.28 * Math.sin(u * Math.PI * 2.8 + 0.4) +
            0.2 * Math.cos(u * Math.PI * 6.5 + 1.1);
          next[i] = baseTarget * wave;
        }
      }
      sim.bins = next;
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
  }, [season, geom.w, geom.h, corners, edge, icicles, density, pile]);

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

        if (Math.abs(ry) < 24 && rx >= 0 && rx <= sim.w && sim.bins.length > 0) {
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
            emitScattered("snow", rx, 0, vxBias, vyBias, clamp(Math.round(removed * 0.7), 1, 5));
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
          const hitTop = p.y >= -6 && p.y <= 5;
          const cornerMargin = Math.max(sim.corners.tl, sim.corners.tr) * 0.68;
          if (hitTop && p.x > cornerMargin && p.x < sim.w - cornerMargin && Math.random() < 0.45) {
            const bIdx = clamp(Math.round((p.x / sim.w) * (sim.bins.length - 1)), 2, sim.bins.length - 3);
            const maxH = sim.w < 340 ? 11.5 : 17.0;
            if (sim.bins[bIdx] < maxH) {
              sim.bins[bIdx] = Math.min(maxH, sim.bins[bIdx] + 1.65);
              sim.bins[bIdx - 1] = Math.min(maxH, sim.bins[bIdx - 1] + 0.9);
              sim.bins[bIdx + 1] = Math.min(maxH, sim.bins[bIdx + 1] + 0.9);
              sim.bins[bIdx - 2] = Math.min(maxH, sim.bins[bIdx - 2] + 0.4);
              sim.bins[bIdx + 2] = Math.min(maxH, sim.bins[bIdx + 2] + 0.4);
              sim.dirtyDrift = true;
            }
            p.y = -24 - Math.random() * 40;
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
        const path = buildSnowDriftPath(sim.bins, sim.w, sim.corners, sim.edge);
        if (driftPathRef.current) driftPathRef.current.setAttribute("d", path);
        if (driftShineRef.current) driftShineRef.current.setAttribute("d", path);
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
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.99" />
              <stop offset="62%" stopColor="#e7f3ff" stopOpacity="0.96" />
              <stop offset="100%" stopColor="#b0d2f5" stopOpacity="0.88" />
            </linearGradient>
            <linearGradient id={iceGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
              <stop offset="55%" stopColor="#cce8ff" stopOpacity="0.68" />
              <stop offset="100%" stopColor="#82bef0" stopOpacity="0.48" />
            </linearGradient>
          </defs>

          <path ref={driftPathRef} fill={`url(#${snowGradId})`} className="season-drift-path" />
          <path
            ref={driftShineRef}
            fill="none"
            stroke="rgba(255,255,255,0.92)"
            strokeWidth="1.2"
            className="season-drift-shine"
          />

          <g className="season-icicle-group">
            {icicles.map((ic, idx) => {
              const half = ic.w * 0.5;
              const x0 = ic.x;
              const y0 = ic.y;
              // Translucent tapered ice-droplet curve + crisp highlight glint (never flat harsh teeth).
              const icePath =
                `M ${(x0 - half).toFixed(1)},${y0.toFixed(1)} ` +
                `Q ${(x0 - half * 0.45).toFixed(1)},${(y0 + ic.h * 0.48).toFixed(1)} ${(x0 - 0.6).toFixed(1)},${(y0 + ic.h - 1.2).toFixed(1)} ` +
                `Q ${x0.toFixed(1)},${(y0 + ic.h + 0.6).toFixed(1)} ${(x0 + 0.7).toFixed(1)},${(y0 + ic.h - 1.2).toFixed(1)} ` +
                `Q ${(x0 + half * 0.45).toFixed(1)},${(y0 + ic.h * 0.48).toFixed(1)} ${(x0 + half).toFixed(1)},${y0.toFixed(1)} Z`;

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
