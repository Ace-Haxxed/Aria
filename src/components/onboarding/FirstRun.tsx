/**
 * First-run flow: welcome, choose a brain, check the machine.
 *
 * Three steps, in the order the decisions actually depend on each other — the
 * system check cannot report an AI connection before one has been chosen. The
 * user can leave at any point; setup that traps someone is worse than setup
 * they skipped.
 */
import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Orb } from '@/components/shared/Orb';
import { BrainChoice } from './BrainChoice';
import { SystemCheck } from './SystemCheck';
import { useSettings } from '@/store/settings';
import { useConnection } from '@/store/connection';
import { cn } from '@/lib/utils';

type StepId = 'welcome' | 'brain' | 'check';
const STEPS: StepId[] = ['welcome', 'brain', 'check'];

export function FirstRun({ onComplete }: { onComplete: () => void }) {
  const [index, setIndex] = useState(0);
  const [brainReady, setBrainReady] = useState(false);
  const [checksPassed, setChecksPassed] = useState(false);
  const update = useSettings((s) => s.update);
  const step = STEPS[index];

  const finish = useCallback(() => {
    update({ setupComplete: true });
    // Kick off the normal launch check so the status bar is populated by the
    // time the main window appears.
    void useConnection.getState().check();
    onComplete();
  }, [update, onComplete]);

  const next = () => setIndex((i) => Math.min(i + 1, STEPS.length - 1));
  const back = () => setIndex((i) => Math.max(i - 1, 0));

  // The brain step is the one place the user genuinely cannot continue past —
  // an assistant with no model cannot do anything at all.
  const canAdvance = useMemo(() => {
    if (step === 'brain') return brainReady;
    return true;
  }, [step, brainReady]);

  return (
    <div className="aria-grid-bg fixed inset-0 z-50 flex flex-col bg-background">
      <div
        className="flex shrink-0 gap-1.5 px-6 pb-2"
        style={{ paddingTop: 'calc(var(--safe-top) + 1.5rem)' }}
      >
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-150',
              i <= index ? 'bg-primary' : 'bg-border',
            )}
          />
        ))}
      </div>

      <div className="aria-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.15, ease: 'easeInOut' }}
            >
              {step === 'welcome' && <Welcome onStart={next} />}
              {step === 'brain' && <BrainChoice onReadyChange={setBrainReady} />}
              {step === 'check' && <SystemCheck onAllDone={setChecksPassed} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* The welcome step carries its own single call to action. */}
      {step !== 'welcome' && (
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-6 py-4"
          style={{ paddingBottom: 'calc(var(--safe-bottom) + 1rem)' }}
        >
          <Button variant="ghost" onClick={back} className="gap-1">
            <ChevronLeft className="h-4 w-4" />
            Back
          </Button>

          <button
            onClick={finish}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip setup
          </button>

          {step === 'check' ? (
            <Button onClick={finish} className="gap-1.5">
              Enter ARIA
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={next} disabled={!canAdvance} className="gap-1.5">
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* Announce completion for screen readers without stealing focus. */}
      <span className="sr-only" role="status">
        {step === 'check' && checksPassed ? 'All system checks passed.' : ''}
      </span>
    </div>
  );
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="flex min-h-[60vh] flex-col items-center justify-center gap-8 text-center"
    >
      <Orb state="idle" size={200} />

      <div className="space-y-3">
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, delay: 0.15 }}
          className="text-3xl font-semibold tracking-tight"
        >
          Your AI. Your computer. Your control.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, delay: 0.28 }}
          className="text-sm leading-relaxed text-muted-foreground"
        >
          ARIA runs locally or in the cloud — you choose.
        </motion.p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, delay: 0.42 }}
      >
        <Button size="lg" onClick={onStart} className="gap-2">
          Get Started
          <ArrowRight className="h-4 w-4" />
        </Button>
      </motion.div>
    </motion.div>
  );
}
