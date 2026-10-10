import { overlaps, storyTimeline, type Novel, type TimelineItem } from "@gh-writer/core";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { timelineMermaid, timelineSvg } from "@gh-writer/core/snapshots";
import { ExportMenu } from "../diagrams/export-menu.tsx";
import { EventDialog } from "./event-dialog.tsx";
import { useViewParams } from "../ui/view-params.ts";
import { itemId, itemTitle, jump, lanesOf, timeline, when, type LaneMode } from "@gh-writer/core/diagrams";

const SLOT = 152;
const HEAD = 168;
const LINKS = 88;
const MODES: [LaneMode, string][] = [
  ["pov", "Point of view"],
  ["plotline", "Plotline"],
  ["location", "Location"],
];

/**
 * The book in story time: scenes and off-page events in the order they happen, evenly spaced with
 * the jumps between them labelled, in lanes by point of view, plotline or location. Below, the
 * scenes in reading order, each linked to its place in story time: a flashback's line runs back
 * across the others. Overlaps (someone in two places at once) and undated scenes are listed, and
 * everything is in a table too.
 */
export function TimelinePage({ novelId, novel }: { novelId: string; novel: Novel }) {
  const [params, setParams] = useViewParams();
  const mode: LaneMode = MODES.some(([m]) => m === params.get("lanes")) ? (params.get("lanes") as LaneMode) : "pov";
  const t = useMemo(() => timeline(novel, mode), [novel, mode]);
  const conflicts = useMemo(() => overlaps(storyTimeline(novel)), [novel]);
  const reading = novel.scenes.filter((s) => t.storyRank.has(s.id));
  const n = t.items.length;
  const readSlot = reading.length ? (n * SLOT) / reading.length : SLOT;
  const name = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  // The event being edited, or "new" for one being added.
  const [editing, setEditing] = useState<string>();
  const editingEvent = editing && editing !== "new" ? novel.events.find((e) => e.id === editing) : undefined;
  const dialog = editing && <EventDialog key={editing} novelId={novelId} novel={novel} event={editingEvent} onClose={() => setEditing(undefined)} />;
  const lanesText = (i: TimelineItem) => lanesOf(i, mode).map((l) => t.lanes.find((x) => x.id === l)?.name ?? l).join(", ");

  if (!n) {
    return (
      <div className="grid gap-3 px-6 py-4">
        <h2 className="sr-only">Timeline</h2>
        <p className="text-muted">No scene or event has a time yet. Give scenes a time in their details (a day of the story, or a date).</p>
        <div>
          <Button onClick={() => setEditing("new")}>New off-page event</Button>
        </div>
        {dialog}
      </div>
    );
  }

  return (
    <div className="grid content-start gap-4 px-6 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="sr-only">Timeline</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setEditing("new")}>
            New off-page event
          </Button>
          <ExportMenu name="timeline" svg={() => timelineSvg(novel, mode)} mermaid={() => timelineMermaid(novel)} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="grid gap-1 font-medium">
          Lanes
          <select value={mode} onChange={(e) => setParams({ lanes: e.target.value === "pov" ? undefined : e.target.value })} className="h-8 rounded-md border border-rule bg-raised px-2 font-normal">
            {MODES.map(([m, l]) => (
              <option key={m} value={m}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-sm text-muted">
        Left to right in story time, evenly spaced; the time between neighbours is above them. Below, the scenes in reading order: each line joins a scene's place in the book to its place in
        time, and a <span className="font-medium text-warn">flashback</span>'s runs back across the others.
      </p>

      <div className="max-w-full overflow-x-auto rounded-lg border border-rule">
        <div style={{ width: HEAD + n * SLOT }} className="relative">
          {/* Story time: the axis, then a row per lane. */}
          <div role="presentation" style={{ display: "grid", gridTemplateColumns: `${HEAD}px repeat(${n}, ${SLOT}px)` }}>
            <div className="sticky left-0 z-10 border-b border-rule bg-paper px-3 py-2 text-xs font-medium text-muted">Story time</div>
            {t.items.map((item, k) => {
              const prev = t.items[k - 1];
              const gap = prev ? jump(prev.at, item.at) : "";
              return (
                <div key={itemId(item)} className="relative border-b border-l border-rule px-2 py-2 text-xs">
                  {gap && gap !== "same time" && <span className="absolute -top-0 left-0 -translate-x-1/2 rounded bg-accent-soft px-1 text-[0.7rem] whitespace-nowrap text-ink">{gap}</span>}
                  <span className="mt-3 block text-muted">{when(item)}</span>
                </div>
              );
            })}
            {t.lanes.map((lane) => (
              <Fragment key={lane.id}>
                <div className="sticky left-0 z-10 truncate border-b border-rule bg-paper px-3 py-3 text-sm font-medium">{lane.name}</div>
                {t.items.map((item) => (
                  <div key={itemId(item)} className="relative border-b border-l border-rule p-1.5">
                    <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-rule" aria-hidden />
                    {lanesOf(item, mode).includes(lane.id) && (
                      <Card
                        novelId={novelId}
                        item={item}
                        flashback={item.kind === "scene" && t.flashbacks.has(item.scene.id)}
                        reading={item.kind === "scene" ? novel.scenes.indexOf(item.scene) + 1 : undefined}
                        onEdit={(eventId) => setEditing(eventId)}
                      />
                    )}
                  </div>
                ))}
              </Fragment>
            ))}
          </div>

          {/* Each scene's place in time joined to its place in the book. */}
          <svg width={HEAD + n * SLOT} height={LINKS} className="block" aria-hidden>
            {reading.map((scene, r) => {
              const k = t.storyRank.get(scene.id)!;
              const flashback = t.flashbacks.has(scene.id);
              return (
                <line
                  key={scene.id}
                  x1={HEAD + k * SLOT + SLOT / 2}
                  y1={0}
                  x2={HEAD + r * readSlot + readSlot / 2}
                  y2={LINKS}
                  stroke={flashback ? "var(--ghw-warn)" : "var(--ghw-rule)"}
                  strokeWidth={flashback ? 2.5 : 1.5}
                />
              );
            })}
          </svg>
          <div role="presentation" style={{ display: "grid", gridTemplateColumns: `${HEAD}px repeat(${reading.length}, ${readSlot}px)` }}>
            <div className="sticky left-0 z-10 border-t border-rule bg-paper px-3 py-2 text-xs font-medium text-muted">Reading order</div>
            {reading.map((scene, r) => (
              <div key={scene.id} className={cn("border-t border-l border-rule px-2 py-2 text-xs", t.flashbacks.has(scene.id) && "bg-warn-soft")}>
                <span className="font-medium tabular-nums">{r + 1}.</span> {scene.title}
              </div>
            ))}
          </div>
        </div>
      </div>

      <section aria-labelledby="overlaps-heading" className="grid gap-1 text-sm">
        <h2 id="overlaps-heading" className="font-semibold">
          In two places at once
        </h2>
        {conflicts.length ? (
          <ul className="grid gap-1">
            {conflicts.map((o, k) => (
              <li key={k}>
                {name(o.character)} is in <ItemLink novelId={novelId} item={o.a} /> and <ItemLink novelId={novelId} item={o.b} /> at the same time, in different places.
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Nobody is in two places at once.</p>
        )}
      </section>

      {(t.undated.length > 0 || t.undatedEvents.length > 0) && (
        <section aria-labelledby="undated-heading" className="grid gap-1 text-sm">
          <h2 id="undated-heading" className="font-semibold">
            Not on the timeline
          </h2>
          <p className="text-muted">These have no time yet: give a scene one in its details.</p>
          <ul className="grid gap-1">
            {t.undated.map((s) => (
              <li key={s.id}>
                <Link to={`/novels/${novelId}/scene/${s.id}`} className="text-accent underline-offset-2 hover:underline">
                  {s.title}
                </Link>
              </li>
            ))}
            {t.undatedEvents.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => setEditing(e.id)} className="text-accent underline-offset-2 hover:underline">
                  {e.title}
                </button>{" "}
                (off page)
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">As a table</summary>
        <table className="mt-2 w-full max-w-4xl border-collapse">
          <caption className="sr-only">Every scene and event in story-time order</caption>
          <thead>
            <tr className="border-b border-rule text-left text-xs text-muted">
              <th scope="col" className="py-1 pr-3 font-medium">
                When
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                What
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                In the book
              </th>
              <th scope="col" className="py-1 font-medium">
                {MODES.find(([m]) => m === mode)![1]}
              </th>
            </tr>
          </thead>
          <tbody>
            {t.items.map((item) => (
              <tr key={itemId(item)} className="border-b border-rule">
                <td className="py-1 pr-3">{when(item)}</td>
                <td className="py-1 pr-3">
                  <ItemLink novelId={novelId} item={item} />
                  {item.kind === "scene" && t.flashbacks.has(item.scene.id) && " (flashback)"}
                </td>
                <td className="py-1 pr-3 tabular-nums">{item.kind === "scene" ? `${novel.scenes.indexOf(item.scene) + 1} of ${novel.scenes.length}` : "off page"}</td>
                <td className="py-1">{lanesText(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {dialog}
    </div>
  );
}

function ItemLink({ novelId, item }: { novelId: string; item: TimelineItem }) {
  return item.kind === "scene" ? (
    <Link to={`/novels/${novelId}/scene/${item.scene.id}`} className="text-accent underline-offset-2 hover:underline">
      “{item.scene.title}”
    </Link>
  ) : (
    <span>the event “{item.event.title}”</span>
  );
}

/** A scene (linked, with its place in the book) or an off-page event (dashed). */
function Card({ novelId, item, flashback, reading, onEdit }: { novelId: string; item: TimelineItem; flashback: boolean; reading: number | undefined; onEdit: (eventId: string) => void }) {
  return (
    <div
      className={cn(
        "relative grid gap-0.5 rounded-md border px-2 py-1 text-xs shadow-sm",
        item.kind === "scene" ? "border-rule bg-raised" : "border-dashed border-muted bg-paper italic",
        flashback && "border-warn ring-1 ring-warn",
      )}
    >
      {item.kind === "scene" ? (
        <Link to={`/novels/${novelId}/scene/${item.scene.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
          {itemTitle(item)}
        </Link>
      ) : (
        <button type="button" onClick={() => onEdit(item.event.id)} aria-label={`Edit the event “${itemTitle(item)}”`} className="text-left font-medium underline-offset-2 hover:underline">
          {itemTitle(item)}
        </button>
      )}
      <span className="text-muted not-italic">
        {item.kind === "scene" ? `#${reading} in the book` : "Off page"}
        {flashback && <span className="ml-1 font-medium text-warn">· flashback</span>}
      </span>
    </div>
  );
}
