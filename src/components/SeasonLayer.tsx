import type { CSSProperties } from "react";
import { useSeason } from "../season";
import "../season.css";

/**
 * A thin decorative layer that clips itself to the notch/dock shape.
 *
 * The particles are static markup positioned with CSS variables; the motion is
 * one keyframe animation per particle. `pointer-events: none` keeps every click
 * going to the surface underneath (the dock is click-through machinery, so this
 * matters), and the whole layer disappears in perf mode and for users who ask
 * for reduced motion.
 */

function rnd(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

type Props = {
  /** Particle count. Kept tiny on purpose: this runs in every Kiro window. */
  density?: number;
  className?: string;
};

export function SeasonLayer({ density = 9, className }: Props) {
  const season = useSeason();
  if (!season) return null;

  return (
    <div className={`season-layer season-${season}${className ? ` ${className}` : ""}`} aria-hidden="true">
      {Array.from({ length: density }, (_, i) => {
        const style = {
          "--x": `${Math.round(rnd(i, 1) * 96)}%`,
          "--size": `${(season === "autumn" ? 5 : 3) + Math.round(rnd(i, 2) * 3)}px`,
          "--dur": `${(season === "summer" ? 9 : 7) + Math.round(rnd(i, 3) * 7)}s`,
          "--delay": `${(-Math.round(rnd(i, 4) * 120) / 10).toFixed(1)}s`,
          "--drift": `${Math.round((rnd(i, 5) - 0.5) * 40)}px`,
          "--rot": `${Math.round(rnd(i, 6) * 360)}deg`,
          "--y": `${Math.round(8 + rnd(i, 7) * 84)}%`,
        } as CSSProperties;
        return <span key={i} className="season-bit" style={style} />;
      })}
    </div>
  );
}
