/**
 * Keep the window title describing what ARIA is doing.
 *
 * The title is visible in the taskbar and the window switcher, which is
 * precisely where someone looks when they have switched away and want to know
 * whether a long task has finished. A static "ARIA" wastes that.
 */
import { useEffect } from 'react';
import { useConversation } from '@/store/conversation';
import { isTauri } from '@/platform';

const BASE = 'ARIA';
/** Long titles get truncated by the window manager anyway. */
const MAX_TASK_CHARS = 40;

export function useWindowTitle(): void {
  const agentState = useConversation((s) => s.agentState);
  const conversation = useConversation((s) => s.current);

  useEffect(() => {
    // Only while busy: an idle window showing the last thing it was asked is
    // stale information dressed up as status.
    const busy = agentState === 'thinking' || agentState === 'acting';

    const task = busy
      ? [...conversation.messages].reverse().find((m) => m.role === 'user')?.content
      : undefined;

    const title = task
      ? `${BASE} — ${task.length > MAX_TASK_CHARS ? `${task.slice(0, MAX_TASK_CHARS).trimEnd()}…` : task}`
      : BASE;

    document.title = title;
    if (isTauri) {
      void import('@tauri-apps/api/window')
        .then((m) => m.getCurrentWindow().setTitle(title))
        .catch(() => {
          // The title is cosmetic; a failure here is not worth reporting.
        });
    }
  }, [agentState, conversation.messages]);
}
