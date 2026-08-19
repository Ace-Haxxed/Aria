/**
 * Startup check for missing system dependencies.
 *
 * The setup wizard covers the first run, but a machine can lose a dependency
 * later — a package removed, a distro upgrade that renames one — and the first
 * the user would otherwise hear of it is a tool call failing mid-conversation.
 * This checks at launch and offers to fix it in place.
 *
 * Only *required* dependencies raise the banner. Optional ones are listed in
 * Settings and each reports itself when the feature that needs it is used;
 * nagging about them at every launch would train the user to dismiss this.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Download, Loader2, X } from 'lucide-react';
import type { DependencyCheck } from '@/platform/desktop';
import { isTauri } from '@/platform';
import { Button } from '@/components/ui/button';

export function DependencyBanner() {
  const [missing, setMissing] = useState<DependencyCheck[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const check = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { desktop } = await import('@/platform/desktop');
      const deps = await desktop.checkDependencies();
      setMissing(deps.filter((d) => d.required && !d.present));
    } catch {
      // A failed probe is not worth interrupting startup for.
      setMissing([]);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const installAll = async () => {
    setInstalling(true);
    setError(null);
    try {
      const { desktop } = await import('@/platform/desktop');
      // Sequential: concurrent package managers deadlock on the database lock.
      for (const dep of missing.filter((d) => d.installable)) {
        await desktop.installDependency(dep.name);
      }
      await check();
      setDone(true);
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  if (dismissed || missing.length === 0) return null;

  const installable = missing.filter((d) => d.installable);

  return (
    <div className="pointer-events-auto fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-3">
      <div
        className="flex w-full max-w-2xl items-start gap-3 rounded-xl border border-risk-medium/40
          bg-background/95 p-3.5 shadow-lg backdrop-blur"
      >
        {done ? (
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-nova-acting" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-risk-medium" />
        )}

        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {done
              ? 'Everything NOVA needs is now installed.'
              : `${missing.length} required ${missing.length === 1 ? 'tool is' : 'tools are'} missing`}
          </p>
          {!done && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {missing.map((d) => d.name).join(', ')} — {missing[0].purpose.toLowerCase()}
              {missing.length > 1 ? ', and more.' : '.'}
            </p>
          )}
          {error && <p className="text-xs leading-relaxed text-risk-high">{error}</p>}
        </div>

        {!done && installable.length > 0 && (
          <Button size="sm" onClick={() => void installAll()} disabled={installing} className="gap-1.5">
            {installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {installing ? 'Installing…' : 'Install'}
          </Button>
        )}

        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
