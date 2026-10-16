const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Infinity],
];

/** "5 minutes ago", "yesterday". */
export function ago(iso: string, now = Date.now()): string {
  let value = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return relative.format(Math.round(value), "year");
}

/** github.com/owner/name for a GitHub remote, else the remote as it is. */
export function remoteLabel(remote: string): string {
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `github.com/${m[1]}` : remote;
}

/**
 * A date in story time, as story time shows dates everywhere (the Timeline, the diagrams exported to
 * GitHub): "2 Nov 2009", or "2 Nov 2009, 23:00" with a time. Not the reader's locale: it's the book's.
 */
export function storyDate(at: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(at);
  const t = m && Date.parse(`${m[1]}T00:00:00Z`);
  if (!m || !t || Number.isNaN(t)) return at;
  const day = new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return m[2] ? `${day}, ${m[2]}` : day;
}

const calendarDay = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

/** A day in the writer's world (when a note was made), in their locale: "Oct 15, 2026". */
export function realDay(iso: string): string {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? iso : calendarDay.format(t);
}
