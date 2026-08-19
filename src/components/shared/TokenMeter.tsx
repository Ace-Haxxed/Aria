/**
 * How much of the model's context window this conversation is using.
 *
 * Running out of context is the failure users find hardest to diagnose: the
 * assistant simply starts forgetting, or the provider refuses the request.
 * Showing the number as it fills makes that visible before it becomes a
 * problem, and explains why older messages get summarised when they do.
 */
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useConversation } from '@/store/conversation';
import { useSettings } from '@/store/settings';
import { measure } from '@/core/context';
import { cn } from '@/lib/utils';

export function TokenMeter() {
  const messages = useConversation((s) => s.current.messages);
  const llm = useSettings((s) => s.settings.llm);
  const [open, setOpen] = useState(false);

  const breakdown = useMemo(() => measure(llm, messages), [llm, messages]);

  // Nothing worth showing on an empty conversation.
  if (messages.length === 0) return null;

  const percent = Math.min(100, breakdown.fraction * 100);
  const tone =
    percent >= 80 ? 'text-risk-high' : percent >= 50 ? 'text-risk-medium' : 'text-nova-acting';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'rounded px-1.5 py-0.5 tabular-nums transition-colors hover:bg-muted/40',
          tone,
        )}
        title="Context used — click for a breakdown"
        aria-expanded={open}
      >
        {formatTokens(breakdown.total)} / {formatTokens(breakdown.limit)}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="absolute bottom-full left-0 z-30 mb-2 w-60 rounded-xl border border-border
              bg-card/95 p-3 shadow-lg backdrop-blur"
          >
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-medium text-foreground">Context used</span>
              <span className={cn('text-xs tabular-nums', tone)}>{percent.toFixed(0)}%</span>
            </div>

            <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-150',
                  percent >= 80
                    ? 'bg-risk-high'
                    : percent >= 50
                      ? 'bg-risk-medium'
                      : 'bg-nova-acting',
                )}
                style={{ width: `${percent}%` }}
              />
            </div>

            <dl className="space-y-1 text-[11px]">
              <Line label="System prompt" value={breakdown.system} />
              <Line label="Earlier messages" value={breakdown.history} />
              <Line label="Current message" value={breakdown.current} />
              <div className="mt-1.5 border-t border-border/60 pt-1.5">
                <Line label="Window" value={breakdown.limit} muted />
              </div>
            </dl>

            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {percent >= 80
                ? 'Older messages will be summarised on the next request so nothing fails.'
                : 'Counted before every request; older messages are summarised automatically if this fills up.'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Line({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn('text-muted-foreground', muted && 'opacity-70')}>{label}</dt>
      <dd className={cn('tabular-nums', muted ? 'text-muted-foreground' : 'text-foreground/90')}>
        {formatTokens(value)}
      </dd>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
