import { AnimatePresence, motion } from 'framer-motion';
import {
  Ban,
  ChevronRight,
  Download,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';
import type { ActionLogEntry } from '@/core/types';
import { Button } from '@/components/ui/button';
import { Badge, ScrollArea } from '@/components/ui/primitives';
import { useActions } from '@/store/actions';
import { cn, formatDuration, formatTime } from '@/lib/utils';

function StatusIcon({ status }: { status: ActionLogEntry['status'] }) {
  switch (status) {
    case 'running':
      return (
        <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-primary border-t-transparent" />
      );
    case 'ok':
      return <span className="hud-dot text-success" />;
    case 'error':
      return <span className="hud-dot text-danger" />;
    case 'cancelled':
      return <Ban className="h-3 w-3 shrink-0 text-muted-foreground" />;
    default:
      return <span className="hud-dot text-muted-foreground" />;
  }
}

export function ActionLog() {
  const entries = useActions((s) => s.entries);
  const undo = useActions((s) => s.undo);
  const exportJson = useActions((s) => s.exportJson);

  const download = async () => {
    const json = await exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `nova-actions-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    // Revoking immediately can cancel the download in some engines.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  return (
    <aside
      className="flex h-full w-[240px] shrink-0 flex-col"
      style={{
        background: 'hsl(222 71% 5% / 0.6)',
        backdropFilter: 'blur(10px)',
        borderLeft: '1px solid var(--border-subtle)',
      }}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div
          className="text-[10px] uppercase tracking-[0.2em]"
          style={{ color: 'var(--text-dim)' }}
        >
          Action log
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void download()}
          disabled={entries.length === 0}
          aria-label="Export the action log as JSON"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="nova-scroll flex-1">
        <div className="space-y-2 px-3 pb-3">
          <AnimatePresence initial={false}>
            {entries.map((entry) => (
              <LogEntry key={entry.id} entry={entry} onUndo={() => void undo(entry.id)} />
            ))}
          </AnimatePresence>
        </div>
      </ScrollArea>
    </aside>
  );
}

/**
 * One action. Collapsed to a single line by default — a run with twenty tool
 * calls should be scannable, and the detail is only wanted for the one that
 * went wrong.
 */
function LogEntry({ entry, onUndo }: { entry: ActionLogEntry; onUndo: () => void }) {
  // Failures open themselves: that is the entry the user is looking for.
  const [expanded, setExpanded] = useState(entry.status === 'error');

  return (
              <motion.div
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                className={cn(
                  'rounded-md border-l-2 px-2 py-1.5 transition-colors duration-150',
                  'hover:bg-[var(--bg-glass)]',
                  entry.risk === 'high'
                    ? 'border-risk-medium'
                    : entry.status === 'error'
                      ? 'border-risk-high'
                      : 'border-transparent',
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="mt-0.5">
                    <StatusIcon status={entry.status} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => setExpanded((v) => !v)}
                      className="flex w-full items-center gap-1.5 text-left"
                      aria-expanded={expanded}
                    >
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
                          expanded && 'rotate-90',
                        )}
                      />
                      <span className="truncate font-mono text-[11px] text-foreground/90">
                        {entry.tool}
                      </span>
                      {entry.risk !== 'low' && (
                        <Badge tone={entry.risk} className="shrink-0">
                          {entry.risk}
                        </Badge>
                      )}
                    </button>

                    <AnimatePresence initial={false}>
                      {expanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                          className="overflow-hidden"
                        >
                          <p className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground">
                            {entry.summary}
                          </p>

                          {entry.error && (
                            <p className="mt-1 break-words text-[11px] leading-snug text-risk-high/90">
                              {entry.error}
                            </p>
                          )}

                          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                            <span>{formatTime(entry.startedAt)}</span>
                            {entry.finishedAt && (
                              <span>{formatDuration(entry.finishedAt - entry.startedAt)}</span>
                            )}
                          </div>

                          <div className="flex flex-wrap gap-1.5">
                            {/* A failed action is worth offering again in
                                place, rather than making the user retype the
                                request that produced it. */}
                            {entry.status === 'error' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-2 h-6 gap-1 px-2 text-[10px]"
                                onClick={() =>
                                  window.dispatchEvent(
                                    new CustomEvent('nova:retry-action', { detail: entry }),
                                  )
                                }
                              >
                                <RotateCcw className="h-3 w-3" />
                                Retry
                              </Button>
                            )}

                            {entry.undo && !entry.undone && entry.status === 'ok' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-2 h-6 gap-1 px-2 text-[10px]"
                                onClick={onUndo}
                              >
                                <Undo2 className="h-3 w-3" />
                                {entry.undo.label}
                              </Button>
                            )}
                          </div>

                          {entry.undone && (
                            <span className="mt-1 block text-[10px] text-nova-acting">Undone</span>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>
  );
}
