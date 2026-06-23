import { describe, it, expect } from 'vitest';

import {
  buildCardGenerationPrompt,
  draftToFields,
  validateCardDraft,
} from './prompts.js';

describe('buildCardGenerationPrompt', () => {
  it('includes the source label, deck hint, topic hint, and card cap', () => {
    const prompt = buildCardGenerationPrompt('some source text here.', {
      sourceLabel: 'Coach Dave Stayman notes',
      topicHint: 'When does responder use Stayman',
      maxCards: 4,
      deckHint: 'Bridge::Conventions::Stayman',
    });
    expect(prompt).toContain('Coach Dave Stayman notes');
    expect(prompt).toContain('When does responder use Stayman');
    expect(prompt).toContain('Bridge::Conventions::Stayman');
    expect(prompt).toContain('AT MOST 4 cards');
    expect(prompt).toContain('some source text here.');
    expect(prompt).toContain('OUTPUT FORMAT:'); // instruction header present
  });

  it('clamps maxCards to [1, 12]', () => {
    const lo = buildCardGenerationPrompt('x', { sourceLabel: 's', maxCards: -5 });
    expect(lo).toContain('AT MOST 1 cards');
    const hi = buildCardGenerationPrompt('x', { sourceLabel: 's', maxCards: 99 });
    expect(hi).toContain('AT MOST 12 cards');
  });

  it('defaults maxCards to 5 when omitted', () => {
    const prompt = buildCardGenerationPrompt('x', { sourceLabel: 's' });
    expect(prompt).toContain('AT MOST 5 cards');
  });

  it('omits topic and deck lines when not provided', () => {
    const prompt = buildCardGenerationPrompt('x', { sourceLabel: 's' });
    expect(prompt).not.toContain('TOPIC HINT:');
    expect(prompt).not.toContain('TARGET DECK:');
  });
});

describe('validateCardDraft', () => {
  it('accepts a well-formed basic card', () => {
    const r = validateCardDraft({
      model: 'basic',
      front: 'What is Stayman?',
      back: '2♣ over 1NT asking for a 4-card major',
      tags: ['bridge', 'stayman'],
      source: 'Coach Dave §3.3',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.front).toBe('What is Stayman?');
      expect(r.card.tags).toEqual(['bridge', 'stayman']);
    }
  });

  it('accepts a well-formed cloze card with {{c1::...}} marker', () => {
    const r = validateCardDraft({
      model: 'cloze',
      text: 'Stayman = {{c1::2♣ over 1NT}} asks opener for a 4-card major',
      tags: ['bridge'],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateCardDraft(null).ok).toBe(false);
    expect(validateCardDraft('a string').ok).toBe(false);
    expect(validateCardDraft(42).ok).toBe(false);
  });

  it('rejects unknown model values', () => {
    const r = validateCardDraft({ model: 'fancy', front: 'q', back: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/model must be/);
  });

  it('rejects basic cards missing front or back', () => {
    expect(validateCardDraft({ model: 'basic', back: 'a' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'basic', front: 'q' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'basic', front: '   ', back: 'a' }).ok).toBe(false);
  });

  it('rejects cloze cards lacking a {{c#::...}} marker', () => {
    const r = validateCardDraft({ model: 'cloze', text: 'Stayman is 2C over 1NT' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cloze.*marker/);
  });

  it('rejects cloze cards with empty text', () => {
    const r = validateCardDraft({ model: 'cloze', text: '' });
    expect(r.ok).toBe(false);
  });

  it('coerces non-array tags to empty list', () => {
    const r = validateCardDraft({ model: 'basic', front: 'q', back: 'a', tags: 'bridge' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.card.tags).toEqual([]);
  });

  it('trims whitespace from string fields', () => {
    const r = validateCardDraft({
      model: 'basic',
      front: '  q  ',
      back: '\na\n',
      source: '  src  ',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.front).toBe('q');
      expect(r.card.back).toBe('a');
      expect(r.card.source).toBe('src');
    }
  });
});

describe('draftToFields', () => {
  it('maps basic drafts to ClaudeClaw Basic Rich fields', () => {
    const out = draftToFields({
      model: 'basic',
      front: 'q',
      back: 'a',
      source: 'src',
    });
    expect(out.model).toBe('ClaudeClaw Basic Rich');
    expect(out.fields).toEqual({ Front: 'q', Back: 'a', Source: 'src' });
  });

  it('maps cloze drafts to ClaudeClaw Cloze Rich fields', () => {
    const out = draftToFields({
      model: 'cloze',
      text: '{{c1::hi}}',
      backExtra: 'more',
    });
    expect(out.model).toBe('ClaudeClaw Cloze Rich');
    expect(out.fields).toEqual({ Text: '{{c1::hi}}', BackExtra: 'more', Source: '' });
  });

  it('emits empty strings for missing optional fields rather than undefined', () => {
    const out = draftToFields({ model: 'basic', front: 'q', back: 'a' });
    expect(out.fields.Source).toBe('');
  });

  it('maps definition drafts to ClaudeClaw Definition fields', () => {
    const out = draftToFields({
      model: 'definition',
      term: 'Stayman',
      definition: '2♣ over 1NT asking for a 4-card major',
      example: 'After partner opens 1NT, with 4 hearts you respond 2♣',
      source: 'Coach Dave §3.3',
    });
    expect(out.model).toBe('ClaudeClaw Definition');
    expect(out.fields.Term).toBe('Stayman');
    expect(out.fields.Definition).toBe('2♣ over 1NT asking for a 4-card major');
    expect(out.fields.Example).toContain('1NT');
    expect(out.fields.Source).toBe('Coach Dave §3.3');
  });

  it('maps scenario drafts to ClaudeClaw Scenario fields', () => {
    const out = draftToFields({
      model: 'scenario',
      setup: 'Partner opens 1NT (15-17). You hold ♠KQxx ♥xx ♦Kxx ♣Jxxx.',
      question: 'What is your bid?',
      answer: '2♣ (Stayman)',
      why: 'You have an unbalanced 4-card major and want to find a 4-4 spade fit before committing to NT.',
      source: 'KB-BP-021',
    });
    expect(out.model).toBe('ClaudeClaw Scenario');
    expect(out.fields.Setup).toContain('1NT');
    expect(out.fields.Question).toBe('What is your bid?');
    expect(out.fields.Answer).toBe('2♣ (Stayman)');
    expect(out.fields.Why).toContain('4-4 spade fit');
  });

  it('maps comparison drafts to ClaudeClaw Comparison fields', () => {
    const out = draftToFields({
      model: 'comparison',
      conceptA: 'Stayman (2♣ over 1NT)',
      conceptB: 'Jacoby Transfer (2♦/2♥ over 1NT)',
      difference: 'Stayman asks for a 4-card major; Jacoby commands a transfer to the named major.',
      source: 'Coach Dave',
    });
    expect(out.model).toBe('ClaudeClaw Comparison');
    expect(out.fields.ConceptA).toContain('Stayman');
    expect(out.fields.ConceptB).toContain('Jacoby');
    expect(out.fields.Difference).toContain('4-card major');
  });
});

describe('validateCardDraft — new archetypes', () => {
  it('accepts a well-formed definition card', () => {
    const r = validateCardDraft({
      model: 'definition',
      term: 'Stayman',
      definition: '2♣ over 1NT asking for a 4-card major',
      example: 'optional',
      tags: ['bridge', 'conventions'],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects definition card missing term or definition', () => {
    expect(validateCardDraft({ model: 'definition', definition: 'd' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'definition', term: 't' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'definition', term: '  ', definition: 'd' }).ok).toBe(false);
  });

  it('accepts a definition card with no example (example is optional)', () => {
    const r = validateCardDraft({
      model: 'definition',
      term: 'Stayman',
      definition: '2♣ over 1NT asking for a 4-card major',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.example).toBeUndefined();
    }
  });

  it('accepts a well-formed scenario card', () => {
    const r = validateCardDraft({
      model: 'scenario',
      setup: 'Partner opens 1NT (15-17)',
      question: 'You hold ♠KQxx — what do you bid?',
      answer: '2♣ (Stayman)',
      why: 'finding 4-4 majors',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects scenario card missing setup, question, or answer', () => {
    expect(validateCardDraft({ model: 'scenario', question: 'q', answer: 'a' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'scenario', setup: 's', answer: 'a' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'scenario', setup: 's', question: 'q' }).ok).toBe(false);
  });

  it('accepts a well-formed comparison card', () => {
    const r = validateCardDraft({
      model: 'comparison',
      conceptA: 'Stayman',
      conceptB: 'Jacoby Transfer',
      difference: 'Stayman asks; Jacoby commands a transfer.',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects comparison card missing any of conceptA/conceptB/difference', () => {
    expect(validateCardDraft({ model: 'comparison', conceptB: 'b', difference: 'd' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'comparison', conceptA: 'a', difference: 'd' }).ok).toBe(false);
    expect(validateCardDraft({ model: 'comparison', conceptA: 'a', conceptB: 'b' }).ok).toBe(false);
  });
});

describe('buildCardGenerationPrompt — archetype menu', () => {
  it('includes the five archetypes in the instructions', () => {
    const prompt = buildCardGenerationPrompt('x', { sourceLabel: 's' });
    for (const name of ['basic', 'cloze', 'definition', 'scenario', 'comparison']) {
      expect(prompt).toMatch(new RegExp(`"${name}"`));
    }
  });

  it('includes the visual-diagram opt-in instructions', () => {
    const prompt = buildCardGenerationPrompt('x', { sourceLabel: 's' });
    expect(prompt).toContain('needsDiagram');
    expect(prompt).toContain('imagePrompt');
  });

  it('includes the variation-across-batch instructions (Story 8)', () => {
    const prompt = buildCardGenerationPrompt('x', { sourceLabel: 's' });
    expect(prompt).toContain('VARIATION ACROSS THE BATCH');
    expect(prompt).toMatch(/vary the archetypes deliberately/i);
    expect(prompt).toMatch(/EXCEPTION/);
    expect(prompt).toMatch(/Match archetype to content/i);
  });
});

describe('validateCardDraft — visual diagrams', () => {
  it('accepts needsDiagram=false (or absent) and ignores any imagePrompt', () => {
    const r1 = validateCardDraft({ model: 'basic', front: 'q', back: 'a' });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.card.imagePrompt).toBeUndefined();

    const r2 = validateCardDraft({ model: 'basic', front: 'q', back: 'a', needsDiagram: false, imagePrompt: 'ignored' });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.card.needsDiagram).toBeUndefined();
      expect(r2.card.imagePrompt).toBeUndefined();
    }
  });

  it('accepts needsDiagram=true with a valid imagePrompt', () => {
    const r = validateCardDraft({
      model: 'definition',
      term: 'Mitochondrion',
      definition: 'The organelle responsible for ATP production',
      needsDiagram: true,
      imagePrompt: 'A cross-section of a mitochondrion showing the outer membrane, inner membrane, cristae, and matrix.',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.needsDiagram).toBe(true);
      expect(r.card.imagePrompt).toContain('mitochondrion');
    }
  });

  it('rejects needsDiagram=true without a non-empty imagePrompt', () => {
    const r = validateCardDraft({ model: 'basic', front: 'q', back: 'a', needsDiagram: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/imagePrompt/);

    const r2 = validateCardDraft({ model: 'basic', front: 'q', back: 'a', needsDiagram: true, imagePrompt: '  ' });
    expect(r2.ok).toBe(false);
  });

  it('rejects imagePrompt longer than 600 chars', () => {
    const huge = 'x'.repeat(601);
    const r = validateCardDraft({
      model: 'basic',
      front: 'q',
      back: 'a',
      needsDiagram: true,
      imagePrompt: huge,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/<= 600 chars/);
  });
});
