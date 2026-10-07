import type { Novel } from "@gh-writer/core";
import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api.ts";
import { sceneItems } from "../bible/pickers.ts";
import { chapterTitle } from "../novel/navigation.tsx";
import { useNotice } from "../novel/notice.tsx";
import { useTheme } from "../theme.ts";
import { Picker } from "../ui/picker.tsx";
import { GraphCanvas } from "./graph-canvas.tsx";
import { graphAt, RELATIONSHIP_GRAPH } from "./graph-model.ts";

/**
 * Who is connected to whom, at a point in the story: characters as nodes, the relationships holding
 * at the chosen scene as edges. The slider (or the scene picker) moves through the book; the scene is
 * kept in the address (?at=). Nodes can be placed by dragging or with the arrow keys, and stay put.
 * Beside the graph, the same relationships as a list.
 */
export function GraphPage({ novelId, novel }: { novelId: string; novel: Novel }) {
  const [params, setParams] = useSearchParams();
  const theme = useTheme((s) => s.theme);
  const show = useNotice((s) => s.show);
  const sliderId = useId();
  const scenes = novel.scenes;
  const asked = params.get("at");
  // The slider answers at once; the address follows. (Waiting on the address would drop key presses.)
  const [at, setAt] = useState(asked);
  useEffect(() => setAt(asked), [asked]);
  const index = Math.max(0, scenes.findIndex((s) => s.id === at));
  const scene = scenes[index];
  const view = useMemo(() => graphAt(novel, scene?.id), [novel, scene?.id]);
  const chapter = scene && novel.chapters.find((c) => c.id === scene.chapterId);

  const go = (id: string | undefined) => {
    if (!id) return;
    setAt(id);
    const next = new URLSearchParams(params);
    next.set("at", id);
    setParams(next, { replace: true });
  };

  const save = (positions: Record<string, { x: number; y: number }>) =>
    void api.saveLayout(novelId, RELATIONSHIP_GRAPH, positions).catch((e: unknown) => show({ message: `Couldn't save where you put that: ${e instanceof Error ? e.message : String(e)}` }));

  return (
    <div className="grid h-full grid-rows-[auto_minmax(24rem,1fr)] gap-3 px-6 py-6">
      <div className="grid gap-3">
        <h1 className="text-xl font-semibold">Relationships</h1>
        {scene ? (
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid min-w-64 flex-1 gap-1.5">
              <label htmlFor={sliderId} className="text-sm font-medium">
                Story position
              </label>
              <input
                id={sliderId}
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
            <Picker label="Scene" items={sceneItems(novel)} value={scene.id} onChange={go} className="w-64" />
          </div>
        ) : (
          <p className="text-muted">The manuscript has no scenes yet: the graph shows relationships that hold from the start.</p>
        )}
      </div>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-h-96 overflow-hidden rounded-lg border border-rule bg-raised">
          {view.nodes.length ? (
            <GraphCanvas nodes={view.nodes} edges={view.edges} label="Relationship graph" onNodesMoved={save} colorMode={theme} />
          ) : (
            <p className="p-6 text-muted">No characters yet. Add some in the story bible to see how they relate.</p>
          )}
        </div>
        <section aria-labelledby={`${sliderId}-list`} className="grid content-start gap-2 text-sm lg:overflow-y-auto">
          <h2 id={`${sliderId}-list`} className="font-semibold">
            {scene ? `At “${scene.title}”` : "From the start"}
          </h2>
          {view.list.length ? (
            <ul className="grid gap-1.5">
              {view.list.map((r) => (
                <li key={r.id}>{r.text}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No relationships here.</p>
          )}
        </section>
      </div>
    </div>
  );
}
