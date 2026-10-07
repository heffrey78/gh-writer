import { backlinks, type Novel } from "@gh-writer/core";
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { sceneItems } from "../bible/pickers.ts";
import { plural } from "../bible/types.ts";
import { chapterTitle } from "../novel/navigation.tsx";
import { useNotice } from "../novel/notice.tsx";
import { useTheme } from "../theme.ts";
import { Button } from "../ui/button.tsx";
import { Picker } from "../ui/picker.tsx";
import { GraphCanvas } from "./graph-canvas.tsx";
import { graphAt, RELATIONSHIP_GRAPH, type GraphFilter } from "./graph-model.ts";

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : undefined);

/**
 * Who is connected to whom, at a point in the story: entities as nodes (characters, unless the
 * filters say otherwise), the relationships holding at the chosen scene as edges. The slider (or the
 * scene picker) moves through the book. Filters narrow it to entity types, relationship types, a
 * plotline, or who is present in a range of scenes. Selecting a node brings out its relationships and
 * lists the scenes it's in. The scene, filters and selection are kept in the address. Nodes can be
 * placed by dragging or with the arrow keys, and stay put. Beside the graph, the same relationships
 * as a list.
 */
export function GraphPage({ novelId, novel }: { novelId: string; novel: Novel }) {
  const [address, setAddress] = useSearchParams();
  // The page answers at once and the address follows: waiting on the address would make the slider
  // drop key presses and checkboxes spring back for a moment.
  const [query, setQuery] = useState(address.toString());
  useEffect(() => setQuery(address.toString()), [address]);
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const theme = useTheme((s) => s.theme);
  const show = useNotice((s) => s.show);
  const id = useId();
  const scenes = novel.scenes;
  const index = Math.max(0, scenes.findIndex((s) => s.id === params.get("at")));
  const scene = scenes[index];
  const chapter = scene && novel.chapters.find((c) => c.id === scene.chapterId);

  const filter: GraphFilter = {
    ...(list(params.get("types")) ? { types: list(params.get("types"))! } : {}),
    ...(list(params.get("rel")) ? { relationshipTypes: list(params.get("rel"))! } : {}),
    ...(params.get("plot") ? { plotline: params.get("plot")! } : {}),
    ...(params.get("from") ? { from: params.get("from")! } : {}),
    ...(params.get("to") ? { to: params.get("to")! } : {}),
  };
  const filterKey = ["types", "rel", "plot", "from", "to"].map((k) => params.get(k) ?? "").join("|");
  const view = useMemo(() => graphAt(novel, scene?.id, filter), [novel, scene?.id, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = filterKey !== "||||";

  const selectedId = params.get("sel") ?? undefined;
  const selected = selectedId ? novel.entities.find((e) => e.id === selectedId && view.nodes.some((n) => n.id === e.id)) : undefined;

  const set = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setQuery(next.toString());
    setAddress(next, { replace: true });
  };
  const go = (sceneId: string | undefined) => sceneId && set({ at: sceneId });

  const types = filter.types ?? ["character"];
  const relTypes = filter.relationshipTypes ?? novel.relationshipTypes.map((t) => t.key);
  const toggle = (key: "types" | "rel", all: string[], current: string[], value: string, defaults: string[]) => {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const ordered = all.filter((v) => next.includes(v));
    set({ [key]: ordered.join(",") === defaults.join(",") ? undefined : ordered.join(",") || "none" });
  };

  const save = (positions: Record<string, { x: number; y: number }>) =>
    void api.saveLayout(novelId, RELATIONSHIP_GRAPH, positions).catch((e: unknown) => show({ message: `Couldn't save where you put that: ${e instanceof Error ? e.message : String(e)}` }));

  const plotlines = novel.entities.filter((e) => e.type === "plotline").sort((a, b) => a.name.localeCompare(b.name));
  const sceneList = useMemo(() => sceneItems(novel), [novel]);
  const shownList = selected ? view.list.filter((r) => view.edges.some((e) => e.id === r.id && (e.source === selected.id || e.target === selected.id))) : view.list;
  const appears = useMemo(() => (selected ? backlinks(novel, selected.id).scenes.filter((s) => s.scene.position >= 0) : []), [novel, selected]);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(24rem,1fr)] gap-3 px-6 py-6">
      <div className="grid gap-3">
        <h1 className="text-xl font-semibold">Relationships</h1>
        {scene ? (
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid min-w-64 flex-1 gap-1.5">
              <label htmlFor={`${id}-slider`} className="text-sm font-medium">
                Story position
              </label>
              <input
                id={`${id}-slider`}
                type="range"
                min={0}
                max={scenes.length - 1}
                step={1}
                value={index}
                onChange={(e) => go(scenes[Number(e.target.value)]?.id)}
                aria-valuetext={`Scene ${index + 1} of ${scenes.length}: ${scene.title}${chapter ? `, in ${chapterTitle(novel, chapter)}` : ""}`}
                className="accent-[var(--ghw-accent)]"
              />
              <p className="text-xs text-muted" aria-hidden>
                Scene {index + 1} of {scenes.length}
                {chapter && ` · ${chapterTitle(novel, chapter)}`}
              </p>
            </div>
            <Picker label="Scene" items={sceneList} value={scene.id} onChange={go} className="w-64" />
          </div>
        ) : (
          <p className="text-muted">The manuscript has no scenes yet: the graph shows relationships that hold from the start.</p>
        )}
        <details className="rounded-md border border-rule px-3 py-2 text-sm" open={filtered || undefined}>
          <summary className="cursor-pointer font-medium">Filters{filtered ? " (on)" : ""}</summary>
          <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-3">
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-xs font-semibold text-muted">Show</legend>
              {novel.entityTypes.map((t) => (
                <label key={t.key} className="flex items-center gap-2">
                  <input type="checkbox" checked={types.includes(t.key)} onChange={() => toggle("types", novel.entityTypes.map((x) => x.key), types, t.key, ["character"])} />
                  {plural(t.label)}
                </label>
              ))}
            </fieldset>
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-xs font-semibold text-muted">Relationships</legend>
              {novel.relationshipTypes.map((t) => (
                <label key={t.key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={relTypes.includes(t.key)}
                    onChange={() =>
                      toggle(
                        "rel",
                        novel.relationshipTypes.map((x) => x.key),
                        relTypes,
                        t.key,
                        novel.relationshipTypes.map((x) => x.key),
                      )
                    }
                  />
                  {t.label ?? t.key}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <label htmlFor={`${id}-plot`} className="text-xs font-semibold text-muted">
                  In scenes of the plotline
                </label>
                <select id={`${id}-plot`} value={filter.plotline ?? ""} onChange={(e) => set({ plot: e.target.value || undefined })} className="h-8 rounded-md border border-rule bg-raised px-2">
                  <option value="">Any</option>
                  {plotlines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Picker label="Present from" items={sceneList} value={filter.from} onChange={(v) => set({ from: v })} placeholder="The start" allowNone className="w-56" />
                <Picker label="to" items={sceneList} value={filter.to} onChange={(v) => set({ to: v })} placeholder="The end" allowNone className="w-56" />
              </div>
            </div>
            {filtered && (
              <Button size="sm" onClick={() => set({ types: undefined, rel: undefined, plot: undefined, from: undefined, to: undefined })}>
                Clear filters
              </Button>
            )}
          </div>
        </details>
      </div>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-h-96 overflow-hidden rounded-lg border border-rule bg-raised">
          {view.nodes.length ? (
            <GraphCanvas
              nodes={view.nodes}
              edges={view.edges}
              label="Relationship graph"
              onNodesMoved={save}
              colorMode={theme}
              selected={selected?.id}
              onSelect={(sel) => set({ sel })}
            />
          ) : (
            <p className="p-6 text-muted">{filtered ? "Nothing matches these filters." : "No characters yet. Add some in the story bible to see how they relate."}</p>
          )}
        </div>
        <section aria-labelledby={`${id}-list`} className="grid content-start gap-2 text-sm lg:overflow-y-auto">
          <h2 id={`${id}-list`} className="font-semibold">
            {selected ? selected.name : scene ? `At “${scene.title}”` : "From the start"}
          </h2>
          {selected && (
            <p className="text-xs text-muted">
              {scene ? `At “${scene.title}”.` : ""}{" "}
              <button type="button" onClick={() => set({ sel: undefined })} className="text-accent underline underline-offset-2">
                Show everyone
              </button>
            </p>
          )}
          {shownList.length ? (
            <ul className="grid gap-1.5" aria-label="Relationships">
              {shownList.map((r) => (
                <li key={r.id}>{r.text}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No relationships here.</p>
          )}
          {selected && (
            <>
              <h3 className="mt-2 font-semibold">Appears in</h3>
              {appears.length ? (
                <ul className="grid gap-1" aria-label={`Scenes with ${selected.name}`}>
                  {appears.map(({ scene: s }) => (
                    <li key={s.id}>
                      <Link to={`/novels/${novelId}/scene/${s.id}`} className="text-accent underline-offset-2 hover:underline">
                        {s.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No scenes yet.</p>
              )}
              <Link to={`/novels/${novelId}/bible/${selected.id}`} className="text-accent underline-offset-2 hover:underline">
                Open the entry
              </Link>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
