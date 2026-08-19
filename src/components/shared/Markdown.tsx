/**
 * Markdown rendering for assistant replies.
 *
 * Models write markdown whether or not you ask them to, so rendering it is not
 * a flourish — showing raw `**bold**` and unformatted tables is a bug. Code
 * blocks get syntax highlighting and their own copy button, since they are the
 * part users most often want to lift out.
 */
import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MarkdownProps {
  children: string;
  className?: string;
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  // The rendered tree is the only place the raw source survives, so the text
  // to copy is recovered from it rather than threaded down separately.
  const text = useMemo(() => extractText(children), [children]);

  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="group relative my-2">
      <pre className="nova-scroll overflow-x-auto rounded-lg border border-border/60 bg-background/80 p-3">
        {children}
      </pre>
      <button
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2 top-2 rounded-md border border-border/60 bg-card/90 p-1.5
          text-muted-foreground opacity-0 transition-all hover:text-foreground
          focus-visible:opacity-100 group-hover:opacity-100 active:scale-95"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-nova-acting" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return '';
}

function MarkdownComponent({ children, className }: MarkdownProps) {
  return (
    <div className={cn('nova-markdown', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `detect` guesses the language when the model omits the fence info
        // string, which it often does.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children, ...props }) => (
            <code className={cn(className, 'font-mono text-xs')} {...props}>
              {children}
            </code>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              // Assistant output is untrusted text; a link in it must not be
              // able to reach back into the app window.
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="nova-scroll my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownComponent);
