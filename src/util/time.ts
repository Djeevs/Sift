export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Parse the many date formats feeds use in practice. Returns epoch ms or null. */
export function parseDate(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const raw = String(input).trim();
  if (!raw) return null;

  const trimmed = raw.replace(/\s*\([^)]*\)\s*$/, '');

  // Timezone-less timestamps are checked first and pinned to UTC. Left to
  // Date.parse they would be read as *server local time*, which would make
  // ingestion results depend on where the process happens to run.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0);

  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (d) return Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!);

  const direct = Date.parse(raw);
  if (!Number.isNaN(direct)) return direct;

  // "Mon, 4 Nov 2024 10:00:00 GMT+0000 (UTC)" and similar trailing junk.
  const second = Date.parse(trimmed);
  if (!Number.isNaN(second)) return second;

  // "19 August 2026 - 12:50" / "19 August 2026" -- NL Times and other CMSes
  // emit human-readable pubDates that no standard parser accepts.
  const human =
    /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})(?:\s*[-,]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(trimmed);
  if (human) {
    const month = MONTHS[human[2]!.toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      return Date.UTC(
        +human[3]!,
        month,
        +human[1]!,
        human[4] ? +human[4] : 0,
        human[5] ? +human[5] : 0,
        human[6] ? +human[6] : 0,
      );
    }
  }

  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** RFC-822 date, required by RSS 2.0. */
export function toRfc822(ms: number): string {
  return new Date(ms).toUTCString();
}

/** UTC day key, used for daily caps. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** "42 min" / "1 hr 5 min" -- used for the listen-instead line. */
export function humanMinutes(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Parse a podcast duration ("42:10", "01:02:03", "2530") into minutes. */
export function durationToMinutes(input: unknown): number | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const secs = Number(raw);
    return secs > 0 ? Math.round(secs / 60) : null;
  }
  const parts = raw.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs > 0 ? Math.round(secs / 60) : null;
}
