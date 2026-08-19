import { useEffect, useState } from 'react';
import type { AgentState } from '@/core/types';
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
  idle: 'text-nova-idle',
  listening: 'text-nova-listening',
  thinking: 'text-nova-thinking',
  speaking: 'text-nova-speaking',
  acting: 'text-nova-acting',
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
      className="drag-region relative flex h-12 shrink-0 items-center justify-between px-4"
      style={{
        background: 'hsl(var(--background) / 0.95)',
        backdropFilter: 'blur(24px)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {/* Left: the mark and the wordmark. Nothing else — the tagline used to
          live here and only competed with the clock for attention. */}
      <div className="flex flex-1 items-center gap-2.5">
        <Emblem state={agentState} />
        <span className="text-[14px] font-bold uppercase tracking-[0.3em] text-foreground">
          NOVA
        </span>
      </div>

      {/* Centre: the clock. The one readout that is true regardless of state. */}
      <div className="hidden flex-none text-center leading-none sm:block">
        <div className="font-mono text-[13px] tracking-[0.1em] text-primary">{clock.time}</div>
        <div
          className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em]"
          style={{ color: 'var(--text-dim)' }}
        >
          {clock.date}
        </div>
      </div>

      <div className="no-drag flex flex-1 items-center justify-end gap-3">
        {/* Right: which brain is answering, and what it is doing. */}
        <ProviderIndicator />

        <StatusPill agentState={agentState} phase={phase} />

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
    // The model id is the tooltip rather than a second line: ids run to forty
    // characters and would set the width of the whole right-hand group.
    <div
      className="hidden items-center rounded-full px-2.5 py-1 text-[11px] lg:flex"
      style={{ border: '1px solid var(--border-glow)' }}
      title={model ? `${PROVIDER_LABEL[provider] ?? provider} · ${model}` : undefined}
    >
      <span className="text-primary">{PROVIDER_LABEL[provider] ?? provider}</span>
    </div>
  );
}

/**
 * What NOVA is doing, from real state.
 *
 * `agentState` is the live turn state and takes precedence; `phase` is the
 * connection check, which only matters when nothing is happening. Thinking
 * gets a spinner because it is the one state with an indefinite duration —
 * a static dot there reads as frozen.
 */
function StatusPill({ agentState, phase }: { agentState: AgentState; phase: string }) {
  const busy = agentState !== 'idle';
  const ready = phase === 'ready';

  return (
    <div
      className="hidden items-center gap-2 rounded-full px-3 py-1 md:flex"
      style={{
        border: `1px solid ${busy || ready ? 'var(--border-glow)' : 'var(--border-subtle)'}`,
      }}
    >
      {agentState === 'thinking' ? (
        <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-primary border-t-transparent" />
      ) : (
        <span
          className={cn(
            'hud-dot',
            busy ? (STATE_TONE[agentState] ?? 'text-primary') : ready ? 'text-success' : 'text-muted-foreground',
            (busy || ready) && 'hud-dot-live',
          )}
        />
      )}
      <span className="text-[11px] uppercase tracking-[0.12em] text-foreground/80">
        {busy ? STATE_LABEL[agentState] : ready ? 'Ready' : 'Offline'}
      </span>
    </div>
  );
}

/**
 * The mark: an A inside a ring that picks up the current state colour.
 *
 * Drawn rather than an image so it inherits the accent hue and animates with
 * the rest of the interface.
 */
function Emblem({ state }: { state: AgentState }) {
  return (
    <span
      className="nova-hex relative flex h-[22px] w-[22px] shrink-0 items-center justify-center"
      style={{
        background:
          'linear-gradient(140deg, hsl(var(--accent-h) var(--accent-s) 72%), hsl(var(--accent-h) var(--accent-s) 46%))',
      }}
    >
      {/* A ring that only appears while something is happening, so the mark
          doubles as the quietest possible activity indicator. */}
      {state !== 'idle' && (
        <span
          className={cn(
            'nova-hex absolute -inset-[3px] opacity-40',
            STATE_TONE[state] ?? 'text-primary',
            'hud-dot-live',
          )}
          style={{ background: 'currentColor' }}
        />
      )}
      <span className="relative text-[10px] font-bold text-white">N</span>
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
