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
 * Generates lush double-strand intertwining vines/blossoms/autumn leaves or clean frosted ice
 * wrapping all 4 rounded edges cleanly while matching exact corner radii.
 */
function buildPerimeterMarkup(
  season: SeasonEffect,
  W: number,
  H: number,
  c: CornerRadii,
  edge: "top" | "bottom"
): string {
  if (W < 24 || H < 18) return "";
  const total = perimeterLength(W, H, c);
  if (total < 40) return "";

  const topFlush = edge === "bottom";
  const fmt = (n: number) => n.toFixed(1);

  if (season === "snow") {
    // Clean rounded-rect frost rim hugging exact corner radii (no dashed inner ring, no jagged edges).
    const step = 3;
    const count = Math.max(40, Math.round(total / step));
    const pts: string[] = [];
    for (let i = 0; i <= count; i++) {
      const d = (i / count) * total;
      const p = samplePerimeter(d, W, H, c);
      pts.push(`${fmt(p.x)},${fmt(p.y)}`);
    }
    const contourPath = `M ${pts.join(" L ")} Z`;

    const crystals: string[] = [];
    const topLen = Math.max(0, W - c.tl - c.tr);
    const rightLen = Math.max(0, H - c.tr - c.br);
    const botLen = Math.max(0, W - c.br - c.bl);
    const arcTR = 0.5 * Math.PI * c.tr;
    const arcBR = 0.5 * Math.PI * c.br;
    const arcBL = 0.5 * Math.PI * c.bl;
    const arcTL = 0.5 * Math.PI * c.tl;

    const cornerDists = [
      topLen + arcTR * 0.5,
      topLen + arcTR + rightLen + arcBR * 0.5,
      topLen + arcTR + rightLen + arcBR + botLen + arcBL * 0.5,
      total - arcTL * 0.5,
    ];

    cornerDists.forEach((d, idx) => {
      if (topFlush && (idx === 0 || idx === 3)) return;
      const p = samplePerimeter(d, W, H, c);
      const cx = p.x + p.nx * 2.2;
      const cy = p.y + p.ny * 2.2;
      const size = 3.6;
      const deg = (Math.atan2(p.ny, p.nx) * 180) / Math.PI;
      crystals.push(
        `<g transform="translate(${fmt(cx)},${fmt(cy)}) rotate(${fmt(deg)})" opacity="0.86">` +
          `<path d="M-${size},0 L${size},0 M0,-${size} L0,${size} M-${size * 0.65},-${size * 0.65} L${size * 0.65},${size * 0.65} M-${size * 0.65},${size * 0.65} L${size * 0.65},-${size * 0.65}" ` +
          `stroke="#eaf5ff" stroke-width="1.0" stroke-linecap="round" fill="none"/>` +
          `<circle cx="0" cy="0" r="1.15" fill="#ffffff"/>` +
          `</g>`
      );
    });

    return (
      `<g class="season-perim-frost">` +
      `<path d="${contourPath}" fill="none" stroke="rgba(218,238,255,0.46)" stroke-width="2.2" stroke-linejoin="round"/>` +
      crystals.join("") +
      `</g>`
    );
  }

  // Lush intertwining twin vine strands (rich thickness & organic twist, sampled every 2.5px so corners curve smoothly!).
  const step = 2.5;
  const segCount = Math.max(48, Math.round(total / step));
  const strandA: string[] = [];
  const strandB: string[] = [];

  for (let i = 0; i <= segCount; i++) {
    const d = (i / segCount) * total;
    const p = samplePerimeter(d, W, H, c);
    const wA = 1.5 * Math.sin(d * 0.13) + 0.5;
    const wB = 1.3 * Math.cos(d * 0.13 + 0.8) + 0.9;
    const clampInward = (off: number) => {
      if (topFlush && p.zone === "top") return clamp(off, -0.3, 0.7);
      if (p.zone === "corner") return clamp(off, -0.4, 1.4);
      if (p.zone === "top" || p.zone === "bottom") return clamp(off, -0.5, 2.2);
      return clamp(off, -0.8, 2.8);
    };
    const oA = clampInward(wA);
    const oB = clampInward(wB);
    strandA.push(`${fmt(p.x + p.nx * oA)},${fmt(p.y + p.ny * oA)}`);
    strandB.push(`${fmt(p.x + p.nx * oB)},${fmt(p.y + p.ny * oB)}`);
  }

  const pathA = `M ${strandA.join(" L ")} Z`;
  const pathB = `M ${strandB.join(" L ")} Z`;

  const ornaments: string[] = [];
  const spacing = season === "rain" ? 14 : season === "leaves" ? 14 : 17;
  const itemCount = Math.max(16, Math.floor(total / spacing));

  const leafShades =
    season === "rain"
      ? ["#1d5e2d", "#297a3b", "#37964a", "#4aad5a", "#246c35"]
      : season === "leaves"
      ? ["#d95826", "#eb8a24", "#b83622", "#e8b32a", "#c94c24"]
      : ["#4f8a48", "#65a358", "#3f743b"];

  for (let i = 0; i < itemCount; i++) {
    const jitter = (seededNoise(i, 3) - 0.5) * spacing * 0.45;
    const d = (i + 0.5) * (total / itemCount) + jitter;
    const p = samplePerimeter(d, W, H, c);

    if (topFlush && p.zone === "top" && i % 3 !== 0) continue;

    const isCornerOrSide = p.zone === "corner" || p.zone === "left" || p.zone === "right";

    const outAng = (Math.atan2(p.ny, p.nx) * 180) / Math.PI;
    const swingSign = i % 2 === 0 ? 1 : -1;
    const tilt = swingSign * (26 + seededNoise(i, 7) * 28);
    const scaleBase = isCornerOrSide
      ? 1.02 + seededNoise(i, 11) * 0.34
      : 0.94 + seededNoise(i, 11) * 0.32;

    const pushOut = topFlush && p.zone === "top" ? 0.5 : isCornerOrSide ? 2.4 : 1.7;
    const ox = p.x + p.nx * pushOut;
    const oy = p.y + p.ny * pushOut;

    if (season === "rain") {
      const fill = leafShades[i % leafShades.length];
      ornaments.push(
        `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + tilt)}) scale(${fmt(scaleBase)})">` +
          `<path d="M0,0 C1.8,-3.6 5.2,-4.4 6.8,-1.8 C8.8,-2.8 11.2,-1.1 11.8,0 C11.2,1.1 8.8,2.8 6.8,1.8 C5.2,4.4 1.8,3.6 0,0 Z" ` +
          `fill="${fill}" stroke="#123d1c" stroke-width="0.65"/>` +
          `<path d="M0.6,0 L8.5,0 M3.5,0 L5.8,-1.8 M3.5,0 L5.8,1.8" stroke="#8ce89a" stroke-opacity="0.52" stroke-width="0.55" fill="none" stroke-linecap="round"/>` +
          `</g>`
      );

      if (isCornerOrSide && i % 3 === 0) {
        const tx = p.x + p.nx * 3.6;
        const ty = p.y + p.ny * 3.6;
        ornaments.push(
          `<path d="M0,0 Q3,-3 5,0 T8,2.2 Q9.5,3.2 8.2,4.4" transform="translate(${fmt(tx)},${fmt(ty)}) rotate(${fmt(outAng - swingSign * 18)})" ` +
            `fill="none" stroke="#459d52" stroke-width="0.95" stroke-linecap="round" opacity="0.82"/>`
        );
      }

      if (i % 3 === 1) {
        const dx = ox + p.nx * 4.2 + p.tx * swingSign * 2;
        const dy = oy + p.ny * 4.2 + p.ty * swingSign * 2;
        ornaments.push(
          `<g transform="translate(${fmt(dx)},${fmt(dy)})">` +
            `<circle cx="0" cy="0" r="1.85" fill="rgba(195,236,255,0.72)" stroke="rgba(255,255,255,0.8)" stroke-width="0.45"/>` +
            `<circle cx="-0.55" cy="-0.55" r="0.6" fill="#ffffff"/>` +
            `</g>`
        );
      }
    } else if (season === "leaves") {
      const fill = leafShades[i % leafShades.length];
      const highlight = i % 2 === 0 ? "#ffd97d" : "#ffb066";
      const isMaple = i % 2 === 0;
      const leafPath = isMaple
        ? "M0,0 L2.5,-2.6 L4.6,-4.4 L5.4,-1.8 L8.5,-2.8 L7.4,-0.5 L10.6,0 L7.4,0.5 L8.5,2.8 L5.4,1.8 L4.6,4.4 L2.5,2.6 Z"
        : "M0,0 C2.6,-3.4 7.4,-3.8 10.6,0 C7.4,3.8 2.6,3.4 0,0 Z";

      ornaments.push(
        `<g transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + tilt)}) scale(${fmt(scaleBase)})">` +
          `<path d="${leafPath}" fill="${fill}" stroke="rgba(72,24,10,0.65)" stroke-width="0.55" stroke-linejoin="round"/>` +
          `<path d="M1.2,0 L8.2,0" stroke="${highlight}" stroke-opacity="0.48" stroke-width="0.55" stroke-linecap="round"/>` +
          `</g>`
      );

      if (isCornerOrSide && i % 4 === 0) {
        ornaments.push(
          `<circle cx="${fmt(ox + p.nx * 3.8)}" cy="${fmt(oy + p.ny * 3.8)}" r="1.55" fill="#d43f26" stroke="#ffad85" stroke-width="0.4"/>`
        );
      }
    } else if (season === "blossom") {
      const leafColor = leafShades[i % leafShades.length];
      ornaments.push(
        `<path d="M0,0 C2.4,-2.4 5.8,-2.2 7.8,0 C5.8,2.2 2.4,2.4 0,0 Z" ` +
          `transform="translate(${fmt(ox)},${fmt(oy)}) rotate(${fmt(outAng + tilt * 1.15)}) scale(${fmt(scaleBase * 0.9)})" ` +
          `fill="${leafColor}" stroke="#274f24" stroke-width="0.5"/>`
      );

      if (i % 2 === 0 || isCornerOrSide) {
        const bx = ox + p.nx * (isCornerOrSide ? 3.8 : 2.6);
        const by = oy + p.ny * (isCornerOrSide ? 3.8 : 2.6);
        const fScale = scaleBase * (isCornerOrSide ? 1.0 : 0.92);
        const rot = outAng + i * 23;
        const petals = [0, 72, 144, 216, 288]
          .map(
            (deg) =>
              `<ellipse cx="3.3" cy="0" rx="2.7" ry="1.85" transform="rotate(${deg})" fill="${
                i % 3 === 0 ? "#ffd4e4" : "#ffb5cf"
              }" stroke="rgba(255,255,255,0.55)" stroke-width="0.35"/>`
          )
          .join("");
        ornaments.push(
          `<g transform="translate(${fmt(bx)},${fmt(by)}) rotate(${fmt(rot)}) scale(${fmt(fScale)})">` +
            petals +
            `<circle cx="0" cy="0" r="1.45" fill="#fff099" stroke="#e68a5c" stroke-width="0.4"/>` +
            `</g>`
        );
      }
    }
  }

  const stemPrimary =
    season === "rain" ? "#1d5829" : season === "blossom" ? "#4e3328" : "#5c361a";
  const stemSecondary =
    season === "rain" ? "#348943" : season === "blossom" ? "#724c3c" : "#865429";

  return (
    `<g class="season-perim-vine">` +
    `<path d="${pathA}" fill="none" stroke="${stemPrimary}" stroke-width="2.15" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="${pathB}" fill="none" stroke="${stemSecondary}" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round" opacity="0.92"/>` +
    ornaments.join("") +
    `</g>`
  );
}

function buildIcicles(W: number, c: CornerRadii, edge: "top" | "bottom"): IcicleSpec[] {
  if (W < 90) return [];
  const specs: IcicleSpec[] = [];
  const yAnchor = 0.5;
  const shoulderStart = Math.max(10, Math.max(c.tl, c.tr) * 0.72);
  const isNarrow = W < 340;
  const count = isNarrow ? 4 : clamp(Math.floor(W / 44), 6, 12);

  let idx = 0;
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    if (isNarrow && u > 0.24 && u < 0.76) continue;
    const x = shoulderStart + u * (W - 2 * shoulderStart);
    const edgeFactor = Math.min(u, 1 - u) * 2;
    const maxLen = edge === "bottom" ? 6.5 : isNarrow ? 8.5 : u > 0.28 && u < 0.72 ? 7.5 : 11.5;
    const h = clamp(maxLen - edgeFactor * 1.5 + seededNoise(i, 19) * 3.0, 5, maxLen + 2);
    const w = 4.0 + seededNoise(i, 23) * 2.0;
    specs.push({ id: idx++, x, y: yAnchor, w, h, phase: seededNoise(i, 29) * Math.PI * 2 });
  }
  return specs;
}

function buildSnowDriftPath(bins: Float32Array, W: number, c: CornerRadii, edge: "top" | "bottom"): string {
  const n = bins.length;
  if (n < 3 || W < 40) return "";
  const r = Math.max(c.tl, c.tr);
  const lip = 1.2;
  const capScale = edge === "bottom" ? 0.38 : 1.0;

  const topPts: string[] = [];
  const basePts: string[] = [];

  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    const distLeft = x;
    const distRight = W - x;
    const cornerFade =
      r > 2
        ? clamp(Math.min(distLeft, distRight) / (r * 0.92), 0, 1)
        : clamp(Math.min(distLeft, distRight) / 6, 0, 1);
    const smoothFade = cornerFade * cornerFade * (3 - 2 * cornerFade);
    const h = bins[i] * smoothFade * capScale;
    const yCrest = edge === "bottom" ? Math.max(-2.5, 2.2 - h * 0.45) : -(h - lip);
    const yBase = edge === "bottom" ? 2.6 : lip;
    topPts.push(`${x.toFixed(1)},${yCrest.toFixed(1)}`);
    basePts.unshift(`${x.toFixed(1)},${yBase.toFixed(1)}`);
  }

  return `M ${topPts.join(" L ")} L ${basePts.join(" L ")} Z`;
}

export function SeasonLayer({
  density,
  pile,
  scatter = true,
  paused = false,
  className,
  radius = 18,
  edge = "top",
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
    () => (season && geom.w > 0 ? buildPerimeterMarkup(season, geom.w, geom.h, corners, edge) : ""),
    [season, geom.w, geom.h, corners, edge]
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
        const baseTarget = clamp(pile ? pile * 0.72 : 7.8, 4.5, 11);
        for (let i = 0; i < binCount; i++) {
          const u = i / Math.max(1, binCount - 1);
          const wave =
            0.55 +
            0.25 * Math.sin(u * Math.PI * 3.2) +
            0.2 * Math.cos(u * Math.PI * 7.5 + 0.8);
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
    const count = clamp(density ?? 12, 6, MAX_FALLING);
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
      const onRim = nearTop || nearBottom || nearLeft || nearRight;

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
  }, [season, effectivePaused, scatter, geom.w]);

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
            const sway = Math.sin(now * 0.0018 + sim.icicles[i].phase) * 1.4;
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
          const hitTop = p.y >= -4 && p.y <= 5;
          const cornerMargin = Math.max(sim.corners.tl, sim.corners.tr) * 0.7;
          if (hitTop && p.x > cornerMargin && p.x < sim.w - cornerMargin && Math.random() < 0.35) {
            const bIdx = clamp(Math.round((p.x / sim.w) * (sim.bins.length - 1)), 1, sim.bins.length - 2);
            const maxH = sim.w < 340 ? 9.5 : 12.0;
            if (sim.bins[bIdx] < maxH) {
              sim.bins[bIdx] = Math.min(maxH, sim.bins[bIdx] + 1.15);
              sim.bins[bIdx - 1] = Math.min(maxH, sim.bins[bIdx - 1] + 0.55);
              sim.bins[bIdx + 1] = Math.min(maxH, sim.bins[bIdx + 1] + 0.55);
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
          viewBox={`0 -22 ${geom.w} ${geom.h + 44}`}
          style={{
            top: -22,
            left: 0,
            width: geom.w,
            height: geom.h + 44,
          }}
        >
          <defs>
            <linearGradient id={snowGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.98" />
              <stop offset="68%" stopColor="#e8f3ff" stopOpacity="0.96" />
              <stop offset="100%" stopColor="#bdd7f4" stopOpacity="0.88" />
            </linearGradient>
            <linearGradient id={iceGradId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
              <stop offset="55%" stopColor="#cfe8ff" stopOpacity="0.78" />
              <stop offset="100%" stopColor="#8bc0ee" stopOpacity="0.62" />
            </linearGradient>
          </defs>

          <path ref={driftPathRef} fill={`url(#${snowGradId})`} className="season-drift-path" />
          <path
            ref={driftShineRef}
            fill="none"
            stroke="rgba(255,255,255,0.9)"
            strokeWidth="1"
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
                  points={`${(ic.x - ic.w * 0.5).toFixed(1)},${ic.y.toFixed(1)} ${(ic.x + ic.w * 0.5).toFixed(1)},${ic.y.toFixed(1)} ${(ic.x + 0.4).toFixed(1)},${(ic.y + ic.h).toFixed(1)}`}
                  fill={`url(#${iceGradId})`}
                  stroke="rgba(255,255,255,0.6)"
                  strokeWidth="0.45"
                />
              </g>
            ))}
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
