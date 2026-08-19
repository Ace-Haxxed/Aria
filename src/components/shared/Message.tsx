import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Check,
  Copy,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from 'lucide-react';
import type { Message as MessageType } from '@/core/types';
import { Markdown } from './Markdown';
import { useTraining } from '@/store/training';
import { cn, formatTime } from '@/lib/utils';

interface MessageProps {
  message: MessageType;
  /** Live text while the message is still arriving. */
  streamingText?: string;
}

function MessageComponent({ message, streamingText }: MessageProps) {
  const text = streamingText ?? message.content;

  // Tool results are shown as a compact strip: useful for debugging a run,
  // but they should never dominate the transcript.
  if (message.role === 'tool') {
    const failed = message.content.startsWith('Error:');
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-2 px-1 text-xs text-muted-foreground"
      >
        <Wrench
          className={cn('mt-0.5 h-3 w-3 shrink-0', failed ? 'text-risk-high' : 'text-nova-acting')}
        />
        <span className={cn('line-clamp-3 font-mono', failed && 'text-risk-high/90')}>
          {message.content}
        </span>
      </motion.div>
    );
  }

  const isUser = message.role === 'user';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className={cn('group flex w-full gap-3', isUser ? 'justify-end' : 'justify-start')}
    >
      {!isUser && (
        <div
          className="nova-hex mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center"
          style={{
            background:
              'linear-gradient(140deg, hsl(var(--accent-h) var(--accent-s) 72%), hsl(var(--accent-h) var(--accent-s) 46%))',
          }}
        >
          <span className="text-[11px] font-semibold text-white">N</span>
        </div>
      )}

      <div className={cn('space-y-2', isUser ? 'max-w-[65%] items-end' : 'max-w-[78%]')}>
        <div
          className={cn(
            'text-sm leading-relaxed',
            // Only the user's turn is a bubble. NOVA's reply is the content of
            // the page, and a card around it competes with what it contains.
            isUser && 'px-[14px] py-[10px] backdrop-blur-md',
            message.error && 'rounded-2xl border border-risk-high/50 bg-risk-high/10 px-4 py-3',
          )}
          style={
            isUser && !message.error
              ? {
                  background: 'hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.06)',
                  border: '1px solid hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.12)',
                  borderRadius: '16px 16px 4px 16px',
                }
              : undefined
          }
        >
          {message.images?.map((src, i) => (
            <img
              key={i}
              src={src}
              alt="attachment"
              className="mb-2 max-h-64 w-full rounded-lg border border-border/60 object-contain"
            />
          ))}

          {/* The user's own text is shown verbatim: rendering their input as
              markdown would silently rewrite what they typed. */}
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{text}</p>
          ) : (
            <Markdown>{text}</Markdown>
          )}

          {/* Streaming caret */}
          {streamingText != null && (
            <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-primary align-middle" />
          )}

          {message.error && (
            <div className="mt-2 flex items-start gap-2 border-t border-risk-high/30 pt-2 text-xs text-risk-high">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{message.error}</span>
            </div>
          )}
        </div>

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {message.toolCalls.map((call) => (
              <span
                key={call.id}
                className="inline-flex items-center gap-1 rounded-full border border-nova-acting/40
                  bg-nova-acting/10 px-2 py-0.5 font-mono text-[10px] text-nova-acting"
              >
                <Terminal className="h-2.5 w-2.5" />
                {call.name}
              </span>
            ))}
          </div>
        )}

        {/* Provenance stays visible: which model answered and how fast is the
            first thing checked when a reply looks off. The actions beside it
            are still hover-only — those are chrome. */}
        <div
          className={cn('flex items-center gap-1 px-1 text-[10px]', isUser && 'justify-end')}
          style={{ color: 'var(--text-dim)' }}
        >
          <span>{formatTime(message.timestamp)}</span>

          {message.meta && (
            <span className="truncate" title={`${message.meta.tokens} tokens`}>
              · {message.meta.model} · {(message.meta.ms / 1000).toFixed(1)}s
              {message.meta.ms > 0 && (
                <> · {Math.round(message.meta.tokens / (message.meta.ms / 1000))} tok/s</>
              )}
            </span>
          )}

          {/* Actions appear only on finished assistant replies: there is
              nothing to copy or judge until the answer is complete. */}
          {!isUser && streamingText == null && message.content.trim() && (
            <MessageActions message={message} />
          )}
        </div>
      </div>

    </motion.div>
  );
}

/**
 * Copy, and a judgement on the answer.
 *
 * The ratings are not decoration: when the user has turned on training capture
 * they are written next to the saved exchange, which is what makes the
 * collected data worth fine-tuning on. They are harmless when capture is off —
 * the rating simply has nothing to attach to.
 */
function MessageActions({ message }: { message: MessageType }) {
  const [copied, setCopied] = useState(false);
  const [rated, setRated] = useState<0 | 1 | null>(null);
  const [asking, setAsking] = useState(false);
  const rate = useTraining((s) => s.rate);

  const copy = () => {
    void navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const submit = (score: 0 | 1, note?: string) => {
    setRated(score);
    setAsking(false);
    void rate(message.id, score, note).catch(() => {
      // Rating is best-effort bookkeeping; failing to record one must not
      // interrupt the conversation.
    });
  };

  return (
    <>
      <button
        onClick={copy}
        aria-label="Copy reply"
        className="rounded p-1 transition-all hover:text-foreground active:scale-90"
      >
        {copied ? <Check className="h-3 w-3 text-nova-acting" /> : <Copy className="h-3 w-3" />}
      </button>

      <button
        onClick={() => submit(1)}
        aria-label="This was helpful"
        aria-pressed={rated === 1}
        className={cn(
          'rounded p-1 transition-all hover:text-foreground active:scale-90',
          rated === 1 && 'text-nova-acting',
        )}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>

      <button
        onClick={() => setAsking(true)}
        aria-label="This was not helpful"
        aria-pressed={rated === 0}
        className={cn(
          'rounded p-1 transition-all hover:text-foreground active:scale-90',
          rated === 0 && 'text-risk-high',
        )}
      >
        <ThumbsDown className="h-3 w-3" />
      </button>

      {asking && (
        <motion.form
          initial={{ opacity: 0, width: 0 }}
          animate={{ opacity: 1, width: 'auto' }}
          transition={{ duration: 0.15 }}
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('note') as HTMLInputElement | null;
            submit(0, input?.value);
          }}
          className="flex items-center gap-1"
        >
          <input
            name="note"
            autoFocus
            placeholder="What was wrong?"
            className="w-36 rounded border border-border bg-background px-1.5 py-0.5 text-[10px]
              outline-none focus:border-primary"
          />
          <button type="submit" className="rounded px-1 text-[10px] text-primary hover:underline">
            Send
          </button>
        </motion.form>
      )}
    </>
  );
}

export const Message = memo(MessageComponent);
