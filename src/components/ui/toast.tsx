/**
 * Toast viewport. Mounted once, near the root.
 *
 * Toasts stack from the bottom-right and never take focus or block input —
 * an error in a background check must not stop the user mid-sentence.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useToasts, type Toast, type ToastKind } from '@/store/toasts';
import { cn } from '@/lib/utils';

const ICONS: Record<ToastKind, typeof Info> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
};

const TONES: Record<ToastKind, string> = {
  error: 'border-risk-high/50 text-risk-high',
  success: 'border-nova-acting/50 text-nova-acting',
  info: 'border-primary/50 text-primary',
};

export function ToastViewport() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div
      // `pointer-events-none` on the stack, restored per toast: the gap between
      // toasts must not swallow clicks on the UI underneath.
      className="pointer-events-none fixed bottom-0 right-0 z-[60] flex w-full max-w-sm flex-col gap-2 p-4"
      style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1rem)' }}
      role="region"
      aria-label="Notifications"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = ICONS[toast.kind];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ duration: 0.15, ease: 'easeInOut' }}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-xl border bg-card/95 p-3.5 shadow-lg backdrop-blur',
        TONES[toast.kind],
      )}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />

      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-foreground">{toast.title}</p>
        {toast.description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{toast.description}</p>
        )}
        {toast.action && (
          <button
            onClick={() => {
              void toast.action?.run();
              onDismiss();
            }}
            className="mt-1 rounded-md border border-current px-2.5 py-1 text-xs font-medium
              transition-transform active:scale-95"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}
