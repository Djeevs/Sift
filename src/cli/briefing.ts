import { main, printTable } from './_bootstrap.js';
import { runBriefing, recentSlots, loadBriefingEditions } from '../briefing/index.js';
import { briefingEntryHtml, briefingEntryTitle } from '../server/renderFeed.js';
import { startJob } from '../pipeline/journal.js';
import { withLock } from '../util/lock.js';

/**
 * Build, preview or inspect a briefing.
 *
 * The pipeline and the scheduler both build editions on their own, so this is
 * mainly a diagnostic: `--dry` answers "what would the next briefing contain?"
 * without writing anything or waiting for 08:00.
 *
 *   npm run briefing -- --dry        what the due slot would publish
 *   npm run briefing                 build it if a slot is due
 *   npm run briefing -- --force      rebuild the most recent slot regardless
 *   npm run briefing -- --show       the last few published editions
 */
await main(async ({ db, config }, args) => {
  if (!config.briefing.enabled) {
    console.log('The briefing is turned off for this reader.');
    console.log('Turn it on with reader_preferences.optional_feeds.briefing in the profile,');
    console.log('or enabled: true in config/briefing.yaml.');
    return;
  }

  if (args.show === true) {
    const editions = loadBriefingEditions(db, config, typeof args.limit === 'string' ? Number(args.limit) : 5);
    if (editions.length === 0) {
      console.log('No briefing has been published yet.');
      return;
    }
    for (const edition of editions) {
      console.log('');
      console.log(`=== ${briefingEntryTitle(edition)} ===`);
      console.log(`published ${new Date(edition.publishedAt).toISOString()}, ${edition.lines.length} item(s)`);
      console.log('');
      for (const line of edition.lines) {
        console.log(`${line.rank}. ${line.title}  [${line.sourceName}]`);
        console.log(`   ${line.url}`);
        if (line.summary) console.log(`   ${line.summary}`);
        console.log('');
      }
    }
    return;
  }

  const dry = args.dry === true;
  const force = args.force === true;

  console.log('');
  console.log(`times: ${config.briefing.schedule.times.join(', ')} (${config.briefing.schedule.timezone})`);
  printTable(
    recentSlots(config.briefing, Date.now()).map((slot) => ({
      slot: slot.time,
      label: slot.label,
      local_day: slot.localDay,
      due: new Date(slot.scheduledFor).toISOString(),
      late_minutes: Math.round(slot.latenessMinutes),
    })),
  );

  // A dry run reads and writes nothing, so it does not need to wait behind a
  // pipeline run that may take minutes.
  const result = dry
    ? runBriefing(db, config, { dry, force })
    : await withLock(config.env.dbPath, 'briefing', async () => {
        const job = startJob(db, 'briefing');
        try {
          const outcome = runBriefing(db, config, { force });
          job.finish({
            built: outcome.built,
            slot: outcome.slot,
            items: outcome.selected,
            candidates: outcome.candidates,
            reason: outcome.reason,
          });
          return outcome;
        } catch (error) {
          job.fail(error);
          throw error;
        }
      });

  console.log('');
  console.log(result.reason);
  console.log(
    `candidates in window: ${result.candidates} · cleared the bar: ${result.eligible} · selected: ${result.selected}`,
  );

  if (result.lines.length > 0) {
    console.log('');
    printTable(
      result.lines.map((line) => ({
        n: line.rank,
        score: line.score.toFixed(3),
        title: line.title,
        source: line.sourceName,
        summary_from: line.summarySource,
        summary: line.summary,
        url: line.url,
      })),
    );
  }

  if (args.html === true && result.lines.length > 0) {
    console.log('');
    console.log('--- as it will render in a reader ---');
    console.log(
      briefingEntryHtml(
        {
          id: 'preview',
          feedId: config.briefing.feed.id,
          localDay: result.localDay ?? '',
          slot: result.slot ?? '',
          slotLabel: '',
          scheduledFor: Date.now(),
          publishedAt: Date.now(),
          windowStart: 0,
          lines: result.lines,
        },
        // Untracked, so the preview shows the publisher URLs rather than
        // /open redirects that only resolve while the feed server is up.
        { tracked: false, publicUrl: config.env.publicUrl, accessToken: '' },
      ),
    );
  }
});
