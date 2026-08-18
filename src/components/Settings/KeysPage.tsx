/**
 * Every credential ARIA holds, on one page.
 *
 * Provider tabs down the side, one field for the selected provider. Pasting a
 * key validates it and saves it in the same gesture — there is no separate
 * "save" step to forget, and a key that fails is never stored, so a green dot
 * always means the key worked against the live API.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Trash2, X } from 'lucide-react';
import {
  OPENROUTER_FALLBACK_MODEL,
  PROVIDERS,
  PROVIDER_CONSOLE,
  PROVIDER_LABEL,
  maskKey,
  useKeys,
  type Provider,
} from '@/store/keys';
import { cn } from '@/lib/utils';

export function KeysPage() {
  const {
    activeProvider,
    model,
    keys,
    status,
    messages,
    saveKey,
    removeKey,
    setActive,
    setModel,
    freeModels,
    freeModelsState,
    loadFreeModels,
  } = useKeys();

  const [tab, setTab] = useState<Provider>(activeProvider);
  const [draft, setDraft] = useState('');
  const [modelDraft, setModelDraft] = useState(model);
  const inputRef = useRef<HTMLInputElement>(null);

  // Switching tabs abandons whatever was half-typed for the previous provider;
  // carrying it across would risk saving a key under the wrong service.
  useEffect(() => {
    setDraft('');
  }, [tab]);

  useEffect(() => {
    setModelDraft(model);
  }, [model]);

  // Fetch the catalogue when the OpenRouter tab is opened rather than on
  // mount: most visits to this page are about a different provider, and the
  // request is wasted for all of them.
  useEffect(() => {
    if (tab === 'openrouter') void loadFreeModels();
  }, [tab, loadFreeModels]);

  const saved = keys[tab] ?? '';
  const state = status[tab] ?? 'unset';

  const submit = async () => {
    if (!draft.trim()) return;
    const ok = await saveKey(tab, draft);
    if (ok) {
      setDraft('');
      // A key that works is almost always the one you want to use.
      if (activeProvider !== tab) void setActive(tab);
    } else {
      inputRef.current?.select();
    }
  };

  return (
    <div className="flex h-full gap-5">
      {/* Provider list. The active one carries a dot so the answer to "which
          brain am I talking to" is visible without opening anything. */}
      <nav className="flex w-40 shrink-0 flex-col gap-0.5">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            onClick={() => setTab(p)}
            className={cn(
              'group flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150',
              tab === p
                ? 'bg-accent/12 text-accent'
                : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
            )}
          >
            <span className="flex items-center gap-2">
              {PROVIDER_LABEL[p]}
              {activeProvider === p && (
                <span className="text-[9px] uppercase tracking-wider text-accent/70">active</span>
              )}
            </span>
            <StatusDot state={status[p] ?? 'unset'} />
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-5">
        <div>
          <h3 className="text-sm font-medium text-foreground">{PROVIDER_LABEL[tab]}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Key from{' '}
            <span className="font-mono text-accent/80">{PROVIDER_CONSOLE[tab]}</span>
          </p>
        </div>

        {saved && !draft ? (
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <StatusDot state={state} />
            <code className="flex-1 font-mono text-xs text-foreground/90">{maskKey(saved)}</code>
            <button
              onClick={() => {
                setDraft(' ');
                setTimeout(() => {
                  setDraft('');
                  inputRef.current?.focus();
                }, 0);
              }}
              className="text-xs text-muted-foreground transition-colors duration-150 hover:text-accent"
            >
              Replace
            </button>
            <button
              onClick={() => void removeKey(tab)}
              aria-label={`Remove ${PROVIDER_LABEL[tab]} key`}
              className="text-muted-foreground transition-colors duration-150 hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`Paste your ${PROVIDER_LABEL[tab]} key`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
                if (e.key === 'Escape') setDraft('');
              }}
              className="h-10 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 font-mono
                text-xs text-foreground outline-none transition-colors duration-150
                placeholder:text-muted-foreground/60 focus:border-accent/50"
            />
            <button
              onClick={() => void submit()}
              disabled={!draft.trim() || state === 'checking'}
              className="h-10 rounded-xl bg-accent/15 px-4 text-xs font-medium text-accent
                transition-colors duration-150 hover:bg-accent/25 disabled:opacity-40"
            >
              {state === 'checking' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                'Save'
              )}
            </button>
          </div>
        )}

        {messages[tab] && (
          <p
            className={cn(
              'text-xs',
              state === 'failed' ? 'text-danger' : 'text-muted-foreground',
            )}
          >
            {messages[tab]}
          </p>
        )}

        {/* The model travels with the provider, so it belongs on this page
            rather than in a separate section the user has to go and find. */}
        <div className="space-y-2 border-t border-white/[0.06] pt-5">
          <label className="text-xs text-muted-foreground">Model</label>

          {/* OpenRouter publishes a live catalogue, so the model is chosen from
              what is actually being served rather than typed from memory — a
              withdrawn id is the difference between working and a 404. Every
              other provider keeps the free-text field. */}
          {tab === 'openrouter' && freeModelsState !== 'failed' ? (
            <>
              <select
                value={model}
                onChange={(e) => void setModel(e.target.value)}
                disabled={freeModelsState === 'loading'}
                className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3
                  font-mono text-xs text-foreground outline-none transition-colors duration-150
                  focus:border-accent/50 disabled:opacity-50"
              >
                {freeModelsState === 'loading' && <option>Loading free models…</option>}

                {/* The model in use may be paid, or may have left the free
                    list; it still has to appear or the select would silently
                    show something else as selected. */}
                {freeModelsState === 'ready' &&
                  !freeModels.some((m) => m.id === model) && (
                    <option value={model}>{model} — current</option>
                  )}

                {freeModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.tier ? `[${m.tier}] ` : ''}
                    {m.name} — {formatContext(m.context)} ctx
                    {m.vision ? ' · vision' : ''}
                  </option>
                ))}
              </select>

              <p className="text-[11px] text-muted-foreground">
                Free models only, read from OpenRouter just now.{' '}
                <span className="text-foreground/70">Smart</span> is 70B+ parameters,{' '}
                <span className="text-foreground/70">Balanced</span> 3–70B,{' '}
                <span className="text-foreground/70">Fast</span> under 3B.
              </p>
            </>
          ) : (
            <input
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => modelDraft !== model && void setModel(modelDraft)}
              onKeyDown={(e) => e.key === 'Enter' && void setModel(modelDraft)}
              spellCheck={false}
              className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 font-mono
                text-xs text-foreground outline-none transition-colors duration-150
                focus:border-accent/50"
            />
          )}

          {tab === 'openrouter' && freeModelsState === 'failed' && (
            <p className="text-[11px] text-risk-medium">
              Could not reach OpenRouter to list its free models. Type an id, or reopen this
              page to try again — {OPENROUTER_FALLBACK_MODEL} is a safe default.
            </p>
          )}

          {tab === 'bytez' && (
            <p className="text-[11px] text-muted-foreground">
              Bytez model ids look like{' '}
              <span className="font-mono">google/gemma-2-9b-it</span>. An id they do not host
              is refused with a 404.
            </p>
          )}
        </div>

        {activeProvider !== tab && keys[tab] && (
          <button
            onClick={() => void setActive(tab)}
            className="text-xs text-accent transition-colors duration-150 hover:underline"
          >
            Use {PROVIDER_LABEL[tab]} for new messages
          </button>
        )}
      </div>
    </div>
  );
}

function StatusDot({ state }: { state: string }) {
  if (state === 'checking') {
    return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  }
  if (state === 'ok') return <Check className="h-3 w-3 text-accent" />;
  if (state === 'failed') return <X className="h-3 w-3 text-danger" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-white/15" />;
}

/** 262144 -> "262K". The exact number is noise next to the magnitude. */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
