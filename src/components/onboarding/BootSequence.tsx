/**
 * The start-up sequence.
 *
 * ARIA has real work to do before it can answer: probing the model backend,
 * loading settings, reading conversation history. That takes a moment, and a
 * blank window during it reads as a hang. This shows what is actually
 * happening — each line appears as its step completes, so the sequence is a
 * genuine progress report rather than theatre.
 *
 * It never blocks: if a step is slow the overlay clears anyway and the app
 * carries on, because a start-up animation that outlasts start-up is worse
 * than no animation.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface Step {
  label: string;
  /** Resolves when this step is genuinely done. */
  run: () => Promise<string>;
}

/** Hard ceiling. The overlay clears at this point whatever is still pending. */
const MAX_DURATION_MS = 2_600;
/** Minimum time each line is visible, so the sequence is readable. */
const MIN_STEP_MS = 180;

/**
 * Reveal a string one character at a time.
 *
 * The interval is derived from the text length so a long line and a short one
 * take about the same time to appear — typing at a fixed per-character rate
 * would make the sequence drag on whichever step happened to be wordiest.
 */
function useTyped(text: string, totalMs = 220): string {
  const [shown, setShown] = useState('');

  useEffect(() => {
    setShown('');
    if (!text) return;
    const step = Math.max(12, totalMs / text.length);
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, step);
    return () => window.clearInterval(id);
  }, [text, totalMs]);

  return shown;
}

function TypedLine({ label, result }: { label: string; result: string }) {
  const typed = useTyped(result);

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
      className="flex items-baseline justify-between gap-3"
    >
      <span className="uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
      <span
        className="flex-1 self-center border-b border-dashed opacity-30"
        style={{ borderColor: 'var(--hud-edge-bright)' }}
      />
      <span className={result === 'unavailable' ? 'text-risk-medium' : 'text-primary'}>
        {typed}
      </span>
    </motion.div>
  );
}

export function BootSequence({ onDone }: { onDone: () => void }) {
  const [lines, setLines] = useState<Array<{ label: string; result: string }>>([]);
  const [leaving, setLeaving] = useState(false);
  const [online, setOnline] = useState(false);
  const finished = useRef(false);

  useEffect(() => {
    let alive = true;

    const finish = () => {
      if (finished.current) return;
      finished.current = true;
      setLeaving(true);
      // Let the fade play out before the app takes the screen.
      window.setTimeout(onDone, 320);
    };

    // The steps report on real subsystems. Each catches its own failure and
    // reports it as a line rather than throwing — a backend that is missing is
    // information, not a reason to stall the launch.
    const steps: Step[] = [
      {
        label: 'core',
        run: async () => 'online',
      },
      {
        label: 'audio',
        run: async () => {
          const { isTauri } = await import('@/platform');
          if (!isTauri) return 'browser';
          const { desktop } = await import('@/platform/desktop');
          const mic = await desktop.testMicrophone();
          return mic.device.slice(0, 22);
        },
      },
      {
        label: 'display',
        run: async () => {
          const { isTauri } = await import('@/platform');
          if (!isTauri) return 'browser';
          const { desktop } = await import('@/platform/desktop');
          const { width, height } = await desktop.screenSize();
          return `${width}×${height}`;
        },
      },
      {
        label: 'neural link',
        run: async () => {
          // The key config is what the next message will actually use.
          const { useKeys, PROVIDER_LABEL } = await import('@/store/keys');
          const { activeProvider, ready } = useKeys.getState();
          if (!ready()) return 'no key';
          return PROVIDER_LABEL[activeProvider].toLowerCase();
        },
      },
    ];

    // Anything still running when the ceiling is reached is abandoned; the
    // subsystem keeps initialising in the background regardless.
    const ceiling = window.setTimeout(finish, MAX_DURATION_MS);

    void (async () => {
      for (const step of steps) {
        const started = Date.now();
        let result = 'ok';
        try {
          result = await step.run();
        } catch {
          // A failed probe is reported, not fatal. The app surfaces the real
          // problem through its own status line once it is running.
          result = 'unavailable';
        }
        if (!alive || finished.current) return;

        const elapsed = Date.now() - started;
        if (elapsed < MIN_STEP_MS) {
          await new Promise((r) => setTimeout(r, MIN_STEP_MS - elapsed));
        }
        if (!alive || finished.current) return;

        setLines((current) => [...current, { label: step.label, result }]);
      }

      if (alive) {
        window.clearTimeout(ceiling);
        // Every subsystem has reported: say so, hold it briefly, then hand over.
        setOnline(true);
        window.setTimeout(finish, 420);
      }
    })();

    return () => {
      alive = false;
      window.clearTimeout(ceiling);
    };
  }, [onDone]);

  return (
    <AnimatePresence>
      {!leaving && (
        <motion.div
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
          className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-background"
        >
          {/* Scanlines, and a brighter band sweeping down over them. Both are
              pure CSS so they cost nothing and cannot fail to load. */}
          <div className="boot-scanlines" aria-hidden />
          <div className="boot-sweep" aria-hidden />

          {/* A faint ring behind the text, echoing the orb. */}
          <motion.div
            aria-hidden
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 0.14, scale: 1 }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
            className="pointer-events-none absolute h-[420px] w-[420px] rounded-full border border-primary"
            style={{ boxShadow: '0 0 90px -20px hsl(var(--accent-h) var(--accent-s) var(--accent-l))' }}
          />

          <div className="relative w-full max-w-sm px-8">
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="hud-brand mb-6 text-center text-lg tracking-[0.34em] text-primary"
            >
              ARIA
            </motion.div>

            <div className="space-y-1.5 font-mono text-[11px]">
              {lines.map((line) => (
                <TypedLine key={line.label} label={line.label} result={line.result} />
              ))}

              {online ? (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                  className="pt-3 text-center text-[12px] font-medium tracking-[0.34em] text-primary"
                  style={{
                    textShadow:
                      '0 0 18px hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.7)',
                  }}
                >
                  ARIA ONLINE
                </motion.div>
              ) : (
                /* Cursor, until the last line lands. */
                <motion.span
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                  className="inline-block h-3 w-1.5 bg-primary align-middle"
                />
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
