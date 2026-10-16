import { projection, streak, type Novel } from "@gh-writer/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { ProgressCharts } from "./progress-charts.tsx";
import { PAGE } from "../ui/page.ts";

/*
 * Progress (#20): how long the book is against its target, where it's heading at the recent pace,
 * today's words against the daily goal and the streak, all from the novel's history (D8).
 */

const number = new Intl.NumberFormat();
const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const dateOf = (day: string, style = longDate) => style.format(new Date(`${day}T00:00:00Z`));
const plural = (n: number, one: string, many = `${one}s`) => `${number.format(n)} ${n === 1 ? one : many}`;

/** Today, where the writer is: YYYY-MM-DD in local time. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function useStats(novelId: string) {
  return useQuery({ queryKey: keys.stats(novelId), queryFn: () => api.stats(novelId) });
}

export function ProgressPage({ novelId, novel }: { novelId: string; novel: Novel }) {
  const stats = useStats(novelId);
  if (stats.isError) return <Page><ErrorAlert title="Couldn't read the novel's history">{stats.error.message}</ErrorAlert></Page>;
  if (!stats.data) return <Page><p className="text-sm text-muted">Reading the novel's history…</p></Page>;
  const { days, words, target, pending } = stats.data;
  const today = localToday();
  const p = projection(days, words, today, target ?? undefined);
  const daily = target?.daily;
  // Saved work not committed yet counts toward today, as it will once the background commit is made.
  const s = daily ? streak(days, daily, today, pending.added) : undefined;
  const committed = days.find((d) => d.day === today);
  const writtenToday = { added: (committed?.added ?? 0) + pending.added, removed: (committed?.removed ?? 0) + pending.removed };

  return (
    <Page>
      <section aria-label="Length" className="grid gap-3">
        <p className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-5xl font-semibold">{number.format(words)}</span>
          <span className="text-lg text-muted">{target?.words ? `of ${number.format(target.words)} words` : "words"}</span>
        </p>
        {target?.words ? <Meter value={words} max={target.words} label="Length against the target" /> : null}
        <p className="max-w-prose text-sm text-muted">{headline(p, target)}</p>
      </section>

      <section aria-label="At a glance" className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
        <Tile label="Written today" value={number.format(writtenToday?.added ?? 0)} note={daily ? `of ${number.format(daily)} a day${s?.todayMet ? " · goal met" : ""}` : writtenToday?.removed ? `${number.format(writtenToday.removed)} cut` : "words added"}>
          {daily ? <Meter value={writtenToday?.added ?? 0} max={daily} label="Today against the daily goal" small /> : null}
        </Tile>
        <Tile label="Streak" value={s ? plural(s.current, "day") : "—"} note={s ? `best ${plural(s.best, "day")}` : "set a daily goal to keep one"} />
        <Tile label="Pace" value={`${number.format(Math.round(p.pace))} a day`} note="net words, the last four weeks" />
        <Tile label="Finish" value={p.finish ? dateOf(p.finish, shortDate) : "—"} note={finishNote(p, target)} />
      </section>

      <ProgressCharts days={days} words={words} target={target} novel={novel} today={today} />
      <TargetForm novelId={novelId} target={target} />
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className={cn(PAGE, "grid gap-8")}>
      <h1 className="text-xl font-semibold">Progress</h1>
      {children}
    </div>
  );
}

/** The one sentence that says where the book stands. */
function headline(p: ReturnType<typeof projection>, target: { words?: number; date?: string } | null): string {
  if (!target?.words) return "Set a target length below to see when you'll get there at your recent pace.";
  if (p.remaining === 0) return "You've reached your target length.";
  const left = `${number.format(p.remaining)} words to go.`;
  if (!p.finish) return `${left} You haven't added to the book in the last four weeks, so there's no pace to project from yet.`;
  const at = `At your pace of ${number.format(Math.round(p.pace))} words a day over the last four weeks, you'd finish on ${dateOf(p.finish)}`;
  if (target.date === undefined || p.spare === undefined) return `${left} ${at}.`;
  if (p.spare >= 0) return `${left} ${at}, ${plural(p.spare, "day")} before your deadline.`;
  const needed = p.needed ? ` To finish on ${dateOf(target.date)}, write ${number.format(p.needed)} words a day from today.` : "";
  return `${left} ${at}, ${plural(-p.spare, "day")} after your deadline.${needed}`;
}

function finishNote(p: ReturnType<typeof projection>, target: { words?: number; date?: string } | null): string {
  if (!target?.words) return "no target set";
  if (p.remaining === 0) return "target reached";
  if (!p.finish) return "no recent progress";
  if (p.spare === undefined) return "at the recent pace";
  return p.spare >= 0 ? `${plural(p.spare, "day")} to spare` : `${plural(-p.spare, "day")} late`;
}

function Tile({ label, value, note, children }: { label: string; value: string; note: string; children?: ReactNode }) {
  return (
    <div className="grid content-start gap-1 rounded-md border border-rule bg-raised p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {children}
      <p className="text-xs text-muted">{note}</p>
    </div>
  );
}

/** A value against a limit: filled in the accent over a lighter track of the same hue. */
function Meter({ value, max, label, small }: { value: number; max: number; label: string; small?: boolean }) {
  const share = Math.max(0, Math.min(1, value / max));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${number.format(value)} of ${number.format(max)} (${Math.round(share * 100)}%)`}
      className={cn("overflow-hidden rounded-full bg-accent-soft", small ? "h-1.5" : "h-3")}
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

/** The target length, deadline and daily goal, saved in novel.yaml (one commit). */
function TargetForm({ novelId, target }: { novelId: string; target: { words?: number; date?: string; daily?: number } | null }) {
  const queryClient = useQueryClient();
  const [words, setWords] = useState(target?.words?.toString() ?? "");
  const [date, setDate] = useState(target?.date ?? "");
  const [daily, setDaily] = useState(target?.daily?.toString() ?? "");
  const ids = { words: useId(), date: useId(), daily: useId(), heading: useId() };
  const save = useMutation({
    mutationFn: () =>
      api.setTarget(novelId, {
        words: words.trim() ? Number(words) : null,
        date: date || null,
        daily: daily.trim() ? Number(daily) : null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.stats(novelId) });
      void queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
    },
  });
  const changed = words !== (target?.words?.toString() ?? "") || date !== (target?.date ?? "") || daily !== (target?.daily?.toString() ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed && !save.isPending) save.mutate();
  };
  const input = "h-9 rounded-md border border-rule bg-raised px-2";
  return (
    <form onSubmit={submit} aria-labelledby={ids.heading} className="grid gap-3 rounded-md border border-rule p-4 text-sm">
      <h2 id={ids.heading} className="font-semibold">
        Targets
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <label htmlFor={ids.words} className="grid gap-1 font-medium">
          Length
          <input id={ids.words} type="number" min={1} inputMode="numeric" placeholder="90000" value={words} onChange={(e) => setWords(e.target.value)} className={cn(input, "w-32 font-normal")} />
        </label>
        <label htmlFor={ids.date} className="grid gap-1 font-medium">
          By
          <input id={ids.date} type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(input, "font-normal")} />
        </label>
        <label htmlFor={ids.daily} className="grid gap-1 font-medium">
          Words a day
          <input id={ids.daily} type="number" min={1} inputMode="numeric" placeholder="500" value={daily} onChange={(e) => setDaily(e.target.value)} className={cn(input, "w-28 font-normal")} />
        </label>
        <Button type="submit" variant="primary" disabled={!changed || save.isPending}>
          {save.isPending ? "Saving…" : "Save targets"}
        </Button>
      </div>
      <p className="text-xs text-muted">Kept with the book (in novel.yaml), so every computer you write on has them. Leave one empty to have none. A day counts toward the daily goal by the words you add; cutting doesn't count against it.</p>
      {save.isError && <ErrorAlert title="The targets weren't saved">{save.error.message}</ErrorAlert>}
    </form>
  );
}
