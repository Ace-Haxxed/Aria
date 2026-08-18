/**
 * Vision tools: locating things on screen and reading text out of an image.
 *
 * Both work by capturing the screen and asking a vision model about it. The
 * screenshot never leaves the device when the backend is Ollama.
 */
import type { LLMConfig, ToolDefinition } from '../types';
import { argString, defineTool, fail, ok, p } from './base';
import { complete } from '../llm';
import { useSettings } from '@/store/settings';
import { parseLooseJson, uid } from '@/lib/utils';

/** Swap in the vision model — the chat model is often text-only. */
function visionConfig(): LLMConfig {
  const { llm } = useSettings.getState().settings;
  return { ...llm, model: llm.visionModel || llm.model };
}

async function askAboutImage(image: string, prompt: string): Promise<string> {
  return await complete(visionConfig(), [
    {
      id: uid('m'),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      images: [image],
    },
  ]);
}

export interface ScreenPoint {
  x: number;
  y: number;
  confidence: number;
}

/** Ask a vision model where something is, in pixel coordinates. */
export async function locateOnScreen(
  image: string,
  description: string,
  screenWidth: number,
  screenHeight: number,
): Promise<ScreenPoint | null> {
  const answer = await askAboutImage(
    image,
    `This is a ${screenWidth}x${screenHeight} pixel screenshot. Find: ${description}\n\n` +
      'Reply with only a JSON object of the form ' +
      '{"x": <number>, "y": <number>, "confidence": <0-1>} giving the centre of the element ' +
      'in pixels. If it is not visible, reply {"found": false}.',
  );

  const parsed = parseLooseJson<Record<string, unknown>>(answer);
  if (!parsed || parsed.found === false) return null;

  const x = Number(parsed.x);
  const y = Number(parsed.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  // Models sometimes answer in normalised 0-1 coordinates despite the prompt.
  const scaledX = x <= 1 && y <= 1 ? Math.round(x * screenWidth) : Math.round(x);
  const scaledY = x <= 1 && y <= 1 ? Math.round(y * screenHeight) : Math.round(y);

  return {
    x: scaledX,
    y: scaledY,
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.5,
  };
}

export function visionTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'find_on_screen',
      description:
        'Find something on screen by describing it in words — "the Save button", "the search ' +
        'box" — and get back its pixel coordinates. Use this instead of guessing coordinates, ' +
        'then pass the result to click.',
      capability: 'screen',
      risk: 'low',
      platforms: ['desktop'],
      parameters: {
        description: p.string('What to look for, in plain words.'),
      },
      required: ['description'],
      async run(args) {
        const description = argString(args, 'description');
        const { desktop } = await import('@/platform/desktop');

        // OCR first: it runs locally in a few hundred milliseconds and costs
        // nothing, and most things worth clicking are labelled with text. Only
        // when that finds nothing is it worth spending a vision request.
        const ocr = await desktop.findOnScreen(description).catch(() => null);
        if (ocr?.found) {
          return ok(`Found "${description}" at ${ocr.x}, ${ocr.y} — ${ocr.detail}`, {
            point: { x: ocr.x, y: ocr.y, confidence: 1 },
          });
        }

        const image = await desktop.screenshot();
        const { width, height } = await desktop.screenSize();
        const point = await locateOnScreen(image, description, width, height);

        if (!point) return fail(`Could not find "${description}" on screen.`);
        return ok(
          `Found "${description}" at ${point.x}, ${point.y} ` +
            `(confidence ${point.confidence.toFixed(2)}).`,
          { point, image },
        );
      },
    }),

    defineTool({
      name: 'get_screen_text',
      description:
        'Read the text currently visible on screen. Use this to check what an application is ' +
        'showing, or to read a dialog you cannot otherwise access.',
      capability: 'screen',
      risk: 'low',
      platforms: ['desktop'],
      parameters: {},
      async run() {
        const { desktop } = await import('@/platform/desktop');
        const image = await desktop.screenshot();
        const text = await askAboutImage(
          image,
          'Transcribe all readable text in this screenshot. Preserve the layout roughly, ' +
            'using line breaks. Reply with the text only.',
        );
        return ok(text.trim() || 'No readable text on screen.', { image });
      },
    }),

    defineTool({
      name: 'describe_screen',
      description:
        'Describe what is currently on screen — which application is in focus, what it is ' +
        'showing, what the user could do next.',
      capability: 'screen',
      risk: 'low',
      platforms: ['desktop'],
      parameters: {
        question: p.string('An optional specific question about the screen.'),
      },
      async run(args) {
        const { desktop } = await import('@/platform/desktop');
        const image = await desktop.screenshot();
        const question =
          args.question != null
            ? argString(args, 'question')
            : 'Describe what is on this screen concisely: the focused application, what it is ' +
              'showing, and the main interactive elements.';

        const answer = await askAboutImage(image, question);
        return ok(answer.trim(), { image });
      },
    }),
  ];
}
