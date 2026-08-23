import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { main, printTable } from './_bootstrap.js';
import { profileDirectory, readOnboardingState } from '../onboarding/index.js';
import {
  firstWeekMetrics,
  proposeFirstWeekChanges,
  saveFirstWeekReview,
  type FirstWeekResponses,
} from '../onboarding/review.js';

function yes(value: string | boolean | undefined): boolean | null {
  if (typeof value !== 'string') return value === true ? true : null;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(normalized)) return true;
  if (['no', 'n', 'false', '0'].includes(normalized)) return false;
  return null;
}

async function askResponses(): Promise<FirstWeekResponses> {
  const rl = createInterface({ input, output });
  try {
    const askYes = async (question: string): Promise<boolean> => {
      while (true) {
        const answer = yes(await rl.question(`${question} [y/n] `));
        if (answer !== null) return answer;
      }
    };
    const too_narrow = await askYes('Does Sift feel too narrow?');
    const too_noisy = await askYes('Does it include too many items that are not worth your time?');
    const too_repetitive = await askYes('Does it repeat stories or perspectives too often?');
    const missing = await rl.question('Missing interests, comma-separated (or leave blank): ');
    return {
      too_narrow,
      too_noisy,
      too_repetitive,
      missing_interests: missing.split(',').map((value) => value.trim()).filter(Boolean),
    };
  } finally {
    rl.close();
  }
}

await main(async ({ db, config }, args) => {
  const profileId = typeof args.profile === 'string' ? args.profile : config.env.profileId;
  if (!profileId) throw new Error('First-week review requires --profile YOUR_NAME');
  const directory = profileDirectory(profileId);
  const state = readOnboardingState(directory);
  const due = new Date(state.first_week_due_at).getTime();
  if (Date.now() < due && args.force !== true) {
    const days = Math.ceil((due - Date.now()) / (24 * 60 * 60 * 1000));
    console.log(`First-week review is due in ${days} day${days === 1 ? '' : 's'}. Use --force to review early.`);
    return;
  }

  const metrics = firstWeekMetrics(db, state.created_at);
  console.log('First-week Sift report');
  printTable([{
    unique_items: metrics.unique_items,
    placements: metrics.placements,
    opens: metrics.opens,
    excellent: metrics.excellent,
    not_for_me: metrics.not_for_me,
    repeated_cluster_pct: Math.round(metrics.repeated_cluster_share * 100),
    top_category: metrics.top_category ?? 'n/a',
    top_category_pct: Math.round(metrics.top_category_share * 100),
    top_source: metrics.top_source ?? 'n/a',
    top_source_pct: Math.round(metrics.top_source_share * 100),
  }]);
  for (const warning of metrics.warnings) console.log(`warning: ${warning}`);

  const flagsComplete = ['narrow', 'noisy', 'repetitive'].every((key) => yes(args[key]) !== null);
  if (!flagsComplete && !input.isTTY) {
    console.log('Questionnaire not recorded: use an interactive terminal or pass --narrow yes|no --noisy yes|no --repetitive yes|no.');
    return;
  }
  const responses = flagsComplete
    ? {
        too_narrow: yes(args.narrow)!,
        too_noisy: yes(args.noisy)!,
        too_repetitive: yes(args.repetitive)!,
        missing_interests: typeof args.missing === 'string'
          ? args.missing.split(',').map((value) => value.trim()).filter(Boolean)
          : [],
      }
    : await askResponses();
  const proposal = proposeFirstWeekChanges(metrics, responses);

  console.log('');
  console.log('Proposed profile changes:');
  if (proposal.reasons.length === 0) console.log('  none');
  for (const reason of proposal.reasons) console.log(`  evidence: ${reason}`);
  for (const value of proposal.add_strong_interests) console.log(`  + strong interest: ${value}`);
  for (const value of proposal.add_positive_traits) console.log(`  + positive trait: ${value}`);
  for (const value of proposal.add_negative_traits) console.log(`  + negative trait: ${value}`);
  for (const value of proposal.add_editorial_notes) console.log(`  + editorial note: ${value}`);
  for (const value of proposal.add_interest_anchors) console.log(`  + interest anchor: ${value.id}`);

  let approved = args.apply === true;
  if (!approved && input.isTTY && proposal.reasons.length > 0) {
    const rl = createInterface({ input, output });
    try {
      approved = (await rl.question('Type apply to approve these changes, or press Enter to keep the profile unchanged: ')).trim() === 'apply';
    } finally {
      rl.close();
    }
  }
  saveFirstWeekReview({ profileDir: directory, config, metrics, responses, proposal, apply: approved });
  console.log(approved ? 'Approved changes applied.' : 'Review saved; profile left unchanged.');
});
