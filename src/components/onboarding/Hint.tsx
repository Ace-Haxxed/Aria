/**
 * First-use pointers.
 *
 * A hint wraps the thing it describes rather than floating free, so it cannot
 * drift out of alignment when the layout changes. Each is dismissed the first
 * time the user interacts with what it points at — someone who has already
 * found the button does not need to be told about it — and the dismissal is
 * stored in settings so it never returns.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSettings } from '@/store/settings';
import { cn } from '@/lib/utils';

export type HintId = 'talk' | 'history' | 'actions';

interface HintProps {
  id: HintId;
  text: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Stagger, so three hints do not appear at once and shout over each other. */
  delayMs?: number;
  children: React.ReactNode;
  className?: string;
}

export function Hint({
  id,
  text,
  placement = 'top',
  delayMs = 0,
  children,
  className,
}: HintProps) {
  const seenHints = useSettings((s) => s.settings.seenHints);
  const update = useSettings((s) => s.update);
  const [visible, setVisible] = useState(false);
  const dismissed = useRef(false);

  const alreadySeen = seenHints.includes(id);

  useEffect(() => {
    if (alreadySeen) return;
    // Let the window settle before pointing at things; a hint that animates in
    // during the first paint reads as part of the loading state.
    const timer = setTimeout(() => setVisible(true), 900 + delayMs);
    return () => clearTimeout(timer);
  }, [alreadySeen, delayMs]);

  const dismiss = useCallback(() => {
    if (dismissed.current || alreadySeen) return;
    dismissed.current = true;
    setVisible(false);

    // Read the current list at call time: two hints dismissed in the same tick
    // would otherwise each overwrite the other's addition.
    const current = useSettings.getState().settings.seenHints;
    if (!current.includes(id)) update({ seenHints: [...current, id] });
  }, [alreadySeen, id, update]);

  if (alreadySeen) return <>{children}</>;

  return (
    <div
      className={cn('relative', className)}
      // Capture phase: the hint must clear even if the child stops the event.
      onPointerDownCapture={dismiss}
      onFocusCapture={dismiss}
    >
      {children}

      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.15, ease: 'easeInOut' }}
            className={cn('pointer-events-none absolute z-30 flex items-center gap-1.5', POSITION[placement])}
            role="note"
          >
            {(placement === 'right' || placement === 'bottom') && <Pointer placement={placement} />}

            <motion.button
              type="button"
              onClick={dismiss}
              animate={{ y: placement === 'top' || placement === 'bottom' ? [0, -3, 0] : 0 }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
              className="pointer-events-auto whitespace-nowrap rounded-full border border-primary/50
                bg-card/95 px-3 py-1.5 text-xs text-foreground shadow-lg backdrop-blur
                transition-transform active:scale-95"
            >
              {text}
            </motion.button>

            {(placement === 'left' || placement === 'top') && <Pointer placement={placement} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const POSITION: Record<NonNullable<HintProps['placement']>, string> = {
  top: 'bottom-full left-1/2 mb-2 -translate-x-1/2 flex-col',
  bottom: 'top-full left-1/2 mt-2 -translate-x-1/2 flex-col-reverse',
  left: 'right-full top-1/2 mr-2 -translate-y-1/2',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2 flex-row-reverse',
};

/** A small animated arrow, drawn with a rotated chevron rather than an image. */
function Pointer({ placement }: { placement: NonNullable<HintProps['placement']> }) {
  const rotation = { top: 90, bottom: -90, left: 0, right: 180 }[placement];
  return (
    <motion.span
      animate={{ opacity: [0.4, 1, 0.4] }}
      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      className="text-primary"
      style={{ transform: `rotate(${rotation}deg)` }}
      aria-hidden
    >
      ➤
    </motion.span>
  );
}
