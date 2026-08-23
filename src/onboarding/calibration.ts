import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { stableId } from '../util/hash.js';
import {
  atomicWrite,
  readOnboardingState,
  readTasteProfile,
  writeOnboardingState,
  writeTasteProfile,
} from './index.js';

export type RankedCalibrationLabel = 'glad' | 'fine' | 'not_for_me' | 'not_read';

export interface RankedCalibrationItem {
  item_id: string;
  title: string;
  url: string | null;
  source: string;
  why_it_surfaced: string | null;
  score: number;
  published_at: number;
}

export const rankedCalibrationAnswersSchema = z.object({
  version: z.literal(2).default(2),
  answers: z.array(z.object({
    item_id: z.string().min(1),
    label: z.enum(['glad', 'fine', 'not_for_me', 'not_read']),
  })).min(1),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const answer of value.answers) {
    if (seen.has(answer.item_id)) ctx.addIssue({ code: 'custom', message: `Duplicate item: ${answer.item_id}` });
    seen.add(answer.item_id);
  }
  if (!value.answers.some((answer) => answer.label !== 'not_read')) {
    ctx.addIssue({ code: 'custom', message: 'Rate at least one article before saving calibration.' });
  }
});

export type RankedCalibrationAnswers = z.infer<typeof rankedCalibrationAnswersSchema>;

/** Real recommendations only: premise cards proved too abstract to produce
 * reliable labels. The newest unique placements are concrete things the reader
 * can open, read, and judge. */
export function rankedCalibrationItems(db: DatabaseSync, limit = 12): RankedCalibrationItem[] {
  return db.prepare(
    `SELECT fi.id AS item_id,
            fi.title,
            COALESCE(fi.canonical_url, fi.original_url) AS url,
            COALESCE(s.name, fi.source_id) AS source,
            MAX(p.why_it_surfaced) AS why_it_surfaced,
            MAX(p.score) AS score,
            MAX(p.published_at) AS published_at
     FROM published_feed_items p
     JOIN feed_items fi ON fi.id = p.item_id
     LEFT JOIN sources s ON s.id = fi.source_id
     GROUP BY fi.id, fi.title, fi.canonical_url, fi.original_url, s.name, fi.source_id
     ORDER BY MAX(p.published_at) DESC, MAX(p.score) DESC
     LIMIT :limit`,
  ).all({ limit }) as unknown as RankedCalibrationItem[];
}

export function parseRankedCalibrationAnswers(raw: string): RankedCalibrationAnswers {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Calibration file is not valid JSON: ${(error as Error).message}`);
  }
  return rankedCalibrationAnswersSchema.parse(data);
}

export function applyRankedCalibration(
  profileDir: string,
  db: DatabaseSync,
  input: RankedCalibrationAnswers,
  now = new Date(),
): void {
  const answers = rankedCalibrationAnswersSchema.parse(input);
  const items = rankedCalibrationItems(db, 100);
  const itemById = new Map(items.map((item) => [item.item_id, item]));
  for (const answer of answers.answers) {
    if (!itemById.has(answer.item_id)) throw new Error(`Article is not a ranked Sift recommendation: ${answer.item_id}`);
  }

  const taste = readTasteProfile(profileDir);
  const calibrationReason = 'Calibration on a real ranked article:';
  taste.positive_examples = taste.positive_examples.filter((item) => !item.reason.startsWith(calibrationReason));
  taste.negative_examples = taste.negative_examples.filter((item) => !item.reason.startsWith(calibrationReason));

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM explicit_feedback WHERE origin = 'admin' AND matched_by = 'calibration'`).run();
    for (const answer of answers.answers) {
      if (answer.label === 'not_read' || answer.label === 'fine') continue;
      const signal = answer.label === 'glad' ? 'excellent' : 'not_for_me';
      db.prepare(
        `INSERT INTO explicit_feedback (id, item_id, signal, origin, matched_by, note, created_at)
         VALUES (:id, :item, :signal, 'admin', 'calibration', :note, :created)
         ON CONFLICT(id) DO UPDATE SET signal = excluded.signal, note = excluded.note, created_at = excluded.created_at`,
      ).run({
        id: stableId('feedback', 'calibration', answer.item_id),
        item: answer.item_id,
        signal,
        note: 'Rated during optional real-article calibration.',
        created: now.getTime(),
      });
      const item = itemById.get(answer.item_id)!;
      const example = {
        description: `${item.title} — ${item.source}`,
        reason: `${calibrationReason} ${answer.label === 'glad' ? 'glad I read it' : 'not worth my time'}.`,
      };
      if (answer.label === 'glad') taste.positive_examples.push(example);
      else taste.negative_examples.push(example);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  writeTasteProfile(profileDir, taste);
  const state = readOnboardingState(profileDir);
  state.calibration = 'completed';
  state.calibration_completed_at = now.toISOString();
  writeOnboardingState(profileDir, state);
  atomicWrite(resolve(profileDir, 'calibration.json'), `${JSON.stringify({
    ...answers,
    completed_at: now.toISOString(),
  }, null, 2)}\n`);
}

export function skipCalibration(profileDir: string): void {
  const state = readOnboardingState(profileDir);
  state.calibration = 'skipped';
  writeOnboardingState(profileDir, state);
}

export function loadRankedCalibrationFile(path: string): RankedCalibrationAnswers {
  if (!existsSync(path)) throw new Error(`Calibration file not found: ${path}`);
  return parseRankedCalibrationAnswers(readFileSync(path, 'utf8'));
}
