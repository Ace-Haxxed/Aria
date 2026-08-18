import { useCallback, useEffect, useState } from 'react';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { ChevronLeft, File as FileIcon, Folder, RefreshCw, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';
import { formatBytes } from '@/lib/utils';

interface Entry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

/**
 * Browser for ARIA's sandboxed storage. iOS and Android do not grant an app
 * access to the whole filesystem, so this is scoped to the app's own directory
 * — the same place the file tools read and write.
 */
export function MobileFiles() {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await Filesystem.readdir({ path: target, directory: Directory.Data });
      setEntries(
        result.files
          .map((f) => ({ name: f.name, type: f.type, size: f.size }))
          .sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
          ),
      );
    } catch (e) {
      // An empty app directory reads as an error on a fresh install.
      setEntries([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(path);
  }, [path, load]);

  const share = async (name: string) => {
    try {
      const full = path ? `${path}/${name}` : name;
      const uri = await Filesystem.getUri({ path: full, directory: Directory.Data });
      await Share.share({ url: uri.uri, dialogTitle: 'Share file' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2">
        {path && (
          <Button size="icon-sm" variant="ghost" onClick={() => setPath(parent)} aria-label="Back">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
        <h2 className="flex-1 truncate text-sm font-semibold">
          {path || 'ARIA storage'}
        </h2>
        <Button size="icon-sm" variant="ghost" onClick={() => void load(path)} aria-label="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {loading && <p className="px-1 text-xs text-muted-foreground">Loading…</p>}

      {!loading && entries.length === 0 && (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing here yet. Files ARIA creates will show up in this folder.
          </p>
          {error && <p className="mt-2 text-[11px] text-muted-foreground/70">{error}</p>}
        </Card>
      )}

      <div className="space-y-1.5">
        {entries.map((entry) => (
          <Card key={entry.name} className="flex items-center gap-3 p-3">
            {entry.type === 'directory' ? (
              <Folder className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}

            <button
              className="min-w-0 flex-1 text-left"
              onClick={() =>
                entry.type === 'directory' &&
                setPath(path ? `${path}/${entry.name}` : entry.name)
              }
            >
              <div className="truncate text-sm">{entry.name}</div>
              {entry.type === 'file' && (
                <div className="text-[11px] text-muted-foreground">{formatBytes(entry.size)}</div>
              )}
            </button>

            {entry.type === 'file' && (
              <button
                onClick={() => void share(entry.name)}
                className="shrink-0 p-1.5 text-muted-foreground active:text-primary"
                aria-label={`Share ${entry.name}`}
              >
                <Share2 className="h-4 w-4" />
              </button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
