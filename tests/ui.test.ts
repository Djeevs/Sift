import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../src/config/index.js';
import { initDb } from '../src/db/index.js';
import { createUiApp, slugifyReaderName, plainError } from '../src/ui/app.js';
import { ACTIONS, JobBusyError, UiJobRunner, redactUiOutput, type UiJob } from '../src/ui/jobs.js';

const dossier = {
  version: 3,
  reading_goal: 'Find a small number of articles that consistently justify attention.',
  executive_taste_summary: 'A curious reader who values clear explanations and surprising discoveries.',
  attention_selection_model: 'Prefer concrete intellectual payoff over comprehensive coverage.',
  values_and_outlook: [],
  current_context: [],
  interests: [{
    id: 'science_discoveries',
    label: 'science discoveries',
    tier: 'core',
    priority: 8,
    preferred_coverage: ['Discoveries with a conceptual payoff and accessible explanation.'],
    conditions: [],
    medium_fit: 'cross_medium',
    basis: 'explicit',
    confidence: 0.9,
  }],
  valuable_intersections: [],
  rewarding_qualities: [{ quality: 'clear mechanisms', why: 'They produce reusable understanding.', strength: 'strong', basis: 'observed', confidence: 0.8 }],
  unrewarding_qualities: [{ quality: 'thin aggregation', why: 'It adds little beyond the headline.', strength: 'strong', basis: 'observed', confidence: 0.8 }],
  content_mix: { breaking_news: 0.2, reporting: 0.6, analysis: 0.8, narrative: 0.6, criticism: 0.4, practical: 0.4, entertainment: 0.4, serendipity: 0.5 },
  timeliness_profile: { news_vs_interpretation: 'Prefer interpretation unless immediacy matters.', loses_value_quickly: [], remains_valuable: ['conceptual explanations'], archival_appetite: 'selective', age_guidance: 'Age alone is not disqualifying.', basis: 'inferred', confidence: 0.6 },
  depth_length_profile: { summary: 'Depth matters more than length.', longform_payoff_threshold: 'Long work must deliver durable insight.', technical_complexity: 'Prefer accessible explanation.', basis: 'inferred', confidence: 0.6 },
  medium_profile: [],
  entertainment_profile: { role_in_ranking: 'Enjoyment is useful but secondary to insight.', rewarding_forms: [], basis: 'inferred', confidence: 0.4 },
  exploration_profile: { frequency: 'occasional', execution_override_strength: 5, unfamiliar_topic_quality_bar: 'Require excellent execution.', override_conditions: [], basis: 'inferred', confidence: 0.5 },
  professional_personal_boundary: { enjoyed_overlap: [], useful_but_not_personal: [], guidance: 'Do not infer obligatory work reading.', basis: 'inferred', confidence: 0.5 },
  style_references: [],
  examples: [],
  assistant_preference_hints: {},
  interest_anchors: [{ id: 'science', category: 'ideas_science', description: 'Accessible science discoveries that materially change understanding.' }],
  avoid_anchors: [],
  source_candidates: [],
  ranking_guidance: { strong_positive_signals: ['conceptual payoff'], moderate_positive_signals: [], weak_positive_signals: [], strong_negative_signals: ['thin aggregation'], hard_filters: [], override_rules: [], interaction_effects: [], source_level_guidance: [], duplication_and_saturation: [] },
  contradictions: [],
  uncertainties: [],
  privacy_redactions: [],
};

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'sift-ui-'));
  mkdirSync(resolve(root, 'onboarding'), { recursive: true });
  mkdirSync(resolve(root, 'config'), { recursive: true });
  copyFileSync(resolve(PROJECT_ROOT, 'onboarding/chatgpt-profile-prompt.md'), resolve(root, 'onboarding/chatgpt-profile-prompt.md'));
  copyFileSync(resolve(PROJECT_ROOT, 'config/feed-config.yaml'), resolve(root, 'config/feed-config.yaml'));
  copyFileSync(resolve(PROJECT_ROOT, 'config/classics.yaml'), resolve(root, 'config/classics.yaml'));
  copyFileSync(resolve(PROJECT_ROOT, 'config/models.yaml'), resolve(root, 'config/models.yaml'));
  return root;
}

function form(values: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  };
}

describe('Mac local UI', () => {
  it('renders the local home and onboarding prompt', async () => {
    const app = createUiApp({ projectRoot: fixtureRoot(), csrfToken: 'test-csrf' });
    const home = await app.request('/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Private discovery on your Mac');
    const onboarding = await app.request('/onboarding');
    const html = await onboarding.text();
    expect(html).toContain('Copy ChatGPT prompt');
    // The two inputs the reader has to fill in, asserted by field name rather
    // than by label text so wording can be improved without breaking the test.
    expect(html).toContain('name="profile_id"');
    expect(html).toContain('name="dossier"');
    // The name field must not impose an id format on the reader: "Alice Smith"
    // is the obvious thing to type and used to fail HTML pattern validation.
    expect(html).not.toContain('pattern="[a-z0-9][a-z0-9_-]{0,63}"');
  });

  it('accepts a reader name typed the way a person would write it', () => {
    expect(slugifyReaderName('Alice Smith')).toBe('alice-smith');
    expect(slugifyReaderName('  Renée O’Brien  ')).toBe('renee-o-brien');
    expect(slugifyReaderName('alice')).toBe('alice');
    expect(() => slugifyReaderName('!!!')).toThrow(/at least one letter or number/);
  });

  it('turns a zod issue array into a sentence naming the field', () => {
    const zodish = JSON.stringify([{ code: 'too_small', minimum: 10, path: ['positive_examples', 0, 'description'] }]);
    const { headline, detail } = plainError(new Error(zodish));
    expect(headline).toContain('could not build a profile');
    expect(detail).toContain('positive_examples → 0 → description');
    expect(detail).not.toContain('too_small');
  });

  it('explains failures without showing raw parser output first', () => {
    const jsonError = plainError(new Error('The onboarding dossier is not valid JSON: Unexpected token'));
    expect(jsonError.headline).toContain('does not look like the profile');
    expect(jsonError.detail).toContain('starts with {');
    // Anything unrecognised still reaches the reader rather than being swallowed.
    expect(plainError(new Error('disk on fire')).detail).toBe('disk on fire');
  });

  it('previews without writing, then creates only after explicit approval', async () => {
    const root = fixtureRoot();
    const app = createUiApp({ projectRoot: root, csrfToken: 'test-csrf' });
    const dossierResponse = await app.request('/onboarding/dossier', form({
      csrf: 'test-csrf',
      profile_id: 'ui-reader',
      dossier: JSON.stringify(dossier),
    }));
    expect(dossierResponse.status).toBe(200);
    const preferencesHtml = await dossierResponse.text();
    const draftId = /name="draft_id" value="([^"]+)"/.exec(preferencesHtml)?.[1];
    expect(draftId).toBeTruthy();
    expect(preferencesHtml).toContain('<option value="never" selected>Never</option>');

    const previewResponse = await app.request('/onboarding/preview', form({
      csrf: 'test-csrf',
      draft_id: draftId!,
      skip_preferences: 'on',
    }));
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.text()).toContain('NO FILES HAVE BEEN CREATED');
    expect(existsSync(resolve(root, 'profiles/ui-reader'))).toBe(false);

    const createResponse = await app.request('/onboarding/create', form({
      csrf: 'test-csrf',
      draft_id: draftId!,
      approval: 'approve',
      skip_calibration: 'on',
    }));
    expect(createResponse.status).toBe(303);
    expect(existsSync(resolve(root, 'profiles/ui-reader/taste-profile.yaml'))).toBe(true);
    expect(readFileSync(resolve(root, 'profiles/ui-reader/onboarding-state.json'), 'utf8')).toContain('profile_approved_at');

    const dashboard = await app.request('/profile/ui-reader');
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('Publish and subscribe');
    expect(dashboardHtml).toContain('Waiting for your first articles');
  });

  it('stores an AI key privately without rendering it or leaving it in job output', async () => {
    const root = fixtureRoot();
    const app = createUiApp({ projectRoot: root, csrfToken: 'test-csrf' });
    const dossierResponse = await app.request('/onboarding/dossier', form({
      csrf: 'test-csrf', profile_id: 'secure-reader', dossier: JSON.stringify(dossier),
    }));
    const draftId = /name="draft_id" value="([^"]+)"/.exec(await dossierResponse.text())?.[1]!;
    await app.request('/onboarding/preview', form({ csrf: 'test-csrf', draft_id: draftId, skip_preferences: 'on' }));
    await app.request('/onboarding/create', form({ csrf: 'test-csrf', draft_id: draftId, approval: 'approve' }));
    const secret = 'synthetic-api-key-for-redaction-test-123456789';
    const saved = await app.request('/profile/secure-reader/ai', form({
      csrf: 'test-csrf',
      provider: 'openai',
      api_key: secret,
      triage_model: 'gpt-5.6-luna',
      deep_model: 'gpt-5.6-terra',
      embedding_model: 'text-embedding-3-small',
      base_url: '',
    }));
    expect(saved.status).toBe(303);
    expect(readFileSync(resolve(root, 'profiles/secure-reader/.env'), 'utf8')).toContain(secret);
    const dashboard = await app.request('/profile/secure-reader?saved=ai');
    const html = await dashboard.text();
    expect(html).not.toContain(secret);
    expect(html).toContain('Its value is deliberately never shown');
    expect(redactUiOutput(`provider failed with ${secret}`, [secret])).toBe('provider failed with [REDACTED]');
  });

  it('offers calibration only after real ranked articles exist', async () => {
    const root = fixtureRoot();
    const app = createUiApp({ projectRoot: root, csrfToken: 'test-csrf' });
    const dossierResponse = await app.request('/onboarding/dossier', form({
      csrf: 'test-csrf', profile_id: 'ranked-reader', dossier: JSON.stringify(dossier),
    }));
    const draftId = /name="draft_id" value="([^"]+)"/.exec(await dossierResponse.text())?.[1]!;
    await app.request('/onboarding/preview', form({ csrf: 'test-csrf', draft_id: draftId, skip_preferences: 'on' }));
    await app.request('/onboarding/create', form({ csrf: 'test-csrf', draft_id: draftId, approval: 'approve' }));
    const before = await app.request('/profile/ranked-reader/calibration');
    expect(before.status).toBe(404);

    const dbPath = resolve(root, 'data/profiles/ranked-reader.db');
    const db = initDb(dbPath);
    const now = Date.now();
    db.run(`INSERT INTO sources (id, name, url, feed_type, language, enabled, publishable, categories_json, config_prior, learned_prior, created_at, updated_at)
            VALUES ('source', 'Real Source', 'https://example.com/feed', 'article', 'en', 1, 1, '[]', 0.5, 0, :now, :now)`, { now });
    db.run(`INSERT INTO feed_items (id, source_id, title, original_url, feed_categories_json, feed_images_json, first_seen_at, status, status_updated_at)
            VALUES ('real-item', 'source', 'The real article Sift ranked', 'https://example.com/real', '[]', '[]', :now, 'published', :now)`, { now });
    db.run(`INSERT INTO published_feed_items (feed_id, item_id, score, rank_position, why_it_surfaced, published_at, day_key)
            VALUES ('essential', 'real-item', 0.91, 1, 'Strong explanatory payoff.', :now, '2026-08-23')`, { now });
    db.close();

    const after = await app.request('/profile/ranked-reader/calibration');
    expect(after.status).toBe(200);
    const html = await after.text();
    expect(html).toContain('The real article Sift ranked');
    expect(html).toContain('Glad I read it');
    expect(html).not.toContain('article premises');
  });

  /**
   * Pressing "Find articles" while the free test run was still going produced
   * "Run free dry test is already running" — naming a button that no longer
   * existed, with nothing to click. Labels now come from one place, and a busy
   * runner sends the reader to the run in progress instead of an error page.
   */
  it('sends a reader to the run already in progress instead of refusing', async () => {
    const runner = new UiJobRunner(fixtureRoot());
    const busy: UiJob = {
      id: 'job-1', profileId: 'r', action: 'pipeline_dry', label: ACTIONS.pipeline_dry.label,
      status: 'running', startedAt: new Date().toISOString(), output: '',
    };
    (runner as unknown as { jobs: Map<string, UiJob> }).jobs.set(busy.id, busy);
    expect(() => runner.start('r', 'pipeline')).toThrow(JobBusyError);
    try {
      runner.start('r', 'pipeline');
    } catch (error) {
      expect((error as JobBusyError).job.id).toBe('job-1');
      // The message must name a control the reader has actually seen.
      expect((error as JobBusyError).message).toContain(ACTIONS.pipeline_dry.label);
      expect((error as JobBusyError).message).not.toContain('dry test');
    }
    expect(runner.running('r')?.id).toBe('job-1');
    expect(runner.running('other')).toBeNull();
  });

  /**
   * /api/status is the one endpoint designed to be piped into other programs —
   * a menu bar item, a status script. Feed URLs carry the reader's access
   * token, so they must never appear here, however convenient it would be.
   */
  it('reports status for machine clients without leaking a feed token', async () => {
    const root = fixtureRoot();
    const app = createUiApp({ projectRoot: root, csrfToken: 'test-csrf' });
    await app.request('/onboarding/dossier', form({ csrf: 'test-csrf', profile_id: 'api-reader', dossier: JSON.stringify(dossier) }));
    const preferences = await app.request('/onboarding/dossier', form({ csrf: 'test-csrf', profile_id: 'api-reader2', dossier: JSON.stringify(dossier) }));
    const draftId = /name="draft_id" value="([^"]+)"/.exec(await preferences.text())?.[1];
    await app.request('/onboarding/preview', form({ csrf: 'test-csrf', draft_id: draftId!, skip_preferences: 'on' }));
    await app.request('/onboarding/create', form({ csrf: 'test-csrf', draft_id: draftId!, approval: 'approve' }));

    const response = await app.request('/api/status');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toMatch(/[?&]t=/);
    const status = JSON.parse(body) as { version: string; profiles: Array<Record<string, unknown>> };
    expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.profiles.length).toBeGreaterThan(0);
    const profile = status.profiles[0]!;
    for (const key of ['id', 'active', 'ready', 'picksToday', 'picks', 'needsAttention', 'backgroundService']) {
      expect(profile, `missing ${key}`).toHaveProperty(key);
    }
  });

  /**
   * Removing a reader takes a feed key and a database with it, so the dashboard
   * asks for the name to be typed rather than a box to be ticked — a checkbox
   * is one mis-click away from the only irreversible-looking action here.
   */
  it('will not remove a reader without the name typed exactly', async () => {
    const root = fixtureRoot();
    const app = createUiApp({ projectRoot: root, csrfToken: 'test-csrf' });
    const preferences = await app.request('/onboarding/dossier', form({ csrf: 'test-csrf', profile_id: 'doomed', dossier: JSON.stringify(dossier) }));
    const draftId = /name="draft_id" value="([^"]+)"/.exec(await preferences.text())?.[1];
    await app.request('/onboarding/preview', form({ csrf: 'test-csrf', draft_id: draftId!, skip_preferences: 'on' }));
    await app.request('/onboarding/create', form({ csrf: 'test-csrf', draft_id: draftId!, approval: 'approve' }));
    expect(existsSync(resolve(root, 'profiles/doomed/taste-profile.yaml'))).toBe(true);

    const wrong = await app.request('/profile/doomed/delete', form({ csrf: 'test-csrf', confirm_name: 'something else' }));
    expect(wrong.status).toBe(400);
    expect(existsSync(resolve(root, 'profiles/doomed/taste-profile.yaml'))).toBe(true);

    const right = await app.request('/profile/doomed/delete', form({ csrf: 'test-csrf', confirm_name: 'doomed' }));
    expect(right.status).toBe(200);
    expect(existsSync(resolve(root, 'profiles/doomed'))).toBe(false);
    // Moved, not erased: the page tells the reader where it went.
    expect(await right.text()).toContain('data/deleted');
  });

  it('rejects a form submitted without its local CSRF token', async () => {
    const app = createUiApp({ projectRoot: fixtureRoot(), csrfToken: 'test-csrf' });
    const response = await app.request('/onboarding/dossier', form({
      csrf: 'wrong',
      profile_id: 'reader',
      dossier: JSON.stringify(dossier),
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('form expired');
  });
});
