/**
 * Short-lived reuse of tool results within a single agent run.
 *
 * A multi-step task calls the same read-only tools repeatedly: capture the
 * screen, look, act, capture again. When two calls land within a second or two
 * the second is answering a question the first already answered, and the wait
 * is pure overhead — a screenshot on Wayland is a portal round trip, and
 * system info spins up a full process probe.
 *
 * Only read-only tools are cached, and only briefly. The lifetimes are set by
 * how fast the underlying thing actually changes: a screen changes constantly,
 * a directory listing rarely.
 */

/** How long each tool's result stays usable, in milliseconds. */
const TTL_MS: Record<string, number> = {
  // The screen changes as the user moves, so this is short — long enough to
  // cover a look-then-act pair, not long enough to act on a stale view.
  take_screenshot: 2_000,
  get_screen_size: 30_000,

  // CPU and memory move continuously but not meaningfully second to second.
  get_system_info: 5_000,
  list_processes: 5_000,

  // Directory contents rarely change under the user mid-task.
  list_directory: 10_000,
  search_files: 10_000,
  get_file_info: 10_000,

  // A page only changes when something navigates it, which is its own tool
  // call and invalidates this anyway.
  get_page_text: 30_000,
  get_page_title: 30_000,
  get_current_url: 30_000,
  list_tabs: 15_000,
};

/**
 * Tools whose success invalidates cached reads.
 *
 * Acting on the world makes every prior observation of it suspect. Clearing on
 * these is what stops the agent reasoning about a screen it already changed.
 */
const INVALIDATES: Record<string, string[]> = {
  click: ['take_screenshot'],
  double_click: ['take_screenshot'],
  right_click: ['take_screenshot'],
  type_text: ['take_screenshot'],
  press_key: ['take_screenshot'],
  drag: ['take_screenshot'],
  scroll: ['take_screenshot'],
  launch_app: ['take_screenshot', 'list_windows', 'list_running_apps'],
  kill_app: ['take_screenshot', 'list_windows', 'list_running_apps'],
  focus_window: ['take_screenshot', 'list_windows'],

  write_file: ['list_directory', 'search_files', 'get_file_info'],
  append_file: ['list_directory', 'search_files', 'get_file_info'],
  delete_file: ['list_directory', 'search_files', 'get_file_info'],
  move_file: ['list_directory', 'search_files', 'get_file_info'],
  copy_file: ['list_directory', 'search_files', 'get_file_info'],
  create_directory: ['list_directory', 'search_files'],

  open_url: ['get_page_text', 'get_page_title', 'get_current_url', 'list_tabs'],
  click_element: ['get_page_text', 'get_page_title', 'get_current_url'],
  type_in_element: ['get_page_text'],
  scroll_page: ['get_page_text'],
  browser_navigate: ['get_page_text', 'get_page_title', 'get_current_url'],
  new_tab: ['list_tabs', 'get_page_text', 'get_current_url'],
  close_tab: ['list_tabs', 'get_page_text', 'get_current_url'],
  fill_form: ['get_page_text'],
  run_command: ['list_directory', 'search_files', 'get_file_info', 'get_system_info'],
};

interface Entry {
  value: unknown;
  storedAt: number;
}

/**
 * Arguments are part of the key: listing two directories is two questions.
 * Keys are sorted so argument order cannot produce a false miss.
 */
function keyFor(tool: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join('&');
  return `${tool}(${parts})`;
}

export interface CacheHit<T> {
  value: T;
  /** How old the cached value is, in milliseconds. */
  ageMs: number;
}

export class ToolCache {
  private entries = new Map<string, Entry>();

  /** A still-valid result for this call, if one exists. */
  get<T>(tool: string, args: Record<string, unknown>): CacheHit<T> | null {
    const ttl = TTL_MS[tool];
    if (!ttl) return null;

    const entry = this.entries.get(keyFor(tool, args));
    if (!entry) return null;

    const ageMs = Date.now() - entry.storedAt;
    if (ageMs > ttl) {
      this.entries.delete(keyFor(tool, args));
      return null;
    }
    return { value: entry.value as T, ageMs };
  }

  /** Store a result, if this tool is one that may be cached at all. */
  set(tool: string, args: Record<string, unknown>, value: unknown): void {
    if (!TTL_MS[tool]) return;
    this.entries.set(keyFor(tool, args), { value, storedAt: Date.now() });
  }

  /**
   * Drop everything this tool's success has made stale.
   *
   * Called after a tool runs, whether or not it was itself cacheable.
   */
  invalidate(tool: string): void {
    const affected = INVALIDATES[tool];
    if (!affected) return;

    for (const key of [...this.entries.keys()]) {
      const name = key.slice(0, key.indexOf('('));
      if (affected.includes(name)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Is this tool eligible for caching? Used for the action-log wording. */
export function isCacheable(tool: string): boolean {
  return Boolean(TTL_MS[tool]);
}

/** "1.2s ago", for the action log. */
export function formatAge(ageMs: number): string {
  return `${(ageMs / 1000).toFixed(1)}s ago`;
}
