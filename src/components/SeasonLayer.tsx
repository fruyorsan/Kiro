import type { CSSProperties } from "react";
import { useSeason } from "../season";
import "../season.css";

/**
 * A decorative layer that rests on the notch/dock rim.
 *
 * Two groups of static spans:
 * - `season-pile`: the settled grains. They straddle the top edge, so most of
 *   each one sits above the bar on the wallpaper (snow on a ledge, leaves caught
 *   on the rim) instead of being painted inside the surface.
 * - `season-bit`: falling flakes. Each one hangs above the rim and settles onto
 *   it, then fades into the drift.
 *
 * The motion is CSS keyframes on `transform`/`opacity` only, so the compositor
 * does the work and React never re-renders. `pointer-events: none` keeps every
 * click going to the surface underneath (the dock is click-through machinery,
 * so this matters), and the whole layer disappears in perf mode and for users
 * who ask for reduced motion.
 */

function rnd(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

type Props = {
  /** Falling flakes. Kept tiny on purpose: this runs in every Kiro window. */
  density?: number;
  /** Settled grains along the rim. */
  pile?: number;
  className?: string;
};

export function SeasonLayer({ density = 9, pile = 12, className }: Props) {
  const season = useSeason();
  if (!season) return null;

  const isAutumn = season === "autumn";

  return (
    <div className={`season-layer season-${season}${className ? ` ${className}` : ""}`} aria-hidden="true">
      {/* Settled grains first: the falling ones land in front of them. */}
      {Array.from({ length: pile }, (_, i) => {
        // Spread them evenly across the width with a little jitter, so the line
        // reads as a drift rather than a repeating pattern.
        const spread = pile > 1 ? (i / (pile - 1)) * 96 + 1.5 : 50;
        const style = {
          "--x": `${(spread + (rnd(i, 11) - 0.5) * 3).toFixed(2)}%`,
          "--size": `${(isAutumn ? 4.5 : 3.5) + rnd(i, 12) * 2.6}px`,
          // Half-buried: 1-3px of each grain overlaps the rim.
          "--sink": `${(1 + rnd(i, 13) * 2).toFixed(1)}px`,
          "--rot": `${Math.round(rnd(i, 14) * 360)}deg`,
        } as CSSProperties;
        return <span key={`p${i}`} className="season-pile" style={style} />;
      })}

      {Array.from({ length: density }, (_, i) => {
        const style = {
          "--x": `${Math.round(rnd(i, 1) * 96)}%`,
          "--size": `${(isAutumn ? 5 : 3) + Math.round(rnd(i, 2) * 3)}px`,
          "--dur": `${(season === "summer" ? 9 : 7) + Math.round(rnd(i, 3) * 7)}s`,
          "--delay": `${(-Math.round(rnd(i, 4) * 120) / 10).toFixed(1)}s`,
          "--drift": `${Math.round((rnd(i, 5) - 0.5) * 26)}px`,
          "--rot": `${Math.round(rnd(i, 6) * 360)}deg`,
          "--op": (0.55 + rnd(i, 8) * 0.4).toFixed(2),
          // Summer only: height inside the 26px band above the rim.
          "--y": `${Math.round(2 + rnd(i, 7) * 20)}px`,
        } as CSSProperties;
        return <span key={`b${i}`} className="season-bit" style={style} />;
      })}
    </div>
  );
}
