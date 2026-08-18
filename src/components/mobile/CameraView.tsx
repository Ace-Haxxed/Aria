import { useState } from 'react';
import { Camera, Image as ImageIcon, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';

interface CameraViewProps {
  /** Runs the agent turn with the captured image attached. */
  onAnalyse: (question: string, image: string) => void;
}

/**
 * "Point the camera at something and ask about it" — the one capability that
 * genuinely belongs to mobile rather than desktop.
 */
export function CameraView({ onAnalyse }: CameraViewProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('What is this?');

  const capture = async (fromLibrary: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { Camera: Cam, CameraResultType, CameraSource } = await import('@capacitor/camera');
      const photo = await Cam.getPhoto({
        quality: 80,
        resultType: CameraResultType.DataUrl,
        source: fromLibrary ? CameraSource.Photos : CameraSource.Camera,
        width: 1024,
      });
      if (photo.dataUrl) setPreview(photo.dataUrl);
    } catch (e) {
      // The user cancelling the picker is not an error worth showing.
      const message = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(message)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card className="overflow-hidden">
        {preview ? (
          <img src={preview} alt="Captured" className="block w-full" />
        ) : (
          <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 text-muted-foreground">
            <Camera className="h-10 w-10" />
            <p className="text-sm">Take a photo and ask about it</p>
          </div>
        )}
      </Card>

      {error && (
        <p className="rounded-lg border border-risk-high/40 bg-risk-high/10 px-3 py-2 text-xs text-risk-high">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button className="flex-1 gap-2" onClick={() => void capture(false)} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          Camera
        </Button>
        <Button
          variant="outline"
          className="flex-1 gap-2"
          onClick={() => void capture(true)}
          disabled={busy}
        >
          <ImageIcon className="h-4 w-4" />
          Library
        </Button>
      </div>

      {preview && (
        <div className="space-y-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What would you like to know?"
            className="w-full rounded-xl border border-input bg-card/70 px-4 py-3 text-sm
              placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1
              focus-visible:ring-ring"
          />
          <Button
            className="w-full"
            onClick={() => {
              onAnalyse(question.trim() || 'What is this?', preview);
              setPreview(null);
            }}
          >
            Ask ARIA
          </Button>
        </div>
      )}
    </div>
  );
}
