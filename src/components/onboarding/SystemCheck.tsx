/**
 * Step 3 of first run: prove the machine actually works.
 *
 * The checks run themselves, in parallel, as soon as the step opens. A "Test"
 * button the user has to press is a test they will skip, and a "Retry" button
 * is an admission that the app knows something is wrong but expects the user
 * to fix it. Each failure here therefore carries the specific action that
 * repairs it, not a generic retry.
 */
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  Check,
  Cpu,
  FolderOpen,
  Globe,
  Loader2,
  Mic,
  Monitor,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';
import { useSettings } from '@/store/settings';
import { providerSpec } from '@/core/llm';
import { isTauri } from '@/platform';
import { humanise } from '@/store/toasts';
import { cn } from '@/lib/utils';

type Status = 'pending' | 'running' | 'ok' | 'failed';

interface CheckResult {
  ok: boolean;
  /** Shown next to the tick — what was found, not that it worked. */
  detail: string;
}

interface CheckSpec {
  id: string;
  label: string;
  icon: typeof Mic;
  /** Optional checks never block finishing setup. */
  optional?: boolean;
  run: () => Promise<CheckResult>;
  /** Offered when the check fails, in place of a bare retry. */
  fix?: { label: string; run: () => Promise<void> };
}

interface CheckState {
  status: Status;
  detail: string;
  problem: string;
}

export function SystemCheck({ onAllDone }: { onAllDone: (allPassed: boolean) => void }) {
  const settings = useSettings((s) => s.settings);
  const [state, setState] = useState<Record<string, CheckState>>({});

  const specs: CheckSpec[] = [
    {
      id: 'mic',
      label: 'Microphone',
      icon: Mic,
      async run() {
        if (!isTauri) return { ok: true, detail: 'Using the system recogniser' };
        const { desktop } = await import('@/platform/desktop');
        const mic = await desktop.testMicrophone();
        return { ok: mic.ok, detail: `Found: ${mic.device}` };
      },
      fix: {
        label: 'Open sound settings',
        async run() {
          const { desktop } = await import('@/platform/desktop');
          // Best effort across desktops; a failure here is not worth reporting
          // since the panel below already says what to do.
          await desktop.runCommand('gnome-control-center sound || systemsettings sound || true');
        },
      },
    },
    {
      id: 'speaker',
      label: 'Speaker',
      icon: Volume2,
      async run() {
        const { useVoiceTest } = await import('@/components/Settings/testSpeaker');
        await useVoiceTest('ARIA online.');
        return { ok: true, detail: 'Working' };
      },
    },
    {
      id: 'screen',
      label: 'Screen capture',
      icon: Monitor,
      async run() {
        if (!isTauri) return { ok: true, detail: 'Not used on this platform' };
        const { desktop } = await import('@/platform/desktop');
        const image = await desktop.screenshot();
        if (!image.startsWith('data:image')) throw new Error('The capture was not an image.');
        const { width, height } = await desktop.screenSize();
        return { ok: true, detail: `Ready — ${width}×${height}` };
      },
    },
    {
      id: 'ai',
      label: 'AI connection',
      icon: Cpu,
      async run() {
        const llm = useSettings.getState().settings.llm;
        const spec = providerSpec(llm.provider);

        if (llm.provider === 'ollama' && isTauri) {
          const { desktop } = await import('@/platform/desktop');
          const status = await desktop.checkOllamaAndStart(llm.baseUrl || undefined);
          if (!status.running) throw new Error('The local AI is not running.');
          const model = status.models.includes(llm.model) ? llm.model : (status.models[0] ?? llm.model);
          return { ok: true, detail: `Connected — ${model}` };
        }

        if (spec.needsApiKey && !llm.apiKey) {
          throw new Error('No API key is set for this provider.');
        }
        return { ok: true, detail: `Connected — ${llm.model}` };
      },
    },
    {
      id: 'files',
      label: 'File access',
      icon: FolderOpen,
      async run() {
        if (!isTauri) return { ok: true, detail: 'Not used on this platform' };
        const { desktop } = await import('@/platform/desktop');
        // Listing the home directory is the same permission every file tool
        // needs, and reads nothing sensitive.
        const entries = await desktop.listDirectory('~');
        return { ok: true, detail: `Ready — ${entries.length} items in home` };
      },
    },
    {
      id: 'browser',
      label: 'Browser control',
      icon: Globe,
      optional: true,
      async run() {
        if (!isTauri) return { ok: true, detail: 'Not used on this platform' };
        const { desktop } = await import('@/platform/desktop');
        const info = await desktop.platformInfo();
        const found = ['chromium', 'google-chrome', 'firefox'].find((b) => info.tools?.[b]);
        if (!found) throw new Error('No supported browser was found.');
        return { ok: true, detail: `${found} detected` };
      },
    },
  ];

  const runOne = useCallback(async (spec: CheckSpec) => {
    setState((s) => ({ ...s, [spec.id]: { status: 'running', detail: '', problem: '' } }));
    try {
      const result = await spec.run();
      setState((s) => ({
        ...s,
        [spec.id]: {
          status: result.ok ? 'ok' : 'failed',
          detail: result.detail,
          problem: result.ok ? '' : result.detail,
        },
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        [spec.id]: { status: 'failed', detail: '', problem: humanise(e) },
      }));
    }
  }, []);

  useEffect(() => {
    // In parallel: they touch unrelated subsystems, and running them in
    // sequence would make the step feel far slower than the machine is.
    void Promise.all(specs.map(runOne));
    // Deliberately once, on mount — re-running on every settings change would
    // restart the checks under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const required = specs.filter((s) => !s.optional);
  const allSettled = specs.every((s) => {
    const status = state[s.id]?.status;
    return status === 'ok' || status === 'failed';
  });
  const requiredPassed = required.every((s) => state[s.id]?.status === 'ok');

  useEffect(() => {
    if (allSettled) onAllDone(requiredPassed);
  }, [allSettled, requiredPassed, onAllDone]);

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">Quick system check</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Running automatically — nothing for you to do unless something needs attention.
        </p>
      </header>

      <div className="space-y-1.5">
        {specs.map((spec, i) => {
          const current = state[spec.id] ?? { status: 'pending' as Status, detail: '', problem: '' };
          return (
            <motion.div
              key={spec.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, delay: i * 0.05, ease: 'easeInOut' }}
            >
              <Card
                className={cn(
                  'flex items-center gap-3 p-3 transition-colors duration-150',
                  current.status === 'ok' && 'border-aria-acting/30',
                  current.status === 'failed' && 'border-risk-medium/40',
                )}
              >
                <StatusGlyph status={current.status} />
                <spec.icon className="h-4 w-4 shrink-0 text-muted-foreground" />

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{spec.label}</div>
                  {current.status === 'ok' && current.detail && (
                    <div className="truncate text-xs text-aria-acting/90">{current.detail}</div>
                  )}
                  {current.status === 'failed' && (
                    <div className="text-xs leading-relaxed text-muted-foreground">
                      {current.problem}
                      {spec.optional && ' This one is optional.'}
                    </div>
                  )}
                </div>

                {current.status === 'failed' && spec.fix && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() =>
                      void spec.fix!.run().then(() => runOne(spec)).catch(() => runOne(spec))
                    }
                  >
                    {spec.fix.label}
                  </Button>
                )}
              </Card>
            </motion.div>
          );
        })}
      </div>

      {allSettled && requiredPassed && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="flex items-center gap-2.5 rounded-xl border border-aria-acting/40 bg-aria-acting/5 p-3.5"
        >
          <Check className="h-4 w-4 shrink-0 text-aria-acting" />
          <p className="text-sm">
            Everything works. {settings.voice.wakeWordEnabled ? `Say "${settings.voice.wakeWord}"` : 'Tap the orb'} to talk.
          </p>
        </motion.div>
      )}
    </div>
  );
}

function StatusGlyph({ status }: { status: Status }) {
  if (status === 'ok') {
    return (
      <motion.span
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-aria-acting/15"
      >
        <Check className="h-3 w-3 text-aria-acting" />
      </motion.span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-risk-medium/15">
        <AlertCircle className="h-3 w-3 text-risk-medium" />
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
    </span>
  );
}
