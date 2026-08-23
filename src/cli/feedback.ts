import { main, printTable } from './_bootstrap.js';
import { pollFeedbackFeeds, recordManualFeedback, resolveFeedbackFeeds } from '../feedback/reeder.js';
import { startJob } from '../pipeline/journal.js';

/**
 * Poll the Reeder feedback feeds, or record a signal by hand.
 *
 *   npm run feedback
 *   npm run feedback -- --item <item-id> --signal excellent
 *   npm run feedback -- --item <item-id> --signal not_for_me --note "too long"
 */
await main(async ({ db, config }, args) => {
  if (typeof args.item === 'string') {
    const signal = args.signal === 'not_for_me' ? 'not_for_me' : 'excellent';
    recordManualFeedback(db, args.item, signal, typeof args.note === 'string' ? args.note : undefined);
    console.log(`recorded ${signal} for ${args.item}`);
    return;
  }

  const feeds = resolveFeedbackFeeds();
  if (feeds.length === 0) {
    console.log('No feedback feeds configured. Set these in .env:');
    console.log('  SIFT_FEEDBACK_EXCELLENT_URL=https://.../shared-feed.xml');
    console.log('  SIFT_FEEDBACK_NOT_FOR_ME_URL=https://.../shared-feed.xml');
    console.log('');
    console.log('See the README section "Explicit feedback from Reeder".');
    return;
  }

  const job = startJob(db, 'feedback');
  try {
    const stats = await pollFeedbackFeeds(db, config, feeds);
    job.finish({ ...stats });
    printTable([stats]);

    const unmatched = db.all(
      `SELECT signal, raw_title, raw_url FROM explicit_feedback
       WHERE item_id IS NULL ORDER BY created_at DESC LIMIT 10`,
    );
    if (unmatched.length) {
      console.log('');
      console.log('unmatched feedback entries (could not be tied to a published item):');
      printTable(unmatched);
    }
  } catch (err) {
    job.fail(err);
    throw err;
  }
});
