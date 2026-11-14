import { useEffect, useId, useRef, type CSSProperties } from "react";
import { useSeason, type SeasonEffect } from "../season";
import "../season.css";

/**
 * Seasonal decor with a real accumulation model.
 *
 * - Weather falls from the top of the window (a long fall, not a 70 px trickle)
 *   and lands on the rim of the notch/dock.
 * - Settled mass is a height field: every landing adds volume, an avalanche
 *   step relaxes steep slopes, so snow gathers into a drift with a soft crest
 *   instead of a row of separate grains. Rain fills a shallow puddle, leaves
 *   and petals stack into a loose mound.
 * - Brushing the pointer across the drift removes height from the field and
 *   throws the displaced particles out under gravity; the drift rebuilds as
 *   more weather lands.
 * - Drawing: every season paints one smooth SVG drift (gradient + wet surface
 *   line for rain); leaves/blossom draw individual settled sprites over it.
 */

type Props = {
  density?: number;
  pile?: number;
  scatter?: boolean;
  /** Keep the accumulated drift but stop simulating (dock/notch hidden). */
  paused?: boolean;
  /** Corner radius of the host surface, when it is drawn by a shape (not CSS). */
  radius?: number;
  /**
   * Which edge of the host the drift rests on. Docks rest on their top edge;
   * the top-of-screen notch is pinned to its bottom edge, so its rounded
   * corners drop the other way.
   */
  edge?: "top" | "bottom";
  className?: string;
};

const MAX_FALLING = 16;
const MAX_SETTLED = 96;
const MAX_SCATTERED = 28;
const MAX_RIPPLES = 8;

/** Height-field resolution across the bar. Normalised, so the bar may resize. */
const CELLS = 72;
/** Horizontal resolution of the drift path (independent of pixels). */
const VB_W = 1000;

type Tuning = {
  /** Tallest drift, in px above the rim. */
  maxPile: number;
  /** Biggest height difference between two neighbouring cells (angle of repose). */
  slope: number;
  /** Area (px²) one landing adds to the field. */
  deposit: number;
  /** Extra cells a landing spreads into. */
  spread: number;
  /** Small base drift so the rim is never completely bare. */
  seed: number;
};

const TUNING: Record<SeasonEffect, Tuning> = {
  snow: { maxPile: 26, slope: 4.2, deposit: 24, spread: 4, seed: 1.1 },
  rain: { maxPile: 14, slope: 1.6, deposit: 5.5, spread: 5, seed: 0.7 },
  // Leaves and petals must not build a fat mound: the garland carries the look,
  // the bed is only a thin shadow of litter along the rim.
  leaves: { maxPile: 5, slope: 4.8, deposit: 18, spread: 3, seed: 0.7 },
  blossom: { maxPile: 5, slope: 3.9, deposit: 15, spread: 3, seed: 0.6 },
};

/** Upper bound on how far above the rim the weather starts, per season. */
const FALL_DISTANCE: Record<SeasonEffect, number> = {
  snow: 78,
  rain: 70,
  leaves: 74,
  blossom: 70,
};

/** Relative falling-particle count. Leaves get fewer so the sky is not spammy. */
const DENSITY: Record<SeasonEffect, number> = {
  snow: 1.05,
  rain: 1.15,
  leaves: 0.5,
  blossom: 0.5,
};

/** How far the drift box reaches below the rim for the draped ends, in px. */
const SAG = 22;

const LEAF_COLORS: [string, string, string][] = [
  ["#ffd166", "#f77f00", "#9b2226"],
  ["#ff9f1c", "#e71d36", "#6a040f"],
  ["#f4a261", "#e76f51", "#7f2b18"],
  ["#ffe066", "#d9480f", "#7c2d12"],
  ["#ff758f", "#c9184a", "#590d22"],
];

function mapleLeafMarkup(idx: number): string {
  const [c1, c2, vein] = LEAF_COLORS[idx % LEAF_COLORS.length];
  const gid = `klg-${idx % LEAF_COLORS.length}`;
  const path =
    idx % 2 === 0
      ? `<path fill="url(#${gid})" stroke="${vein}" stroke-width="0.6" d="M12 1.5 L14.2 6.8 L19.5 5.2 L17.4 10.2 L22 12.4 L16.8 14.8 L18.2 18.8 L13.2 17.2 L12.4 22.5 L11.4 22.5 L10.8 17.2 L5.8 18.8 L7.2 14.8 L2 12.4 L6.6 10.2 L4.5 5.2 L9.8 6.8 Z"/>`
      : `<path fill="url(#${gid})" stroke="${vein}" stroke-width="0.6" d="M12 2 C16.5 4.5 20 8.5 19.2 13.5 C18.5 17.2 15.2 19.2 12.5 19.8 L12.5 22.8 L11.3 22.8 L11.5 19.8 C8.8 19.2 5.5 17.2 4.8 13.5 C4 8.5 7.5 4.5 12 2 Z"/>`;
  return `<svg viewBox="0 0 24 24" class="season-svg" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>${path}</svg>`;
}

function sakuraPetalMarkup(idx: number): string {
  if (idx % 4 === 0) {
    return `<svg viewBox="0 0 20 20" class="season-svg" aria-hidden="true"><g fill="#ffb3c6" stroke="#ff7597" stroke-width="0.4"><circle cx="10" cy="5.2" r="3.4"/><circle cx="14.5" cy="8.5" r="3.4"/><circle cx="12.8" cy="13.8" r="3.4"/><circle cx="7.2" cy="13.8" r="3.4"/><circle cx="5.5" cy="8.5" r="3.4"/><circle cx="10" cy="9.8" r="1.8" fill="#fff0f5"/></g></svg>`;
  }
  return `<svg viewBox="0 0 20 20" class="season-svg" aria-hidden="true"><path fill="#ffc2d4" stroke="#ff8fab" stroke-width="0.5" d="M10 18 C5 15.5 2.5 10.5 4.2 5.5 C5.4 2.2 8.2 1.8 10 4.2 C11.8 1.8 14.6 2.2 15.8 5.5 C17.5 10.5 15 15.5 10 18 Z"/></svg>`;
}

const SNOWFLAKE_MARKUP = `<svg viewBox="0 0 20 20" class="season-svg season-snowflake-svg" aria-hidden="true"><g stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"><line x1="10" y1="2" x2="10" y2="18"/><line x1="3.1" y1="6" x2="16.9" y2="14"/><line x1="3.1" y1="14" x2="16.9" y2="6"/><circle cx="10" cy="10" r="1.6" fill="#e8f4ff"/></g></svg>`;

/**
 * A crystal resting on the bank. The arms are drawn twice: a wider blue-grey
 * pass underneath acts as a crisp drawn outline, then a white pass on top. At
 * 6-8 px a soft drop-shadow just blurs the arms into a puff, so the contrast
 * comes from the two strokes instead.
 */
const SNOW_CRYSTAL_MARKUP = `<svg viewBox="0 0 20 20" class="season-svg season-crystal-svg" aria-hidden="true"><g class="season-crystal-arms" stroke="#9fbedb" stroke-width="3.2" stroke-linecap="round" fill="none"><line x1="10" y1="1.5" x2="10" y2="18.5"/><line x1="2.6" y1="5.7" x2="17.4" y2="14.3"/><line x1="2.6" y1="14.3" x2="17.4" y2="5.7"/></g><g class="season-crystal-arms" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" fill="none"><line x1="10" y1="1.5" x2="10" y2="18.5"/><line x1="2.6" y1="5.7" x2="17.4" y2="14.3"/><line x1="2.6" y1="14.3" x2="17.4" y2="5.7"/><path d="M10 4.4 L8.2 2.7 M10 4.4 L11.8 2.7 M10 15.6 L8.2 17.3 M10 15.6 L11.8 17.3"/></g></svg>`;

const SNOW_PUFF_MARKUP = `<span class="season-snow-puff"></span>`;
const RAIN_STREAK_MARKUP = `<span class="season-rain-streak"></span>`;
const RAIN_DROP_MARKUP = `<span class="season-rain-drop"></span>`;

/**
 * Rain hangs a little ivy over the ends of the bar: one tendril with a few
 * glossy leaves, so the wet season reads green at the edges instead of only
 * grey water. Drawn once per node, swayed by CSS.
 */
const IVY_MARKUP = `<svg viewBox="0 0 14 30" class="season-ivy-svg" aria-hidden="true"><path d="M7.2 0 C6 8 8.5 14 6.6 30" stroke="#3f6f3a" stroke-width="1.3" fill="none" stroke-linecap="round"/><g stroke="#2f5a2d" stroke-width="0.35"><ellipse cx="3.4" cy="6.4" rx="3.1" ry="2.2" fill="#5c9b52" transform="rotate(-26 3.4 6.4)"/><ellipse cx="10.4" cy="10.6" rx="3" ry="2.1" fill="#4c8a46" transform="rotate(24 10.4 10.6)"/><ellipse cx="3.9" cy="15.6" rx="2.9" ry="2" fill="#69a95c" transform="rotate(-20 3.9 15.6)"/><ellipse cx="9.6" cy="20.6" rx="2.6" ry="1.9" fill="#3f7a3e" transform="rotate(26 9.6 20.6)"/><ellipse cx="5.4" cy="25.4" rx="2.4" ry="1.7" fill="#5c9b52" transform="rotate(-16 5.4 25.4)"/></g><ellipse cx="5.6" cy="4.6" rx="0.9" ry="0.5" fill="#8cc47c" transform="rotate(-30 5.6 4.6)"/><ellipse cx="8.8" cy="13.4" rx="0.8" ry="0.45" fill="#8cc47c" transform="rotate(20 8.8 13.4)"/></svg>`;

/**
 * The garland runs the WHOLE rim, not just the two ends: one hanging tendril
 * every ~2% of the bar, alternating length and lean, so the vine covers the
 * face of the notch and the gaps between icons instead of sitting in two
 * clumps at the corners. Positions are percentages, so it follows any width.
 */
type GarlandNode = { key: string; x: string; len: number; delay: string; lean: number; scale: number; variant: number };

const GARLAND_NODES: GarlandNode[] = (() => {
  const out: GarlandNode[] = [];
  const count = 11;
  for (let i = 0; i < count; i++) {
    // Deterministic jitter (no Math.random: the vine must not jump on re-render).
    const r1 = ((i * 9301 + 49297) % 233280) / 233280;
    const r2 = ((i * 4093 + 7919) % 104729) / 104729;
    const x = 2.5 + (i / (count - 1)) * 95 + (r1 - 0.5) * 1.6;
    // Ends hang longest so the garland wraps the rounded corners.
    const edgeBoost = 1 - Math.min(1, Math.min(x, 100 - x) / 16);
    out.push({
      key: `g${i}`,
      x: `${x.toFixed(2)}%`,
      len: Math.round(20 + r2 * 16 + edgeBoost * 20),
      delay: `${(-(r1 * 5.6)).toFixed(2)}s`,
      lean: Math.round((r2 - 0.5) * 34),
      scale: 1.05 + r1 * 0.55,
      variant: i % 3,
    });
  }
  return out;
})();

/**
 * Rain uses the same full-rim garland but sparser and shorter: a whole wall of
 * ivy would hide the icons, so the tendrils thin out in the middle and grow
 * longer toward the corners, where the bar looks overgrown at its edges.
 */
const IVY_NODES: GarlandNode[] = GARLAND_NODES.filter((_, i) => i % 2 === 0).map((n, i) => {
  const x = parseFloat(n.x);
  const edgeBoost = 1 - Math.min(1, Math.min(x, 100 - x) / 16);
  return {
    ...n,
    key: `i${i}`,
    len: Math.round(n.len * 0.72 + edgeBoost * 14),
    scale: n.scale * (0.82 + edgeBoost * 0.25),
  };
});

function garlandNodes(season: SeasonEffect): GarlandNode[] {
  return season === "rain" ? IVY_NODES : GARLAND_NODES;
}

/** Autumn tendril: a woody stem with maple leaves of mixed warm tones. */
function leafVineMarkup(variant: number): string {
  const stems = ["#7a5334", "#6b4728", "#855c37"];
  const palettes: [string, string][] = [
    ["#ffb703", "#e07a1f"],
    ["#f4845f", "#c2410c"],
    ["#f4a261", "#9a3412"],
    ["#ffd166", "#b45309"],
  ];
  const stem = stems[variant % stems.length];
  const leaves: string[] = [];
  for (let k = 0; k < 3; k++) {
    const [c1, c2] = palettes[(variant + k) % palettes.length];
    const cx = k % 2 === 0 ? 3.6 : 10.8;
    const cy = 8 + k * 8.6;
    const rot = k % 2 === 0 ? -30 : 28;
    leaves.push(
      `<g transform="rotate(${rot} ${cx} ${cy})"><path d="M${cx} ${cy - 5.4} C${cx + 4.4} ${cy - 3} ${cx + 4.9} ${cy + 1.8} ${cx + 2} ${cy + 4.6} L${cx + 1.5} ${cy + 6.8} L${cx - 1.5} ${cy + 6.8} L${cx - 2} ${cy + 4.6} C${cx - 4.9} ${cy + 1.8} ${cx - 4.4} ${cy - 3} ${cx} ${cy - 5.4} Z" fill="${c1}"/><path d="M${cx} ${cy - 5.4} C${cx + 2.4} ${cy - 3.2} ${cx + 2.6} ${cy + 1.2} ${cx + 1.1} ${cy + 4} L${cx} ${cy + 5.8} Z" fill="${c2}" fill-opacity="0.85"/></g>`
    );
  }
  return `<svg viewBox="0 0 14 32" class="season-vine-svg season-vine-leaf" aria-hidden="true"><path d="M7.2 0 C5.6 8 8.8 15 6.4 32" stroke="${stem}" stroke-width="1.1" fill="none" stroke-linecap="round"/>${leaves.join("")}</svg>`;
}

/** Blossom tendril: a thin green branch with pink flowers and buds. */
function blossomVineMarkup(variant: number): string {
  const flowers: string[] = [];
  const pinks = ["#ffc2d4", "#ffb3c6", "#ffd6e2", "#ff9fbb"];
  for (let k = 0; k < 3; k++) {
    const cx = k % 2 === 0 ? 4 : 10.6;
    const cy = 7.5 + k * 8.6;
    const fill = pinks[(variant + k) % pinks.length];
    if (k === 2) {
      flowers.push(`<ellipse cx="${cx}" cy="${cy}" rx="2.6" ry="3.2" fill="${fill}" stroke="#f08aa8" stroke-width="0.3"/>`);
    } else {
      flowers.push(
        `<g><circle cx="${cx}" cy="${cy - 2.4}" r="2.9" fill="${fill}"/><circle cx="${cx + 2.7}" cy="${cy + 0.9}" r="2.9" fill="${fill}"/><circle cx="${cx + 1.5}" cy="${cy + 3.8}" r="2.9" fill="${fill}"/><circle cx="${cx - 1.5}" cy="${cy + 3.8}" r="2.9" fill="${fill}"/><circle cx="${cx - 2.7}" cy="${cy + 0.9}" r="2.9" fill="${fill}"/><circle cx="${cx}" cy="${cy + 1.5}" r="1.4" fill="#fff4f8"/></g>`
      );
    }
  }
  return `<svg viewBox="0 0 14 32" class="season-vine-svg season-vine-blossom" aria-hidden="true"><path d="M7 0 C6.2 9 8.4 16 6.8 32" stroke="#4d7a45" stroke-width="1" fill="none" stroke-linecap="round"/>${flowers.join("")}</svg>`;
}

/**
 * The main runner: one wavy stem along the whole rim with leaves sprouting from
 * it. Without this the tendrils read as unrelated sprigs; with it the bar looks
 * overgrown from end to end.
 *
 * Drawn as a fixed-size tile repeated with `background-repeat: repeat-x`, so
 * the leaves keep their shape at any bar width instead of being stretched.
 */
function garlandRunnerCss(season: SeasonEffect): string {
  const TILE_W = 180;
  const TILE_H = 18;
  const y = 4.2;
  const amp = 2.2;
  const yAt = (i: number, steps: number) =>
    y + Math.sin((i / steps) * Math.PI * 4) * amp + Math.sin((i / steps) * Math.PI * 8 + 1.1) * amp * 0.4;
  const steps = 24;
  let d = `M0 ${yAt(0, steps).toFixed(2)}`;
  for (let i = 1; i <= steps; i++) {
    const x = (i / steps) * TILE_W;
    const xm = ((i - 0.5) / steps) * TILE_W;
    d += ` Q${xm.toFixed(1)} ${yAt(i - 0.5, steps).toFixed(2)} ${x.toFixed(1)} ${yAt(i, steps).toFixed(2)}`;
  }

  const isLeafy = season === "leaves";
  const stemStroke = isLeafy ? "#6e4a2c" : "#4a7340";
  const leafFills = isLeafy
    ? ["#f2a03d", "#e2672b", "#d9b03c", "#c98a44", "#ef7d4a"]
    : ["#7fb069", "#5c9b52", "#95c97f", "#68a95c", "#a8d68f"];

  const bits: string[] = [];
  const count = 9;
  for (let i = 1; i <= count; i++) {
    const x = (i / (count + 1)) * TILE_W;
    const yy = yAt((i / (count + 1)) * steps, steps);
    const up = i % 2 === 0;
    const size = 4.6 + (((i * 37) % 23) / 23) * 2.2;
    const fill = leafFills[i % leafFills.length];
    const cy = yy + (up ? -size * 0.62 : size * 0.85);
    bits.push(
      `<ellipse cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(size * 0.62).toFixed(1)}" ry="${size.toFixed(1)}" fill="${fill}" transform="rotate(${up ? -26 : 24} ${x.toFixed(1)} ${cy.toFixed(1)})"/>`
    );
    if (season === "blossom" && i % 3 === 0) {
      const r = 2.1;
      const petals = [
        [0, -2.5],
        [1.8, -0.8],
        [1.1, 1.3],
        [-1.1, 1.3],
        [-1.8, -0.8],
      ]
        .map(([dx, dy]) => `<circle cx="${(x + dx).toFixed(1)}" cy="${(cy + dy).toFixed(1)}" r="${r}" fill="#ffc2d4"/>`)
        .join("");
      bits.push(`<g>${petals}<circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="1" fill="#fff4f8"/></g>`);
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}" viewBox="0 0 ${TILE_W} ${TILE_H}"><path d="${d}" fill="none" stroke="${stemStroke}" stroke-width="2" stroke-linecap="round"/>${bits.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function garlandMarkup(season: SeasonEffect, variant: number): string {
  if (season === "leaves") return leafVineMarkup(variant);
  if (season === "blossom") return blossomVineMarkup(variant);
  return IVY_MARKUP;
}

/**
 * The frozen edge: a thin, smooth snow cap along the rim (drawn as one path so
 * it never breaks) plus separate icicles positioned along the width. The
 * icicles are DOM nodes with fixed pixel sizes, not a stretched drawing, so
 * they stay sharp and correctly proportioned on a narrow notch and on a wide
 * dock alike, and they can hang as far down as real ice would.
 */
const CAP_PATH = (() => {
  const W = 1000;
  const base = 3.2;
  const steps = 40;
  let d = `M0 0 L0 ${base}`;
  for (let i = 0; i < steps; i++) {
    const x0 = (i / steps) * W;
    const x1 = ((i + 1) / steps) * W;
    const y0 = base + Math.sin((x0 / W) * Math.PI * 2.2) * 1.4 + Math.sin((x0 / W) * Math.PI * 7.3 + 1.2) * 0.8;
    const y1 = base + Math.sin((x1 / W) * Math.PI * 2.2) * 1.4 + Math.sin((x1 / W) * Math.PI * 7.3 + 1.2) * 0.8;
    d += ` Q${x0.toFixed(1)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(1)} ${((y0 + y1) / 2).toFixed(2)}`;
  }
  d += ` L${W} ${base} L${W} 0 Z`;
  return d;
})();

/**
 * One icicle: a rounded shoulder that narrows into a long, slightly bent tip.
 * Two tones (a pale core and a glassier rim) are painted, so it reads as ice
 * instead of a white triangle. `variant` picks one of three silhouettes.
 */
const ICICLE_MARKUP = [
  `<svg viewBox="0 0 22 40" preserveAspectRatio="none" aria-hidden="true"><path class="ice-body" d="M1 0 C1 6 3.4 9 5.2 14 C7.4 20.2 9.6 28 10.6 38 C10.9 39.6 11.5 39.6 11.8 38 C12.9 28 15.2 20.2 17.4 14 C19.2 9 21 6 21 0 Z"/><path class="ice-core" d="M6.4 0 C6.6 5 8 8.4 9.3 13 C10.4 17 10.8 20 11 22 C10.6 17 10.2 12.6 10.8 8.4 C11.2 5 11.6 2 11.6 0 Z"/></svg>`,
  `<svg viewBox="0 0 16 40" preserveAspectRatio="none" aria-hidden="true"><path class="ice-body" d="M1 0 C1.4 5 3.2 8 4.6 12.6 C6 17.4 7.2 24 7.7 36 C7.9 38.6 8.3 38.8 8.5 36 C9 24 10.2 17.4 11.6 12.6 C13 8 14.6 5 15 0 Z"/><path class="ice-core" d="M5.4 0 C5.8 4.6 6.6 8 7.2 12 C7.2 16 7.4 20 7.6 23 C7.4 18 7.4 13 7.8 9 C8.1 5.4 8.4 2 8.4 0 Z"/></svg>`,
  `<svg viewBox="0 0 34 34" preserveAspectRatio="none" aria-hidden="true"><path class="ice-body" d="M1 0 C1.4 4 5.6 6 9 9.6 C12.4 13.2 15.2 17.4 16.6 20.4 C17.4 22 17.8 22 18.6 20.4 C20 17.4 22.8 13.2 26.2 9.6 C29.6 6 33.6 4 34 0 Z"/><path class="ice-core" d="M13.6 0 C13.8 4 14.6 7 15.6 10 C16.4 12.4 16.8 14.4 17 15.6 C17 13.4 17.2 10.4 17.6 7.4 C18 4.4 18.4 1.8 18.4 0 Z"/></svg>`,
];

type Icicle = { key: string; x: string; w: number; h: number; variant: number; delay: string };

/**
 * Icicles hang all along the rim in loose clusters: two or three together, then
 * a bare stretch, like real melt on a roof edge. Clumping is what stops them
 * reading as a row of teeth. Ends of the bar get the longest ones, as if the
 * melt ran toward the corners. Percent positions follow any width.
 */
const ICICLES: Icicle[] = (() => {
  const out: Icicle[] = [];
  const clusters = 6;
  let key = 0;
  for (let c = 0; c < clusters; c++) {
    const r0 = ((c * 6151 + 104729) % 233280) / 233280;
    // Cluster centres spread across the bar with jitter; none hard against the
    // ends, where the rounded corner would clip it.
    const cx = 5 + ((c + 0.5) / clusters) * 90 + (r0 - 0.5) * 6;
    const members = r0 > 0.6 ? 3 : 2;
    for (let m = 0; m < members; m++) {
      const r1 = ((key * 7919 + 24697) % 233280) / 233280;
      const r2 = ((key * 3571 + 40009) % 65536) / 65536;
      const x = cx + (m - (members - 1) / 2) * (3.4 + r1 * 2.4);
      const edgeBoost = 1 - Math.min(1, Math.min(x, 100 - x) / 14);
      // One long stalactite per cluster, its neighbours much shorter, so a
      // cluster reads as hanging ice instead of a comb.
      const rank = m === 0 ? 1 : 0.3 + r2 * 0.28;
      out.push({
        key: `ice${key}`,
        x: `${Math.min(98.6, Math.max(1.4, x)).toFixed(2)}%`,
        w: Math.round(8 + r2 * 5 + edgeBoost * 4),
        h: Math.round((24 + r1 * 18) * rank + edgeBoost * 14),
        variant: key % 3,
        delay: `${(-(r1 * 4.5)).toFixed(2)}s`,
      });
      key++;
    }
  }
  return out;
})();

function fallingMarkup(season: SeasonEffect, idx: number): string {
  switch (season) {
    case "snow":
      return idx % 4 === 0 ? SNOWFLAKE_MARKUP : SNOW_PUFF_MARKUP;
    case "rain":
      return RAIN_STREAK_MARKUP;
    case "leaves":
      return mapleLeafMarkup(idx);
    case "blossom":
      return sakuraPetalMarkup(idx);
  }
}

function settledMarkup(season: SeasonEffect, idx: number): string {
  switch (season) {
    case "snow":
      // A few crystals catch the light on top of the bank; no puff "dots".
      return SNOW_CRYSTAL_MARKUP;
    case "rain":
      return RAIN_DROP_MARKUP;
    case "leaves":
      return mapleLeafMarkup(idx);
    case "blossom":
      return sakuraPetalMarkup(idx);
  }
}

interface Flyer {
  active: boolean;
  x: number;
  y: number;
  startY: number;
  vx: number;
  vy: number;
  swayAmp: number;
  swaySpeed: number;
  phase: number;
  w: number;
  h: number;
  rot: number;
  vrot: number;
  variant: number;
  cooldown: number;
}

interface Settled {
  /** 0..1 across the bar. */
  xf: number;
  /** 0..1 how deep inside the drift a leaf sits. */
  depth: number;
  size: number;
  rot: number;
}

interface Scattered {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vrot: number;
  opacity: number;
}

interface Ripple {
  active: boolean;
  x: number;
  /** Local water height at the impact point, so the ring sits on the surface. */
  bed: number;
  t: number;
}

function rnd(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function SeasonLayer({ scatter = true, paused = false, className, radius, edge = "top" }: Props) {
  const season = useSeason();
  const uid = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Hosts whose rounded surface is drawn by SurfaceShape have no CSS radius, so
  // the caller passes it in; otherwise it is measured from the parent element.
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  const driftRef = useRef<SVGPathElement>(null);
  const surfaceRef = useRef<SVGPathElement>(null);
  const lipRef = useRef<SVGPathElement>(null);
  const flyerRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const settledRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const scatterRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const rippleRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !season) return;

    const cfg = TUNING[season];
    const isSnow = season === "snow";
    const isRain = season === "rain";
    const isLeafy = season === "leaves" || season === "blossom";
    // Which way the host's rounded corners fall away from the rim. A dock's
    // corners drop below its top rim; the notch pinned to the bottom of the
    // screen has its corners cut away upwards, so its drift lifts there.
    const rimSign: 1 | -1 = edge === "bottom" ? -1 : 1;
    // Litter lies in a flat bed on the rim, so it never needs to flow down over
    // the rounded corner (only the snow bank does).
    const cornerFollow = edge === "bottom" || isLeafy ? 0 : 1;
    // Every season paints a settled bed; leaves/petals then draw sprites on it.
    // Leaves and blossom skip the bed entirely: a solid band of colour behind a
    // garland reads as a painted stripe, not as fallen leaves.
    const paintsDrift = !isLeafy;

    // ------------------------------------------------------------- the pile
    // Height above the rim, in px, sampled across the bar. Independent of the
    // bar's pixel width, so resizing the dock never invalidates the drift.
    const field = new Float32Array(CELLS);
    /** The settled depth the bar heals back to when the weather keeps falling. */
    const baseField = new Float32Array(CELLS);

    const pileCap = () =>
      Math.min(cfg.maxPile, Math.max(5, (root.clientHeight || 40) * 0.42));

    // Each column tops out at its own height: a drift that fills up must still
    // read as a rolling bank, never as one flat white roof. Two low-frequency
    // swells plus a small ripple give the crest the uneven line of real snow.
    const capAt = (i: number, cap: number) => {
      const t = i / (CELLS - 1);
      const swell =
        0.5 +
        0.28 * Math.sin(t * 6.9 + 1.15) +
        0.16 * Math.sin(t * 14.3 + 2.7) +
        0.09 * Math.sin(t * 26.1 + 0.4);
      return cap * (0.46 + 0.54 * clamp(swell, 0, 1));
    };

    const cellWidth = () => Math.max(3, (root.clientWidth || 160) / CELLS);

    // Follow the host bar's rounded rim: the drift rests on the same corner
    // curve, so a full bank drapes over it instead of being cut off at the rim.
    // The shell animates its radius when it expands, so this is re-read on a
    // slow timer as well as on resize.
    const syncRadius = () => {
      if (radiusRef.current != null) {
        root.style.setProperty("--season-radius", `${Math.max(0, Math.round(radiusRef.current))}px`);
        return;
      }
      const host = root.parentElement ?? root;
      const cs = getComputedStyle(host);
      const r =
        Math.max(
          parseFloat(cs.borderTopLeftRadius) || 0,
          parseFloat(cs.borderTopRightRadius) || 0
        ) || 0;
      root.style.setProperty("--season-radius", `${Math.max(0, Math.round(r))}px`);
    };
    syncRadius();
    window.addEventListener("resize", syncRadius);
    const radiusTimer = window.setInterval(syncRadius, 250);

    // The drift must end inside the rounded rim, so the outermost cells are
    // scaled down over a fixed pixel span (the corner radius) instead of
    // running flat into the very edge of the bar.
    const edgeTaper = (i: number) => {
      const taperCells = Math.max(2, Math.ceil(10 / cellWidth()));
      const t = clamp(Math.min(i, CELLS - 1 - i) / taperCells, 0, 1);
      const s = t * t * (3 - 2 * t);
      return s * s;
    };

    const fieldAt = (xf: number) => {
      const c = clamp(xf, 0, 1) * (CELLS - 1);
      const i = Math.floor(c);
      const f = c - i;
      return i >= CELLS - 1 ? field[CELLS - 1] : field[i] * (1 - f) + field[i + 1] * f;
    };

    // A light dusting to start with, plus a few uneven mounds. The rest of the
    // drift arrives with the falling particles.
    const seed = () => {
      const cap = pileCap();
      for (let i = 0; i < CELLS; i++) {
        const edge = edgeTaper(i);
        // A settled bank at roughly half depth, gently undulating. It should
        // already look like snow that has been falling for a while, and the
        // weather keeps adding to it.
        const swell = 0.5 + 0.5 * Math.sin(i * 0.41 + rnd(0, 41) * 6.28);
        field[i] =
          edge *
          (cfg.seed * (0.8 + rnd(i, 21) * 1.5) +
            // Start with a light dusting and let the weather build it up; snow
            // that pops in at 80% depth felt like it was already full.
            cap * (isLeafy ? 0.5 : isSnow ? 0.28 : 0.48) +
            cap * 0.14 * swell +
            cap * 0.05 * rnd(i, 22));
      }
      for (let m = 0; m < 4; m++) {
        const center = Math.round((0.14 + m * 0.24 + rnd(m, 31) * 0.05) * (CELLS - 1));
        const amp = cap * (0.12 + rnd(m, 32) * 0.12);
        const rad = Math.max(4, Math.round(CELLS * 0.085));
        for (let d = -rad; d <= rad; d++) {
          const i = center + d;
          if (i < 0 || i >= CELLS) continue;
          const f = 1 - Math.abs(d) / (rad + 1);
          field[i] = Math.min(capAt(i, cap) * edgeTaper(i), field[i] + amp * f * f);
        }
      }
    };
    seed();
    // Remember the settled bank so a brushed-off patch fills back in with the
    // next few seconds of weather instead of leaving the bar bald forever.
    baseField.set(field);

    const addVolume = (i: number, area: number, cap: number) => {
      if (i < 0 || i >= CELLS) return;
      field[i] = Math.min(capAt(i, cap), field[i] + area / cellWidth());
    };

    /** A landing deposits an area of weather around a normalised position. */
    const deposit = (xf: number, area: number, cap: number) => {
      const c = clamp(xf, 0, 1) * (CELLS - 1);
      const i0 = Math.floor(c);
      const frac = c - i0;
      addVolume(i0, area * (1 - frac), cap);
      addVolume(i0 + 1, area * frac, cap);
      for (let k = 1; k <= cfg.spread; k++) {
        const w = 0.55 / (k * k);
        addVolume(i0 - k, area * w, cap);
        addVolume(i0 + k, area * w, cap);
      }
    };

    /** Sandpile relaxation: steep crests slide sideways into a soft mound. */
    const relax = (cap: number) => {
      const maxSlope = cfg.slope;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < CELLS - 1; i++) {
          const d = field[i] - field[i + 1];
          if (d > maxSlope) {
            const t = (d - maxSlope) * 0.5;
            field[i] -= t;
            field[i + 1] += t;
          } else if (d < -maxSlope) {
            const t = (-d - maxSlope) * 0.5;
            field[i + 1] -= t;
            field[i] += t;
          }
        }
      }
      // Drifts thin out towards the open ends instead of ending in a wall.
      field[0] *= 0.972;
      field[CELLS - 1] *= 0.972;
      for (let i = 0; i < CELLS; i++) {
        const lim = capAt(i, cap) * edgeTaper(i);
        if (field[i] > lim) field[i] = lim;
        else if (field[i] < 0.02) field[i] = 0;
      }
    };

    // --------------------------------------------------------------- sprites
    const flyers: Flyer[] = Array.from({ length: MAX_FALLING }, (_, i) => ({
      active: false,
      x: 0,
      y: -75,
      startY: -75,
      vx: 0,
      vy: 25,
      swayAmp: 6,
      swaySpeed: 2,
      phase: i * 1.3,
      w: 8,
      h: 8,
      rot: 0,
      vrot: 0,
      variant: i,
      cooldown: Math.random() * 1.2,
    }));

    const scattered: Scattered[] = Array.from({ length: MAX_SCATTERED }, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      w: 8,
      h: 8,
      rot: 0,
      vrot: 0,
      opacity: 0,
    }));

    const ripples: Ripple[] = Array.from({ length: MAX_RIPPLES }, () => ({
      active: false,
      x: 0,
      bed: 0,
      t: 0,
    }));

    // Leaves and petals: a few loose sprites in the gaps are enough; the
    // garland carries the look. A full row of settled sprites reads as grass.
    const settledCount = isSnow ? 11 : isRain ? 10 : 8;

    // Leaves and petals gather into a handful of litter mounds instead of an
    // even sprinkle along the rim. The bump also lifts the sprite stack so the
    // pile reads as a rounded heap of leaves.
    const LEAF_MOUNDS = 7;
    const moundX = Array.from({ length: LEAF_MOUNDS }, (_, m) => 0.06 + rnd(m, 61) * 0.88);
    const moundBump = (xf: number) => {
      let best = 0;
      for (let m = 0; m < LEAF_MOUNDS; m++) {
        const d = Math.abs(xf - moundX[m]);
        if (d < 0.12) {
          const f = 1 - d / 0.12;
          best = Math.max(best, f * f);
        }
      }
      return best;
    };

    const settled: Settled[] = Array.from({ length: MAX_SETTLED }, (_, i) => ({
      // Snow/rain crests are spread evenly. Litter also needs an even base so
      // the pile never opens into bare gaps; the mounds only add depth on top.
      xf: isLeafy
        ? clamp(
            (i + 0.5) / settledCount +
              (rnd(i, 62) - 0.5) * 0.03 +
              (moundBump((i + 0.5) / settledCount) - 0.5) * 0.05,
            0.004,
            0.996
          )
        : (i + 0.5) / settledCount + (rnd(i, 7) - 0.5) * 0.012,
      depth: isLeafy ? 0.05 + rnd(i, 8) * 0.95 : 0.35 + rnd(i, 8) * 0.6,
      size: isSnow
        ? 4.6 + rnd(i, 9) * 2.2
        : isRain
          ? 3.2 + rnd(i, 9) * 1.6
          : isLeafy
            ? (season === "leaves" ? 9 : 8) + rnd(i, 9) * 3
            : 8,
      rot: isLeafy ? (rnd(i, 14) - 0.5) * 100 : 0,
    }));

    // Paint the sprite internals once per season.
    for (let i = 0; i < MAX_FALLING; i++) {
      const el = flyerRefs.current[i];
      if (el) {
        el.innerHTML = fallingMarkup(season, i);
        el.style.opacity = "0";
      }
    }
    for (let i = 0; i < MAX_SETTLED; i++) {
      const el = settledRefs.current[i];
      if (el) {
        el.innerHTML = i < settledCount ? settledMarkup(season, i) : "";
        el.style.opacity = "0";
      }
    }
    for (let i = 0; i < MAX_SCATTERED; i++) {
      const el = scatterRefs.current[i];
      if (el) {
        el.innerHTML = settledMarkup(season, i + 3);
        el.style.opacity = "0";
      }
    }
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const el = rippleRefs.current[i];
      if (el) {
        el.innerHTML = isRain ? `<span class="season-ripple-ring"></span>` : "";
        el.style.opacity = "0";
      }
    }

    const emitScattered = (
      x: number,
      y: number,
      w: number,
      h: number,
      rot: number,
      variant: number,
      pushDir: number,
      burst = 1
    ) => {
      for (let b = 0; b < burst; b++) {
        for (let i = 0; i < MAX_SCATTERED; i++) {
          const sc = scattered[i];
          if (sc.active) continue;
          sc.active = true;
          sc.x = x;
          sc.y = y;
          // Pop outward/up, then gravity takes over.
          sc.vx = pushDir * (14 + Math.random() * 26) + (Math.random() - 0.5) * 18;
          sc.vy = -(8 + Math.random() * 16);
          sc.w = w * (0.7 + Math.random() * 0.5);
          sc.h = h * (0.7 + Math.random() * 0.5);
          sc.rot = rot;
          sc.vrot = (pushDir || 1) * (95 + Math.random() * 150);
          sc.opacity = 0.98;
          const el = scatterRefs.current[i];
          if (el) el.innerHTML = settledMarkup(season, variant + b);
          break;
        }
      }
    };

    const spawnRipple = (xf: number, bed: number) => {
      for (let i = 0; i < MAX_RIPPLES; i++) {
        const r = ripples[i];
        if (r.active) continue;
        r.active = true;
        r.x = xf * (root.clientWidth || 160);
        r.bed = bed;
        r.t = 0;
        break;
      }
    };

    const spawnFlyer = (i: number, initial: boolean) => {
      const f = flyers[i];
      const width = root.clientWidth || 160;
      // Fall from a short, natural distance above the rim. Scaling it to the
      // bar keeps flakes hugging the surface instead of hanging in the middle
      // of the transparent window (which looked like dots stuck on screen).
      const fall = clamp(
        Math.min(pileCap() * 2.1 + 16, FALL_DISTANCE[season]),
        26,
        FALL_DISTANCE[season]
      );
      f.startY = -fall;
      f.active = true;
      f.phase = Math.random() * Math.PI * 2;
      f.x = 3 + Math.random() * Math.max(4, width - 6);
      f.y = initial
        ? f.startY + Math.random() * fall * 0.9
        : f.startY - Math.random() * 12;

      if (isRain) {
        f.w = 1;
        f.h = 9 + Math.random() * 6;
        f.vy = 95 + Math.random() * 45;
        f.vx = -6 - Math.random() * 4;
        f.swayAmp = 0;
        f.swaySpeed = 0;
        f.rot = -8;
        f.vrot = 0;
      } else if (isSnow) {
        const sz = (i % 4 === 0 ? 5.4 : 3.4) + Math.random() * 1.9;
        f.w = sz;
        f.h = sz;
        f.vy = 34 + Math.random() * 22;
        f.vx = (Math.random() - 0.5) * 5;
        f.swayAmp = 4 + Math.random() * 5;
        f.swaySpeed = 1.4 + Math.random() * 1.2;
        f.rot = 0;
        f.vrot = i % 4 === 0 ? 28 : 0;
      } else {
        const sz = (season === "leaves" ? 11 : 9.5) + Math.random() * 3.5;
        f.w = sz;
        f.h = sz;
        f.vy = 32 + Math.random() * 20;
        f.vx = (Math.random() - 0.5) * 6;
        f.swayAmp = 6 + Math.random() * 6;
        f.swaySpeed = 1.5 + Math.random() * 1.2;
        f.rot = (Math.random() - 0.5) * 35;
        f.vrot = (Math.random() - 0.5) * 55;
      }
    };

    // Pre-fill the sky so the first frame already has weather in it.
    for (let i = 0; i < MAX_FALLING; i++) {
      if (i % 2 === 0) spawnFlyer(i, true);
    }

    // ------------------------------------------------------------- pointer
    let prevMouseX: number | null = null;

    const onPointerMove = (e: PointerEvent) => {
      if (!scatter) return;
      // While the surface is hidden the drift is frozen: do not erase it either.
      if (pausedRef.current) return;
      const rect = root.getBoundingClientRect();
      const width = rect.width;
      if (width < 20) return;

      const flipped =
        !root.closest(".notch-bottom-right") && !!root.closest(".kiro:not(.expanded)");
      const rimY = flipped ? rect.bottom : rect.top;
      const relX = e.clientX - rect.left;
      const distY = e.clientY - rimY;
      const cap = pileCap();

      if (relX < -12 || relX > width + 12 || distY < -cap - 16 || distY > 18) {
        prevMouseX = null;
        return;
      }

      const mouseDeltaX = prevMouseX !== null ? relX - prevMouseX : 0;
      prevMouseX = relX;

      // A resting pointer must not strip the drift: only real horizontal travel
      // digs in, and even then it is a shallow track, never a bald bar.
      if (Math.abs(mouseDeltaX) < 1.2) return;

      const normX = clamp(relX / width, 0, 1);
      const brushCells = Math.max(2, Math.round(24 / cellWidth()));
      const center = Math.round(normX * (CELLS - 1));
      const pushDir =
        Math.abs(mouseDeltaX) > 1.2 ? Math.sign(mouseDeltaX) : Math.random() < 0.5 ? -1 : 1;
      const dig = clamp(Math.abs(mouseDeltaX) * 0.9, 0.8, 5.5);
      const floor = isLeafy ? 0.4 : 0.8;
      let bursts = 0;

      for (let i = center - brushCells; i <= center + brushCells; i++) {
        if (i < 0 || i >= CELLS) continue;
        const had = field[i];
        if (had < 0.7) continue;
        const k = 1 - Math.abs(i - center) / (brushCells + 1);
        field[i] = Math.max(Math.min(had, floor), had - dig * k);
        if (bursts < 3 && Math.random() < 0.45) {
          bursts++;
          emitScattered(
            (i / (CELLS - 1)) * width,
            -had,
            isSnow ? 4 + Math.random() * 3 : isRain ? 2.6 : 10,
            isSnow ? 3 + Math.random() * 2.6 : isRain ? 2.6 : 10,
            0,
            i,
            pushDir
          );
        }
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });

    // ---------------------------------------------------------------- frame
    let raf = 0;
    let prevTime = performance.now();
    /** True while the surface is hidden, so the frozen sky can be cleared once. */
    let wasPaused = false;
    /** Clears every flying particle and parks it for a fresh spawn. */
    const freezeSky = () => {
      for (let i = 0; i < MAX_FALLING; i++) {
        const el = flyerRefs.current[i];
        if (el) el.style.opacity = "0";
        flyers[i].active = false;
        flyers[i].cooldown = Math.random() * 0.4;
      }
      for (let i = 0; i < MAX_SCATTERED; i++) {
        const el = scatterRefs.current[i];
        if (el) el.style.opacity = "0";
        scattered[i].active = false;
      }
      for (let i = 0; i < MAX_RIPPLES; i++) {
        const el = rippleRefs.current[i];
        if (el) el.style.opacity = "0";
        ripples[i].active = false;
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (pausedRef.current) {
        // Keep the settled drift, but never leave flakes frozen in mid-air over
        // the transparent window while the surface is hidden.
        if (!wasPaused) {
          wasPaused = true;
          freezeSky();
        }
        prevTime = now;
        return;
      }
      if (wasPaused) {
        // Resume: refill the sky above the rim so it never pops in from nowhere.
        wasPaused = false;
        for (let i = 0; i < MAX_FALLING; i++) {
          if (i % 2 === 0) spawnFlyer(i, true);
        }
      }
      if (document.documentElement.classList.contains("perf-lite")) return;

      // The webview throttles/pauses rAF when the window is occluded or the
      // screen sleeps. Coming back must not paint a stale frame with flakes
      // frozen where they hung, so a long gap clears the sky and respawns.
      const rawDt = (now - prevTime) / 1000;
      if (rawDt > 0.45 || document.visibilityState !== "visible") {
        freezeSky();
        for (let i = 0; i < MAX_FALLING; i++) {
          if (i % 2 === 0) spawnFlyer(i, true);
        }
        prevTime = now;
        return;
      }

      const dt = Math.min(0.05, Math.max(0.001, rawDt));
      prevTime = now;

      const width = root.clientWidth || 160;
      const height = root.clientHeight || 40;
      const cap = pileCap();
      const maxFlyers = Math.max(
        2,
        Math.min(MAX_FALLING, Math.round((width / 46) * DENSITY[season]))
      );

      // 1. Falling weather
      for (let i = 0; i < MAX_FALLING; i++) {
        const f = flyers[i];
        const el = flyerRefs.current[i];
        if (!el) continue;

        if (i >= maxFlyers) {
          if (f.active) {
            f.active = false;
            el.style.opacity = "0";
          }
          continue;
        }

        if (!f.active) {
          f.cooldown -= dt;
          if (f.cooldown > 0) continue;
          spawnFlyer(i, false);
        }

        f.phase += f.swaySpeed * dt;
        f.y += f.vy * dt;
        f.x += f.vx * dt;
        f.rot += f.vrot * dt;

        // Keep wandering flakes inside the bar.
        if (f.x < 1) {
          f.x = 1;
          f.vx = Math.abs(f.vx);
        } else if (f.x > width - 1) {
          f.x = width - 1;
          f.vx = -Math.abs(f.vx);
        }

        const drawX = f.x + Math.sin(f.phase) * f.swayAmp;
        const traveled = f.y - f.startY;
        const fadeIn = clamp(traveled / 36, 0, 1);

        if (f.y >= -1) {
          // Landed on the drift: add real volume to the height field.
          f.active = false;
          f.cooldown = isRain
            ? 0.25 + Math.random() * 0.6
            : 0.5 + Math.random() * 1.1;
          el.style.opacity = "0";

          const nx = clamp(f.x / width, 0.015, 0.985);
          const brim = fieldAt(nx);
          const localCap = capAt(Math.round(nx * (CELLS - 1)), cap);
          // Full drift: the flake slides over the edge and falls off instead.
          if (brim < localCap - 0.35) {
            deposit(nx, (cfg.deposit * (0.55 + Math.random() * 0.75)) / 1.25, cap);
          } else if (Math.random() < 0.22) {
            emitScattered(nx * width, -1, f.w, f.h, 0, i, Math.random() < 0.5 ? -1 : 1);
          }

          if (isRain) {
            if (Math.random() < 0.45) spawnRipple(nx, fieldAt(nx));
            if (Math.random() < 0.3) {
              emitScattered(nx * width, -2, 2.4, 2.4, 0, i, Math.random() < 0.5 ? -1 : 1, 2);
            }
          }
          continue;
        }

        const tilt = isRain ? -8 : f.rot + Math.cos(f.phase) * 14;
        el.style.width = `${f.w.toFixed(1)}px`;
        el.style.height = `${f.h.toFixed(1)}px`;
        el.style.opacity = `${(fadeIn * (isRain ? 0.55 : 0.92)).toFixed(2)}`;
        el.style.transform = `translate3d(${(drawX - f.w * 0.5).toFixed(1)}px, ${f.y.toFixed(1)}px, 0) rotate(${tilt.toFixed(1)}deg)`;
      }

      // 2. The drift itself
      relax(cap);
      // Weather keeps falling, so a patch the pointer brushed away rebuilds on
      // its own instead of leaving a permanent hole in the bank.
      const heal = Math.min(1, dt * 0.45);
      for (let i = 0; i < CELLS; i++) {
        const b = baseField[i];
        if (field[i] < b) field[i] += (b - field[i]) * heal;
      }

      if (paintsDrift) {
        // RIM is the bar's top edge in viewBox units (the svg starts exactly
        // maxPile above it). The box is taller than the pile so the bank can
        // drape over the rounded ends instead of being cut off flat.
        const RIM = cfg.maxPile;
        const step = VB_W / (CELLS - 1);

        // Horizontal viewBox units are ~7x smaller than vertical ones (the box
        // is 1000 wide but only ~50 tall), so the corner radius is converted
        // through the bar's pixel width. Vertically 1 unit is exactly 1 px.
        const pxPerVb = () => (root.clientWidth || 160) / VB_W;
        const radiusPx = () => {
          const px = parseFloat(root.style.getPropertyValue("--season-radius")) || 0;
          return clamp(px, 0, 24);
        };
        // How far below the bar's top edge its rounded shoulder sits at column
        // i. The bank rests on that shoulder, so at both ends the mass flows
        // down over the corner instead of being cut off at the rim.
        const shoulder = (i: number) => {
          const r = radiusPx();
          if (r <= 0.5) return 0;
          const x = i * step * pxPerVb();
          const w = root.clientWidth || 160;
          const inset = Math.min(x, w - x);
          if (inset >= r) return 0;
          return r - Math.sqrt(Math.max(0, r * r - (r - inset) * (r - inset)));
        };

        // Leaves compact into the same mounds the sprites cluster on, so the bed
        // supports the heap instead of letting leaves float over the rim. The
        // mound lift is capped so the heap can never grow past the drift box.
        const lipScale = isLeafy ? 0.45 : isRain ? 0.5 : 1;
        const insetPxAt = (i: number) => {
          const t = i / (CELLS - 1);
          return Math.min(t, 1 - t) * (root.clientWidth || 160);
        };
        // The drift thins out before each end so it meets the rim in a soft tip
        // instead of a vertical wall. At the bottom of the screen the flat edge
        // only starts inside the rounded corners, so taper across the radius;
        // a dock's bank instead flows down over its corner.
        const taperPx =
          edge === "bottom" ? 10 : isLeafy ? 3.2 : 7;
        const taperStart = edge === "bottom" ? radiusPx() * 0.55 : 0;
        const endTaper = (i: number) =>
          clamp((insetPxAt(i) - taperStart) / taperPx, 0, 1);
        // How far the mass spills past the rim and hangs over the bar's face,
        // in soft irregular lobes. Zero at the very ends.
        const lipAt = (i: number) => {
          if (lipScale <= 0) return 0;
          const ramp =
            edge === "bottom" ? endTaper(i) : clamp(insetPxAt(i) / 9, 0, 1);
          const t = i / (CELLS - 1);
          const lobes =
            0.55 +
            0.45 * Math.sin(t * 13.1 + 1.1) * Math.sin(t * 4.7 + 0.6) +
            0.22 * Math.sin(t * 27.3 + 2.4);
          return ramp * (2.8 + 7 * clamp(lobes, 0, 1)) * lipScale;
        };
        const floorAt = (i: number) =>
          RIM + 1 + shoulder(i) * rimSign * cornerFollow + lipAt(i);
        const crest = (i: number) => {
          const lift = isLeafy ? 0.45 + 0.9 * moundBump(i / (CELLS - 1)) : 1;
          const taper = endTaper(i);
          const hgt = Math.min(field[i] * lift, cfg.maxPile) * taper;
          if (isLeafy) {
            // A litter bed stays a flat mat under the sprites: a minimum
            // thickness so it never opens into bare gaps, capped so it does not
            // rise as a smooth dune above the leaves.
            const bed = 5 + Math.min(3.6, hgt * 0.5);
            return RIM + shoulder(i) * rimSign * cornerFollow - bed * taper;
          }
          // Measured up from the shoulder, so the surface dips with the corner
          // and tapers to nothing exactly at the outer edge.
          return floorAt(i) - Math.max(0.45 * taper, hgt);
        };

        // Smooth the crest through midpoints so snow reads as rounded drifts
        // instead of a jagged polyline. The outline is drawn along the crest
        // only, so no hairline runs along the rim.
        let d = `M 0 ${crest(0).toFixed(1)}`;
        let sd = "";
        let open = false;
        for (let i = 1; i < CELLS - 1; i++) {
          const y = crest(i);
          const nx = (i + 1) * step;
          const ny = crest(i + 1);
          const mx = (i * step + nx) * 0.5;
          const my = (y + ny) * 0.5;
          d += ` Q ${(i * step).toFixed(1)} ${y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
          // Skip the tapered ends: they are only a hairline of snow and
          // outlining them made a bright wire poking out of the bar.
          const solid = field[i] > cap * 0.06 && endTaper(i) > 0.3;
          if (solid) {
            if (!open) {
              sd += `M ${((i - 1) * step).toFixed(1)} ${crest(i - 1).toFixed(1)}`;
              open = true;
            }
            sd += ` Q ${(i * step).toFixed(1)} ${y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
          } else {
            open = false;
          }
        }
        // Close the shape back along the underside, which curls down over the
        // rounded corners at both ends.
        d += ` L ${VB_W} ${crest(CELLS - 1).toFixed(1)}`;
        for (let i = CELLS - 1; i >= 0; i--) {
          d += ` L ${(i * step).toFixed(1)} ${floorAt(i).toFixed(1)}`;
        }
        d += " Z";
        if (driftRef.current) driftRef.current.setAttribute("d", d);
        if (surfaceRef.current) surfaceRef.current.setAttribute("d", sd);

        // The overhang band: the slice of the mass that has spilled past the
        // rim. Filled with the shaded tone so it reads as the bank folding over
        // the edge, not as a flat skirt. Only snow and rain use it.
        const lip = lipRef.current;
        if (lip) {
          if (lipScale > 0) {
            // The band starts at the rim (where the bank folds over the edge),
            // not at the crest, so the part above the rim keeps the bright snow
            // gradient and the underside below it reads as shaded.
            const topAt = (i: number) =>
              Math.min(Math.max(crest(i) + 0.6, RIM - 0.6), floorAt(i) - 0.25);
            let ld = `M 0 ${topAt(0).toFixed(1)}`;
            for (let i = 1; i < CELLS; i++) {
              ld += ` L ${(i * step).toFixed(1)} ${topAt(i).toFixed(1)}`;
            }
            for (let i = CELLS - 1; i >= 0; i--) {
              ld += ` L ${(i * step).toFixed(1)} ${floorAt(i).toFixed(1)}`;
            }
            lip.setAttribute("d", `${ld} Z`);
          } else if (lip.getAttribute("d")) {
            lip.setAttribute("d", "");
          }
        }
      }

      // Settled crest / leaf pile
      for (let i = 0; i < MAX_SETTLED; i++) {
        const s = settled[i];
        const el = settledRefs.current[i];
        if (!el) continue;

        if (i >= settledCount) {
          if (el.style.opacity !== "0") el.style.opacity = "0";
          continue;
        }

        const h = fieldAt(s.xf);
        if (h < (isLeafy ? 1.4 : 0.45)) {
          if (el.style.opacity !== "0") el.style.opacity = "0";
          continue;
        }

        const px = s.xf * width;
        // Rain drops rest flat on the surface; leaves fill the pile depth.
        const sw = isRain ? s.size * 1.45 : s.size;
        const sh = isLeafy ? s.size : isRain ? s.size * 0.55 : s.size * 0.9;
        const py = isLeafy
          ? -Math.min(h, 9) * (0.35 + 0.65 * s.depth) - s.size * 0.14
          : isRain
            ? -h - sh * 0.45
            : -h - s.size * 0.28;
        // Follow the rounded shoulder at the ends, so a crystal near the corner
        // sits on the snow that has draped over it instead of floating in air.
        const rPx = Math.max(0, parseFloat(root.style.getPropertyValue("--season-radius")) || 0);
        const inset = Math.min(px, width - px);
        const shoulderPx =
          rPx > 0.5 && inset < rPx
            ? (rPx - Math.sqrt(Math.max(0, rPx * rPx - (rPx - inset) * (rPx - inset)))) *
              rimSign *
              cornerFollow
            : 0;
        const edgeFade = clamp(Math.min(s.xf, 1 - s.xf) / 0.03, 0, 1);
        const wobble = isLeafy ? 0 : Math.sin(now * 0.0016 + i) * 0.6;
        // Snow/rain sprites follow the shoulder so a crystal near the corner
        // rests on the draped bank instead of floating in air. Litter never
        // hangs: a leaf below the rim would read as a floating chip.
        const hang = 0;

        el.style.width = `${sw.toFixed(1)}px`;
        el.style.height = `${sh.toFixed(1)}px`;
        el.style.opacity = `${(edgeFade * (isRain ? 0.8 : 0.96)).toFixed(2)}`;
        el.style.transform = `translate3d(${(px - sw * 0.5).toFixed(1)}px, ${(py + wobble + shoulderPx + hang).toFixed(1)}px, 0) rotate(${s.rot.toFixed(1)}deg)`;
      }

      // 3. Knocked-off weather under gravity
      for (let i = 0; i < MAX_SCATTERED; i++) {
        const sc = scattered[i];
        const el = scatterRefs.current[i];
        if (!el || !sc.active) continue;

        sc.vy += 165 * dt;
        sc.vx *= 1 - 1.4 * dt;
        sc.x += sc.vx * dt;
        sc.y += sc.vy * dt;
        sc.rot += sc.vrot * dt;
        sc.opacity -= dt * 1.05;

        if (sc.opacity <= 0.02 || sc.y > height + 40) {
          sc.active = false;
          el.style.opacity = "0";
          continue;
        }

        el.style.width = `${sc.w.toFixed(1)}px`;
        el.style.height = `${sc.h.toFixed(1)}px`;
        el.style.opacity = `${sc.opacity.toFixed(2)}`;
        el.style.transform = `translate3d(${(sc.x - sc.w * 0.5).toFixed(1)}px, ${sc.y.toFixed(1)}px, 0) rotate(${sc.rot.toFixed(1)}deg)`;
      }

      // 4. Puddle ripples
      for (let i = 0; i < MAX_RIPPLES; i++) {
        const r = ripples[i];
        const el = rippleRefs.current[i];
        if (!el) continue;
        if (!r.active) {
          if (el.style.opacity !== "0") el.style.opacity = "0";
          continue;
        }
        r.t += dt / 0.75;
        if (r.t >= 1) {
          r.active = false;
          el.style.opacity = "0";
          continue;
        }
        const grow = 0.4 + r.t * 1.5;
        el.style.opacity = `${((1 - r.t) * 0.46).toFixed(2)}`;
        el.style.transform = `translate3d(${(r.x - 7).toFixed(1)}px, ${(-r.bed - 3.5).toFixed(1)}px, 0) scale(${grow.toFixed(2)}, ${(grow * 0.32).toFixed(2)})`;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", syncRadius);
      window.clearInterval(radiusTimer);
    };
  }, [season, scatter, edge]);

  if (!season) return null;

  // The drift box is taller than the pile by SAG so the bank can drape over
  // the rounded ends; the gradient is anchored to the rim itself.
  const H = TUNING[season].maxPile + 2 + SAG;
  const gradientStops =
    season === "snow" ? (
      <>
        <stop offset="0%" stopColor="#ffffff" />
        <stop offset="58%" stopColor="#f0f7ff" />
        <stop offset="100%" stopColor="#d6e7fb" />
      </>
    ) : season === "leaves" ? (
      <>
        <stop offset="0%" stopColor="#b87d3c" stopOpacity="0.2" />
        <stop offset="55%" stopColor="#95602c" stopOpacity="0.26" />
        <stop offset="100%" stopColor="#6d401d" stopOpacity="0.3" />
      </>
    ) : season === "blossom" ? (
      <>
        <stop offset="0%" stopColor="#f7b9cd" stopOpacity="0.18" />
        <stop offset="55%" stopColor="#e79bb6" stopOpacity="0.24" />
        <stop offset="100%" stopColor="#c97a96" stopOpacity="0.28" />
      </>
    ) : (
      <>
        <stop offset="0%" stopColor="#f2fbff" stopOpacity="0.96" />
        <stop offset="30%" stopColor="#bde3ff" stopOpacity="0.74" />
        <stop offset="68%" stopColor="#93c6ee" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#6ea8d8" stopOpacity="0.38" />
      </>
    );

  return (
    <div
      ref={rootRef}
      className={`season-layer season-${season}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <div className="season-stage">
        <svg
          className="season-drift"
          viewBox={`0 0 ${VB_W} ${H}`}
          preserveAspectRatio="none"
          style={{ top: `-${TUNING[season].maxPile}px`, height: `${H}px` }}
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id={`${uid}-drift`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2="0"
              y2={TUNING[season].maxPile + 2}
            >
              {gradientStops}
            </linearGradient>
          </defs>
          <path ref={driftRef} className="season-drift-fill" fill={`url(#${uid}-drift)`} />
          <path ref={lipRef} className="season-drift-lip" />
          <path ref={surfaceRef} className="season-drift-surface" />
        </svg>

        {(season === "snow" || season === "rain") && (
          <div
            className={`season-fringe season-fringe-${season}${edge === "bottom" ? " season-fringe-bottom" : ""}`}
          >
            <svg
              className="season-fringe-cap"
              viewBox="0 0 1000 12"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id={`${uid}-cap`} x1="0" y1="0" x2="0" y2="1">
                  {season === "snow" ? (
                    <>
                      <stop offset="0%" stopColor="#ffffff" />
                      <stop offset="60%" stopColor="#f7fbff" />
                      <stop offset="100%" stopColor="#d9e9fb" />
                    </>
                  ) : (
                    <>
                      <stop offset="0%" stopColor="#f4fcff" stopOpacity="0.62" />
                      <stop offset="70%" stopColor="#bfe0f9" stopOpacity="0.5" />
                      <stop offset="100%" stopColor="#8fbfe6" stopOpacity="0.52" />
                    </>
                  )}
                </linearGradient>
              </defs>
              <path d={CAP_PATH} fill={`url(#${uid}-cap)`} />
            </svg>
            {ICICLES.map((ice) => (
              <span
                key={ice.key}
                className="season-icicle"
                style={
                  {
                    "--ice-x": ice.x,
                    "--ice-w": `${season === "rain" ? Math.max(5, Math.round(ice.w * 0.75)) : ice.w}px`,
                    "--ice-h": `${season === "rain" ? Math.max(6, Math.round(ice.h * 0.5)) : ice.h}px`,
                    "--ice-delay": ice.delay,
                  } as CSSProperties
                }
                dangerouslySetInnerHTML={{ __html: ICICLE_MARKUP[ice.variant] }}
              />
            ))}
          </div>
        )}

        {season !== "snow" && (
          <div className={`season-garland season-garland-${season}`}>
            {season !== "rain" && (
              <span
                className="season-vine-runner"
                style={{ backgroundImage: garlandRunnerCss(season) }}
              />
            )}
            {garlandNodes(season).map((n) => (
              <span
                key={n.key}
                className="season-vine"
                style={
                  {
                    "--vine-x": n.x,
                    "--vine-len": `${n.len}px`,
                    "--vine-delay": n.delay,
                    "--vine-lean": `${n.lean}deg`,
                    "--vine-scale": n.scale,
                  } as CSSProperties
                }
              >
                <span
                  className="season-vine-inner"
                  dangerouslySetInnerHTML={{ __html: garlandMarkup(season, n.variant) }}
                />
              </span>
            ))}
          </div>
        )}

        {/* The old frozen-edge ribbon duplicated the drift lip: it drew a flat
            white band across the whole rim regardless of how much snow there
            was. The lip band above now does that job and follows the pile. */}

        {Array.from({ length: MAX_SETTLED }, (_, i) => (
          <span
            key={`s${i}`}
            ref={(n) => {
              settledRefs.current[i] = n;
            }}
            className="season-node season-settled"
          />
        ))}
        {Array.from({ length: MAX_FALLING }, (_, i) => (
          <span
            key={`f${i}`}
            ref={(n) => {
              flyerRefs.current[i] = n;
            }}
            className="season-node season-flyer"
          />
        ))}
        {Array.from({ length: MAX_SCATTERED }, (_, i) => (
          <span
            key={`d${i}`}
            ref={(n) => {
              scatterRefs.current[i] = n;
            }}
            className="season-node season-scattered"
          />
        ))}
        {Array.from({ length: MAX_RIPPLES }, (_, i) => (
          <span
            key={`r${i}`}
            ref={(n) => {
              rippleRefs.current[i] = n;
            }}
            className="season-node season-ripple"
          />
        ))}
      </div>
    </div>
  );
}
