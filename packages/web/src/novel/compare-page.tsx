import type { ChapterComparison, ChangeStatus, Checkpoint, Comparison, FieldChange, ParagraphDiff, SceneComparison, Version } from "@gh-writer/client";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useSearchParams } from "react-router";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { useVersions } from "./versions.tsx";

/*
 * Two states of the book side by side (#17): now, any version, any checkpoint. A summary, then every
 * chapter and scene with what changed, a scene's text word by word when opened, and the story bible.
 */

const number = new Intl.NumberFormat();
const signed = (n: number) => (n > 0 ? `+${number.format(n)}` : n < 0 ? `−${number.format(-n)}` : "±0");
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

interface Side {
  value: string;
  label: string;
}

/** What can be compared: now, the versions, the named checkpoints (and, asked for, the automatic ones). */
function sides(versions: Version[] | undefined, checkpoints: Checkpoint[] | undefined): { group: string; options: Side[] }[] {
  const open = versions?.find((v) => v.current);
  return [
    { group: "Now", options: [{ value: "now", label: `Now: ${open?.name ?? "the open version"}, as saved` }] },
    { group: "Versions", options: (versions ?? []).map((v) => ({ value: `version:${v.id}`, label: v.name })) },
    { group: "Checkpoints", options: (checkpoints ?? []).map((c) => ({ value: `checkpoint:${c.id}`, label: `${c.name}${c.auto ? " (automatic)" : ""}, ${dateTime.format(new Date(c.date))}` })) },
  ].filter((g) => g.options.length);
}

/** By default: the main version against now when another is open, else the latest named checkpoint against now. */
function defaults(versions: Version[] | undefined, checkpoints: Checkpoint[] | undefined): { from: string; to: string } {
  const open = versions?.find((v) => v.current);
  if (open && !open.main) return { from: "version:main", to: "now" };
  const named = checkpoints?.find((c) => !c.auto);
  return { from: named ? `checkpoint:${named.id}` : "version:main", to: "now" };
}

export function ComparePage({ novelId }: { novelId: string }) {
  const [params, setParams] = useSearchParams();
  const versions = useVersions(novelId);
  const checkpoints = useQuery({ queryKey: keys.checkpoints(novelId), queryFn: () => api.checkpoints(novelId) });
  const fallback = defaults(versions.data, checkpoints.data);
  const from = params.get("from") ?? fallback.from;
  const to = params.get("to") ?? fallback.to;
  const ready = versions.isSuccess && checkpoints.isSuccess;
  const comparison = useQuery({
    queryKey: [...keys.versions(novelId), "compare", from, to],
    queryFn: () => api.compare(novelId, from, to),
    enabled: ready,
  });
  const [onlyChanges, setOnlyChanges] = useState(true);
  const set = (next: { from?: string; to?: string }) => setParams({ from: next.from ?? from, to: next.to ?? to }, { replace: true });
  const options = sides(versions.data, checkpoints.data);
  const label = (value: string) => options.flatMap((g) => g.options).find((o) => o.value === value)?.label ?? value;
  const ids = { from: useId(), to: useId(), only: useId() };

  return (
    <div className="grid gap-5 px-6 py-6">
      <h1 className="text-xl font-semibold">Compare</h1>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div className="grid gap-1.5">
          <label htmlFor={ids.from} className="font-medium">
            From
          </label>
          <SidePicker id={ids.from} value={from} options={options} onChange={(v) => set({ from: v })} />
        </div>
        <Button size="sm" onClick={() => set({ from: to, to: from })} aria-label="Swap from and to">
          <ArrowLeftRight className="size-4" aria-hidden />
        </Button>
        <div className="grid gap-1.5">
          <label htmlFor={ids.to} className="font-medium">
            To
          </label>
          <SidePicker id={ids.to} value={to} options={options} onChange={(v) => set({ to: v })} />
        </div>
        <label htmlFor={ids.only} className="flex items-center gap-2 pb-2">
          <input id={ids.only} type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
          Only what changed
        </label>
      </div>

      {comparison.isError ? (
        <ErrorAlert title="Couldn't compare them">{comparison.error.message}</ErrorAlert>
      ) : !comparison.data ? (
        <p className="text-sm text-muted">Comparing…</p>
      ) : (
        <Result novelId={novelId} comparison={comparison.data} from={from} to={to} onlyChanges={onlyChanges} fromLabel={label(from)} toLabel={label(to)} />
      )}
    </div>
  );
}

function SidePicker({ id, value, options, onChange }: { id: string; value: string; options: { group: string; options: Side[] }[]; onChange: (value: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 max-w-80 rounded-md border border-rule bg-raised px-2">
      {options.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function Result({ novelId, comparison: c, from, to, onlyChanges, fromLabel, toLabel }: { novelId: string; comparison: Comparison; from: string; to: string; onlyChanges: boolean; fromLabel: string; toLabel: string }) {
  const nothing = !c.counts.added && !c.counts.removed && !c.counts.changed && !c.counts.moved && c.chapters.every((ch) => ch.status === "unchanged") && !c.entries.length && !c.relationships.length && !c.events.length;
  const chapters = onlyChanges ? c.chapters.filter((ch) => ch.status !== "unchanged" || ch.moved) : c.chapters;
  const counts = [
    c.counts.changed && `${c.counts.changed} scene${c.counts.changed === 1 ? "" : "s"} changed`,
    c.counts.added && `${c.counts.added} added`,
    c.counts.removed && `${c.counts.removed} removed`,
    c.counts.moved && `${c.counts.moved} moved`,
  ].filter(Boolean);
  return (
    <>
      <section aria-label="Summary" className="grid gap-1 rounded-md border border-rule bg-panel p-4 text-sm">
        <p>
          From <strong>{fromLabel}</strong> to <strong>{toLabel}</strong>
        </p>
        <p>
          {number.format(c.words.before)} → {number.format(c.words.after)} words ({signed(c.words.after - c.words.before)})
          {counts.length > 0 && ` · ${counts.join(", ")}`}
        </p>
        {nothing && <p className="text-muted">They're the same.</p>}
      </section>

      {chapters.length > 0 && (
        <section aria-labelledby="compare-manuscript" className="grid gap-3">
          <h2 id="compare-manuscript" className="text-lg font-semibold">
            Manuscript
          </h2>
          {chapters.map((ch) => (
            <ChapterBlock key={ch.id} novelId={novelId} chapter={ch} from={from} to={to} onlyChanges={onlyChanges} />
          ))}
        </section>
      )}

      {(c.entries.length > 0 || c.relationships.length > 0 || c.events.length > 0) && (
        <section aria-labelledby="compare-bible" className="grid gap-3 text-sm">
          <h2 id="compare-bible" className="text-lg font-semibold">
            Story bible
          </h2>
          {c.entries.length > 0 && (
            <ul aria-label="Entries" className="grid gap-2">
              {c.entries.map((e) => (
                <li key={e.id} className="rounded-md border border-rule p-3">
                  <p className="font-medium">
                    {e.type}: {e.name} <Status status={e.status} />
                  </p>
                  <Fields fields={e.fields} />
                </li>
              ))}
            </ul>
          )}
          {c.relationships.length > 0 && (
            <>
              <h3 className="font-semibold">Relationships</h3>
              <ul className="grid gap-1">
                {c.relationships.map((r) => (
                  <li key={r.id}>
                    <Status status={r.status} /> {r.before && r.after ? <Change before={r.before} after={r.after} /> : (r.after ?? r.before)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {c.events.length > 0 && (
            <>
              <h3 className="font-semibold">Off-page events</h3>
              <ul className="grid gap-2">
                {c.events.map((e) => (
                  <li key={e.id}>
                    <span className="font-medium">{e.title}</span> <Status status={e.status} />
                    <Fields fields={e.fields} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}

const STATUS: Record<ChangeStatus, { label: string; className: string }> = {
  added: { label: "added", className: "bg-accent-soft text-ink" },
  removed: { label: "removed", className: "bg-danger-soft text-danger" },
  changed: { label: "changed", className: "bg-warn-soft text-ink" },
  unchanged: { label: "unchanged", className: "bg-panel text-muted" },
};

function Status({ status, moved }: { status: ChangeStatus; moved?: boolean }) {
  return (
    <>
      <span className={cn("rounded px-1.5 py-0.5 text-xs font-normal", STATUS[status].className)}>{STATUS[status].label}</span>
      {moved && <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-xs font-normal text-muted">moved</span>}
    </>
  );
}

function ChapterBlock({ novelId, chapter: ch, from, to, onlyChanges }: { novelId: string; chapter: ChapterComparison; from: string; to: string; onlyChanges: boolean }) {
  const scenes = onlyChanges ? ch.scenes.filter((s) => s.status !== "unchanged" || s.moved) : ch.scenes;
  const delta = ch.words.after - ch.words.before;
  return (
    <section aria-label={`Chapter: ${ch.title}`} className="grid gap-2 rounded-md border border-rule p-3">
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        {ch.title} <Status status={ch.status} moved={ch.moved} />
        <span className="text-sm font-normal text-muted">{delta ? `${signed(delta)} words` : ""}</span>
      </h3>
      <Fields fields={ch.fields} />
      {scenes.length > 0 && (
        <ul className="grid gap-1.5">
          {scenes.map((s) => (
            <SceneItem key={s.id} novelId={novelId} scene={s} from={from} to={to} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SceneItem({ novelId, scene: s, from, to }: { novelId: string; scene: SceneComparison; from: string; to: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const delta = s.words.after - s.words.before;
  const expandable = s.prose || s.fields.length > 0 || s.status === "added" || s.status === "removed";
  const summary = (
    <>
      <span className="font-medium">{s.title}</span> <Status status={s.status} moved={s.moved} />
      {s.movedFrom && <span className="text-xs text-muted">from {s.movedFrom}</span>}
      {delta !== 0 && <span className="text-xs text-muted">{signed(delta)} words</span>}
    </>
  );
  return (
    <li className="grid gap-2">
      {expandable ? (
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} className="flex flex-wrap items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-paper">
          <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
          {summary}
        </button>
      ) : (
        <p className="flex flex-wrap items-center gap-2 px-1 py-0.5 pl-7">{summary}</p>
      )}
      {open && (
        <div id={bodyId} className="grid gap-3 pl-7">
          <Fields fields={s.fields} />
          {(s.prose || s.status !== "changed") && <Prose novelId={novelId} sceneId={s.id} from={from} to={to} />}
        </div>
      )}
    </li>
  );
}

function Prose({ novelId, sceneId, from, to }: { novelId: string; sceneId: string; from: string; to: string }) {
  const diff = useQuery({ queryKey: [...keys.versions(novelId), "compare-scene", sceneId, from, to], queryFn: () => api.compareScene(novelId, sceneId, from, to) });
  if (diff.isError) return <ErrorAlert title="Couldn't compare the text">{diff.error.message}</ErrorAlert>;
  if (!diff.data) return <p className="text-sm text-muted">Comparing the text…</p>;
  if (diff.data.every((p) => p.kind === "same")) return <p className="text-sm text-muted">The words are the same; only their formatting changed.</p>;
  return (
    <div className="grid max-w-[40rem] gap-3 font-serif text-[1.05rem] leading-relaxed">
      {diff.data.map((p, i) => (
        <Paragraph key={i} paragraph={p} />
      ))}
    </div>
  );
}

const DEL = "rounded-sm bg-danger-soft text-danger line-through decoration-danger";
// Right after a deletion, a little apart from it: "~~twice~~ three times", not "~~twice~~three times".
const INS = "rounded-sm bg-accent-soft underline decoration-accent decoration-2 underline-offset-2 [del+&]:ml-1";

/** A paragraph of the diff: deletions struck through, insertions underlined (and said so to screen readers). */
function Paragraph({ paragraph: p }: { paragraph: ParagraphDiff }) {
  if (p.kind === "same") return <p className="text-muted">{p.text}</p>;
  if (p.kind === "added")
    return (
      <p>
        <ins className={INS}>
          <span className="sr-only">Added paragraph: </span>
          {p.text}
        </ins>
      </p>
    );
  if (p.kind === "removed")
    return (
      <p>
        <del className={DEL}>
          <span className="sr-only">Removed paragraph: </span>
          {p.text}
        </del>
      </p>
    );
  return (
    <p>
      {p.parts.map((part, i) =>
        part.op === "same" ? (
          <span key={i}>{part.text}</span>
        ) : part.op === "del" ? (
          <del key={i} className={DEL}>
            <span className="sr-only">deleted: </span>
            {part.text}
          </del>
        ) : (
          <ins key={i} className={INS}>
            <span className="sr-only">inserted: </span>
            {part.text}
          </ins>
        ),
      )}
    </p>
  );
}

function Fields({ fields }: { fields: FieldChange[] }) {
  if (!fields.length) return null;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {fields.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-muted">{f.label}</dt>
          <dd>{f.before !== undefined && f.after !== undefined ? <Change before={f.before} after={f.after} /> : f.after !== undefined ? <>added: {f.after}</> : <>removed: {f.before}</>}</dd>
        </div>
      ))}
    </dl>
  );
}

function Change({ before, after }: { before: string; after: string }) {
  return (
    <>
      <del className={DEL}>
        <span className="sr-only">was: </span>
        {before}
      </del>{" "}
      → <ins className={INS}>
        <span className="sr-only">now: </span>
        {after}
      </ins>
    </>
  );
}
