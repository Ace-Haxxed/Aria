/**
 * Timers and reminders. Kept in its own store because both the agent's
 * `set_timer` tool and the Skills screen drive it.
 */
import { create } from 'zustand';
import { uid } from '@/lib/utils';
import { isMobile, isTauri } from '@/platform';

export interface Timer {
  id: string;
  label: string;
  firesAt: number;
  /** Live handle so a cancelled timer actually stops. */
  handle?: ReturnType<typeof setTimeout>;
}

async function notify(title: string, body: string): Promise<void> {
  if (isMobile) {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.schedule({
      notifications: [
        {
          // The plugin requires a 32-bit int id, so derive one from the clock.
          id: Date.now() % 2_147_483_647,
          title,
          body,
          schedule: { at: new Date(Date.now() + 100) },
        },
      ],
    });
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
    return;
  }

  if (isTauri) {
    const { desktop } = await import('@/platform/desktop');
    await desktop.notify(title, body);
    return;
  }

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

interface TimerState {
  timers: Timer[];
  add: (label: string, seconds: number) => Promise<Timer>;
  cancel: (id: string) => void;
  tickAll: () => void;
}

export const useTimers = create<TimerState>((set, get) => ({
  timers: [],

  async add(label, seconds) {
    const timer: Timer = {
      id: uid('timer'),
      label,
      firesAt: Date.now() + seconds * 1000,
    };

    timer.handle = setTimeout(() => {
      void notify('NOVA', label);
      set((s) => ({ timers: s.timers.filter((t) => t.id !== timer.id) }));
    }, seconds * 1000);

    set((s) => ({ timers: [...s.timers, timer].sort((a, b) => a.firesAt - b.firesAt) }));
    return timer;
  },

  cancel(id) {
    const timer = get().timers.find((t) => t.id === id);
    if (timer?.handle) clearTimeout(timer.handle);
    set((s) => ({ timers: s.timers.filter((t) => t.id !== id) }));
  },

  /** Drop anything already past due — used after the app wakes from sleep. */
  tickAll() {
    const now = Date.now();
    set((s) => ({ timers: s.timers.filter((t) => t.firesAt > now) }));
  },
}));
