/**
 * Kill-switch test for the Nano Banana image-gen client.
 *
 * Separate file from gemini-image.test.ts because that one mocks
 * GOOGLE_API_KEY=''. To exercise the `requireEnabled` path we need a
 * non-empty key (otherwise generateImagePng short-circuits before ever
 * touching the kill switch).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GOOGLE_API_KEY: 'test-api-key' };
});

vi.mock('./kill-switches.js', () => ({
  requireEnabled: vi.fn(() => {
    throw Object.assign(new Error('kill switch is disabled'), { code: 'KILL_SWITCH_DISABLED' });
  }),
}));

import { generateImagePng, _resetGeminiImageClientForTests } from './gemini-image.js';

beforeEach(() => {
  _resetGeminiImageClientForTests();
});

describe('generateImagePng — kill switch', () => {
  it('returns null when LLM_SPAWN_ENABLED kill switch throws (operator emergency stop)', async () => {
    const out = await generateImagePng('a labeled mitochondrion');
    expect(out).toBeNull();
  });
});
