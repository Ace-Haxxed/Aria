/**
 * Speaker test, used by Settings → Voice and by the setup wizard.
 *
 * Deliberately independent of `useVoice`: the point is to prove the configured
 * output path works, so it goes through the same engine selection but without
 * touching agent state.
 */
import { isMobile, isTauri } from '@/platform';
import { useSettings } from '@/store/settings';

export async function useVoiceTest(text: string): Promise<void> {
  const voice = useSettings.getState().settings.voice;

  if (isMobile && voice.ttsEngine === 'native') {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    await TextToSpeech.speak({
      text,
      lang: 'en-US',
      rate: voice.speed,
      pitch: voice.pitch,
      category: 'ambient',
    });
    return;
  }

  if (isTauri && voice.ttsEngine === 'piper-sidecar') {
    const { desktop } = await import('@/platform/desktop');
    const dataUrl = await desktop.synthesize(text, voice.speed);
    await new Audio(dataUrl).play();
    return;
  }

  if (isTauri && voice.ttsEngine === 'os-native') {
    const { desktop } = await import('@/platform/desktop');
    await desktop.speakNative(text);
    return;
  }

  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = voice.speed;
    utterance.pitch = voice.pitch;
    window.speechSynthesis.speak(utterance);
    return;
  }

  throw new Error('No speech engine is available.');
}
