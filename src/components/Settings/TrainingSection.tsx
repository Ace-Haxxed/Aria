/**
 * Training data panel.
 *
 * Shows what has been collected, how far it is from being useful, and gives
 * the user unambiguous control over it — export it, or delete it. Data
 * collected about someone that they cannot see or remove is not a feature, so
 * the count, the file path and the delete button are all first-class here.
 */
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Download, ExternalLink, GraduationCap, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, Switch } from '@/components/ui/primitives';
import { useTraining } from '@/store/training';
import { useSettings } from '@/store/settings';
import { humanise, toast } from '@/store/toasts';
import { isTauri } from '@/platform';
import { formatBytes } from '@/lib/utils';

const FINE_TUNE_GUIDE = 'https://docs.unsloth.ai/get-started/fine-tuning-llms-guide';

export function TrainingSection() {
  const stats = useTraining((s) => s.stats);
  const refresh = useTraining((s) => s.refresh);
  const exportTo = useTraining((s) => s.exportTo);
  const clear = useTraining((s) => s.clear);
  const enabled = useSettings((s) => s.settings.trainLocalFromCloud);
  const update = useSettings((s) => s.update);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doExport = async () => {
    setBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await exportTo(`~/Downloads/aria-training-${stamp}.jsonl`);
      toast.success('Training data exported', path);
    } catch (e) {
      toast.error('Could not export the training data', humanise(e));
    } finally {
      setBusy(false);
    }
  };

  const doClear = async () => {
    setBusy(true);
    try {
      await clear();
      toast.success('Training data deleted', 'It was moved to your trash, so it is recoverable.');
    } catch (e) {
      toast.error('Could not delete the training data', humanise(e));
    } finally {
      setBusy(false);
    }
  };

  const openGuide = async () => {
    try {
      if (isTauri) {
        const { desktop } = await import('@/platform/desktop');
        await desktop.openUrl(FINE_TUNE_GUIDE);
        return;
      }
      window.open(FINE_TUNE_GUIDE, '_blank', 'noopener');
    } catch {
      window.open(FINE_TUNE_GUIDE, '_blank', 'noopener');
    }
  };

  const count = stats?.count ?? 0;
  const target = stats?.target ?? 1000;
  const percent = stats?.percent ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Teach a local AI</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Save each exchange to a file on this computer so you can fine-tune a local model on
            your own conversations later. Nothing is uploaded.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => update({ trainLocalFromCloud: v })}
        />
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium tabular-nums">
            {count.toLocaleString()}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              of {target.toLocaleString()} conversations
            </span>
          </span>
          {stats && stats.sizeBytes > 0 && (
            <span className="text-xs text-muted-foreground">{formatBytes(stats.sizeBytes)}</span>
          )}
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <motion.div
            className="h-full rounded-full bg-primary"
            animate={{ width: `${percent}%` }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          />
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {stats?.ready
            ? 'You have enough conversations for a useful fine-tune.'
            : `About ${target.toLocaleString()} conversations gives a fine-tune enough to learn from. Keep using ARIA and this fills up on its own.`}
        </p>

        {stats && (stats.ratedGood > 0 || stats.ratedBad > 0) && (
          <p className="text-xs text-muted-foreground">
            <span className="text-aria-acting">{stats.ratedGood} rated helpful</span>
            {' · '}
            <span className="text-risk-high">{stats.ratedBad} rated unhelpful</span>
            {' — ratings let a fine-tune weight the good answers more heavily.'}
          </p>
        )}

        {stats?.path && (
          <p className="truncate font-mono text-[10px] text-muted-foreground/80" title={stats.path}>
            {stats.path}
          </p>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void doExport()}
          disabled={busy || count === 0}
          className="gap-1.5"
        >
          <Download className="h-3.5 w-3.5" />
          Export training data
        </Button>

        <Button
          size="sm"
          onClick={() => void openGuide()}
          disabled={!stats?.ready}
          className="gap-1.5"
          title={
            stats?.ready
              ? 'Open the fine-tuning guide'
              : `Available once you have ${target.toLocaleString()} conversations`
          }
        >
          <GraduationCap className="h-3.5 w-3.5" />
          Start fine-tuning
          <ExternalLink className="h-3 w-3 opacity-70" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => void doClear()}
          disabled={busy || count === 0}
          className="gap-1.5 text-risk-high hover:text-risk-high"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>

      {stats?.ready && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Fine-tuning runs outside ARIA, on your own machine or a rented GPU. The guide walks
          through training Llama 3.1 8B on an exported JSONL file with Unsloth; the result is a
          model you can run in Ollama and select here.
        </p>
      )}
    </div>
  );
}
