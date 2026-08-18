/**
 * The transcript, windowed so a long conversation stays responsive.
 *
 * A fixed-cell virtualiser (react-window and friends) is the usual answer, but
 * it is the wrong tool here: every row is a different height, markdown reflows
 * as the container resizes, and the last row grows on every streamed token.
 * Feeding that into a measurement cache means invalidating it continuously,
 * and the visible symptom is the scroll position jumping while the assistant
 * is still typing — exactly the moment the user is reading.
 *
 * Windowing by slice avoids all of it. Only a bounded number of messages are
 * mounted; older ones are dropped from the tree and brought back when the user
 * scrolls up. React reconciles a keyed list cheaply, the browser keeps native
 * scrolling, and heights are whatever the content says they are.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, Loader2 } from 'lucide-react';
import type { Message as MessageType } from '@/core/types';
import { Message } from './Message';

/** Mounted at once. Comfortably more than one screenful at any window size. */
const WINDOW_SIZE = 60;
/** Revealed each time the user asks for more. */
const PAGE = 40;

interface MessageListProps {
  messages: MessageType[];
  streaming: { id: string; text: string } | null;
  /** The scroll container, so restoring position after a reveal is possible. */
  scrollRef: React.RefObject<HTMLDivElement>;
}

export function MessageList({ messages, streaming, scrollRef }: MessageListProps) {
  const [limit, setLimit] = useState(WINDOW_SIZE);
  const restoreRef = useRef<number | null>(null);

  // A new conversation starts from the bottom again.
  const conversationLength = messages.length;
  useEffect(() => {
    if (conversationLength <= WINDOW_SIZE) setLimit(WINDOW_SIZE);
  }, [conversationLength]);

  const visible = useMemo(
    () => (messages.length > limit ? messages.slice(messages.length - limit) : messages),
    [messages, limit],
  );
  const hidden = messages.length - visible.length;

  // Revealing older messages adds height above the viewport, which would
  // otherwise shove the user's reading position down the page. Restore the
  // distance from the bottom instead, which is the part they are looking at.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || restoreRef.current == null) return;
    el.scrollTop = el.scrollHeight - restoreRef.current;
    restoreRef.current = null;
  }, [limit, scrollRef]);

  const revealOlder = () => {
    const el = scrollRef.current;
    restoreRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setLimit((l) => l + PAGE);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
      {hidden > 0 && (
        <button
          onClick={revealOlder}
          className="mx-auto flex items-center gap-1.5 rounded-full border border-border bg-card/60
            px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40
            hover:text-foreground active:scale-95"
        >
          <ChevronUp className="h-3 w-3" />
          Show {Math.min(hidden, PAGE)} earlier {hidden === 1 ? 'message' : 'messages'}
        </button>
      )}

      {visible.map((message) => (
        <Message
          key={message.id}
          message={message}
          streamingText={streaming?.id === message.id ? streaming.text : undefined}
        />
      ))}

      {/* The reply before its message has been committed to the conversation. */}
      {streaming && !messages.some((m) => m.id === streaming.id) && (
        <Message
          message={{
            id: streaming.id,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
          }}
          streamingText={streaming.text}
        />
      )}
    </div>
  );
}

/**
 * Shown while a reply is being waited on but nothing has streamed yet, so the
 * transcript never sits visibly empty after the user presses send.
 */
export function ThinkingSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl gap-3 px-6 pb-6">
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10">
        <Loader2 className="h-3 w-3 animate-spin text-primary" />
      </div>
      <div className="w-full max-w-[60%] space-y-2 rounded-2xl rounded-bl-sm border border-border/60 bg-card/70 px-4 py-3">
        <div className="aria-skeleton h-3 w-4/5" />
        <div className="aria-skeleton h-3 w-3/5" />
      </div>
    </div>
  );
}
