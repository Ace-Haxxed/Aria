import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUp, Loader2, Mic, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { humanise, toast } from '@/store/toasts';
import { isTauri } from '@/platform';
import { cn } from '@/lib/utils';

/** The composer grows to this many lines, then scrolls. */
const MAX_LINES = 5;

/** How long a finished transcript sits in the box before it sends itself. */
const AUTO_SUBMIT_MS = 1_000;

interface VoiceInputProps {
  onSend: (text: string, images?: string[]) => void;
  /** Click to start listening, click again to stop. */
  onMicToggle: () => void;
  /**
   * A finished transcript to drop into the box. It is shown rather than sent
   * straight away, then submits itself a second later — long enough to read
   * what was heard and hit Escape if the transcription is wrong.
   */
  seed?: { text: string; at: number } | null;
  listening: boolean;
  busy: boolean;
  onCancel: () => void;
  level?: number;
  /** Recalled by pressing Up in an empty box, like a shell history. */
  lastUserMessage?: string;
  placeholder?: string;
  className?: string;
}

export function VoiceInput({
  onSend,
  onMicToggle,
  seed,
  listening,
  busy,
  onCancel,
  level = 0,
  lastUserMessage,
  placeholder = 'Ask NOVA…',
  className,
}: VoiceInputProps) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to MAX_LINES, then scroll. The ceiling is
  // measured from the element's own line-height and padding rather than
  // hardcoded, so it stays five lines if the type scale changes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const ceiling = lineHeight * MAX_LINES + padding;

    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, ceiling)}px`;
    el.style.overflowY = el.scrollHeight > ceiling ? 'auto' : 'hidden';
  }, [value]);

  /**
   * Show a transcript, then send it a beat later.
   *
   * Keyed on `seed.at` rather than the text so saying the same thing twice
   * still fires. Any keystroke or Escape during the pause cancels the send and
   * leaves the text in the box to be edited — which is the whole reason for
   * the pause.
   */
  const autoSubmitRef = useRef<number | null>(null);
  const cancelAutoSubmit = useCallback(() => {
    if (autoSubmitRef.current != null) {
      clearTimeout(autoSubmitRef.current);
      autoSubmitRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!seed?.text.trim()) return;
    setValue(seed.text);
    ref.current?.focus();

    cancelAutoSubmit();
    autoSubmitRef.current = window.setTimeout(() => {
      autoSubmitRef.current = null;
      // Read from the element rather than from `value`, which this effect
      // closed over before the state update landed.
      const current = ref.current?.value.trim() ?? seed.text.trim();
      if (current) {
        setValue('');
        setImages([]);
        onSend(current, images.length > 0 ? images : undefined);
      }
    }, AUTO_SUBMIT_MS);

    return cancelAutoSubmit;
    // `images` and `onSend` are read at fire time, not subscribed to: adding
    // them would restart the countdown whenever an image is attached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.at, cancelAutoSubmit]);

  const submit = () => {
    cancelAutoSubmit();
    const text = value.trim();
    // An image on its own is a valid message — "what is this?" is implied.
    if (!text && images.length === 0) return;
    setValue('');
    setImages([]);
    onSend(text, images.length > 0 ? images : undefined);
  };

  const attach = (dataUrl: string) => setImages((current) => [...current, dataUrl]);

  /** Read an image file into a data URL the vision model can consume. */
  const readImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') attach(reader.result);
    };
    reader.onerror = () => toast.error('That image could not be read');
    reader.readAsDataURL(file);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        readImage(file);
        continue;
      }

      // A non-image is a file to work on rather than to look at, so the path
      // goes into the prompt and NOVA's file tools take it from there.
      const path = (file as File & { path?: string }).path;
      if (isTauri && path) {
        setValue((v) => (v ? `${v} ${path}` : path));
      } else {
        try {
          const text = await file.text();
          setValue((v) => `${v}${v ? '\n\n' : ''}${file.name}:\n${text.slice(0, 4_000)}`);
        } catch (e) {
          toast.error(`Could not read ${file.name}`, humanise(e));
        }
      }
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={i} className="group relative">
              <img
                src={src}
                alt=""
                className="h-16 w-16 rounded-lg border border-border object-cover"
              />
              <button
                onClick={() => setImages((c) => c.filter((_, index) => index !== i))}
                aria-label="Remove image"
                className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-card p-0.5
                  text-muted-foreground transition-transform hover:text-foreground active:scale-90"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* One floating pill holding the mic, the field and send. The blur and
          the ring are what lift it off the conversation scrolling behind it. */}
      <div
        className={cn(
          'flex items-end gap-1.5 p-1.5 transition-colors duration-150',
          // Focus lights the edge rather than moving anything: the composer is
          // the one element always on screen, and a shifting outline there is
          // visible in peripheral vision the whole time you are typing.
          focused && 'nova-composer-focused',
        )}
        style={{
          background: 'var(--bg-surface)',
          backdropFilter: 'blur(24px)',
          border: `1px solid ${dragging || focused ? 'var(--border-glow)' : 'var(--border-subtle)'}`,
          borderRadius: 20,
        }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={() => setFocused(false)}
      >
        {busy ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={onCancel}
            className="h-9 w-9 shrink-0 rounded-full text-risk-high hover:bg-risk-high/10"
            aria-label="Stop"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <motion.div
            // Pulse with the input level so push-to-talk feels responsive.
            animate={{ scale: listening ? 1 + level * 0.2 : 1 }}
            transition={{ duration: 0.1 }}
            className="shrink-0"
          >
            <Button
              size="icon"
              variant="ghost"
              onClick={onMicToggle}
              className={cn(
                'h-9 w-9 shrink-0 touch-none rounded-full',
                listening
                  ? 'bg-nova-listening text-white hover:bg-nova-listening/90'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-label={listening ? 'Stop listening' : 'Start listening'}
            >
              {listening ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </Button>
          </motion.div>
        )}

        <div className="relative flex-1">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => {
              cancelAutoSubmit();
              setValue(e.target.value);
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
                return;
              }
              // Up in an empty box recalls the last thing sent, so a typo can
              // be corrected without retyping it.
              if (e.key === 'ArrowUp' && !value && lastUserMessage) {
                e.preventDefault();
                setValue(lastUserMessage);
              }
            }}
            onPaste={(e) => {
              // A screenshot on the clipboard is the fastest way to ask about
              // something on screen, so it is attached rather than ignored.
              const image = Array.from(e.clipboardData.items).find((i) =>
                i.type.startsWith('image/'),
              );
              const file = image?.getAsFile();
              if (!file) return;
              e.preventDefault();
              readImage(file);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => void handleDrop(e)}
            rows={1}
            placeholder={listening ? 'Listening…' : placeholder}
            className="nova-scroll nova-composer-input w-full resize-none bg-transparent px-2
              py-2 text-sm focus-visible:outline-none"
          />
        </div>

        <Button
          size="icon"
          variant="ghost"
          onClick={submit}
          disabled={!value.trim() && images.length === 0}
          className="h-9 w-9 shrink-0 rounded-full bg-primary/15 text-primary
            transition-transform duration-150 hover:bg-primary/25 active:scale-90
            disabled:bg-transparent disabled:text-muted-foreground"
          aria-label="Send"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
