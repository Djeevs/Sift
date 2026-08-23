import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { initDb } from '../db/index.js';
import { loadConfig, PROJECT_ROOT } from '../config/index.js';
import { loadEnvFile, parseArgs } from './_bootstrap.js';
import { profileDirectory } from '../onboarding/index.js';
import {
  applyRankedCalibration,
  loadRankedCalibrationFile,
  rankedCalibrationItems,
  skipCalibration,
  type RankedCalibrationAnswers,
  type RankedCalibrationItem,
  type RankedCalibrationLabel,
} from '../onboarding/calibration.js';

async function ask(items: RankedCalibrationItem[]): Promise<RankedCalibrationAnswers | null> {
  const rl = createInterface({ input, output });
  try {
    const answers: RankedCalibrationAnswers['answers'] = [];
    console.log('Rate real Sift recommendations: 1 = glad I read it, 2 = fine, 3 = not for me, 4 = not read. Type skip to stop.');
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      let label: RankedCalibrationLabel | null = null;
      while (!label) {
        console.log(`\n${index + 1}/${items.length}  ${item.title}`);
        console.log(`Source: ${item.source}${item.url ? `\n${item.url}` : ''}`);
        if (item.why_it_surfaced) console.log(`Why Sift chose it: ${item.why_it_surfaced}`);
        const value = (await rl.question('Your label [1/2/3/4]: ')).trim().toLowerCase();
        if (value === 'skip') return null;
        label = value === '1' ? 'glad' : value === '2' ? 'fine' : value === '3' ? 'not_for_me' : value === '4' ? 'not_read' : null;
      }
      answers.push({ item_id: item.item_id, label });
    }
    return { version: 2, answers };
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  loadEnvFile();
  const args = parseArgs();
  const profileId = typeof args.profile === 'string' ? args.profile : process.env.SIFT_PROFILE;
  if (!profileId) throw new Error('Missing --profile YOUR_NAME');
  const directory = profileDirectory(profileId, PROJECT_ROOT);
  if (args['skip-calibration'] === true) {
    skipCalibration(directory);
    console.log('Calibration skipped. It remains available after Sift has ranked recommendations.');
    return;
  }

  const config = loadConfig({ configDir: directory, reload: true });
  const db = initDb(config.env.dbPath);
  try {
    const items = rankedCalibrationItems(db.raw);
    if (items.length === 0) {
      throw new Error(`No ranked recommendations yet. Run npm run pipeline -- --profile ${profileId}, read a few results, then calibrate.`);
    }
    const answers = typeof args.from === 'string'
      ? loadRankedCalibrationFile(resolve(args.from))
      : input.isTTY
        ? await ask(items)
        : null;
    if (!answers) {
      if (!input.isTTY) throw new Error('Interactive calibration needs a terminal; use --from FILE or --skip-calibration');
      skipCalibration(directory);
      console.log('Calibration skipped. You can run it again later.');
      return;
    }
    applyRankedCalibration(directory, db.raw, answers);
    console.log(`Calibration saved to ${resolve(directory, 'calibration.json')}`);
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
