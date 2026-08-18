/**
 * Platform gate. Everything platform-specific is resolved here exactly once,
 * so the rest of the app can import `tools`, `isDesktop` and friends without
 * ever branching on the runtime itself.
 */
import type { PlatformInfo, ToolDefinition } from '@/core/types';

/**
 * Capacitor's native bridge, when one exists.
 *
 * Read from the global rather than imported. These two values are needed
 * synchronously at module load — every other module's imports depend on them —
 * so they cannot come from a dynamic import, and a static one would pull
 * Capacitor's entire core shim into the desktop bundle for two booleans that
 * are always false there. The native runtime injects this global before any
 * app script runs, which is the same thing the package's own shim reads.
 */
const bridge = (
  globalThis as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }
).Capacitor;

export const isMobile: boolean = bridge?.isNativePlatform?.() ?? false;
export const platform = (bridge?.getPlatform?.() ?? 'web') as 'android' | 'ios' | 'web';
export const isDesktop: boolean = !isMobile;

/**
 * True when running inside the Tauri shell. `isDesktop` is also true in a plain
 * browser during `vite dev`, where no native command exists — code that calls
 * into Rust must check this, not `isDesktop`.
 */
export const isTauri: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const isAndroid = platform === 'android';
export const isIOS = platform === 'ios';

let toolsCache: ToolDefinition[] | null = null;
let infoCache: PlatformInfo | null = null;

/** The tool set available on this device. */
export async function getTools(): Promise<ToolDefinition[]> {
  if (toolsCache) return toolsCache;

  if (isMobile) {
    const mod = await import('./mobile');
    toolsCache = await mod.mobileTools();
  } else {
    const mod = await import('./desktop');
    toolsCache = await mod.desktopTools();
  }
  return toolsCache;
}

export async function getPlatformInfo(): Promise<PlatformInfo> {
  if (infoCache) return infoCache;

  if (isMobile) {
    const mod = await import('./mobile');
    infoCache = await mod.mobilePlatformInfo();
  } else {
    const mod = await import('./desktop');
    infoCache = await mod.desktopPlatformInfo();
  }
  return infoCache;
}

/** Invalidate the caches after the user changes capability permissions. */
export function resetPlatformCaches(): void {
  toolsCache = null;
  infoCache = null;
}
