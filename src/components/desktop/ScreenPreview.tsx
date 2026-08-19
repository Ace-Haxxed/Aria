import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useActions } from '@/store/actions';

/**
 * Floating thumbnail of the last screenshot NOVA took, so the user can see
 * exactly what it saw when it decided where to click.
 */
export function ScreenPreview() {
  const screenshot = useActions((s) => s.lastScreenshot);
  const setScreenshot = useActions((s) => s.setScreenshot);
  const [expanded, setExpanded] = useState(false);

  return (
    <AnimatePresence>
      {screenshot && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ type: 'spring', damping: 24, stiffness: 300 }}
          className="nova-panel absolute bottom-4 left-4 z-20 overflow-hidden rounded-xl shadow-2xl"
          style={{ width: expanded ? 520 : 220 }}
        >
          <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Last capture
            </span>
            <div className="flex items-center gap-0.5">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? 'Shrink preview' : 'Expand preview'}
              >
                {expanded ? (
                  <Minimize2 className="h-3 w-3" />
                ) : (
                  <Maximize2 className="h-3 w-3" />
                )}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setScreenshot(null)}
                aria-label="Dismiss preview"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <img src={screenshot} alt="Last screenshot NOVA captured" className="block w-full" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
