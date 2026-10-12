import { nextSeriesSlot, relationshipStyle, SERIES, slugify, type Novel, type Relationship, type RelationshipLine, type SeriesSlot } from "@gh-writer/core";
import { describeRelationship as describe } from "@gh-writer/core/diagrams";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useId, useState } from "react";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";

type Editing = { key?: string; label: string; inverse: string; symmetric: boolean; color: SeriesSlot; line: RelationshipLine };

const LINES: { line: RelationshipLine; name: string }[] = [
  { line: "solid", name: "Solid" },
  { line: "dashed", name: "Dashed" },
  { line: "dotted", name: "Dotted" },
];
const DASH: Record<RelationshipLine, string | undefined> = { solid: undefined, dashed: "6 4", dotted: "2 4" };

/** A short stretch of a relationship's line, as the graph draws it. */
export function LineSample({ color, line, className }: { color: SeriesSlot; line: RelationshipLine; className?: string }) {
  return (
    <svg viewBox="0 0 28 8" className={className ?? "h-2 w-7 shrink-0"} aria-hidden>
      <line x1="1" y1="4" x2="27" y2="4" stroke={`var(--ghw-${color})`} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={DASH[line]} />
    </svg>
  );
}

/** The kinds of relationship this novel uses: add one, or change one's name, colour and line. */
export function RelationshipTypes({ novelId, novel }: { novelId: string; novel: Novel }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const [editing, setEditing] = useState<Editing>();
  const save = useMutation({
    mutationFn: (e: Editing) =>
      e.key
        ? api.bible.updateRelationshipType(novelId, e.key, {
            label: e.label.trim(),
            ...(e.symmetric ? {} : { inverse_label: e.inverse.trim() || e.label.trim() }),
            ...styleChanges(e.key, e),
          })
        : api.bible.createRelationshipType(novelId, {
            key: slugify(e.label),
            label: e.label.trim(),
            symmetric: e.symmetric,
            ...(e.symmetric || !e.inverse.trim() ? {} : { inverse_label: e.inverse.trim() }),
            style: { color: e.color, line: e.line },
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      setEditing(undefined);
    },
  });
  /** Only what changed in its look, so a type keeps the lines it had in novel.yaml otherwise. */
  const styleChanges = (key: string, e: Editing) => {
    const was = relationshipStyle(novel, key);
    const style = { ...(e.color !== was.slot ? { color: e.color } : {}), ...(e.line !== was.line ? { line: e.line } : {}) };
    return Object.keys(style).length ? { style } : {};
  };
  const edit = (key: string) => {
    const t = novel.relationshipTypes.find((x) => x.key === key)!;
    const { slot, line } = relationshipStyle(novel, key);
    setEditing({ key, label: t.label ?? key, inverse: t.inverse_label ?? "", symmetric: Boolean(t.symmetric), color: slot, line });
  };
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold">
          Kinds of relationship
        </h2>
        <Button size="sm" variant="ghost" onClick={() => setEditing({ label: "", inverse: "", symmetric: true, color: nextSeriesSlot(novel), line: "solid" })}>
          New kind
        </Button>
      </div>
      <ul className="grid gap-1 text-sm">
        {novel.relationshipTypes.map((t) => (
          <li key={t.key} className="flex items-center justify-between gap-2 rounded-md border border-rule px-3 py-1.5">
            <span className="flex items-center gap-2">
              <LineSample color={relationshipStyle(novel, t.key).slot} line={relationshipStyle(novel, t.key).line} />
              <span>
              {t.label ?? t.key}
              {!t.symmetric && t.inverse_label && <span className="text-muted"> / {t.inverse_label}</span>}
              {t.symmetric && <span className="text-muted"> (both ways)</span>}
              </span>
            </span>
            <Button size="sm" variant="ghost" aria-label={`Edit “${t.label ?? t.key}”`} onClick={() => edit(t.key)}>
              Edit
            </Button>
          </li>
        ))}
      </ul>
      <Dialog.Root open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content aria-describedby={undefined} className="fixed top-1/2 left-1/2 z-50 grid max-h-[85vh] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl">
            <Dialog.Title className="text-lg font-semibold">{editing?.key ? "Edit the relationship" : "New kind of relationship"}</Dialog.Title>
            {editing && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (editing.label.trim()) save.mutate(editing);
                }}
                className="grid gap-3"
              >
                <Field label="Name" placeholder="Rivals with" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} required autoFocus />
                {!editing.key && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={editing.symmetric} onChange={(e) => setEditing({ ...editing, symmetric: e.target.checked })} />
                    The same both ways (like “Sibling of”)
                  </label>
                )}
                {!editing.symmetric && (
                  <Field label="From the other side" placeholder="Mentee of" value={editing.inverse} onChange={(e) => setEditing({ ...editing, inverse: e.target.value })} />
                )}
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1 text-sm font-medium">Colour</legend>
                  <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                    {SERIES.map((c) => (
                      <label key={c.slot} className="flex cursor-pointer items-center gap-2 rounded-md border border-rule px-2 py-1 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent">
                        <input type="radio" name="colour" value={c.slot} checked={editing.color === c.slot} onChange={() => setEditing({ ...editing, color: c.slot })} className="sr-only" />
                        <span className="size-3.5 shrink-0 rounded-full" style={{ background: `var(--ghw-${c.slot})` }} aria-hidden />
                        {c.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1 text-sm font-medium">Line</legend>
                  <div className="flex flex-wrap gap-1">
                    {LINES.map((l) => (
                      <label key={l.line} className="flex cursor-pointer items-center gap-2 rounded-md border border-rule px-2 py-1 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent">
                        <input type="radio" name="line" value={l.line} checked={editing.line === l.line} onChange={() => setEditing({ ...editing, line: l.line })} className="sr-only" />
                        <LineSample color={editing.color} line={l.line} />
                        {l.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {save.isError && <ErrorAlert title="Couldn't save it">{save.error.message}</ErrorAlert>}
                <div className="flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <Button>Cancel</Button>
                  </Dialog.Close>
                  <Button type="submit" variant="primary" disabled={!editing.label.trim() || save.isPending}>
                    {editing.key ? "Save" : "Add"}
                  </Button>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

/** Relationships as sentences from `entityId`'s side, each beside its kind's line: the same look as the arcs and the graph. */
export function RelationshipLines({ novel, entityId, relationships }: { novel: Novel; entityId: string; relationships: Relationship[] }) {
  return (
    <ul className="grid gap-0.5">
      {relationships.map((r) => {
        const { slot, line } = relationshipStyle(novel, r.type);
        return (
          <li key={r.id} className="flex items-center gap-2">
            <LineSample color={slot} line={line} className="h-2 w-5 shrink-0" />
            <span>{describe(novel, entityId, r)}</span>
          </li>
        );
      })}
    </ul>
  );
}
