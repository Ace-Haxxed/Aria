/**
 * Transient notifications.
 *
 * The rule this store exists to enforce: the user is never shown a raw error.
 * Anything that fails arrives here as a plain-language summary plus, where one
 * exists, a button that fixes it. Toasts slide in beside the content rather
 * than interrupting it, so a failed background check never blocks what the
 * user is doing.
 */
import { create } from 'zustand';
import { uid } from '@/lib/utils';

export type ToastKind = 'error' | 'success' | 'info';

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  /** One short line. What happened, in the user's terms. */
  title: string;
  /** Optional second line: what to do about it. */
  description?: string;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss; 0 means it stays until dismissed. */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

/** More than a few at once is noise; the oldest fall off. */
const MAX_VISIBLE = 4;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],

  push(toast) {
    const id = uid('toast');
    // A toast offering an action must wait for the user: dismissing it after
    // five seconds would take the fix away before it could be read.
    const duration = toast.duration ?? (toast.action ? 0 : 5_000);

    set((s) => ({ toasts: [...s.toasts, { ...toast, id, duration }].slice(-MAX_VISIBLE) }));

    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration);
    }
    return id;
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  clear() {
    set({ toasts: [] });
  },
}));

/* ── Convenience wrappers ────────────────────────────────────────── */

export const toast = {
  error(title: string, description?: string, action?: ToastAction) {
    return useToasts.getState().push({ kind: 'error', title, description, action });
  },
  success(title: string, description?: string) {
    return useToasts.getState().push({ kind: 'success', title, description });
  },
  info(title: string, description?: string, action?: ToastAction) {
    return useToasts.getState().push({ kind: 'info', title, description, action });
  },
};

/**
 * Present an unknown thrown value as something a person can read.
 *
 * Backend errors already arrive as complete sentences — Rust builds them that
 * way — so those pass through unchanged. Anything else is a bug rather than a
 * condition the user caused, and saying so is more honest than showing them a
 * stack trace or a DOMException name.
 */
export function humanise(e: unknown): string {
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
  const trimmed = raw.trim();

  if (!trimmed) return 'Something went wrong. Please try again.';

  // A sentence with a capital and terminal punctuation came from our own
  // error paths and is already written for the user.
  const looksWritten = /^[A-Z].*[.!?]$/s.test(trimmed) && trimmed.length > 20;
  if (looksWritten) return trimmed;

  // Recognisable low-level failures, mapped to their actual cause.
  if (/network|fetch|connect|ECONNREFUSED/i.test(trimmed)) {
    return 'Could not reach the service. Check your connection and try again.';
  }
  if (/timeout|timed out/i.test(trimmed)) {
    return 'That took too long to respond. Try again in a moment.';
  }
  if (/permission|denied|forbidden/i.test(trimmed)) {
    return 'ARIA does not have permission for that yet.';
  }

  return 'Something went wrong. Please try again.';
}
