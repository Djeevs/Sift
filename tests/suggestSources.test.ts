import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { observedDomains } from '../src/onboarding/suggestSources.js';
import { seedDeepEvaluation, seedItem, testDb } from './helpers.js';

/**
 * The assistant supplies context; Sift chooses the sources. Where Sift has
 * watched a domain perform for this reader, that evidence outranks any model's
 * prior, so it is gathered and handed to the prompt rather than left in the
 * database unused.
 */
describe('evidence for source suggestions', () => {
  it('reports discovery domains that produced several good articles', () => {
    const { db } = testDb();
    db.run(`UPDATE sources SET feed_type = 'linkblog' WHERE id = 'hacker_news'`);
    for (const [i, score] of [0.8, 0.7, 0.2].entries()) {
      const id = seedItem(db, { sourceId: 'hacker_news', title: `good ${i}`, url: `https://good.example/${i}` });
      seedDeepEvaluation(db, id, { expected_attention_value: score });
    }
    const domains = observedDomains(db);
    expect(domains.map((d) => d.domain)).toContain('good.example');
    expect(domains.find((d) => d.domain === 'good.example')!.items).toBe(3);
  });

  // One good article is luck; the threshold exists so a single outlier cannot
  // recommend a whole publication.
  it('ignores a domain seen only once', () => {
    const { db } = testDb();
    db.run(`UPDATE sources SET feed_type = 'linkblog' WHERE id = 'hacker_news'`);
    const id = seedItem(db, { sourceId: 'hacker_news', title: 'once', url: 'https://once.example/a' });
    seedDeepEvaluation(db, id, { expected_attention_value: 0.9 });
    expect(observedDomains(db).some((d) => d.domain === 'once.example')).toBe(false);
  });

  // An item from a source already configured says nothing about whether to
  // configure it, so it is not evidence for this question.
  it('ignores items from sources already followed', () => {
    const { db } = testDb();
    const configured = db.all<{ id: string }>(`SELECT id FROM sources WHERE feed_type != 'linkblog' LIMIT 1`)[0];
    if (!configured) return;
    for (let i = 0; i < 3; i += 1) {
      const id = seedItem(db, { sourceId: configured.id, title: `already ${i}`, url: `https://already.example/${i}` });
      seedDeepEvaluation(db, id, { expected_attention_value: 0.9 });
    }
    expect(observedDomains(db).some((d) => d.domain === 'already.example')).toBe(false);
  });

  it('degrades to no evidence rather than failing', () => {
    expect(observedDomains(null as never)).toEqual([]);
  });
});

describe('the source-discovery prompt', () => {
  const body = readFileSync(resolve(process.cwd(), 'prompts/source-discovery-v1.md'), 'utf8');

  it('describes all three lanes and what each wants', () => {
    for (const lane of ['feeds', 'briefing', 'classics']) expect(body).toContain(lane);
    // The distinction that matters: noisy sources belong in the digest.
    expect(body).toMatch(/too noisy for `feeds` is often ideal/);
  });

  /**
   * The model proposes names and domains; Sift finds the feed. A guessed
   * /feed.xml is noise, and a plausible invention is worse than a short list
   * because Sift will try to fetch it.
   */
  it('forbids inventing feed URLs and publications', () => {
    expect(body).toMatch(/Give the domain, not a feed URL/);
    expect(body).toMatch(/Only real publications/);
  });

  it('tells the model that observed evidence outranks its prior', () => {
    expect(body).toMatch(/stronger than your prior beliefs/);
  });

  it('uses only template variables the renderer supplies', () => {
    const used = [...body.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
    for (const name of used) expect(name).toMatch(/^[A-Z_]+$/);
    expect(used).toContain('EXISTING_SOURCES');
    expect(used).toContain('OBSERVED_DOMAINS');
  });
});
