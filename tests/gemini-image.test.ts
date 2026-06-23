/**
 * Unit tests for the Nano Banana image-gen client.
 *
 * Focuses on the graceful-degrade paths (no API key, kill switch off,
 * empty prompt). The actual API call is mocked because it's costly /
 * non-deterministic; the network shape is integration-tested manually
 * by Brian's smoke flow.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GOOGLE_API_KEY: '' };
});

import { generateImagePng, _resetGeminiImageClientForTests, MAX_IMAGE_PROMPT_CHARS } from './gemini-image.js';

beforeEach(() => {
  _resetGeminiImageClientForTests();
});

describe('generateImagePng', () => {
  it('returns null when GOOGLE_API_KEY is empty (graceful degrade)', async () => {
    const out = await generateImagePng('a heart with labeled chambers');
    expect(out).toBeNull();
  });

  it('returns null on an empty prompt', async () => {
    const out = await generateImagePng('');
    expect(out).toBeNull();
  });

  it('returns null on a whitespace-only prompt', async () => {
    const out = await generateImagePng('   \n\t');
    expect(out).toBeNull();
  });

  it('exports a sane MAX_IMAGE_PROMPT_CHARS', () => {
    expect(MAX_IMAGE_PROMPT_CHARS).toBeGreaterThan(100);
    expect(MAX_IMAGE_PROMPT_CHARS).toBeLessThan(10_000);
  });
});
