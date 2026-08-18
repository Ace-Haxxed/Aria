/**
 * Step 2 of first run: local model or cloud model.
 *
 * This is the only decision in setup that genuinely cannot be made for the
 * user — it is a privacy and cost trade-off, not a technical one — so it is
 * asked once, plainly, with the consequences of each side stated rather than
 * implied. Everything downstream of the choice is then done for them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  Check,
  Cloud,
  Download,
  ExternalLink,
  Loader2,
  MonitorSmartphone,
} from 'lucide-react';
import type { LLMProvider } from '@/core/types';
import type { PullProgress } from '@/platform/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, Label, Switch } from '@/components/ui/primitives';
import { providerSpec } from '@/core/llm';
import { useSettings } from '@/store/settings';
import { isTauri } from '@/platform';
import { humanise } from '@/store/toasts';
import { cn } from '@/lib/utils';

export type BrainKind = 'local' | 'cloud';

/** The model first run downloads. Small enough to be practical, good enough to be useful. */
const DEFAULT_LOCAL_MODEL = 'llama3.1:8b';

/** Cloud providers offered here, Groq first because its free tier needs no card. */
const CLOUD_ORDER: LLMProvider[] = ['groq', 'openrouter', 'openai', 'anthropic', 'gemini'];

interface BrainChoiceProps {
  /** Raised whenever the step becomes satisfiable or stops being so. */
  onReadyChange: (ready: boolean) => void;
}

export function BrainChoice({ onReadyChange }: BrainChoiceProps) {
  const [kind, setKind] = useState<BrainKind | null>(null);

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">How should ARIA think?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You can change this later in Settings.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <ChoiceCard
          selected={kind === 'local'}
          onSelect={() => setKind('local')}
          icon={MonitorSmartphone}
          title="Local AI"
          subtitle="Ollama"
          points={[
            { good: true, text: '100% private' },
            { good: true, text: 'Works offline' },
            { good: true, text: 'Free forever' },
            { good: true, text: 'Your data stays on your machine' },
            { good: false, text: 'Needs a ~4 GB download' },
          ]}
        />
        <ChoiceCard
          selected={kind === 'cloud'}
          onSelect={() => setKind('cloud')}
          icon={Cloud}
          title="Cloud AI"
          subtitle="Groq, OpenAI, Anthropic, Gemini"
          points={[
            { good: true, text: 'Nothing to download' },
            { good: true, text: 'Faster responses' },
            { good: true, text: 'More capable models' },
            { good: false, text: 'Needs internet' },
            { good: false, text: 'Needs an API key (free tier available)' },
          ]}
        />
      </div>

      <AnimatePresence mode="wait">
        {kind === 'local' && (
          <motion.div
            key="local"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: 'easeInOut' }}
          >
            <LocalSetup onReadyChange={onReadyChange} />
          </motion.div>
        )}
        {kind === 'cloud' && (
          <motion.div
            key="cloud"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: 'easeInOut' }}
          >
            <CloudSetup onReadyChange={onReadyChange} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── The two cards ───────────────────────────────────────────────── */

function ChoiceCard({
  selected,
  onSelect,
  icon: Icon,
  title,
  subtitle,
  points,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: typeof Cloud;
  title: string;
  subtitle: string;
  points: Array<{ good: boolean; text: string }>;
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'rounded-2xl border p-4 text-left transition-all duration-150 active:scale-[0.99]',
        selected
          ? 'border-primary bg-primary/10 shadow-[0_0_0_1px_hsl(var(--primary)/0.5),0_0_24px_-6px_hsl(var(--primary)/0.6)]'
          : 'border-border hover:border-primary/40',
      )}
    >
      <div className="flex items-center gap-2.5">
        <Icon className={cn('h-5 w-5', selected ? 'text-primary' : 'text-muted-foreground')} />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </div>

      <ul className="mt-3 space-y-1.5">
        {points.map((p) => (
          <li key={p.text} className="flex items-start gap-2 text-xs leading-snug">
            <span className={cn('mt-0.5 shrink-0', p.good ? 'text-aria-acting' : 'text-muted-foreground')}>
              {p.good ? '✓' : '~'}
            </span>
            <span className={p.good ? 'text-foreground/90' : 'text-muted-foreground'}>{p.text}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

/* ── Local ───────────────────────────────────────────────────────── */

type LocalPhase =
  | 'checking'
  | 'needs-install'
  | 'installing'
  | 'needs-model'
  | 'pulling'
  | 'ready'
  | 'problem';

function LocalSetup({ onReadyChange }: { onReadyChange: (ready: boolean) => void }) {
  const [phase, setPhase] = useState<LocalPhase>('checking');
  const [models, setModels] = useState<string[]>([]);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [problem, setProblem] = useState('');
  const setProvider = useSettings((s) => s.setProvider);
  const updateLLM = useSettings((s) => s.updateLLM);

  const hasUsableModel = useCallback(
    (list: string[]) => list.some((m) => m.startsWith('llama3.1') || m.startsWith(DEFAULT_LOCAL_MODEL)),
    [],
  );

  const inspect = useCallback(async () => {
    setPhase('checking');
    setProblem('');
    if (!isTauri) {
      setPhase('problem');
      setProblem('Local AI needs the desktop app.');
      return;
    }

    try {
      const { desktop } = await import('@/platform/desktop');
      // This also starts the server if it is installed but stopped, so a
      // machine that already has Ollama needs no interaction at all.
      const status = await desktop.checkOllamaAndStart();
      setModels(status.models);

      if (!status.installed) {
        setPhase('needs-install');
        return;
      }
      if (!status.running) {
        setPhase('problem');
        setProblem('Ollama is installed but would not start.');
        return;
      }

      // Any pulled model will do — the user should not be made to download a
      // second one because ours is not the one they already have.
      if (status.models.length > 0) {
        void setProvider('ollama');
        updateLLM({
          model: hasUsableModel(status.models) ? DEFAULT_LOCAL_MODEL : status.models[0],
        });
        setPhase('ready');
        return;
      }
      setPhase('needs-model');
    } catch (e) {
      setPhase('problem');
      setProblem(humanise(e));
    }
  }, [hasUsableModel, setProvider, updateLLM]);

  useEffect(() => {
    void inspect();
  }, [inspect]);

  useEffect(() => {
    onReadyChange(phase === 'ready');
  }, [phase, onReadyChange]);

  const install = async () => {
    setPhase('installing');
    setProblem('');
    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.installOllama();
      await inspect();
    } catch (e) {
      setPhase('problem');
      setProblem(humanise(e));
    }
  };

  const pull = async () => {
    setPhase('pulling');
    setProblem('');
    setProgress(null);

    const { listen } = await import('@tauri-apps/api/event');
    // Subscribe before starting: the first progress events arrive immediately.
    const off = await listen<PullProgress>('ollama-pull', (event) => setProgress(event.payload));

    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.ollamaPull(DEFAULT_LOCAL_MODEL);
      void setProvider('ollama');
      updateLLM({ model: DEFAULT_LOCAL_MODEL });
      setPhase('ready');
    } catch (e) {
      setPhase('problem');
      setProblem(humanise(e));
    } finally {
      off();
    }
  };

  if (phase === 'checking') {
    return (
      <Card className="flex items-center gap-3 p-4 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Looking for a local AI on this machine…
      </Card>
    );
  }

  if (phase === 'ready') {
    const model = hasUsableModel(models) ? DEFAULT_LOCAL_MODEL : models[0];
    return (
      <Card className="flex items-center gap-3 border-aria-acting/40 bg-aria-acting/5 p-4">
        <Check className="h-5 w-5 shrink-0 text-aria-acting" />
        <div className="min-w-0 text-sm">
          <div className="font-medium">Ready</div>
          <div className="truncate text-xs text-muted-foreground">
            Running {model} locally. Nothing you say will leave this machine.
          </div>
        </div>
      </Card>
    );
  }

  if (phase === 'needs-install' || phase === 'installing') {
    return (
      <Card className="space-y-3 p-4">
        <div className="text-sm">
          <div className="font-medium">Ollama is not installed yet</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            It is the program that runs AI models on your own computer. ARIA can install it
            using your system's package manager — you will see your usual password prompt.
          </p>
        </div>
        <Button onClick={() => void install()} disabled={phase === 'installing'} className="w-full gap-2">
          {phase === 'installing' ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Installing Ollama…
            </>
          ) : (
            <>
              <Download className="h-4 w-4" />
              Install Ollama
            </>
          )}
        </Button>
      </Card>
    );
  }

  if (phase === 'needs-model' || phase === 'pulling') {
    const percent = progress?.percent ?? 0;
    return (
      <Card className="space-y-3 p-4">
        <div className="text-sm">
          <div className="font-medium">Download an AI model</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {DEFAULT_LOCAL_MODEL} — about 4 GB. This happens once, and then ARIA works with no
            internet at all.
          </p>
        </div>

        {phase === 'pulling' ? (
          <div className="space-y-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full rounded-full bg-primary"
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span className="truncate">{progress?.status ?? 'starting…'}</span>
              <span className="tabular-nums">
                {progress && progress.total > 0
                  ? `${formatGb(progress.completed)} / ${formatGb(progress.total)}`
                  : ''}
              </span>
            </div>
          </div>
        ) : (
          <Button onClick={() => void pull()} className="w-full gap-2">
            <Download className="h-4 w-4" />
            Download AI Model (~4 GB)
          </Button>
        )}
      </Card>
    );
  }

  return (
    <Card className="space-y-3 border-risk-medium/40 p-4">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-risk-medium" />
        <div className="min-w-0 text-sm">
          <div className="font-medium">Local AI is not ready</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {problem} You can try again, or pick Cloud AI above — it needs no download.
          </p>
        </div>
      </div>
      <Button variant="outline" onClick={() => void inspect()} className="w-full">
        Try again
      </Button>
    </Card>
  );
}

function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/* ── Cloud ───────────────────────────────────────────────────────── */

const KEY_LINKS: Partial<Record<LLMProvider, { label: string; url: string }>> = {
  groq: { label: 'Get a free Groq key at console.groq.com', url: 'https://console.groq.com/keys' },
  openrouter: {
    label: 'Get a key at openrouter.ai — free models need no credits',
    url: 'https://openrouter.ai/keys',
  },
  openai: { label: 'Get a key at platform.openai.com', url: 'https://platform.openai.com/api-keys' },
  anthropic: {
    label: 'Get a key at console.anthropic.com',
    url: 'https://console.anthropic.com/settings/keys',
  },
  gemini: { label: 'Get a free key at aistudio.google.com', url: 'https://aistudio.google.com/apikey' },
};

/** Long enough that a paste settles, short enough to feel live. */
const VALIDATE_DEBOUNCE_MS = 800;

function CloudSetup({ onReadyChange }: { onReadyChange: (ready: boolean) => void }) {
  const settings = useSettings((s) => s.settings);
  const setProvider = useSettings((s) => s.setProvider);
  const setApiKey = useSettings((s) => s.setApiKey);
  const update = useSettings((s) => s.update);

  const [provider, setLocalProvider] = useState<LLMProvider>('groq');
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ valid: boolean; message: string } | null>(null);
  const timer = useRef<number | null>(null);

  // Groq is the default: its free tier needs no payment details, which makes
  // it the only one that can honestly be called "free" during setup.
  useEffect(() => {
    void setProvider('groq');
  }, [setProvider]);

  useEffect(() => {
    onReadyChange(result?.valid === true);
  }, [result, onReadyChange]);

  const validate = useCallback(
    (candidate: string, forProvider: LLMProvider) => {
      if (timer.current) window.clearTimeout(timer.current);
      setResult(null);

      if (!candidate.trim()) {
        setChecking(false);
        return;
      }

      setChecking(true);
      timer.current = window.setTimeout(async () => {
        try {
          // The unified key store validates and saves in one step, and writes
          // to the same file the settings page reads, so onboarding cannot
          // leave a key somewhere the rest of the app will not look for it.
          const { useKeys } = await import('@/store/keys');
          const keys = useKeys.getState();
          const ok = await keys.saveKey(forProvider as Parameters<typeof keys.saveKey>[0], candidate);
          setResult({
            valid: ok,
            message: useKeys.getState().messages[forProvider] ?? '',
          });
          if (ok) await setProvider(forProvider);
        } catch (e) {
          setResult({ valid: false, message: humanise(e) });
        } finally {
          setChecking(false);
        }
      }, VALIDATE_DEBOUNCE_MS);
    },
    [setApiKey, setProvider],
  );

  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const link = KEY_LINKS[provider];

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap gap-1.5">
        {CLOUD_ORDER.map((id) => {
          const spec = providerSpec(id);
          const active = provider === id;
          return (
            <button
              key={id}
              onClick={() => {
                setLocalProvider(id);
                validate(key, id);
              }}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition-all active:scale-95',
                active ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:border-primary/40',
              )}
            >
              {spec.label.split(' (')[0]}
              {id === 'groq' && <span className="ml-1.5 opacity-70">free</span>}
            </button>
          );
        })}
      </div>

      <div className="space-y-2">
        <Label htmlFor="first-run-key">Paste your API key</Label>
        <div className="relative">
          <Input
            id="first-run-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              validate(e.target.value, provider);
            }}
            placeholder="sk-…"
            className={cn(
              'pr-9',
              result?.valid === true && 'border-aria-acting',
              result?.valid === false && 'border-risk-high',
            )}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {checking && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {!checking && result?.valid === true && <Check className="h-4 w-4 text-aria-acting" />}
            {!checking && result?.valid === false && <AlertCircle className="h-4 w-4 text-risk-high" />}
          </div>
        </div>

        {result && (
          <p className={cn('text-xs leading-relaxed', result.valid ? 'text-aria-acting' : 'text-risk-high')}>
            {result.message}
          </p>
        )}

        {link && (
          <button
            onClick={() => void openExternal(link.url)}
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            {link.label}
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-border/60 bg-background/50 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Use cloud AI to teach a local AI</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              ARIA saves your exchanges to a file on this computer so you can fine-tune a local
              model on them later. The local model gets better at your work without any of it
              leaving your machine. Nothing is uploaded, and you can delete it at any time.
            </p>
          </div>
          <Switch
            checked={settings.trainLocalFromCloud}
            onCheckedChange={(v) => update({ trainLocalFromCloud: v })}
          />
        </div>
      </div>
    </Card>
  );
}

async function openExternal(url: string) {
  try {
    if (isTauri) {
      const { desktop } = await import('@/platform/desktop');
      await desktop.openUrl(url);
      return;
    }
    window.open(url, '_blank', 'noopener');
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
