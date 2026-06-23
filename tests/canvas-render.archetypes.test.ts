/**
 * Playwright integration test for archetype-aware Canvas previews.
 *
 * Renders a Scenario card and a Comparison card through the real
 * renderHtmlToPng → chromium pipeline and asserts a PNG was produced.
 * This is the Story 6 acceptance criterion for "Canvas preview renders
 * all archetypes correctly" — pure vitest tests cover the HTML; this
 * test catches Playwright-side breakage (CSS that won't render, layout
 * collapse, etc.).
 *
 * Skipped automatically when the chromium binary isn't installed, so
 * this won't break CI environments without Playwright.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

import { renderHtmlToPng } from './canvas-render.js';
import { renderPendingPreviewHtml } from './anki-pending.js';
import type { PendingCard } from './anki-pending.js';

function makeCard(model: string, fields: Record<string, string>): PendingCard {
  return {
    id: 1,
    agentId: 'main',
    proposedAt: Date.now(),
    deck: 'Bridge::Test',
    model,
    fields,
    tags: ['bridge'],
    media: [],
    sourceType: 'doc-html',
    sourceRef: '/tmp/test.html',
    sourceCitation: 'KB-BP-021',
    contentHash: 'test',
    batchId: null,
    chatId: null,
    previewMessageId: null,
    ankiNoteId: null,
    decidedAt: null,
    status: 'pending',
  };
}

describe('Canvas preview — archetype rendering (Playwright)', () => {
  it('renders a Scenario card to a non-empty PNG', async () => {
    const card = makeCard('ClaudeClaw Scenario', {
      Setup: 'Partner opens 1NT (15-17). You hold ♠KQxx ♥xx ♦Kxx ♣Jxxx.',
      Question: 'What is your bid?',
      Answer: '2♣ (Stayman)',
      Why: 'Finding a 4-4 spade fit before committing to NT.',
      Source: 'KB-BP-021',
    });
    const html = renderPendingPreviewHtml(card, { index: 1, total: 1 });
    const pngPath = await renderHtmlToPng(html);
    if (!pngPath) {
      // Playwright/chromium not installed — skip rather than fail.
      console.warn('renderHtmlToPng returned null; chromium likely unavailable. Skipping.');
      return;
    }
    expect(fs.existsSync(pngPath)).toBe(true);
    const stat = fs.statSync(pngPath);
    expect(stat.size).toBeGreaterThan(2000); // a blank or collapsed render would be much smaller
    fs.unlinkSync(pngPath);
  }, 30_000);

  it('renders a Comparison card to a non-empty PNG', async () => {
    const card = makeCard('ClaudeClaw Comparison', {
      ConceptA: 'Stayman (2♣ over 1NT)',
      ConceptB: 'Jacoby Transfer (2♦/2♥ over 1NT)',
      Difference: 'Stayman asks opener for a 4-card major; Jacoby commands a transfer to the named major.',
      Source: 'Coach Dave',
    });
    const html = renderPendingPreviewHtml(card, { index: 1, total: 1 });
    const pngPath = await renderHtmlToPng(html);
    if (!pngPath) {
      console.warn('renderHtmlToPng returned null; chromium likely unavailable. Skipping.');
      return;
    }
    expect(fs.existsSync(pngPath)).toBe(true);
    const stat = fs.statSync(pngPath);
    expect(stat.size).toBeGreaterThan(2000);
    fs.unlinkSync(pngPath);
  }, 30_000);

  it('renders a Definition card to a non-empty PNG', async () => {
    const card = makeCard('ClaudeClaw Definition', {
      Term: 'Stayman',
      Definition: '2♣ over 1NT asking opener for a 4-card major',
      Example: 'With ♠KQxx ♥xx ♦Kxx ♣Jxxx, respond 2♣',
      Source: 'Coach Dave §3.3',
    });
    const html = renderPendingPreviewHtml(card, { index: 1, total: 1 });
    const pngPath = await renderHtmlToPng(html);
    if (!pngPath) {
      console.warn('renderHtmlToPng returned null; chromium likely unavailable. Skipping.');
      return;
    }
    expect(fs.existsSync(pngPath)).toBe(true);
    const stat = fs.statSync(pngPath);
    expect(stat.size).toBeGreaterThan(2000);
    fs.unlinkSync(pngPath);
  }, 30_000);

  it('renders a card with an embedded data: image (Story 7 Nano Banana)', async () => {
    // 1×1 red PNG, base64. Real Nano Banana output would be ~512×512, but
    // we just need to verify the <img> tag survives the Canvas pipeline.
    const tinyRedPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const card = makeCard('ClaudeClaw Definition', {
      Term: 'Mitochondrion',
      Definition: `<img src="data:image/png;base64,${tinyRedPng}" class="auto-diagram"> The organelle responsible for ATP production via the electron transport chain.`,
      Example: 'A muscle cell has thousands of mitochondria',
      Source: 'Lehninger 7e §16.1',
    });
    const html = renderPendingPreviewHtml(card, { index: 1, total: 1 });
    expect(html).toContain('data:image/png;base64');
    const pngPath = await renderHtmlToPng(html);
    if (!pngPath) {
      console.warn('renderHtmlToPng returned null; chromium likely unavailable. Skipping.');
      return;
    }
    expect(fs.existsSync(pngPath)).toBe(true);
    const stat = fs.statSync(pngPath);
    expect(stat.size).toBeGreaterThan(2000);
    fs.unlinkSync(pngPath);
  }, 30_000);
});
