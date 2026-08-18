/**
 * Connection state, as one quiet line.
 *
 * Reaching a model can take a few seconds — longer if a local server has to be
 * started — and the honest way to show that is an indicator that resolves
 * itself. A modal over the window would make a slow start look like a failure
 * and would stop the user typing while they wait.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useConnection } from '@/store/connection';
import { useSettings } from '@/store/settings';
import { providerSpec } from '@/core/llm';
import { TokenMeter } from './TokenMeter';
import { cn } from '@/lib/utils';

export function StatusBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const phase = useConnection((s) => s.phase);
  const model = useConnection((s) => s.model);
  const problem = useConnection((s) => s.problem);
  const check = useConnection((s) => s.check);
  const provider = useSettings((s) => s.settings.llm.provider);

  const label = providerSpec(provider).label.split(' (')[0];

  // Failure is the only state with something to do, so it is the only one that
  // behaves like a button.
  const interactive = phase === 'failed';

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
      <AnimatePresence mode="wait" initial={false}>
        <motion.button
          key={phase}
          type="button"
          disabled={!interactive}
          onClick={() => {
            if (!interactive) return;
            void check();
            onOpenSettings?.();
          }}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
          className={cn(
            'flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left',
            interactive && 'transition-colors hover:text-foreground active:scale-95',
          )}
          title={interactive ? 'Click to retry and open settings' : undefined}
        >
          {phase === 'connecting' && (
            <>
              <Dot className="bg-risk-medium" pulse />
              <span>Connecting…</span>
            </>
          )}

          {phase === 'ready' && (
            <>
              <Dot className="bg-aria-acting" />
              <span className="truncate">
                {label}
                {model && <span className="opacity-70"> · {model}</span>}
              </span>
            </>
          )}

          {phase === 'failed' && (
            <>
              <Dot className="bg-risk-high" />
              <span className="truncate">{problem || `${label} offline`}</span>
              <span className="shrink-0 text-primary">Retry</span>
            </>
          )}

          {phase === 'idle' && <Dot className="bg-muted-foreground/40" />}
        </motion.button>
      </AnimatePresence>

      {/* Context usage sits beside the model, since the two are read together. */}
      {phase === 'ready' && <TokenMeter />}
    </div>
  );
}

function Dot({ className, pulse }: { className?: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            className,
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', className)} />
    </span>
  );
}
