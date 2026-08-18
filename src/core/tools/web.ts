/**
 * Tools that work identically on every platform: web search, page reading,
 * timers and long-term memory.
 */
import type { ToolDefinition } from '../types';
import { argNumber, argString, defineTool, ok, p } from './base';
import { httpGet } from '@/lib/http';
import { useTimers } from '@/store/timers';
import { rememberFact, recallFacts, forgetFact } from '../memory';

const BOTH: Array<'desktop' | 'mobile'> = ['desktop', 'mobile'];

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo's HTML endpoint needs no API key and no account, which is what
 * makes web search work out of the box. It wraps every result URL in a
 * redirect, so the real target has to be pulled back out.
 */
function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const absolute = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(absolute, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : absolute;
  } catch {
    return href;
  }
}

export function parseSearchResults(html: string): SearchResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results: SearchResult[] = [];

  for (const node of Array.from(doc.querySelectorAll('.result, .web-result'))) {
    const link = node.querySelector<HTMLAnchorElement>('a.result__a');
    if (!link) continue;

    const title = link.textContent?.trim() ?? '';
    const snippet = node.querySelector('.result__snippet')?.textContent?.trim() ?? '';
    const url = unwrapDuckDuckGoUrl(link.getAttribute('href') ?? '');
    if (title && url) results.push({ title, url, snippet });
  }

  // The lite endpoint uses a different layout; fall back to it.
  if (results.length === 0) {
    for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a.result-link'))) {
      const title = link.textContent?.trim() ?? '';
      const url = unwrapDuckDuckGoUrl(link.getAttribute('href') ?? '');
      if (title && url) results.push({ title, url, snippet: '' });
    }
  }

  return results;
}

export async function searchWeb(query: string): Promise<SearchResult[]> {
  const res = await httpGet(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) throw new Error(`search failed with HTTP ${res.status}`);
  return parseSearchResults(res.body);
}

/** Strip a page down to its readable text. */
export function extractReadableText(html: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim() ?? '';

  // Remove the elements whose text is never what the reader wants.
  for (const sel of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form']) {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  }

  // Prefer a semantic container when the page has one.
  const main =
    doc.querySelector('article') ??
    doc.querySelector('main') ??
    doc.querySelector('[role="main"]') ??
    doc.body;

  const text = (main?.textContent ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return { title, text };
}

export function sharedTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'web_search',
      description:
        'Search the web with DuckDuckGo and get back titles, URLs and snippets. Use this for ' +
        'anything you do not already know, especially current events. Follow up with ' +
        'read_webpage to read a result in full.',
      capability: 'network',
      risk: 'low',
      platforms: BOTH,
      parameters: {
        query: p.string('What to search for.'),
        limit: p.integer('How many results to return. Defaults to 6.'),
      },
      required: ['query'],
      async run(args) {
        const query = argString(args, 'query');
        const limit = args.limit != null ? argNumber(args, 'limit') : 6;

        const results = (await searchWeb(query)).slice(0, Math.max(1, Math.min(limit, 15)));
        if (results.length === 0) return `No results for "${query}".`;

        const text = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join('\n\n');
        return ok(text, { results });
      },
    }),

    defineTool({
      name: 'read_webpage',
      description:
        'Fetch a URL and return its readable text, with navigation and scripts stripped out. ' +
        'Use this to read an article or check a page a search turned up.',
      capability: 'network',
      risk: 'low',
      platforms: BOTH,
      parameters: { url: p.string('The URL to read.') },
      required: ['url'],
      async run(args) {
        const url = argString(args, 'url');
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, output: 'Error: only http and https URLs can be read', error: 'bad url' };
        }

        const res = await httpGet(url);
        if (!res.ok) {
          return {
            ok: false,
            output: `Error: the page returned HTTP ${res.status}`,
            error: `HTTP ${res.status}`,
          };
        }

        const { title, text } = extractReadableText(res.body);
        // Cap it: a long page can otherwise consume the whole context window.
        const capped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n… [truncated]` : text;
        return ok(`${title}\n\n${capped}`, { title, url });
      },
    }),

    defineTool({
      name: 'set_timer',
      description:
        'Set a timer or reminder. When it fires the user gets a notification. Use this for ' +
        '"remind me in 10 minutes" or "set a timer for 5 minutes".',
      capability: 'notifications',
      risk: 'low',
      platforms: BOTH,
      parameters: {
        label: p.string('What the timer is for.'),
        seconds: p.integer('How many seconds from now it should fire.'),
      },
      required: ['label', 'seconds'],
      async run(args) {
        const label = argString(args, 'label');
        const seconds = Math.max(1, argNumber(args, 'seconds'));
        await useTimers.getState().add(label, seconds);

        const mins = Math.round(seconds / 60);
        const when = seconds < 90 ? `${seconds} seconds` : `${mins} minutes`;
        return `Timer set: "${label}" in ${when}.`;
      },
    }),

    defineTool({
      name: 'list_timers',
      description: 'List the timers and reminders that are still pending.',
      capability: 'notifications',
      risk: 'low',
      platforms: BOTH,
      parameters: {},
      async run() {
        const timers = useTimers.getState().timers;
        if (timers.length === 0) return 'No timers are set.';
        return timers
          .map((t) => {
            const left = Math.max(0, Math.round((t.firesAt - Date.now()) / 1000));
            return `${t.label} — ${left}s remaining`;
          })
          .join('\n');
      },
    }),

    defineTool({
      name: 'remember',
      description:
        'Store a fact about the user so it survives into future conversations — preferences, ' +
        'frequently used apps, how they like things done. Use a short stable key.',
      capability: 'files',
      risk: 'low',
      platforms: BOTH,
      parameters: {
        key: p.string('Short identifier, e.g. "preferred_editor".'),
        value: p.string('The fact to remember.'),
      },
      required: ['key', 'value'],
      async run(args) {
        const key = argString(args, 'key');
        await rememberFact(key, argString(args, 'value'));
        return `Noted: ${key}.`;
      },
    }),

    defineTool({
      name: 'recall',
      description: 'List everything remembered about the user.',
      capability: 'files',
      risk: 'low',
      platforms: BOTH,
      parameters: {},
      async run() {
        const facts = await recallFacts();
        const entries = Object.entries(facts);
        if (entries.length === 0) return 'Nothing has been remembered yet.';
        return entries.map(([k, v]) => `${k}: ${v}`).join('\n');
      },
    }),

    defineTool({
      name: 'forget',
      description: 'Delete a remembered fact by its key.',
      capability: 'files',
      risk: 'low',
      platforms: BOTH,
      parameters: { key: p.string('The key to forget.') },
      required: ['key'],
      async run(args) {
        const key = argString(args, 'key');
        await forgetFact(key);
        return `Forgot ${key}.`;
      },
    }),
  ];
}
