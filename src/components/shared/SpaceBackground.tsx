/**
 * The ambient backdrop: deep space, stars, one drifting aurora, a perspective
 * grid.
 *
 * Every layer is CSS. No canvas, no requestAnimationFrame, no library, no
 * image — which means it costs nothing on the main thread, cannot fail to
 * load, and keeps animating while React is busy streaming a reply. The star
 * field is the only part generated in JS, and only once: positions are fixed
 * at module load so the layout never reflows and a re-render never reshuffles
 * the sky.
 *
 * It sits at the root behind everything, `fixed` and `pointer-events-none`, so
 * no component has to know it exists.
 */

/** Enough to read as a field without becoming a texture. */
const STAR_COUNT = 200;

/**
 * Deterministic pseudo-random, seeded per index.
 *
 * `Math.random()` would give a different sky on every reload, and — worse —
 * a different one per hot reload during development, which makes visual
 * regressions impossible to spot. The exact constants do not matter, only
 * that the sequence is stable and well spread.
 */
function noise(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

interface Star {
  left: string;
  top: string;
  size: string;
  /** 3-8s, so neighbouring stars visibly drift out of step. */
  duration: string;
  /** Staggered start, so they do not all pulse together on first paint. */
  delay: string;
  peak: number;
}

const STARS: Star[] = Array.from({ length: STAR_COUNT }, (_, i) => {
  const bright = noise(i * 3 + 2);
  return {
    left: `${noise(i * 3) * 100}%`,
    top: `${noise(i * 3 + 1) * 100}%`,
    // A few larger ones give the field depth; most stay sub-pixel-ish.
    size: `${bright > 0.93 ? 2 : 1}px`,
    duration: `${3 + noise(i * 3 + 4) * 5}s`,
    delay: `${noise(i * 3 + 5) * 8}s`,
    peak: 0.3 + bright * 0.5,
  };
});

export function SpaceBackground() {
  return (
    <div aria-hidden className="aria-space">
      {/* Radial gradient from the void centre out to black. */}
      <div className="aria-space-void" />

      {/* Perspective grid receding to the centre. Two gradients, skewed —
          cheaper and crisper than an SVG at any resolution. */}
      <div className="aria-space-grid" />

      {/* One slow aurora. Barely visible by design: it exists to keep the
          background from reading as flat black, not to be looked at. */}
      <div className="aria-space-aurora" />

      <div className="aria-space-stars">
        {STARS.map((star, i) => (
          <span
            key={i}
            className="aria-star"
            style={{
              left: star.left,
              top: star.top,
              width: star.size,
              height: star.size,
              animationDuration: star.duration,
              animationDelay: star.delay,
              // Read by the keyframes, so each star peaks at its own
              // brightness rather than every star hitting the same value.
              ['--star-peak' as string]: star.peak,
            }}
          />
        ))}
      </div>
    </div>
  );
}
