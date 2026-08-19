/**
 * The one-time download that makes NOVA work offline.
 *
 * Shown before anything else on first launch. It is the only point in the app
 * where the user genuinely has to wait, so it says plainly what is happening,
 * how long it will take, and offers a way past it — a setup screen with no exit
 * is a trap, and someone on a hotel connection should be able to use a cloud
 * key today and download the model tonight.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Check, ChevronDown, Download, Loader2, Pause } from 'lucide-react';
import type { ModelCatalogEntry, ModelDownloadProgress } from '@/platform/desktop';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';
import { isTauri } from '@/platform';
import { humanise } from '@/store/toasts';
import { cn } from '@/lib/utils';

interface ModelDownloadProps {
  /** The model is on disk and ready to load. */
  onReady: (modelId: string) => void;
  /** Continue without a local model, using a cloud key instead. */
  onSkip: () => void;
}

export function ModelDownload({ onReady, onSkip }: ModelDownloadProps) {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [selected, setSelected] = useState<string>('phi-3.5-mini');
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [problem, setProblem] = useState('');
  const unlistenRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { desktop } = await import('@/platform/desktop');
      const models = await desktop.listBuiltinModels();
      setCatalog(models);

      // A model already on disk means there is nothing to do here.
      const installed = models.find((m) => m.installed);
      if (installed) onReady(installed.id);
    } catch {
      setCatalog([]);
    }
  }, [onReady]);

  useEffect(() => {
    void refresh();
    return () => unlistenRef.current?.();
  }, [refresh]);

  const start = async () => {
    setDownloading(true);
    setProblem('');
    setProgress(null);

    const { listen } = await import('@tauri-apps/api/event');
    // Subscribed before the command runs: the first progress events arrive
    // immediately on a fast connection.
    const off = await listen<ModelDownloadProgress>('model-download', (event) => {
      setProgress(event.payload);
    });
    unlistenRef.current = off;

    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.downloadBuiltinModel(selected);
      onReady(selected);
    } catch (e) {
      setProblem(humanise(e));
    } finally {
      off();
      unlistenRef.current = null;
      setDownloading(false);
    }
  };

  const pause = async () => {
    const { desktop } = await import('@/platform/desktop');
    // The partial file is kept, so this is a pause rather than a cancel.
    await desktop.cancelModelDownload();
  };

  const current = catalog.find((m) => m.id === selected);
  const percent = progress?.percent ?? 0;
  const resumable = (current?.downloadedBytes ?? 0) > 0 && !downloading;

  return (
    <div className="nova-grid-bg fixed inset-0 z-50 flex items-center justify-center bg-background p-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-md"
      >
        <Card className="space-y-5 p-6">
          <div className="space-y-2 text-center">
            <div className="text-3xl">🤖</div>
            <h1 className="text-lg font-semibold tracking-tight">Setting up NOVA AI</h1>
            <p className="text-sm text-muted-foreground">
              {downloading ? 'Downloading your personal AI model…' : 'One download and NOVA works on its own.'}
            </p>
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-background/50 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{current?.name ?? 'Phi-3.5 Mini'}</span>
              <span className="text-xs text-muted-foreground">
                {((current?.sizeMb ?? 2200) / 1000).toFixed(1)} GB
              </span>
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full rounded-full bg-primary"
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
              />
            </div>

            <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>
                {progress && progress.total > 0
                  ? `${formatGb(progress.downloaded)} / ${formatGb(progress.total)}`
                  : (current?.description ?? '')}
              </span>
              <span>
                {progress?.phase === 'verifying'
                  ? 'Verifying…'
                  : downloading && progress
                    ? `${percent.toFixed(0)}% · ${formatSpeed(progress.bytesPerSec)}${
                        progress.etaSeconds > 0 ? ` · ${formatEta(progress.etaSeconds)}` : ''
                      }`
                    : ''}
              </span>
            </div>
          </div>

          <div className="space-y-1 text-center text-xs leading-relaxed text-muted-foreground">
            <p>This is a one-time download.</p>
            <p>Your AI runs entirely on this device — no internet needed afterwards.</p>
          </div>

          {problem && (
            <div className="flex items-start gap-2 rounded-lg border border-risk-high/40 bg-risk-high/5 p-3 text-xs text-risk-high">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="leading-relaxed">{problem}</span>
            </div>
          )}

          <div className="space-y-2">
            {downloading ? (
              <Button variant="outline" onClick={() => void pause()} className="w-full gap-2">
                <Pause className="h-4 w-4" />
                Pause
              </Button>
            ) : (
              <Button onClick={() => void start()} className="w-full gap-2">
                <Download className="h-4 w-4" />
                {resumable
                  ? `Resume (${formatGb(current?.downloadedBytes ?? 0)} done)`
                  : problem
                    ? 'Retry download'
                    : 'Download and continue'}
              </Button>
            )}

            <button
              onClick={() => setPicking((v) => !v)}
              disabled={downloading}
              className="flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs
                text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Choose a different model
              <ChevronDown className={cn('h-3 w-3 transition-transform', picking && 'rotate-180')} />
            </button>

            <AnimatePresence>
              {picking && !downloading && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                  className="overflow-hidden"
                >
                  <div className="space-y-1 pt-1">
                    {catalog.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => {
                          setSelected(model.id);
                          setPicking(false);
                        }}
                        className={cn(
                          'flex w-full items-start gap-2 rounded-lg border p-2.5 text-left transition-colors',
                          selected === model.id
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/40',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-xs font-medium">
                            {model.name}
                            {model.installed && <Check className="h-3 w-3 text-nova-acting" />}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {model.description}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-[10px] text-muted-foreground">
                          <div>{(model.sizeMb / 1000).toFixed(1)} GB</div>
                          <div>{model.needsRamGb} GB RAM</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <button
              onClick={onSkip}
              className="w-full rounded-lg py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Skip — use cloud AI instead
            </button>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}

function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  return `${Math.max(0, bytesPerSec / 1000).toFixed(0)} KB/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.round(minutes / 60)}h left`;
}

/** A spinner for the moment between "download finished" and "model loaded". */
export function ModelLoading({ name }: { name: string }) {
  return (
    <div className="nova-grid-bg fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Loading {name}…
      </div>
    </div>
  );
}
