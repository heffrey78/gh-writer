import { entryPresence, relationshipsAt, relationshipStyle, type Entity, type Novel, type Relationship } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, keys } from "../api.ts";
import { MENU_ITEM } from "../layout.tsx";
import { useCurrentScene } from "../novel/current.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Confirm } from "../ui/confirm.tsx";
import { describeRelationship as describe } from "@gh-writer/core/diagrams";
import { ProfileSection } from "./profile.tsx";
import { RelationshipLines } from "./relationship-types.tsx";
import { AddRelationshipDialog, RelationshipAtSceneDialog } from "./relationships.tsx";
import { StripHeader } from "./strip.tsx";

/*
 * Relationships as arcs (#160): each of an entry's relationships a bar over the same scenes as its
 * strip, from the scene it starts to the scene it ends, in its type's colour and line, named on the
 * bar. Bars are grouped by who the relationship is with, stacked where they overlap. A marker under
 * them (arrow keys, or a click) reads what holds at one scene. A bar opens its changes.
 */

type Lane = { r: Relationship; start: number; end: number }[];

const BORDER = { solid: "solid", dashed: "dashed", dotted: "dotted" } as const;

export function RelationshipArcs({ novelId, novel, entity, compact }: { novelId: string; novel: Novel; entity: Entity; compact?: boolean }) {
  /** The name column: narrower in the sidebar. */
  const cols = compact ? "grid-cols-[4.5rem_minmax(0,1fr)]" : "grid-cols-[6.5rem_minmax(0,1fr)]";
  const queryClient = useQueryClient();
  const presence = useMemo(() => entryPresence(novel, entity.id), [novel, entity.id]);
  const n = presence?.scenes.length ?? 0;
  const current = useCurrentScene((s) => s.scene);
  const [at, setAt] = useState(() => Math.max(0, novel.scenes.findIndex((s) => s.id === current?.id)));
  // Beside the text, the marker follows the scene the author is in.
  useEffect(() => {
    const i = novel.scenes.findIndex((s) => s.id === current?.id);
    if (i >= 0) setAt(i);
  }, [current?.id, novel]);
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "change" | "end" | "remove"; relationship: Relationship }>();
  const markerName = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  const remove = useMutation({ mutationFn: (id: string) => api.bible.deleteRelationship(novelId, id), onSuccess: refresh });

  // By who it's with (in the order they first appear), each in lanes where they overlap.
  const groups = useMemo(() => {
    const index = new Map(novel.scenes.map((s, i) => [s.id, i]));
    const mine = novel.relationships
      .filter((r) => r.from === entity.id || r.to === entity.id)
      .map((r) => ({ r, start: r.since ? (index.get(r.since) ?? 0) : 0, end: r.until ? (index.get(r.until) ?? n) : n }))
      // The longest first where they start together, so a lasting one heads its row.
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const byOther = new Map<string, Lane[]>();
    for (const bar of mine) {
      const other = bar.r.from === entity.id ? bar.r.to : bar.r.from;
      const lanes = byOther.get(other) ?? [];
      const lane = lanes.find((l) => l.every((b) => b.end <= bar.start || b.start >= bar.end));
      if (lane) lane.push(bar);
      else lanes.push([bar]);
      byOther.set(other, lanes);
    }
    return [...byOther];
  }, [novel, entity.id, n]);

  const scene = novel.scenes[Math.min(at, n - 1)];
  const holding = scene ? relationshipsAt(novel, scene.id).filter((r) => r.from === entity.id || r.to === entity.id) : [];
  const name = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  const typeLabel = (r: Relationship) => {
    const type = novel.relationshipTypes.find((t) => t.key === r.type);
    return (r.from === entity.id || type?.symmetric ? type?.label : (type?.inverse_label ?? type?.label)) ?? r.type;
  };

  return (
    <ProfileSection
      title="Relationships"
      action={
        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "add" })}>
          <Plus className="size-4" aria-hidden /> Add a relationship
        </Button>
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm text-muted">No relationships yet.</p>
      ) : (
        presence &&
        n > 0 && (
          <>
            <div className={cn("grid items-center gap-x-3 gap-y-1.5", cols)}>
              <StripHeader presence={presence} />
            </div>
            <ul aria-label="All relationships" className="grid gap-2">
              {groups.map(([other, lanes]) => (
                <li key={other} className={cn("grid items-start gap-x-3", cols)}>
                  <Link to={`/novels/${novelId}/bible/${other}`} className="truncate pt-0.5 text-sm text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent">
                    {name(other)}
                  </Link>
                  <div className="grid gap-1">
                    {lanes.map((lane, i) => (
                      <div key={i} className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                        {lane.map(({ r, start, end }) => {
                          const { slot, line } = relationshipStyle(novel, r.type);
                          const said = describe(novel, entity.id, r);
                          return (
                            <DropdownMenu.Root key={r.id} modal={false}>
                              <DropdownMenu.Trigger asChild>
                                <button
                                  type="button"
                                  title={said}
                                  style={{
                                    gridColumn: `${start + 1} / ${Math.max(end, start + 1) + 1}`,
                                    borderColor: `var(--ghw-${slot})`,
                                    borderStyle: BORDER[line],
                                    background: `color-mix(in srgb, var(--ghw-${slot}) 16%, transparent)`,
                                  }}
                                  className="min-w-0 truncate rounded-[4px] border-2 px-1.5 py-0.5 text-left text-xs text-ink hover:brightness-95 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                                >
                                  <span aria-hidden>
                                    {typeLabel(r)}
                                    {r.note ? ` · ${r.note}` : ""}
                                  </span>
                                  <span className="sr-only">{said}</span>
                                </button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-44 rounded-md border border-rule bg-raised p-1 shadow-lg">
                                  <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "change", relationship: r })}>
                                    Change at…
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "end", relationship: r })}>
                                    End at…
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "remove", relationship: r })}>
                                    Remove…
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            {/* The marker: one scene at a time, by arrow keys or a click, read below. */}
            <div className={cn("grid items-center gap-x-3", cols)}>
              <span className="text-[13px] text-muted">Read at</span>
              <div role="radiogroup" aria-label="Read the relationships at a scene" className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                  {presence.scenes.map(({ scene: s }, i) => (
                    <label key={s.id} title={s.title} className={cn("flex cursor-pointer justify-center rounded-sm text-[11px] leading-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent", i === at ? "text-ink" : "text-rule hover:text-muted")}>
                      <input type="radio" name={markerName} checked={i === at} onChange={() => setAt(i)} className="sr-only" />
                      <span aria-hidden>▲</span>
                      <span className="sr-only">{s.title}</span>
                    </label>
                  ))}
              </div>
            </div>
            {scene && (
              <section aria-label={`At “${scene.title}”`} aria-live="polite" className={cn("grid gap-1 rounded-lg border border-rule bg-raised px-3 py-2 text-sm", compact ? "ml-[calc(4.5rem+0.75rem)]" : "ml-[calc(6.5rem+0.75rem)]")}>
                <p className="text-xs text-muted">At “{scene.title}”</p>
                {holding.length ? (
                  <RelationshipLines novel={novel} entityId={entity.id} relationships={holding} />
                ) : (
                  <p className="text-muted">None hold here.</p>
                )}
              </section>
            )}
          </>
        )
      )}
      {remove.isError && <ErrorAlert title="Couldn't remove it">{remove.error.message}</ErrorAlert>}
      {dialog?.kind === "add" && <AddRelationshipDialog novelId={novelId} novel={novel} entity={entity} onClose={() => setDialog(undefined)} />}
      {(dialog?.kind === "change" || dialog?.kind === "end") && (
        <RelationshipAtSceneDialog novelId={novelId} novel={novel} entity={entity} kind={dialog.kind} relationship={dialog.relationship} onClose={() => setDialog(undefined)} />
      )}
      <Confirm
        open={dialog?.kind === "remove"}
        onOpenChange={(o) => !o && setDialog(undefined)}
        title="Remove this relationship?"
        description={dialog?.kind === "remove" ? `“${describe(novel, entity.id, dialog.relationship)}” will no longer be in the bible.` : ""}
        action="Remove"
        danger
        onConfirm={() => dialog?.kind === "remove" && remove.mutate(dialog.relationship.id)}
      />
    </ProfileSection>
  );
}
