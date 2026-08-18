import { AnimatePresence, motion } from 'framer-motion';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConversation } from '@/store/conversation';
import { cn } from '@/lib/utils';

interface SwipeHistoryProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Conversation history as a bottom sheet, opened by swiping up on the orb
 * screen and dismissed by dragging it back down.
 */
export function SwipeHistory({ open, onClose }: SwipeHistoryProps) {
  const list = useConversation((s) => s.list);
  const currentId = useConversation((s) => s.current.id);
  const openConversation = useConversation((s) => s.open);
  const remove = useConversation((s) => s.remove);
  const startNew = useConversation((s) => s.startNew);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          />

          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 340 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            // Dismiss on a decisive downward flick or a long drag.
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 500) onClose();
            }}
            className="aria-panel fixed inset-x-0 bottom-0 z-50 max-h-[75vh] rounded-t-2xl border-b-0"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
          >
            <div className="flex justify-center pt-2">
              <div className="h-1 w-10 rounded-full bg-border" />
            </div>

            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-sm font-semibold">Conversations</h2>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  startNew();
                  onClose();
                }}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                New
              </Button>
            </div>

            <div className="aria-scroll max-h-[55vh] overflow-y-auto px-3 pb-4">
              {list.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No conversations yet.
                </p>
              )}

              {list.map((conversation) => (
                <div
                  key={conversation.id}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-3 transition-colors',
                    conversation.id === currentId ? 'bg-primary/15' : 'active:bg-accent',
                  )}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      void openConversation(conversation.id);
                      onClose();
                    }}
                  >
                    <div className="truncate text-sm">{conversation.title}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(conversation.updatedAt).toLocaleDateString()}
                    </div>
                  </button>

                  <button
                    onClick={() => void remove(conversation.id)}
                    className="shrink-0 p-2 text-muted-foreground active:text-risk-high"
                    aria-label={`Delete ${conversation.title}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
