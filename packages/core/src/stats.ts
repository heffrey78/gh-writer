import { diffSequences } from "./word-diff.ts";
import { markdownWords } from "./words.ts";

/*
 * Writing statistics (#20, D8), from the novel's history: words added and removed by each commit,
 * gathered by day, with the book's length, the daily goal's streak and a projected finish.
 */

// A history's commits each change a paragraph or two of a scene: each paragraph's words are worked out once.
const paragraphs = new Map<string, string[]>();
const PARAGRAPHS = 50_000;

/**
 * The words of a scene body, as markdownWords gives them, paragraph by paragraph (a blank line
 * separates words the same way the whole text would), each paragraph's kept for the next commit.
 */
export function sceneWords(markdown: string): string[] {
  const out: string[] = [];
  for (const paragraph of markdown.split(/\n[ \t]*\n/)) {
    let words = paragraphs.get(paragraph);
    if (!words) {
      words = markdownWords(paragraph);
      if (paragraphs.size >= PARAGRAPHS) paragraphs.clear();
      paragraphs.set(paragraph, words);
    }
    for (const w of words) out.push(w);
  }
  return out;
}

/** Words added and removed between two versions of a scene body (undefined: the scene isn't there). */
export function wordChange(before: string | undefined, after: string | undefined): { added: number; removed: number } {
  const a = before === undefined ? [] : sceneWords(before);
  const b = after === undefined ? [] : sceneWords(after);
  let added = 0;
  let removed = 0;
  for (const run of diffSequences(a, b, 20_000)) {
    if (run.op === "ins") added += run.items.length;
    else if (run.op === "del") removed += run.items.length;
  }
  return { added, removed };
}

/** What one commit did to the manuscript. `date` is its author date, ISO with the author's offset. */
export interface CommitWords {
  commit: string;
  date: string;
  added: number;
  removed: number;
}

/** A day of writing, in the writer's own time zone: words added and removed, and the book's length at its end. */
export interface WritingDay {
  /** YYYY-MM-DD. */
  day: string;
  added: number;
  removed: number;
  net: number;
  words: number;
}

/**
 * The days with writing, in order. Each commit counts on its author's own date. The book's length
 * runs on from each day's net change, ending at `currentWords` (counted directly, so anything the
 * per-commit sums miss, such as a merge's own edits, can't make it drift).
 */
export function writingDays(commits: CommitWords[], currentWords: number): WritingDay[] {
  const byDay = new Map<string, { added: number; removed: number }>();
  for (const c of commits) {
    const day = c.date.slice(0, 10);
    const d = byDay.get(day) ?? { added: 0, removed: 0 };
    d.added += c.added;
    d.removed += c.removed;
    byDay.set(day, d);
  }
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b));
  const total = days.reduce((n, [, d]) => n + d.added - d.removed, 0);
  let words = currentWords - total;
  return days.map(([day, d]) => {
    words += d.added - d.removed;
    return { day, added: d.added, removed: d.removed, net: d.added - d.removed, words };
  });
}

/** `day` moved by `n` days (YYYY-MM-DD, calendar arithmetic). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface Streak {
  /** Days in a row meeting the goal, up to today (or yesterday, while today isn't met yet). */
  current: number;
  best: number;
  /** Words added today, and whether that meets the goal. */
  today: number;
  todayMet: boolean;
}

/** The daily goal's streak: a day counts when the words added that day reach the goal (revising doesn't break it). */
export function streak(days: WritingDay[], goal: number, today: string, unsavedToday = 0): Streak {
  const added = new Map(days.map((d) => [d.day, d.added]));
  added.set(today, (added.get(today) ?? 0) + unsavedToday);
  const met = (day: string) => (added.get(day) ?? 0) >= goal;
  let best = 0;
  let run = 0;
  let previous: string | undefined;
  for (const day of [...added.keys()].sort()) {
    if (!met(day)) {
      run = 0;
      previous = undefined;
      continue;
    }
    run = previous !== undefined && daysBetween(previous, day) === 1 ? run + 1 : 1;
    previous = day;
    best = Math.max(best, run);
  }
  let current = 0;
  for (let day = met(today) ? today : addDays(today, -1); met(day); day = addDays(day, -1)) current++;
  return { current, best, today: added.get(today) ?? 0, todayMet: met(today) };
}

/** How many days the pace is taken over. */
export const PACE_DAYS = 28;

export interface Projection {
  /** Net words a day over the last PACE_DAYS days (today included). */
  pace: number;
  /** Words still to write, or 0 once the target is reached. */
  remaining: number;
  /** When the target is reached at this pace (YYYY-MM-DD); undefined when it never would be (no progress lately) or there's no target. */
  finish?: string;
  /** Against the deadline: days to spare (positive) or late (negative), when there's both a finish and a deadline. */
  spare?: number;
  /** Words a day needed to meet the deadline from today, when there is one still ahead. */
  needed?: number;
}

/** Where the book is heading: the recent pace, the finish it gives, and how it stands against the deadline. */
export function projection(days: WritingDay[], words: number, today: string, target?: { words?: number; date?: string }): Projection {
  const since = addDays(today, -(PACE_DAYS - 1));
  const recent = days.filter((d) => d.day >= since && d.day <= today).reduce((n, d) => n + d.net, 0);
  const pace = recent / PACE_DAYS;
  const remaining = target?.words ? Math.max(0, target.words - words) : 0;
  const out: Projection = { pace, remaining };
  if (!target?.words) return out;
  if (remaining === 0) out.finish = today;
  else if (pace > 0) out.finish = addDays(today, Math.ceil(remaining / pace));
  if (target.date) {
    if (out.finish) out.spare = daysBetween(out.finish, target.date);
    const left = daysBetween(today, target.date) + 1;
    if (left > 0 && remaining > 0) out.needed = Math.ceil(remaining / left);
  }
  return out;
}

/** The middle value (the mean of the middle two for an even count); 0 for none. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** How far from the median a length has to be to stand out: half of it, or half again. */
export const SHORT = 0.5;
export const LONG = 1.5;

/** Parts (chapters, or scenes) unusually long or short against their median: under half of it, or over one and a half times. */
export function unbalanced<T extends { words: number }>(items: T[]): { median: number; long: T[]; short: T[] } {
  const m = median(items.map((i) => i.words));
  // With fewer than three there's no telling what's usual.
  if (items.length < 3 || m === 0) return { median: m, long: [], short: [] };
  return { median: m, long: items.filter((i) => i.words > m * LONG), short: items.filter((i) => i.words < m * SHORT) };
}
