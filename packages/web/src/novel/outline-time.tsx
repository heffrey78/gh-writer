import { countWords, proseText, storyTimeline, type Novel, type Scene, type StoryEvent } from "@gh-writer/core";
import { when } from "@gh-writer/core/diagrams";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FilterSelect, STATUS_TONE } from "./corkboard.tsx";
import { shows, type CorkboardFilter } from "./corkboard-order.ts";
import { STATUSES, StatusSelect, Synopsis, useSceneEdit } from "./outline.tsx";
import type { Workspace } from "./workspace.ts";

/*
 * The outline in story time (#165): the scenes in the order things happen, with the off-page events
 * placed among them, drawn so they're never taken for scenes (dashed cards, italic rows, "Off the
 * page"). Dated items first, then relative days; then the undated scenes in reading order, and the
 * undated events. Nothing moves here: it's reading order that's rearranged.
 */

type Item = { kind: "scene"; scene: Scene; when?: string } | { kind: "event"; event: StoryEvent; when?: string };

/** Every scene and event, in story-time order. */
function inStoryTime(novel: Novel): Item[] {
  const t = storyTimeline(novel);
  return [
    ...t.items.map((i): Item => (i.kind === "scene" ? { kind: "scene", scene: i.scene, when: when(i) } : { kind: "event", event: i.event, when: when(i) })),
    ...t.undatedScenes.map((scene): Item => ({ kind: "scene", scene })),
    ...t.undatedEvents.map((event): Item => ({ kind: "event", event })),
  ];
}

/** An event's note, as a line of plain text. */
const noteLine = (e: StoryEvent) => proseText(e.body).replace(/\s+/g, " ").trim();

const NOT_MOVED = "In story time, nothing is moved: switch to reading order to rearrange the book.";
const number = new Intl.NumberFormat();

export function OutlineTimeTable({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const items = useMemo(() => inStoryTime(novel), [novel]);
  const edit = useSceneEdit(novelId, workspace);
  const name = (id: string | undefined) => novel.entities.find((e) => e.id === id)?.name;
  const names = (ids: string[] | undefined) => (ids ?? []).map(name).filter(Boolean).join(", ") || <span className="text-muted not-italic">—</span>;
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted">{NOT_MOVED}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <caption className="sr-only">Every scene and off-page event in story-time order</caption>
          <thead>
            <tr className="border-b border-rule text-left text-xs text-muted">
              <th scope="col" className="w-36 py-2 pr-3 font-medium">
                When
              </th>
              <th scope="col" className="w-48 py-2 pr-3 font-medium">
                Scene
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Synopsis
              </th>
              <th scope="col" className="w-28 py-2 pr-3 font-medium">
                Status
              </th>
              <th scope="col" className="w-28 py-2 pr-3 font-medium">
                Point of view
              </th>
              <th scope="col" className="w-40 py-2 pr-3 font-medium">
                Characters
              </th>
              <th scope="col" className="w-36 py-2 pr-3 font-medium">
                Plotlines
              </th>
              <th scope="col" className="w-16 py-2 text-right font-medium">
                Words
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) =>
              item.kind === "scene" ? (
                <tr key={item.scene.id} className="border-b border-rule align-top">
                  <td className="py-2 pr-3 text-muted">{item.when ?? "No time"}</td>
                  <td className="py-2 pr-3">
                    <Link to={`/novels/${novelId}/scene/${item.scene.id}`} className="font-medium underline-offset-2 hover:underline">
                      {item.scene.title}
                    </Link>
                  </td>
                  <td className="py-1 pr-3">
                    <Synopsis scene={item.scene} onSave={(v) => void edit(item.scene, "synopsis", v)} />
                  </td>
                  <td className="py-1 pr-3">
                    <StatusSelect scene={item.scene} onChange={(v) => void edit(item.scene, "status", v)} />
                  </td>
                  <td className="py-2 pr-3">{name(item.scene.pov) ?? <span className="text-muted">—</span>}</td>
                  <td className="py-2 pr-3">{names(item.scene.characters)}</td>
                  <td className="py-2 pr-3">{names(item.scene.plotlines.map((p) => p.id))}</td>
                  <td className="py-2 text-right tabular-nums">{number.format(countWords(item.scene.body))}</td>
                </tr>
              ) : (
                <tr key={item.event.id} className="border-b border-dashed border-rule bg-paper align-top italic">
                  <td className="py-2 pr-3 text-muted">{item.when ?? "No time"}</td>
                  <td className="py-2 pr-3">
                    <Link to={`/novels/${novelId}/event/${item.event.id}`} className="underline-offset-2 hover:underline">
                      {item.event.title}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-muted">{noteLine(item.event)}</td>
                  <td className="py-2 pr-3 text-xs font-medium tracking-wide text-muted not-italic uppercase">Off the page</td>
                  <td className="py-2 pr-3 text-muted not-italic">—</td>
                  <td className="py-2 pr-3">{names(item.event.characters)}</td>
                  <td className="py-2 pr-3">{names(item.event.plotlines)}</td>
                  <td className="py-2 text-right text-muted not-italic">—</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Whether an event shows with the cards' filters: those about its people and plotlines; a point of view or status is a scene's. */
const eventShows = (e: StoryEvent, f: CorkboardFilter) =>
  !f.pov && !f.status && (!f.plotline || (e.plotlines ?? []).includes(f.plotline)) && (!f.character || (e.characters ?? []).includes(f.character));

export function OutlineTimeCards({ novelId, novel }: { novelId: string; novel: Novel }) {
  const [params, setParams] = useSearchParams();
  const filter: CorkboardFilter = Object.fromEntries(["pov", "plotline", "status", "character"].flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));
  const all = useMemo(() => inStoryTime(novel), [novel]);
  const items = all.filter((i) => (i.kind === "scene" ? shows(i.scene, filter) : eventShows(i.event, filter)));
  const filtered = Object.keys(filter).length > 0;
  const name = (id: string | undefined) => novel.entities.find((e) => e.id === id)?.name;
  const setFilter = (key: keyof CorkboardFilter, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const characters = novel.entities.filter((e) => e.type === "character").sort((a, b) => a.name.localeCompare(b.name));
  const plotlines = novel.entities.filter((e) => e.type === "plotline").sort((a, b) => a.name.localeCompare(b.name));
  const scenes = items.filter((i) => i.kind === "scene").length;
  return (
    <div className="grid gap-4">
      <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Point of view" value={filter.pov} onChange={(v) => setFilter("pov", v)} options={characters.map((c) => [c.id, c.name])} />
        <FilterSelect label="Character" value={filter.character} onChange={(v) => setFilter("character", v)} options={characters.map((c) => [c.id, c.name])} />
        <FilterSelect label="Plotline" value={filter.plotline} onChange={(v) => setFilter("plotline", v)} options={plotlines.map((p) => [p.id, p.name])} />
        <FilterSelect label="Status" value={filter.status} onChange={(v) => setFilter("status", v)} options={STATUSES.map((s) => [s, s])} />
        {filtered && (
          <Button size="sm" onClick={() => setParams({ order: "time" }, { replace: true })}>
            Clear filters
          </Button>
        )}
      </div>
      <p role="status" className="text-sm text-muted">
        {filtered ? `${scenes} of ${novel.scenes.length} scenes match` : `${novel.scenes.length} scenes`}, and {items.length - scenes} off-page {items.length - scenes === 1 ? "event" : "events"}. {NOT_MOVED}
      </p>
      <ol aria-label="In story time" className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {items.map((item) =>
          item.kind === "scene" ? (
            <li key={item.scene.id} aria-label={item.scene.title} className={cn("grid content-start gap-1.5 rounded-md border border-l-4 border-rule bg-raised p-3 text-sm shadow-sm", STATUS_TONE[item.scene.status])}>
              <span className="text-xs text-muted">{item.when ?? "No time"}</span>
              <Link to={`/novels/${novelId}/scene/${item.scene.id}`} className="font-semibold underline-offset-2 hover:underline">
                {item.scene.title}
              </Link>
              {item.scene.synopsis && <p className="text-muted">{item.scene.synopsis}</p>}
              <p className="text-xs text-muted">
                {item.scene.status}
                {item.scene.pov && ` · ${name(item.scene.pov)}`}
              </p>
            </li>
          ) : (
            <li key={item.event.id} aria-label={`${item.event.title}, off the page`} className="grid content-start gap-1.5 rounded-md border border-dashed border-muted bg-paper p-3 text-sm italic">
              <span className="text-xs text-muted not-italic">
                {item.when ?? "No time"} · <span className="font-medium tracking-wide uppercase">Off the page</span>
              </span>
              <Link to={`/novels/${novelId}/event/${item.event.id}`} className="font-semibold underline-offset-2 hover:underline">
                {item.event.title}
              </Link>
              {noteLine(item.event) && <p className="text-muted">{noteLine(item.event)}</p>}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
