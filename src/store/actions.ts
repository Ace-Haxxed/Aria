/**
 * The action log: every tool call NOVA makes, with its outcome and — where
 * possible — a way to undo it.
 *
 * NOVA asks for nothing before acting, so this log is the whole record of what
 * it did. Entries are written when a call starts, not when it finishes, and
 * mirrored to SQLite, so a call that hangs or crashes the app still leaves
 * evidence. `undo` is the recovery path that confirmation used to be.
 */
import { create } from 'zustand';
import type { ActionLogEntry, RiskLevel, ToolCall } from '@/core/types';
import { isTauri } from '@/platform';
import { uid } from '@/lib/utils';

interface ActionState {
  entries: ActionLogEntry[];
  /** Most recent screenshot, shown in the floating preview. */
  lastScreenshot: string | null;

  start: (entry: ActionLogEntry) => void;
  update: (id: string, patch: Partial<ActionLogEntry>) => void;
  clear: () => void;
  setScreenshot: (dataUrl: string | null) => void;

  undo: (id: string) => Promise<void>;
  exportJson: () => Promise<string>;
}

/** Mirror an entry into SQLite so the log survives a restart. */
function persist(entry: ActionLogEntry): void {
  if (!isTauri) return;
  void (async () => {
    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.logAction({
        id: entry.id,
        tool: entry.tool,
        args: JSON.stringify(entry.args),
        risk: entry.risk,
        status: entry.status,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt ?? null,
        summary: entry.summary,
        result: entry.result ?? null,
        error: entry.error ?? null,
      });
    } catch {
      // A logging failure must never break the action it is logging.
    }
  })();
}

export const useActions = create<ActionState>((set, get) => ({
  entries: [],
  lastScreenshot: null,

  start(entry) {
    // Newest first — the log reads top-down as things happen.
    set((s) => ({ entries: [entry, ...s.entries].slice(0, 500) }));
    persist(entry);
  },

  update(id, patch) {
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));
    const updated = get().entries.find((e) => e.id === id);
    if (updated) persist(updated);
  },

  clear() {
    set({ entries: [] });
  },

  setScreenshot(dataUrl) {
    set({ lastScreenshot: dataUrl });
  },

  async undo(id) {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry?.undo || entry.undone) return;

    try {
      if (entry.undo.kind === 'restore-file' && isTauri) {
        const { desktop } = await import('@/platform/desktop');
        await desktop.restoreFromTrash(String(entry.undo.payload.originalPath ?? ''));
      } else if (entry.undo.kind === 'restore-clipboard' && isTauri) {
        const { desktop } = await import('@/platform/desktop');
        await desktop.setClipboard(String(entry.undo.payload.text ?? ''));
      } else {
        return;
      }
      get().update(id, { undone: true });
    } catch (e) {
      get().update(id, {
        error: `Undo failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },

  async exportJson() {
    if (isTauri) {
      try {
        const { desktop } = await import('@/platform/desktop');
        return await desktop.exportActionLog();
      } catch {
        // Fall through to the in-memory copy.
      }
    }
    return JSON.stringify(get().entries, null, 2);
  },
}));

/** Build a log entry for a call that has not run yet. */
export function newEntry(call: ToolCall, risk: RiskLevel, summary: string): ActionLogEntry {
  return {
    id: uid('act'),
    tool: call.name,
    args: call.args,
    risk,
    status: 'pending',
    startedAt: Date.now(),
    summary,
  };
}
