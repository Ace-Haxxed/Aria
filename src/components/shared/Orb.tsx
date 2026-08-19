/**
 * The NOVA orb.
 *
 * Each agent state gets a distinct motion signature so the current state is
 * readable from across the room, without needing to read any text:
 *
 *   idle      slow breathing pulse
 *   listening concentric ripples, driven by the real microphone level
 *   thinking  a ring breathing in and out
 *   speaking  radial bars from the audio spectrum
 *   acting    fixed segments brightening in sequence
 *
 * Nothing rotates. A spinner next to text being read pulls the eye for as long
 * as the reply takes, so the busy states pulse in place instead.
 *
 * Drawn on a canvas rather than with CSS or motion components. The orb is the
 * one element on screen that animates continuously, and doing that with
 * animated DOM nodes means the compositor re-evaluates layers on every frame
 * for the whole window — which is felt as jank in the transcript while a reply
 * streams. One canvas is a single layer with a fixed cost.
 *
 * State changes are interpolated rather than switched. A hard cut between
 * colours reads as a glitch; a short blend reads as the same object changing
 * what it is doing.
 */
import { memo, useEffect, useRef } from 'react';
import type { AgentState } from '@/core/types';
import { cn } from '@/lib/utils';

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  acting: 'Working',
};

/** HSL triples, kept numeric so they can be interpolated. */
type Hsl = [number, number, number];

const FALLBACK: Record<AgentState, Hsl> = {
  idle: [197, 94, 55],
  listening: [0, 85, 60],
  thinking: [200, 15, 96],
  speaking: [212, 92, 62],
  acting: [145, 72, 48],
};

/**
 * How long each transition takes, in milliseconds.
 *
 * Entering a state is quick — the user has just done something and wants the
 * acknowledgement immediately — while settling back to idle is slower, because
 * an abrupt return reads as the app having given up rather than finished.
 */
function transitionMs(from: AgentState, to: AgentState): number {
  if (from === 'idle' && to === 'listening') return 150;
  if (from === 'listening' && to === 'thinking') return 100;
  if (from === 'thinking' && to === 'speaking') return 100;
  if (to === 'idle') return 300;
  return 200;
}

interface OrbProps {
  state: AgentState;
  /** 0-1 microphone level, drives ripple intensity while listening. */
  level?: number;
  /** Frequency bins, drives the bars while speaking. */
  spectrum?: number[];
  size?: number;
  onClick?: () => void;
  /** Press-and-hold to talk, released to send — the walkie-talkie gesture. */
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  className?: string;
}

function readPalette(): Record<AgentState, Hsl> {
  if (typeof window === 'undefined') return FALLBACK;
  const style = getComputedStyle(document.documentElement);

  const num = (name: string, fallback: number) => {
    const raw = style.getPropertyValue(name).trim().replace('%', '');
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const parse = (name: string, fallback: Hsl): Hsl => {
    const raw = style.getPropertyValue(name).trim();
    const match = raw.match(/([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
    return fallback;
  };

  return {
    // The idle colour is composed from the user's accent hue, so it is built
    // from the three parts rather than parsed from an unresolved `var()`.
    idle: [num('--accent-h', 197), num('--accent-s', 94), num('--accent-l', 55)],
    listening: parse('--nova-listening', FALLBACK.listening),
    thinking: parse('--nova-thinking', FALLBACK.thinking),
    speaking: parse('--nova-speaking', FALLBACK.speaking),
    acting: parse('--nova-acting', FALLBACK.acting),
  };
}

/** Shortest-path hue interpolation, so cyan→red does not sweep through green. */
function mixHsl(a: Hsl, b: Hsl, t: number): Hsl {
  let dh = b[0] - a[0];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return [(a[0] + dh * t + 360) % 360, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const css = (c: Hsl, alpha = 1) =>
  `hsla(${c[0].toFixed(1)}, ${c[1].toFixed(1)}%, ${c[2].toFixed(1)}%, ${alpha})`;

/** Smootherstep: no velocity discontinuity at either end of a transition. */
const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function OrbComponent({
  state,
  level = 0,
  spectrum,
  size = 200,
  onClick,
  onPointerDown,
  onPointerUp,
  className,
}: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Live values the animation loop reads. Kept in refs so a new level 50 times
  // a second re-renders nothing — the canvas is redrawn either way.
  const live = useRef({ state, level, spectrum: spectrum ?? [] });
  live.current.state = state;
  live.current.level = level;
  live.current.spectrum = spectrum ?? [];

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    let palette = readPalette();
    // The accent hue is a user setting; pick up a change without a remount.
    const paletteTimer = window.setInterval(() => {
      palette = readPalette();
    }, 2_000);

    const centre = size / 2;
    const baseRadius = size * 0.24;

    let raf = 0;
    let start = performance.now();
    let last = start;

    // Transition bookkeeping.
    let fromState: AgentState = live.current.state;
    let toState: AgentState = live.current.state;
    let transitionStart = start;
    let duration = 1;

    // Smoothed level, so a spiky microphone reading does not jitter the glow.
    let smoothedLevel = 0;

    const draw = (now: number) => {
      const current = live.current.state;

      // Frame budget.
      //
      // This loop rebuilds two radial gradients per frame and never stops, so
      // at 60fps it holds a core busy drawing an orb that is not moving. Full
      // rate is reserved for the states that actually change frame to frame:
      // audio-reactive listening, and the moment of a state transition.
      //
      // Idle still animates — the core breathes at 1.6 rad/s, which reads
      // fine at 12fps — but costs a fifth of what it did.
      const focused = document.hasFocus();
      const settled = current === toState && now - transitionStart > duration;
      const quiet = current === 'idle' && live.current.level < 0.02;

      let minFrameMs = 0;
      if (!focused) {
        // Decoration nobody is looking at.
        minFrameMs = 100;
      } else if (settled && quiet) {
        minFrameMs = 80;
      } else if (settled && current !== 'listening') {
        // Thinking and speaking pulse, but not per-frame.
        minFrameMs = 33;
      }

      if (now - last < minFrameMs) {
        raf = requestAnimationFrame(draw);
        return;
      }
      last = now;

      if (current !== toState) {
        // Blend from wherever the previous transition had reached, so a rapid
        // sequence of changes stays continuous instead of snapping.
        const progress = Math.min(1, (now - transitionStart) / duration);
        fromState = progress < 1 ? fromState : toState;
        duration = transitionMs(toState, current);
        toState = current;
        transitionStart = now;
      }

      const t = ease(Math.min(1, (now - transitionStart) / duration));
      const colour = mixHsl(palette[fromState], palette[toState], t);

      const elapsed = (now - start) / 1000;
      smoothedLevel += (live.current.level - smoothedLevel) * 0.2;

      ctx.clearRect(0, 0, size, size);

      // Outer glow, intensified by the live audio level.
      const glow = 0.18 + smoothedLevel * 0.35;
      const halo = ctx.createRadialGradient(centre, centre, baseRadius * 0.4, centre, centre, centre);
      halo.addColorStop(0, css(colour, glow));
      halo.addColorStop(1, css(colour, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      drawState(ctx, toState, {
        centre,
        baseRadius,
        size,
        elapsed,
        colour,
        level: smoothedLevel,
        spectrum: live.current.spectrum,
        blend: t,
        fromState,
      });

      // Core sphere, breathing gently at all times.
      const breath = 1 + Math.sin(elapsed * 1.6) * 0.035;
      const coreRadius = baseRadius * breath * (1 + smoothedLevel * 0.12);
      const core = ctx.createRadialGradient(
        centre - coreRadius * 0.3,
        centre - coreRadius * 0.3,
        coreRadius * 0.1,
        centre,
        centre,
        coreRadius,
      );
      core.addColorStop(0, css([colour[0], colour[1], Math.min(98, colour[2] + 30)], 0.95));
      core.addColorStop(0.6, css(colour, 0.85));
      core.addColorStop(1, css([colour[0], colour[1], Math.max(8, colour[2] - 28)], 0.9));

      ctx.beginPath();
      ctx.arc(centre, centre, coreRadius, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(paletteTimer);
    };
  }, [size]);

  const interactive = Boolean(onClick || onPointerDown);

  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      // Releasing outside the orb must still send, or a slight drag while
      // speaking silently discards the recording.
      onPointerLeave={onPointerUp}
      onPointerCancel={onPointerUp}
      role={interactive ? 'button' : 'img'}
      tabIndex={interactive ? 0 : undefined}
      aria-label={STATE_LABEL[state]}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={{ width: size, height: size }}
      className={cn(
        'select-none',
        interactive && 'cursor-pointer transition-transform duration-150 active:scale-95',
        className,
      )}
    />
  );
}

interface DrawArgs {
  centre: number;
  baseRadius: number;
  size: number;
  elapsed: number;
  colour: Hsl;
  level: number;
  spectrum: number[];
  blend: number;
  fromState: AgentState;
}

/** The per-state motion signature, drawn behind the core. */
function drawState(ctx: CanvasRenderingContext2D, state: AgentState, a: DrawArgs) {
  const { centre, baseRadius, elapsed, colour, level, spectrum } = a;

  switch (state) {
    case 'idle': {
      // A single slow ring, breathing out and fading.
      const phase = (elapsed * 0.35) % 1;
      ctx.beginPath();
      ctx.arc(centre, centre, baseRadius * (1.25 + phase * 0.7), 0, Math.PI * 2);
      ctx.strokeStyle = css(colour, 0.28 * (1 - phase));
      ctx.lineWidth = 1.5;
      ctx.stroke();
      break;
    }

    case 'listening': {
      // Three ripples, spaced evenly through the cycle. Loud speech pushes
      // them further out, which is what makes the orb feel connected to the
      // microphone rather than merely animated.
      const reach = 0.55 + level * 0.9;
      for (let i = 0; i < 3; i++) {
        const phase = ((elapsed * 1.1 + i / 3) % 1);
        ctx.beginPath();
        ctx.arc(centre, centre, baseRadius * (1 + phase * reach), 0, Math.PI * 2);
        ctx.strokeStyle = css(colour, 0.4 * (1 - phase));
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      break;
    }

    case 'thinking': {
      // A ring that breathes rather than a head that travels round it.
      // Nothing here rotates: a spinner beside text you are trying to read
      // pulls the eye continuously, and it is the one thing on screen for as
      // long as a reply takes.
      const radius = baseRadius * 1.5;
      const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5;

      ctx.beginPath();
      ctx.arc(centre, centre, radius, 0, Math.PI * 2);
      ctx.strokeStyle = css(colour, 0.18 + pulse * 0.5);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.stroke();
      break;
    }

    case 'speaking': {
      // Radial bars around the core. Falls back to a gentle synthetic wave
      // when there is no spectrum — OS-native speech gives us no signal, and
      // a motionless orb would suggest nothing is happening.
      const bars = spectrum.length > 0 ? spectrum : synthetic(elapsed);
      const inner = baseRadius * 1.18;
      ctx.lineCap = 'round';
      for (let i = 0; i < bars.length; i++) {
        const angle = (i / bars.length) * Math.PI * 2 - Math.PI / 2;
        const length = baseRadius * (0.12 + bars[i] * 0.75);
        ctx.beginPath();
        ctx.moveTo(centre + Math.cos(angle) * inner, centre + Math.sin(angle) * inner);
        ctx.lineTo(
          centre + Math.cos(angle) * (inner + length),
          centre + Math.sin(angle) * (inner + length),
        );
        ctx.strokeStyle = css(colour, 0.5 + bars[i] * 0.5);
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      break;
    }

    case 'acting': {
      // Fixed segments that brighten in turn. Distinct from thinking's single
      // ring, and still obviously busy — but the segments hold their position
      // instead of turning, so nothing on screen is spinning.
      const radius = baseRadius * 1.45;
      const segments = 6;
      ctx.lineCap = 'butt';
      for (let i = 0; i < segments; i++) {
        const from = (i / segments) * Math.PI * 2;
        // Each segment peaks a beat after the one before it.
        const lit = 0.5 + Math.sin(elapsed * 3 - (i / segments) * Math.PI * 2) * 0.5;
        ctx.beginPath();
        ctx.arc(centre, centre, radius, from, from + Math.PI / segments);
        ctx.strokeStyle = css(colour, 0.2 + lit * 0.6);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      break;
    }
  }
}

/** A plausible waveform for when no real spectrum is available. */
function synthetic(elapsed: number): number[] {
  return Array.from(
    { length: 24 },
    (_, i) => 0.25 + Math.abs(Math.sin(elapsed * 3 + i * 0.5)) * 0.4,
  );
}

export const Orb = memo(OrbComponent);
