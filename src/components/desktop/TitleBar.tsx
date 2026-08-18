import { useEffect, useState } from 'react';
import { Minus, Settings as SettingsIcon, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { STATE_LABEL } from '@/components/shared/Orb';
import { useConversation } from '@/store/conversation';
import { useConnection } from '@/store/connection';
import { PROVIDER_LABEL, useKeys } from '@/store/keys';
import { isTauri } from '@/platform';
import { cn } from '@/lib/utils';

interface TitleBarProps {
  onOpenSettings: () => void;
}

/** Colour per agent state, matching the orb and the tray icon. */
const STATE_TONE: Record<string, string> = {
  idle: 'text-aria-idle',
  listening: 'text-aria-listening',
  thinking: 'text-aria-thinking',
  speaking: 'text-aria-speaking',
  acting: 'text-aria-acting',
};

/**
 * The window uses `decorations: false`, so this is the entire title bar —
 * the drag region, the window controls, and the readouts that belong at the
 * top of an instrument panel rather than buried in the layout.
 */
export function TitleBar({ onOpenSettings }: TitleBarProps) {
  const agentState = useConversation((s) => s.agentState);
  const phase = useConnection((s) => s.phase);
  const clock = useClock();

  const windowAction = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!isTauri) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();

    if (action === 'minimize') await win.minimize();
    // Close hides to tray — the Rust side intercepts CloseRequested.
    else if (action === 'close') await win.close();
    else await win.toggleMaximize();
  };

  return (
    <header
      className="drag-region relative flex h-14 shrink-0 items-center justify-between
        border-b border-[var(--hud-edge)] bg-card/30 px-4 backdrop-blur"
    >
      {/* A hairline of accent along the bottom edge, brightest at the centre. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-60"
        style={{
          background:
            'linear-gradient(90deg, transparent, hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.5), transparent)',
        }}
      />

      {/* Left: the mark and the name. */}
      <div className="flex flex-1 items-center gap-3">
        <Emblem state={agentState} />
        <div className="leading-none">
          <div className="hud-brand text-[13px] tracking-[0.2em] text-primary">ARIA</div>
          <div className="hud-label mt-1 text-[8.5px] tracking-[0.18em]">
            Adaptive Reasoning and Intelligence Assistant
          </div>
        </div>
      </div>

      {/* Centre: the clock. The one readout that is true regardless of state. */}
      <div className="hidden flex-none text-center leading-none sm:block">
        <div className="font-mono text-sm tracking-[0.12em] text-foreground">{clock.time}</div>
        <div className="hud-label mt-1 text-[8.5px]">{clock.date}</div>
      </div>

      <div className="no-drag flex flex-1 items-center justify-end gap-3">
        {/* Right: which brain is answering, and what it is doing. */}
        <ProviderIndicator />

        <div
          className={cn(
            'hidden items-center gap-2 rounded-full border px-3 py-1.5 md:flex',
            phase === 'ready'
              ? 'border-[var(--hud-edge-bright)]'
              : 'border-[var(--hud-edge)]',
          )}
        >
          <span
            className={cn(
              'hud-dot',
              STATE_TONE[agentState] ?? 'text-aria-idle',
              agentState !== 'idle' && 'hud-dot-live',
            )}
          />
          <span className="hud-label text-[9px] text-foreground/80">
            {STATE_LABEL[agentState]}
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          <Button size="icon-sm" variant="ghost" onClick={onOpenSettings} aria-label="Settings">
            <SettingsIcon className="h-3.5 w-3.5" />
          </Button>

          {isTauri && (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void windowAction('minimize')}
                aria-label="Minimise"
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void windowAction('toggleMaximize')}
                aria-label="Maximise"
              >
                <Square className="h-3 w-3" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void windowAction('close')}
                className="hover:bg-risk-high/20 hover:text-risk-high"
                aria-label="Close to tray"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Which provider and model are answering.
 *
 * Reading it off the unified key config rather than the settings store means
 * it matches what the next message will actually use — the two could otherwise
 * disagree for the moment between changing a provider and settings persisting.
 */
function ProviderIndicator() {
  const provider = useKeys((s) => s.activeProvider);
  const model = useKeys((s) => s.model);

  return (
    <div className="hidden text-right leading-none lg:block">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
        {PROVIDER_LABEL[provider] ?? provider}
      </div>
      {/* Model ids are long and the interesting part is the end, so the head
          is what gets dropped when there is not room for all of it. */}
      <div className="hud-label mt-1 max-w-[15ch] truncate font-mono text-[8.5px]" title={model}>
        {model}
      </div>
    </div>
  );
}

/**
 * The mark: an A inside a ring that picks up the current state colour.
 *
 * Drawn rather than an image so it inherits the accent hue and animates with
 * the rest of the interface.
 */
function Emblem({ state }: { state: string }) {
  return (
    <span
      className={cn(
        'relative flex h-7 w-7 shrink-0 items-center justify-center',
        STATE_TONE[state] ?? 'text-aria-idle',
      )}
    >
      <span
        className="absolute inset-0 rounded-full border border-current opacity-40"
        style={{ borderStyle: 'dashed' }}
      />
      <span className="absolute inset-[3px] rounded-full border border-current opacity-70" />
      <span
        className={cn(
          'absolute inset-[3px] rounded-full bg-current opacity-10',
          state !== 'idle' && 'hud-dot-live',
        )}
      />
      <span className="relative font-display text-[9px] font-bold tracking-wider">A</span>
    </span>
  );
}

/** Wall clock, ticking once a second. */
function useClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Aligned to the next whole second so the display does not lag behind the
    // system clock by a fraction that drifts.
    const align = 1000 - (Date.now() % 1000);
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 1000);
    }, align);

    return () => {
      window.clearTimeout(timeout);
      if (interval) window.clearInterval(interval);
    };
  }, []);

  return {
    time: now.toLocaleTimeString(undefined, { hour12: false }),
    date: now.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }),
  };
}
