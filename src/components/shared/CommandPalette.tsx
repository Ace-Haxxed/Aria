/**
 * Ctrl+K: everything reachable from one place.
 *
 * Conversations, model switching and the handful of settings people change
 * often are otherwise spread across a sidebar and six settings tabs. Searching
 * for them by name is faster than remembering where they live, and it scales
 * as more is added — a menu does not.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Cpu, MessageSquare, Plus, Search, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { useConversation } from '@/store/conversation';
import { useConnection } from '@/store/connection';
import { useSettings } from '@/store/settings';
import { cn } from '@/lib/utils';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: typeof Search;
  /** Free-text the search matches against, beyond the label. */
  keywords?: string;
  run: () => void;
}

export function CommandPalette({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const conversations = useConversation((s) => s.list);
  const openConversation = useConversation((s) => s.open);
  const startNew = useConversation((s) => s.startNew);
  const removeConversation = useConversation((s) => s.remove);
  const localModels = useConnection((s) => s.localModels);
  const updateLLM = useSettings((s) => s.updateLLM);
  const currentModel = useSettings((s) => s.settings.llm.model);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      // Ctrl+L starts a new conversation, matching a terminal's "clear".
      if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        startNew();
        return;
      }
      // Ctrl+, is the conventional settings shortcut on every platform.
      if (mod && e.key === ',') {
        e.preventDefault();
        onOpenSettings();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, startNew, onOpenSettings]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setIndex(0);
      return;
    }
    // Focus after the entrance animation has begun, or the caret jumps.
    const handle = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(handle);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const close = (fn: () => void) => () => {
      fn();
      setOpen(false);
    };

    const actions: Command[] = [
      {
        id: 'new',
        label: 'New conversation',
        hint: 'Ctrl+L',
        icon: Plus,
        keywords: 'clear reset start',
        run: close(startNew),
      },
      {
        id: 'settings',
        label: 'Open settings',
        hint: 'Ctrl+,',
        icon: SettingsIcon,
        keywords: 'preferences options config',
        run: close(onOpenSettings),
      },
    ];

    const models: Command[] = localModels
      .filter((m) => m !== currentModel)
      .map((model) => ({
        id: `model-${model}`,
        label: `Switch to ${model}`,
        icon: Cpu,
        keywords: `model switch ${model}`,
        run: close(() => updateLLM({ model })),
      }));

    const threads: Command[] = conversations.slice(0, 25).map((c) => ({
      id: `conv-${c.id}`,
      label: c.title || 'Untitled conversation',
      icon: MessageSquare,
      keywords: 'conversation history open',
      run: close(() => void openConversation(c.id)),
    }));

    return [...actions, ...models, ...threads];
  }, [
    conversations,
    localModels,
    currentModel,
    startNew,
    onOpenSettings,
    openConversation,
    updateLLM,
  ]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 12);
    return commands
      .filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [commands, query]);

  // Keep the highlight inside the result list as it shrinks while typing.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[70] flex items-start justify-center bg-background/70 pt-[12vh] backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
            role="dialog"
            aria-label="Command palette"
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setIndex((i) => (i + 1) % Math.max(1, results.length));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setIndex((i) => (i - 1 + results.length) % Math.max(1, results.length));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    results[index]?.run();
                  }
                }}
                placeholder="Search conversations, models, settings…"
                className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="nova-scroll max-h-80 overflow-y-auto p-1.5">
              {results.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Nothing matches “{query}”.
                </p>
              ) : (
                results.map((command, i) => (
                  <button
                    key={command.id}
                    onClick={command.run}
                    onMouseEnter={() => setIndex(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      i === index ? 'bg-primary/15 text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <command.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint && (
                      <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">
                        {command.hint}
                      </kbd>
                    )}
                    {command.id.startsWith('conv-') && (
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label="Delete conversation"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeConversation(command.id.slice(5));
                        }}
                        className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:text-risk-high group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
