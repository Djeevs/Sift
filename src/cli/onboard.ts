import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PROJECT_ROOT, readerPreferencesSchema, type ReaderPreferences } from '../config/index.js';
import { loadEnvFile, parseArgs } from './_bootstrap.js';
import { createProfile, parseDossier, renderProfilePreview } from '../onboarding/index.js';
import {
  defaultReaderPreferences,
  normalizeLanguages,
  parseReaderPreferences,
  suggestedReaderPreferences,
} from '../onboarding/preferences.js';

type PreferenceStatus = 'completed' | 'defaults';

async function choose<T extends string>(
  rl: Interface,
  question: string,
  choices: Array<{ value: T; label: string }>,
  defaultValue: T,
): Promise<T> {
  console.log(`\n${question}`);
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label}${choice.value === defaultValue ? ' [default]' : ''}`));
  while (true) {
    const answer = (await rl.question('Choose a number or press Enter: ')).trim().toLowerCase();
    if (!answer) return defaultValue;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index]!.value;
    const direct = choices.find((choice) => choice.value === answer);
    if (direct) return direct.value;
  }
}

function commaList(value: string, fallback: string[]): string[] {
  if (!value.trim()) return fallback;
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function parseMediumPreferences(
  raw: string,
  fallback: ReaderPreferences['medium_preferences'],
): ReaderPreferences['medium_preferences'] {
  if (!raw.trim()) return fallback;
  const result: ReaderPreferences['medium_preferences'] = [];
  for (const entry of raw.split(',')) {
    const [subject, mediumRaw] = entry.split('=').map((part) => part?.trim());
    const preferred_medium = mediumRaw?.toLowerCase();
    if (!subject || !['text', 'video', 'podcast', 'any'].includes(preferred_medium ?? '')) {
      throw new Error(`Invalid medium preference "${entry.trim()}". Use subject=text|video|podcast|any.`);
    }
    result.push({ subject, preferred_medium: preferred_medium as 'text' | 'video' | 'podcast' | 'any', strength: 'prefer' });
  }
  return result;
}

async function interactivePreferences(proposed: ReaderPreferences): Promise<{
  preferences: ReaderPreferences;
  status: PreferenceStatus;
}> {
  const rl = createInterface({ input, output });
  try {
    console.log('\nSift preferences wizard');
    console.log('ChatGPT suggestions are defaults only. Press Enter to accept one, or choose a different value.');
    const skip = (await rl.question('Skip this wizard and use safe Sift defaults? [y/N] ')).trim().toLowerCase();
    if (skip === 'y' || skip === 'yes') return { preferences: defaultReaderPreferences(), status: 'defaults' };

    const attention_budget = await choose(rl, 'Realistic article-reading capacity:', [
      { value: 'under_15', label: 'Under 15 minutes per day' },
      { value: '15_30', label: '15–30 minutes per day' },
      { value: '30_60', label: '30–60 minutes per day' },
      { value: '60_plus', label: '60+ minutes per day' },
      { value: 'variable', label: 'Highly variable' },
    ], proposed.attention_budget);
    const article_length = await choose(rl, 'Preferred article length:', [
      { value: 'mostly_short', label: 'Mostly short reads' },
      { value: 'medium', label: 'Mostly medium reads' },
      { value: 'long_when_exceptional', label: 'Long articles when exceptional' },
      { value: 'any', label: 'Length does not matter' },
    ], proposed.article_length);
    const paywall_policy = await choose(rl, 'Paywall policy (Sift never bypasses logins or paywalls):', [
      { value: 'free_only', label: 'Free articles only' },
      { value: 'subscribed_publications', label: 'Include publications I subscribe to when readable' },
      { value: 'readable_only', label: 'Any article Sift can read normally' },
      { value: 'quality_first', label: 'Rank quality first, while still requiring readable access' },
    ], proposed.paywall_policy);
    const subscribed = paywall_policy === 'subscribed_publications'
      ? commaList(await rl.question(`Subscribed publications, comma-separated [${proposed.subscribed_publications.join(', ')}]: `), proposed.subscribed_publications)
      : proposed.subscribed_publications;
    const languages = normalizeLanguages(commaList(
      await rl.question(`Languages, names or codes, comma-separated [${proposed.languages.join(', ')}]: `),
      proposed.languages,
    ));
    const nonPrimary = languages.length > 1
      ? await choose(rl, 'How should non-primary languages be treated?', [
        { value: 'never', label: 'Never recommend them' },
        { value: 'exceptional_only', label: 'Recommend only when especially good' },
        { value: 'equal', label: 'Treat equally' },
      ], proposed.non_primary_language_policy)
      : proposed.non_primary_language_policy;
    const freshness_balance = await choose(rl, 'Freshness balance:', [
      { value: 'timely', label: 'Mostly worth knowing this week' },
      { value: 'balanced', label: 'Even mix of timely and evergreen' },
      { value: 'evergreen', label: 'Best things regardless of age' },
    ], proposed.freshness_balance);
    const ageAnswer = (await rl.question(`Maximum evergreen age in days; blank means no limit [${proposed.max_evergreen_age_days ?? 'none'}]: `)).trim();
    const maxAge = ageAnswer ? Number(ageAnswer) : proposed.max_evergreen_age_days;
    if (maxAge !== null && (!Number.isInteger(maxAge) || maxAge <= 0)) throw new Error('Evergreen age must be a positive whole number or blank.');
    const serendipityAnswer = (await rl.question(`Serendipity from 0–10 [${proposed.serendipity}]: `)).trim();
    const serendipity = serendipityAnswer ? Number(serendipityAnswer) : proposed.serendipity;
    if (!Number.isFinite(serendipity) || serendipity < 0 || serendipity > 10) throw new Error('Serendipity must be between 0 and 10.');
    const voices = commaList(await rl.question(`Preferred voices, comma-separated [${proposed.writing_voices.join(', ')}]: `), proposed.writing_voices);
    const disliked = commaList(await rl.question(`Disliked styles, comma-separated [${proposed.disliked_styles.join(', ')}]: `), proposed.disliked_styles);
    const currentMedium = proposed.medium_preferences.map((item) => `${item.subject}=${item.preferred_medium}`).join(', ');
    const medium = parseMediumPreferences(
      await rl.question(`Subjects better in another medium as subject=video|podcast|text|any [${currentMedium}]: `),
      proposed.medium_preferences,
    );
    const optional_feeds = await askOptionalFeeds(rl, proposed.optional_feeds);

    return {
      preferences: readerPreferencesSchema.parse({
        version: 1,
        attention_budget,
        article_length,
        paywall_policy,
        subscribed_publications: subscribed,
        languages,
        non_primary_language_policy: nonPrimary,
        freshness_balance,
        max_evergreen_age_days: maxAge,
        serendipity,
        writing_voices: voices,
        disliked_styles: disliked,
        medium_preferences: medium,
        optional_feeds,
      }),
      status: 'completed',
    };
  } finally {
    rl.close();
  }
}

/**
 * The two optional feeds, explained before they are offered.
 *
 * The web wizard describes each one in a paragraph beside its checkbox; a
 * terminal reader gets the same words. "Classics? [Y/n]" would be a question
 * nobody can answer on their first run.
 */
async function askOptionalFeeds(
  rl: Interface,
  proposed: ReaderPreferences['optional_feeds'],
): Promise<ReaderPreferences['optional_feeds']> {
  const confirm = async (question: string, current: boolean): Promise<boolean> => {
    const answer = (await rl.question(`${question} [${current ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
    if (!answer) return current;
    return answer === 'y' || answer === 'yes';
  };

  console.log('\nTwo extra feeds, on top of the six topic feeds. Both are on by default.');
  console.log('\n  The Briefing — twice a day');
  console.log('  One short article at 8am and 8pm: the ten things worth knowing since the');
  console.log('  last one, each a headline, a link and a summary in the publisher\u2019s own');
  console.log('  words. Ranked by the same judgement as everything else, so it is ten things');
  console.log('  relevant to you rather than ten things that happened. Costs nothing extra');
  console.log('  to run, and never takes an article away from your other feeds.');
  const briefing = await confirm('\n  Send the Briefing?', proposed.briefing);

  console.log('\n  Sift Classics — at most one a day');
  console.log('  One exceptional older article \u2014 at least a year old, often much more \u2014');
  console.log('  chosen for timeless writing, obsessive expertise and irresistible rabbit');
  console.log('  holes rather than for being new. Most days nothing clears the bar and');
  console.log('  nothing arrives. This one does use a little AI credit, because each');
  console.log('  candidate is read in full before it is offered.');
  const classics = await confirm('\n  Send Sift Classics?', proposed.classics);

  return { briefing, classics };
}

async function explicitApproval(): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('\nType "approve" to create and activate this profile, or press Enter to stop: ')).trim().toLowerCase();
    return answer === 'approve';
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  loadEnvFile();
  const args = parseArgs();
  const promptPath = resolve(PROJECT_ROOT, 'onboarding', 'chatgpt-profile-prompt.md');
  if (args['print-prompt'] || !args.from) {
    console.log(readFileSync(promptPath, 'utf8'));
    if (!args.from) {
      console.log('\nNext: npm run onboard -- --profile YOUR_NAME --from /path/to/dossier.json');
      return;
    }
  }

  if (typeof args.profile !== 'string') throw new Error('Missing --profile YOUR_NAME');
  if (typeof args.from !== 'string') throw new Error('Missing --from /path/to/dossier.json');
  const dossierPath = resolve(args.from);
  if (!existsSync(dossierPath)) throw new Error(`Dossier not found: ${dossierPath}`);
  const dossier = parseDossier(readFileSync(dossierPath, 'utf8'));
  const proposed = suggestedReaderPreferences(dossier.assistant_preference_hints);

  let preferences: ReaderPreferences;
  let preferenceStatus: PreferenceStatus;
  if (typeof args['preferences-file'] === 'string') {
    const path = resolve(args['preferences-file']);
    if (!existsSync(path)) throw new Error(`Preferences file not found: ${path}`);
    preferences = parseReaderPreferences(readFileSync(path, 'utf8'));
    preferenceStatus = 'completed';
  } else if (args['skip-preferences'] === true) {
    preferences = defaultReaderPreferences();
    preferenceStatus = 'defaults';
  } else if (input.isTTY) {
    const result = await interactivePreferences(proposed);
    preferences = result.preferences;
    preferenceStatus = result.status;
  } else {
    preferences = proposed;
    preferenceStatus = 'completed';
  }

  console.log('');
  console.log(renderProfilePreview(dossier, preferences, preferenceStatus));
  if (args.preview === true) {
    console.log('\nPreview only: no profile was created.');
    return;
  }

  const approved = args.approve === true || (input.isTTY && await explicitApproval());
  if (!approved) {
    console.log('\nNo profile was created. Review the preview, then rerun with --approve or approve interactively.');
    return;
  }

  const created = createProfile({
    profileId: args.profile,
    dossier,
    preferences,
    preferencesStatus: preferenceStatus,
    approved: true,
    skipCalibration: false,
    force: args.force === true,
  });

  console.log('');
  console.log(`Profile created: ${created.directory}`);
  console.log(`Private database: ${created.databasePath}`);
  console.log(`Preferences: ${preferenceStatus}`);
  console.log('Calibration: available after the first ranked recommendations');
  console.log(`Source candidates: ${dossier.source_candidates.length} recorded for validation`);
  if (dossier.source_candidates.length > 0) console.log(`Discover feeds: npm run sources:discover -- --profile ${created.profileId}`);
  console.log(`After ranking and reading a few results: npm run calibrate -- --profile ${created.profileId}`);
  console.log('');
  console.log(`Next: npm run db:setup -- --profile ${created.profileId}`);
  console.log(`Then: npm run doctor -- --profile ${created.profileId}`);
  console.log(`First-week review: npm run review -- --profile ${created.profileId}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
