import type { BriefingConfig } from '../config/index.js';
import { DAY_MS } from '../util/time.js';

/**
 * When a briefing is due.
 *
 * Pure functions: no database, no clock of their own. The briefing is the one
 * part of Sift that cares what time it is where the reader is, so all of that
 * reasoning lives here where it can be tested against a fixed `now`.
 */

export interface BriefingSlot {
  /** Stable per-time identifier, e.g. "0800". Part of the edition's key. */
  id: string;
  /** The configured wall-clock time, "HH:MM". */
  time: string;
  /** "Morning" / "Afternoon" / "Evening", for the entry title. */
  label: string;
  /** Local calendar day this occurrence belongs to, "YYYY-MM-DD". */
  localDay: string;
  /** When the slot was due, as epoch ms. */
  scheduledFor: number;
  /** How late a run is discovering it, in minutes. */
  latenessMinutes: number;
}

const WALL_CLOCK_PARTS = ['year', 'month', 'day', 'hour', 'minute'] as const;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The wall clock in the reader's zone at a given instant.
 *
 * `Intl` is the only correct way to do this without a timezone database of our
 * own, and it goes one direction only: instant to wall clock. Everything below
 * is arranged so that is the only direction needed.
 */
export function wallClockAt(ms: number, timezone: string): WallClock {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (timezone !== 'local') options.timeZone = timezone;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(new Date(ms));
  } catch {
    // An unresolvable zone must not stop the pipeline: fall back to the host
    // clock, which is what `local` would have used anyway.
    delete options.timeZone;
    parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(new Date(ms));
  }

  const found = new Map(parts.map((part) => [part.type, part.value]));
  const read = (key: (typeof WALL_CLOCK_PARTS)[number]): number => Number(found.get(key) ?? '0');
  // "24:00" is a legal formatToParts hour for midnight in some ICU versions.
  const hour = read('hour') % 24;
  return { year: read('year'), month: read('month'), day: read('day'), hour, minute: read('minute') };
}

function dayString(clock: Pick<WallClock, 'year' | 'month' | 'day'>): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`;
}

/** The calendar day before a "YYYY-MM-DD" string. */
export function previousDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  // Calendar arithmetic on a date alone, so no timezone or DST is involved.
  return new Date(Date.UTC(year, month - 1, date) - DAY_MS).toISOString().slice(0, 10);
}

export function slotIdFor(time: string): string {
  return time.replace(':', '');
}

export function slotLabelFor(time: string): string {
  const hour = Number(time.slice(0, 2));
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

/**
 * Every configured slot occurrence at or before `now`, most recent first.
 *
 * Lateness is measured in elapsed minutes from the wall-clock difference rather
 * than by converting a local time back to an instant. That avoids the ambiguous
 * and non-existent local times a DST change produces -- 02:30 happens twice in
 * autumn and never in spring, and a briefing must not be published twice or
 * skipped because of it. The cost is that on the two changeover days a slot's
 * recorded `scheduledFor` can be an hour out; nothing downstream depends on it
 * more precisely than `max_lateness_minutes`, which is measured in hours.
 */
export function recentSlots(config: BriefingConfig, now: number): BriefingSlot[] {
  const { times, timezone } = config.schedule;
  const clock = wallClockAt(now, timezone);
  const today = dayString(clock);
  const yesterday = previousDay(today);
  const nowMinutes = clock.hour * 60 + clock.minute;

  const slots = times.map((time) => {
    const [hour, minute] = time.split(':').map(Number) as [number, number];
    const slotMinutes = hour * 60 + minute;
    const sameDay = slotMinutes <= nowMinutes;
    const latenessMinutes = sameDay ? nowMinutes - slotMinutes : nowMinutes + (1440 - slotMinutes);
    return {
      id: slotIdFor(time),
      time,
      label: slotLabelFor(time),
      localDay: sameDay ? today : yesterday,
      scheduledFor: now - latenessMinutes * 60_000,
      latenessMinutes,
    };
  });

  return slots.sort((a, b) => a.latenessMinutes - b.latenessMinutes);
}

export interface DueSlot {
  slot: BriefingSlot | null;
  /** Why nothing is due, for the log and for `npm run briefing`. */
  reason: string;
}

/**
 * The slot this run should build, if any.
 *
 * Only the most recent occurrence is ever considered. Catching up on older
 * slots was tempting and is wrong: a Mac that slept through the weekend would
 * wake and deliver four briefings at once, each a stale digest of a window that
 * has since been summarised by the next one.
 */
export function dueSlot(
  config: BriefingConfig,
  now: number,
  hasEdition: (slot: BriefingSlot) => boolean,
): DueSlot {
  const slots = recentSlots(config, now);
  const slot = slots[0];
  if (!slot) return { slot: null, reason: 'no briefing times are configured' };
  if (hasEdition(slot)) {
    return { slot: null, reason: `the ${slot.time} briefing for ${slot.localDay} was already published` };
  }
  if (slot.latenessMinutes > config.schedule.max_lateness_minutes) {
    return {
      slot: null,
      reason:
        `the ${slot.time} briefing for ${slot.localDay} is ${Math.round(slot.latenessMinutes / 60)}h late ` +
        `(limit ${Math.round(config.schedule.max_lateness_minutes / 60)}h), so it was skipped rather than published stale`,
    };
  }
  return { slot, reason: `the ${slot.time} briefing for ${slot.localDay} is due` };
}
