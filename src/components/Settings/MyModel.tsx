/**
 * Fine-tuning a local model on the user's own conversations.
 *
 * This is the panel where the collected training data becomes something. It
 * shows honestly what the machine can do — training needs Python and a GPU
 * helps a great deal — rather than offering a button that fails when pressed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  Check,
  Cpu,
  GraduationCap,
  Loader2,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { Adapter, TrainingReadiness } from '@/platform/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, Label } from '@/components/ui/primitives';
import { useTraining } from '@/store/training';
import { isTauri } from '@/platform';
import { humanise, toast } from '@/store/toasts';
import { cn, formatBytes } from '@/lib/utils';

/** One point on the loss curve. */
interface LossPoint {
  step: number;
  loss: number;
}

interface Progress {
  step: number;
  total: number;
  loss: number | null;
  epoch: number | null;
  etaSeconds: number;
}

export function MyModel() {
  const stats = useTraining((s) => s.stats);
  const refreshStats = useTraining((s) => s.refresh);

  const [readiness, setReadiness] = useState<TrainingReadiness | null>(null);
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [curve, setCurve] = useState<LossPoint[]>([]);
  const [problem, setProblem] = useState('');
  const unlistenRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { desktop } = await import('@/platform/desktop');
      const [support, list] = await Promise.all([
        desktop.checkFinetuneSupport(),
        desktop.listAdapters(),
      ]);
      setReadiness(support);
      setAdapters(list);
    } catch {
      setReadiness(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshStats();
    return () => unlistenRef.current?.();
  }, [refresh, refreshStats]);

  const start = async () => {
    setRunning(true);
    setProblem('');
    setCurve([]);
    setProgress(null);
    setStatus('Starting…');

    const { listen } = await import('@tauri-apps/api/event');
    // Subscribed first: the script reports its backend within a second.
    const off = await listen<Record<string, unknown>>('finetune-progress', (event) => {
      const payload = event.payload;
      const kind = String(payload.event ?? '');

      if (kind === 'status') {
        setStatus(String(payload.message ?? ''));
      } else if (kind === 'progress') {
        const step = Number(payload.step ?? 0);
        const loss = payload.loss == null ? null : Number(payload.loss);
        setProgress({
          step,
          total: Number(payload.total ?? 0),
          loss,
          epoch: payload.epoch == null ? null : Number(payload.epoch),
          etaSeconds: Number(payload.eta_seconds ?? 0),
        });
        // The curve is the trainer's real reported loss, not a simulation.
        if (loss != null && Number.isFinite(loss)) {
          setCurve((c) => [...c, { step, loss }]);
        }
      } else if (kind === 'error') {
        setProblem(String(payload.message ?? 'Training failed.'));
        setRunning(false);
      } else if (kind === 'done' || kind === 'finished') {
        setRunning(false);
        setStatus('');
        toast.success('Your model is ready', 'Select it below to start using it.');
        void refresh();
      } else if (kind === 'failed') {
        setRunning(false);
      }
    });
    unlistenRef.current = off;

    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.startFinetuning({
        name: name.trim() || `my-aria-${new Date().toISOString().slice(0, 10)}`,
        // Only offered when the libraries are missing, and only on this press.
        autoInstall: readiness?.ready === false,
      });
    } catch (e) {
      setProblem(humanise(e));
      setRunning(false);
    }
  };

  const cancel = async () => {
    const { desktop } = await import('@/platform/desktop');
    await desktop.cancelFinetuning();
    setRunning(false);
    setStatus('');
  };

  const remove = async (adapter: Adapter) => {
    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.deleteAdapter(adapter.name);
      toast.success(`${adapter.name} deleted`, 'It was moved to your trash.');
      void refresh();
    } catch (e) {
      toast.error('Could not delete that model', humanise(e));
    }
  };

  if (!isTauri) return null;

  const pairs = readiness?.pairs ?? 0;
  // Below this a fine-tune has nothing to learn from and produces a model
  // that is worse than the one it started from.
  const MINIMUM = 50;
  const enoughData = pairs >= MINIMUM;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium">My model</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Train a local model on your own conversations, so it answers the way you
          expect. Everything happens on this machine.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <Row label="Base model" value="Phi-3.5 Mini" />
        <Row label="Conversations saved" value={String(stats?.count ?? 0)} />
        <Row
          label="Usable for training"
          value={`${pairs}${stats?.ratedGood ? ` · ${stats.ratedGood} rated helpful` : ''}`}
        />
        <Row
          label="Training on"
          value={
            readiness?.gpu
              ? `${readiness.device} (fast)`
              : (readiness?.device ?? 'CPU') + ' (slower)'
          }
        />
        {readiness?.estimatedMinutes ? (
          <Row label="Estimated time" value={`about ${readiness.estimatedMinutes} minutes`} />
        ) : null}
      </Card>

      {/* State the blocker plainly rather than offering a button that fails. */}
      {readiness && !readiness.pythonAvailable && (
        <Notice tone="warn" icon={AlertCircle}>
          {readiness.problem ??
            'Fine-tuning needs Python 3. Everything else in ARIA works without it.'}
        </Notice>
      )}

      {readiness?.pythonAvailable && !readiness.ready && (
        <Notice tone="info" icon={Cpu}>
          The training libraries are not installed yet. Starting a fine-tune will install them
          first — several gigabytes, once.
        </Notice>
      )}

      {readiness?.pythonAvailable && !enoughData && (
        <Notice tone="info" icon={GraduationCap}>
          {pairs} of {MINIMUM} conversations. Keep using ARIA with training capture on and this
          fills up on its own.
        </Notice>
      )}

      {!running && (
        <div className="space-y-2">
          <Label htmlFor="model-name">Name your model</Label>
          <Input
            id="model-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`my-aria-${new Date().toISOString().slice(0, 10)}`}
          />
          <Button
            onClick={() => void start()}
            disabled={!readiness?.pythonAvailable || !enoughData}
            className="w-full gap-2"
          >
            <Zap className="h-4 w-4" />
            Start fine-tuning
            {readiness?.estimatedMinutes
              ? ` · about ${readiness.estimatedMinutes} min`
              : ''}
          </Button>
        </div>
      )}

      <AnimatePresence>
        {running && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <Card className="space-y-3 p-4">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="min-w-0 flex-1 truncate">
                  {progress
                    ? `Step ${progress.step} of ${progress.total}`
                    : status || 'Preparing…'}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void cancel()} className="h-7 gap-1 px-2 text-xs">
                  <X className="h-3 w-3" />
                  Stop
                </Button>
              </div>

              {progress && progress.total > 0 && (
                <>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <motion.div
                      className="h-full rounded-full bg-primary"
                      animate={{ width: `${(progress.step / progress.total) * 100}%` }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                    <span>
                      {progress.loss != null && `loss ${progress.loss.toFixed(3)}`}
                      {progress.epoch != null && ` · epoch ${progress.epoch.toFixed(1)}`}
                    </span>
                    <span>{formatEta(progress.etaSeconds)}</span>
                  </div>
                </>
              )}

              {curve.length > 1 && <LossCurve points={curve} />}

              {status && progress && (
                <p className="truncate text-[11px] text-muted-foreground">{status}</p>
              )}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                ARIA stays usable while this runs.
              </p>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {problem && <Notice tone="error" icon={AlertCircle}>{problem}</Notice>}

      {adapters.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Your trained models</div>
          {adapters.map((adapter) => (
            <Card key={adapter.name} className="flex items-center gap-3 p-3">
              <Check className="h-4 w-4 shrink-0 text-aria-acting" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{adapter.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {relativeTime(adapter.trainedAt)} · {formatBytes(adapter.sizeBytes)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove(adapter)}
                aria-label={`Delete ${adapter.name}`}
                className="h-7 px-2 text-risk-high hover:text-risk-high"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </Card>
          ))}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Adapters are LoRA weights — around 50 MB each, layered on the base model rather than
            replacing it. Copy one to another machine to share it.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The loss curve, drawn from the trainer's own reported values.
 *
 * An SVG polyline rather than a charting library: it is one line of one
 * series, and adding a dependency for that would cost more than it explains.
 */
function LossCurve({ points }: { points: LossPoint[] }) {
  const width = 260;
  const height = 60;

  const losses = points.map((p) => p.loss);
  const min = Math.min(...losses);
  const max = Math.max(...losses);
  // A flat curve would divide by zero; give it a nominal range instead.
  const span = max - min || 1;

  const path = points
    .map((p, i) => {
      const x = (i / Math.max(1, points.length - 1)) * width;
      const y = height - ((p.loss - min) / span) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="space-y-1">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-16 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Training loss, currently ${losses[losses.length - 1].toFixed(3)}`}
      >
        <path d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>loss {max.toFixed(2)}</span>
        <span>{min.toFixed(2)}</span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium">{value}</span>
    </div>
  );
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'info' | 'warn' | 'error';
  icon: typeof AlertCircle;
  children: React.ReactNode;
}) {
  const styles = {
    info: 'border-border bg-background/50 text-muted-foreground',
    warn: 'border-risk-medium/40 bg-risk-medium/5 text-muted-foreground',
    error: 'border-risk-high/40 bg-risk-high/5 text-risk-high',
  }[tone];

  return (
    <div className={cn('flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed', styles)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min left` : `${Math.round(minutes / 60)}h left`;
}

function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown date';
  const days = Math.floor((Date.now() / 1000 - unixSeconds) / 86_400);
  if (days <= 0) return 'trained today';
  if (days === 1) return 'trained yesterday';
  if (days < 30) return `trained ${days} days ago`;
  return `trained ${Math.floor(days / 30)} months ago`;
}
