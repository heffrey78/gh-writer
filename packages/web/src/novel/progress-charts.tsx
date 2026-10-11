import { addDays, countWords, unbalanced, type Novel, type WritingDay } from "@gh-writer/core";
import { chapterTitle } from "@gh-writer/core/diagrams";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../ui/cn.ts";

/*
 * Progress charts (#20): words added and cut per day, the book's length over time, and the length
 * of each chapter and its scenes. Inline SVG in the theme's tokens (--ghw-series-1/2, validated for
 * colour vision and contrast in both themes); each with a tooltip on hover and on the arrow keys,
 * and a table that says everything the chart does.
 */

const number = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDay = (day: string, f = shortDay) => f.format(new Date(`${day}T00:00:00Z`));

const SERIES_1 = "var(--ghw-series-1)";
const SERIES_2 = "var(--ghw-series-2)";
const GRID = "var(--ghw-rule)";
const SURFACE = "var(--ghw-raised)";

type Range = "30" | "90" | "all";
const RANGES: { key: Range; label: string }[] = [
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "all", label: "All" },
];

/** The width the chart has, as it changes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry!.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A clean step (1, 2 or 5 times a power of ten) for about `count` ticks up to `max`. */
function niceStep(max: number, count = 4): number {
  if (max <= 0) return 1;
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
}

/** A column with a 4px rounded data end, square at the baseline, rising (or falling) from `base`. */
function column(x: number, w: number, base: number, h: number, up: boolean): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  const end = up ? base - h : base + h;
  const toward = up ? r : -r;
  return `M${x},${base}V${end + toward}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + toward}V${base}Z`;
}

export function ProgressCharts({ days, words, target, novel, today }: { days: WritingDay[]; words: number; target: { words?: number; date?: string } | null; novel: Novel; today: string }) {
  const [range, setRange] = useState<Range>("30");
  const first = days[0]?.day ?? today;
  const start = range === "all" ? (first < today ? first : today) : addDays(today, -(Number(range) - 1));
  // Every day in the range, with or without writing, the book's length carried over quiet days.
  const series = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    let length = [...days].reverse().find((d) => d.day < start)?.words ?? 0;
    const out: { day: string; added: number; removed: number; words: number }[] = [];
    for (let day = start; day <= today; day = addDays(day, 1)) {
      const d = byDay.get(day);
      if (d) length = d.words;
      out.push({ day, added: d?.added ?? 0, removed: d?.removed ?? 0, words: length });
    }
    // Today's length is the book's now, even before today's first commit.
    if (out.length) out[out.length - 1]!.words = words;
    return out;
  }, [days, start, today, words]);
  const rangeId = useId();

  return (
    <div className="grid gap-6">
      <div role="radiogroup" aria-labelledby={rangeId} className="flex flex-wrap items-center gap-2 text-sm">
        <span id={rangeId} className="text-muted">
          Show
        </span>
        <div className="inline-flex rounded-md border border-rule bg-raised p-0.5">
          {RANGES.map((r) => (
            <label key={r.key} className={cn("cursor-pointer rounded px-3 py-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent", range === r.key ? "bg-accent-soft font-medium" : "text-muted hover:text-ink")}>
              <input type="radio" name="progress-range" value={r.key} checked={range === r.key} onChange={() => setRange(r.key)} className="sr-only" />
              {r.label}
            </label>
          ))}
        </div>
      </div>
      <WordsPerDay series={series} />
      <BookLength series={series} target={target} />
      <ChapterLengths novel={novel} />
    </div>
  );
}

function Card({ title, caption, children, table }: { title: string; caption: ReactNode; children: ReactNode; table: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-3 rounded-md border border-rule bg-raised p-4">
      <div>
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted">{caption}</p>
      </div>
      {children}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">As a table</summary>
        <div className="mt-2 max-h-80 overflow-auto">{table}</div>
      </details>
    </section>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  // Kept inside the chart: flipped to the left of the pointer near the right edge.
  const left = x > width - 180 ? x - 172 : x + 12;
  return (
    <div className="pointer-events-none absolute z-10 grid min-w-36 gap-0.5 rounded-md border border-rule bg-raised px-3 py-2 text-xs shadow-lg" style={{ left, top: Math.max(0, y - 10) }}>
      {children}
    </div>
  );
}

function Key({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={line ? "inline-block h-0.5 w-3 rounded" : "inline-block size-2.5 rounded-sm"} style={{ background: color }} />
      {label}
    </span>
  );
}

/** Left and right arrows (Home, End) move the reading along the marks; the pointer does the same. */
function useReading(count: number) {
  const [active, setActive] = useState<number>();
  const onKeyDown = (e: KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowRight: (active ?? -1) + 1, ArrowLeft: (active ?? count) - 1, Home: 0, End: count - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(count - 1, to)));
  };
  return { active, setActive, onKeyDown, onBlur: () => setActive(undefined) };
}

const M = { top: 12, right: 16, bottom: 26, left: 44 };

function WordsPerDay({ series }: { series: { day: string; added: number; removed: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = 220;
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const maxAdded = Math.max(0, ...series.map((d) => d.added));
  const maxRemoved = Math.max(0, ...series.map((d) => d.removed));
  const step = niceStep(Math.max(maxAdded, maxRemoved, 1), maxRemoved ? 3 : 4);
  const up = Math.max(step, Math.ceil(maxAdded / step) * step);
  // Below the line, only the room the cuts take (with a little air): a small cut doesn't cost a whole step.
  const down = maxRemoved ? maxRemoved * 1.15 : 0;
  const scale = plotH / (up + down);
  const base = M.top + up * scale;
  const band = plotW / Math.max(1, series.length);
  const barW = Math.max(1, Math.min(24, band * 0.7));
  const reading = useReading(series.length);
  const ticks: number[] = [];
  for (let v = -Math.floor(down / step) * step || 0; v <= up; v += step) ticks.push(v);
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(plotW / 70))));
  const totals = series.reduce((t, d) => ({ added: t.added + d.added, removed: t.removed + d.removed }), { added: 0, removed: 0 });
  const active = reading.active !== undefined ? series[reading.active] : undefined;
  const x = (i: number) => M.left + band * i + (band - barW) / 2;

  return (
    <Card
      title="Words per day"
      caption={`${number.format(totals.added)} added and ${number.format(totals.removed)} cut over these ${series.length} days. Above the line, words added; below it, words cut.`}
      table={
        <DayTable rows={series.filter((d) => d.added || d.removed)} columns={[["Added", (d) => d.added], ["Cut", (d) => d.removed], ["Net", (d) => d.added - d.removed]]} />
      }
    >
      <div className="flex gap-4 text-xs text-muted">
        <Key color={SERIES_1} label="Words added" />
        <Key color={SERIES_2} label="Words cut" />
      </div>
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label="Words added and cut each day. Arrow keys read the days."
          className="rounded outline-none focus-visible:outline-2 focus-visible:outline-accent"
          onKeyDown={reading.onKeyDown}
          onBlur={reading.onBlur}
          onPointerLeave={() => reading.setActive(undefined)}
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const i = Math.floor((e.clientX - box.left - M.left) / band);
            reading.setActive(i >= 0 && i < series.length ? i : undefined);
          }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={base - v * scale} y2={base - v * scale} stroke={GRID} strokeWidth={1} />
              <text x={M.left - 6} y={base - v * scale} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                {v < 0 ? `−${compact.format(-v)}` : compact.format(v)}
              </text>
            </g>
          ))}
          {reading.active !== undefined && <rect x={M.left + band * reading.active} y={M.top} width={band} height={plotH} className="fill-ink/5" />}
          {series.map((d, i) => (
            <g key={d.day}>
              <path d={column(x(i), barW, base - 1, d.added * scale - 1, true)} fill={SERIES_1} />
              <path d={column(x(i), barW, base + 1, d.removed * scale - 1, false)} fill={SERIES_2} />
            </g>
          ))}
          {series.map((d, i) =>
            i % labelEvery === 0 || i === series.length - 1 ? (
              <text key={d.day} x={M.left + band * (i + 0.5)} y={height - 8} textAnchor="middle" className="fill-muted text-[11px]">
                {fmtDay(d.day)}
              </text>
            ) : null,
          )}
        </svg>
        {active && reading.active !== undefined && (
          <Tooltip x={M.left + band * (reading.active + 0.5)} y={M.top} width={width}>
            <span className="text-muted">{fmtDay(active.day, longDay)}</span>
            <span>
              <strong className="text-sm">{number.format(active.added)}</strong> <Key color={SERIES_1} label="added" line />
            </span>
            <span>
              <strong className="text-sm">{number.format(active.removed)}</strong> <Key color={SERIES_2} label="cut" line />
            </span>
          </Tooltip>
        )}
        <p className="sr-only" aria-live="polite">
          {active ? `${fmtDay(active.day, longDay)}: ${number.format(active.added)} added, ${number.format(active.removed)} cut.` : ""}
        </p>
      </div>
    </Card>
  );
}

function BookLength({ series, target }: { series: { day: string; words: number }[]; target: { words?: number; date?: string } | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = 220;
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const longest = Math.max(1, ...series.map((d) => d.words));
  // A target far beyond the book would flatten its line: then the scale is the book's, and the caption says where the target is.
  const targetOnScale = !!target?.words && target.words <= longest * 4;
  const maxWords = Math.max(longest, targetOnScale ? target!.words! : 0);
  const step = niceStep(maxWords);
  const top = Math.ceil(maxWords / step) * step;
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  const n = series.length;
  const x = (i: number) => M.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const reading = useReading(n);
  const line = series.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.words)}`).join("");
  const area = n ? `${line}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z` : "";
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const last = series.at(-1);
  const active = reading.active !== undefined ? series[reading.active] : undefined;
  const deadline = target?.date && series.length && target.date >= series[0]!.day && target.date <= series.at(-1)!.day ? series.findIndex((d) => d.day === target.date) : -1;

  return (
    <Card
      title="Length of the book"
      caption={
        target?.words
          ? `${number.format(last?.words ?? 0)} words of ${number.format(target.words)}${target.date ? `, by ${fmtDay(target.date, longDay)}` : ""}. The line is the length at the end of each day${targetOnScale ? "" : "; the target is far above this scale"}.`
          : `${number.format(last?.words ?? 0)} words. The line is the length at the end of each day.`
      }
      table={<DayTable rows={series.filter((d, i) => i === 0 || d.words !== series[i - 1]!.words)} columns={[["Words", (d) => d.words]]} />}
    >
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label="The book's length at the end of each day. Arrow keys read the days."
          className="rounded outline-none focus-visible:outline-2 focus-visible:outline-accent"
          onKeyDown={reading.onKeyDown}
          onBlur={reading.onBlur}
          onPointerLeave={() => reading.setActive(undefined)}
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const i = n === 1 ? 0 : Math.round(((e.clientX - box.left - M.left) / plotW) * (n - 1));
            reading.setActive(i >= 0 && i < n ? i : undefined);
          }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
              <text x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                {compact.format(v)}
              </text>
            </g>
          ))}
          {target?.words && targetOnScale ? (
            <g>
              <line x1={M.left} x2={width - M.right} y1={y(target.words)} y2={y(target.words)} className="stroke-muted" strokeWidth={1} />
              <text x={M.left + 4} y={y(target.words) - 4} className="fill-muted text-[11px]">
                Target {number.format(target.words)}
              </text>
            </g>
          ) : null}
          {deadline >= 0 && (
            <g>
              <line x1={x(deadline)} x2={x(deadline)} y1={M.top} y2={M.top + plotH} className="stroke-muted" strokeWidth={1} />
              <text x={x(deadline) - 4} y={M.top + 10} textAnchor="end" className="fill-muted text-[11px]">
                Deadline
              </text>
            </g>
          )}
          <path d={area} fill={SERIES_1} opacity={0.1} />
          <path d={line} fill="none" stroke={SERIES_1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {reading.active !== undefined && <line x1={x(reading.active)} x2={x(reading.active)} y1={M.top} y2={M.top + plotH} className="stroke-muted" strokeWidth={1} />}
          {last && (
            <g>
              <circle cx={x(n - 1)} cy={y(last.words)} r={4} fill={SERIES_1} stroke={SURFACE} strokeWidth={2} />
              <text x={x(n - 1) - 8} y={y(last.words) - 10} textAnchor="end" className="fill-ink text-[11px] font-medium tabular-nums">
                {number.format(last.words)}
              </text>
            </g>
          )}
          {active && reading.active !== undefined && <circle cx={x(reading.active)} cy={y(active.words)} r={4} fill={SERIES_1} stroke={SURFACE} strokeWidth={2} />}
          {series.map((d, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={d.day} x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-muted text-[11px]">
                {fmtDay(d.day)}
              </text>
            ) : null,
          )}
        </svg>
        {active && reading.active !== undefined && (
          <Tooltip x={x(reading.active)} y={y(active.words)} width={width}>
            <span className="text-muted">{fmtDay(active.day, longDay)}</span>
            <span>
              <strong className="text-sm">{number.format(active.words)}</strong> words
            </span>
          </Tooltip>
        )}
        <p className="sr-only" aria-live="polite">
          {active ? `${fmtDay(active.day, longDay)}: ${number.format(active.words)} words.` : ""}
        </p>
      </div>
    </Card>
  );
}

function ChapterLengths({ novel }: { novel: Novel }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const chapters = useMemo(
    () =>
      novel.chapters.map((c) => {
        const scenes = c.sceneIds.map((id) => novel.allScenes.find((s) => s.id === id)).filter((s) => s !== undefined).map((s) => ({ id: s.id, title: s.title, words: countWords(s.body) }));
        return { id: c.id, title: chapterTitle(novel, c), scenes, words: scenes.reduce((n, s) => n + s.words, 0) };
      }),
    [novel],
  );
  const scenes = chapters.flatMap((c) => c.scenes.map((s) => ({ ...s, chapter: c.title })));
  const byChapter = unbalanced(chapters);
  const byScene = unbalanced(scenes);
  const label = Math.min(180, Math.max(100, width * 0.28));
  const row = 28;
  const barH = 16;
  const right = 56;
  const height = M.top + 6 + chapters.length * row + 8;
  const plotW = width - label - right;
  const max = Math.max(1, ...chapters.map((c) => c.words));
  const scale = plotW / max;
  const reading = useReading(scenes.length);
  const active = reading.active !== undefined ? scenes[reading.active] : undefined;
  // Where each scene's segment is, for the tooltip and the reading.
  const segments = chapters.flatMap((c, ci) => {
    let x = label;
    return c.scenes.map((s, si) => {
      const w = Math.max(0, s.words * scale - (si < c.scenes.length - 1 ? 2 : 0));
      const seg = { id: s.id, x, y: M.top + 6 + ci * row + (row - barH) / 2, w, last: si === c.scenes.length - 1 };
      x += s.words * scale;
      return seg;
    });
  });
  const segment = (id: string | undefined) => segments.find((g) => g.id === id);
  const list = (items: { title: string; words: number }[]) => items.map((i) => `${i.title} (${number.format(i.words)})`).join(", ");
  const notes = [
    byChapter.long.length && `Long chapters: ${list(byChapter.long)}.`,
    byChapter.short.length && `Short chapters: ${list(byChapter.short)}.`,
    byScene.long.length && `Long scenes: ${list(byScene.long)}.`,
    byScene.short.length && `Short scenes: ${list(byScene.short)}.`,
  ].filter(Boolean) as string[];

  return (
    <Card
      title="Chapters and their scenes"
      caption={`Each bar is a chapter, divided into its scenes. A chapter's median is ${number.format(Math.round(byChapter.median))} words, a scene's ${number.format(Math.round(byScene.median))}.`}
      table={
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Chapter
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Scene
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Words
              </th>
            </tr>
          </thead>
          <tbody>
            {chapters.flatMap((c) =>
              c.scenes.map((s, i) => (
                <tr key={s.id} className="border-t border-rule">
                  <td className="py-1 pr-3">{i === 0 ? `${c.title} (${number.format(c.words)})` : ""}</td>
                  <td className="py-1 pr-3">{s.title}</td>
                  <td className="py-1 text-right tabular-nums">{number.format(s.words)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      }
    >
      <p className="text-sm" role="note">
        {notes.length ? notes.join(" ") : "No chapter or scene stands out as much longer or shorter than the rest."} <span className="text-muted">(Long: over half again the median; short: under half of it.)</span>
      </p>
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label="Each chapter's length, divided into its scenes. Arrow keys read the scenes."
          className="rounded outline-none focus-visible:outline-2 focus-visible:outline-accent"
          onKeyDown={reading.onKeyDown}
          onBlur={reading.onBlur}
          onPointerLeave={() => reading.setActive(undefined)}
        >
          <line x1={label + byChapter.median * scale} x2={label + byChapter.median * scale} y1={M.top - 2} y2={height - 4} stroke={GRID} strokeWidth={1} />
          <text x={label + byChapter.median * scale} y={M.top - 4} textAnchor="middle" className="fill-muted text-[10px]">
            median
          </text>
          {chapters.map((c, ci) => (
            <g key={c.id}>
              <text x={label - 8} y={M.top + 6 + ci * row + row / 2} dy="0.32em" textAnchor="end" className="fill-ink text-[12px]">
                {c.title.length > 22 ? `${c.title.slice(0, 21)}…` : c.title}
              </text>
              <text x={label + c.words * scale + 6} y={M.top + 6 + ci * row + row / 2} dy="0.32em" className="fill-muted text-[11px] tabular-nums">
                {number.format(c.words)}
              </text>
            </g>
          ))}
          {segments.map((g, i) => (
            <path
              key={g.id}
              d={g.last ? barRight(g.x, g.y, g.w, barH) : `M${g.x},${g.y}h${g.w}v${barH}h${-g.w}Z`}
              fill={SERIES_1}
              opacity={reading.active === undefined || reading.active === i ? 1 : 0.55}
              onPointerEnter={() => reading.setActive(i)}
            />
          ))}
        </svg>
        {active && segment(active.id) && (
          <Tooltip x={segment(active.id)!.x + segment(active.id)!.w / 2} y={segment(active.id)!.y + barH} width={width}>
            <span className="text-muted">{active.chapter}</span>
            <span>
              <strong className="text-sm">{number.format(active.words)}</strong> {active.title}
            </span>
          </Tooltip>
        )}
        <p className="sr-only" aria-live="polite">
          {active ? `${active.title}, in ${active.chapter}: ${number.format(active.words)} words.` : ""}
        </p>
      </div>
    </Card>
  );
}

/** A horizontal bar's last segment: its data end (the right) rounded 4px, square where it starts. */
function barRight(x: number, y: number, w: number, h: number): string {
  if (w <= 0) return "";
  const r = Math.min(4, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

/** Days as a table, newest first. */
function DayTable<T extends { day: string }>({ rows, columns }: { rows: T[]; columns: [string, (row: T) => number][] }) {
  if (!rows.length) return <p className="text-muted">No writing in these days.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-muted">
        <tr>
          <th scope="col" className="py-1 pr-3 font-medium">
            Day
          </th>
          {columns.map(([name]) => (
            <th key={name} scope="col" className="py-1 pl-3 text-right font-medium">
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...rows].reverse().map((r) => (
          <tr key={r.day} className="border-t border-rule">
            <td className="py-1 pr-3">{fmtDay(r.day, longDay)}</td>
            {columns.map(([name, value]) => (
              <td key={name} className="py-1 pl-3 text-right tabular-nums">
                {number.format(value(r))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
