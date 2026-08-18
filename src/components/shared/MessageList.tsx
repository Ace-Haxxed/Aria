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
import { ChevronUp } from 'lucide-react';
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
    // Three dots rather than a skeleton: a skeleton promises a shape, and the
    // reply that arrives is rarely the two grey lines it drew.
    <div className="mx-auto flex max-w-3xl gap-3 px-6 pb-6">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          background:
            'linear-gradient(140deg, hsl(var(--accent-h) var(--accent-s) 62%), hsl(var(--accent-h) var(--accent-s) 38%))',
        }}
      >
        <span className="text-[12px] font-semibold text-white">A</span>
      </div>
      <div className="flex items-center gap-1.5 pt-2.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="aria-thinking-dot h-1.5 w-1.5 rounded-full bg-primary"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
