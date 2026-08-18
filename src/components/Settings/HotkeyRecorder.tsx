import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/store/settings';
import type { HotkeyConfig } from '@/core/types';
import { cn } from '@/lib/utils';

interface HotkeyRecorderProps {
  action: keyof HotkeyConfig;
  label: string;
}

/** Modifier keys are never a shortcut on their own. */
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/**
 * Convert a KeyboardEvent into the accelerator string Tauri expects.
 * `CommandOrControl` maps to Cmd on macOS and Ctrl elsewhere.
 */
function toAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  // `code` is layout-independent, which matters for a global grab.
  let key = e.code;
  if (key.startsWith('Key')) key = key.slice(3);
  else if (key.startsWith('Digit')) key = key.slice(5);
  else if (key.startsWith('Arrow')) key = key.slice(5);

  // A bare letter with no modifier would swallow that key system-wide.
  if (parts.length === 0 && key.length === 1) return null;

  parts.push(key);
  return parts.join('+');
}

export function HotkeyRecorder({ action, label }: HotkeyRecorderProps) {
  const binding = useSettings((s) => s.settings.hotkeys[action]);
  const updateHotkeys = useSettings((s) => s.updateHotkeys);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }

      const accelerator = toAccelerator(e);
      if (!accelerator) return;

      updateHotkeys({ [action]: accelerator } as Partial<HotkeyConfig>);
      setRecording(false);
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, action, updateHotkeys]);

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {recording ? 'Press the keys now, or Escape to cancel' : 'Click to change'}
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => setRecording((v) => !v)}
        className={cn(
          'shrink-0 gap-2 font-mono text-xs',
          recording && 'border-primary text-primary',
        )}
      >
        <Keyboard className="h-3.5 w-3.5" />
        {recording ? 'Listening…' : binding}
      </Button>
    </div>
  );
}
