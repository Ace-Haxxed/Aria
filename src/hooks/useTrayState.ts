/**
 * Mirror what ARIA is doing onto the tray icon.
 *
 * When the window is hidden the tray is the only thing the user can see, so it
 * carries the same state the orb does. The wake word matters most: "the
 * microphone is open" is something a user is entitled to notice without
 * hunting for it, so it pulses whenever the listener is running.
 */
import { useEffect } from 'react';
import { useConversation } from '@/store/conversation';
import { useSettings } from '@/store/settings';
import { isTauri } from '@/platform';

type TrayState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';

export function useTrayState(): void {
  const agentState = useConversation((s) => s.agentState);
  const wakeWordEnabled = useSettings((s) => s.settings.voice.wakeWordEnabled);

  useEffect(() => {
    if (!isTauri) return;

    // What the agent is doing outranks the wake word: both are true while a
    // reply generates, and the active one is the more informative.
    const state: TrayState =
      agentState !== 'idle' ? (agentState as TrayState) : wakeWordEnabled ? 'listening' : 'idle';

    void import('@/platform/desktop')
      .then((m) => m.desktop.setTrayState(state))
      .catch(() => {
        // The tray is unavailable on some desktops; the window still shows
        // the same state.
      });
  }, [agentState, wakeWordEnabled]);
}
