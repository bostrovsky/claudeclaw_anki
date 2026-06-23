/**
 * Gemini 2.5 Flash Image ("Nano Banana") client.
 *
 * Generates PNG images from a text prompt for use as inline diagrams on
 * Anki cards. The model is invoked via the same @google/genai SDK we use
 * for text generation; the response includes inline base64-encoded image
 * data which we decode to a Buffer.
 *
 * Returns null on:
 *   - LLM_SPAWN_ENABLED kill switch off
 *   - missing GOOGLE_API_KEY
 *   - empty / non-image response
 *   - API error
 *
 * Callers (e.g. card-generation pipeline) treat null as "no image" and
 * proceed without one — image generation is always a best-effort
 * enrichment, never a hard requirement.
 */
import { GoogleGenAI, Modality } from '@google/genai';

import { GOOGLE_API_KEY } from './config.js';
import { logger } from './logger.js';
import { requireEnabled } from './kill-switches.js';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is not set');
  }
  client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  return client;
}

/** Reset the client cache. For tests only. */
export function _resetGeminiImageClientForTests(): void {
  client = null;
}

/** Max prompt length the image-gen model will accept usefully. */
export const MAX_IMAGE_PROMPT_CHARS = 600;

/** Per-call timeout (ms). 20s matches the AC4 budget. */
export const IMAGE_GEN_TIMEOUT_MS = 20_000;

/**
 * Stylistic preamble prepended to every image prompt. Pulls the visual
 * aesthetic toward "diagram" rather than "photograph" so the resulting
 * PNGs sit cleanly inside Anki's dark-mode card body. Keep this short —
 * the user-supplied prompt dominates.
 */
const STYLE_PREAMBLE =
  'A clear educational textbook diagram in landscape orientation (16:9 aspect ratio, roughly 1024x576 pixels). Clean labeled illustration with concise text labels on the key parts only (one or two words per label, never sentences). Light background, dark line work, one or two accent colors for emphasis. Style: anatomy textbook / engineering schematic — accurate proportions, clearly distinguishable parts. NO decorative elements, NO photorealism, NO neon or stylized art. Subject:';

/**
 * Generate a PNG image from the given prompt. Returns a Buffer or null
 * on any failure. Never throws.
 */
export async function generateImagePng(userPrompt: string): Promise<Buffer | null> {
  try {
    requireEnabled('LLM_SPAWN_ENABLED');
  } catch (err) {
    logger.warn({ err }, 'gemini-image: kill switch is off, returning null');
    return null;
  }

  if (!GOOGLE_API_KEY) {
    // Same graceful-degrade pattern as generateContent: no key → no image.
    return null;
  }

  const trimmed = (userPrompt ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  const safePrompt = trimmed.slice(0, MAX_IMAGE_PROMPT_CHARS);
  const fullPrompt = `${STYLE_PREAMBLE} ${safePrompt}`;

  const ai = getClient();

  // Wrap the API call in a manual timeout. The SDK doesn't expose a
  // per-request timeout option, and the image model occasionally hangs.
  // The timer is unref'd so it doesn't pin the event loop open (tests
  // would otherwise hang for 20s after each call) and cleared after the
  // race resolves to free the resource immediately on the happy path.
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timerId = setTimeout(() => resolve(null), IMAGE_GEN_TIMEOUT_MS);
    timerId.unref?.();
  });
  const call = (async (): Promise<Buffer | null> => {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: fullPrompt,
        config: {
          responseModalities: [Modality.IMAGE],
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith('image/')) {
          return Buffer.from(inline.data, 'base64');
        }
      }
      logger.warn({ promptHead: safePrompt.slice(0, 80) }, 'gemini-image: response had no inline image');
      return null;
    } catch (err: unknown) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), promptHead: safePrompt.slice(0, 80) },
        'gemini-image: generateContent failed',
      );
      return null;
    }
  })();

  const result = await Promise.race([call, timeout]);
  if (timerId !== null) clearTimeout(timerId);
  if (result === null) {
    // null can mean: (a) the API call's catch block already logged an
    // error and resolved null, or (b) the timeout won and the API call
    // is still running in the background (the SDK aborts on next await).
    // The within-call path logs; the timeout path is otherwise silent,
    // so log it here so the operator can see when latency was the cause.
    logger.warn(
      { promptHead: safePrompt.slice(0, 80) },
      'gemini-image: returned null (timeout or empty response)',
    );
    return null;
  }
  return result;
}
