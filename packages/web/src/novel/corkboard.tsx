import type { Novel, Scene } from "@gh-writer/core";
import { GripVertical } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { visibleScenes, visibleStep, type CorkboardFilter } from "./corkboard-order.ts";
import { chapterTitle } from "./navigation.tsx";
import { STATUSES } from "./outline.tsx";
import { dropMove, useStructure } from "./structure.ts";
import type { Workspace } from "./workspace.ts";

const STATUS_TONE: Record<string, string> = {
  idea: "border-l-rule",
  outlined: "border-l-warn",
  drafted: "border-l-accent",
  revised: "border-l-ok",
  final: "border-l-ink",
};

/**
 * Scenes as index cards, by chapter, filtered by point of view, plotline, status or character. A card
 * dropped before another lands immediately before it in the whole book, filtered or not; Alt+Left and
 * Alt+Right on a card's handle step it past its visible neighbour the same way.
 */
/** Outline as cards (the corkboard): scenes as cards by chapter, filtered, dragged to reorder. */
export function OutlineCards({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const structure = useStructure(novelId, novel, workspace);
  const [params, setParams] = useSearchParams();
  const filter: CorkboardFilter = Object.fromEntries(["pov", "plotline", "status", "character"].flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));
  const visible = useMemo(() => visibleScenes(novel, filter), [novel, params]); // eslint-disable-line react-hooks/exhaustive-deps
  const dragging = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const name = (id: string | undefined) => novel.entities.find((e) => e.id === id)?.name;
  const filtered = Object.keys(filter).length > 0;

  const setFilter = (key: keyof CorkboardFilter, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const moveTo = (id: string, target: string, after: boolean) => {
    const move = dropMove(novel, id, target, after);
    return move ? structure.move(id, move.index, move.to) : undefined;
  };

  // A card moved by keyboard keeps focus, even when it lands in another chapter (a new element)
  // after the model reloads: focus left on nothing goes back to its handle.
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = refocus.current;
    if (id && (document.activeElement === document.body || !document.activeElement?.isConnected)) document.querySelector<HTMLElement>(`[data-card-handle="${id}"]`)?.focus();
  }, [novel]);

  const onHandleKey = (e: KeyboardEvent, scene: Scene) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const step = visibleStep(
      visible.map((s) => s.id),
      scene.id,
      e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1,
    );
    if (!step) return;
    refocus.current = scene.id;
    void Promise.resolve(moveTo(scene.id, step.target, step.after)).then(() =>
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card-handle="${scene.id}"]`)?.focus()),
    );
  };

  const onDragOver = (e: DragEvent, scene: Scene) => {
    if (!dragging.current || dragging.current === scene.id) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDrop({ id: scene.id, after: e.clientX > rect.left + rect.width / 2 });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const id = dragging.current;
    const target = drop;
    dragging.current = undefined;
    setDrop(undefined);
    if (id && target) void moveTo(id, target.id, target.after);
  };

  const chapters = novel.chapters.map((c) => ({ chapter: c, scenes: visible.filter((s) => s.chapterId === c.id) })).filter((g) => g.scenes.length || !filtered);
  const characters = novel.entities.filter((e) => e.type === "character").sort((a, b) => a.name.localeCompare(b.name));
  const plotlines = novel.entities.filter((e) => e.type === "plotline").sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="grid gap-4">
      <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Point of view" value={filter.pov} onChange={(v) => setFilter("pov", v)} options={characters.map((c) => [c.id, c.name])} />
        <FilterSelect label="Character" value={filter.character} onChange={(v) => setFilter("character", v)} options={characters.map((c) => [c.id, c.name])} />
        <FilterSelect label="Plotline" value={filter.plotline} onChange={(v) => setFilter("plotline", v)} options={plotlines.map((p) => [p.id, p.name])} />
        <FilterSelect label="Status" value={filter.status} onChange={(v) => setFilter("status", v)} options={STATUSES.map((s) => [s, s])} />
        {filtered && (
          <Button size="sm" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </Button>
        )}
      </div>
      <p role="status" className="text-sm text-muted">
        {filtered ? `${visible.length} of ${novel.scenes.length} scenes match.` : `${novel.scenes.length} scenes.`}
      </p>
      {chapters.map(({ chapter, scenes }) => (
        <section key={chapter.id} aria-labelledby={`cork-${chapter.id}`} className="grid gap-2">
          <h2 id={`cork-${chapter.id}`} className="font-semibold">
            {chapterTitle(novel, chapter)}
          </h2>
          {scenes.length ? (
            <ol className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
              {scenes.map((scene) => (
                <li
                  key={scene.id}
                  onDragOver={(e) => onDragOver(e, scene)}
                  onDrop={onDrop}
                  aria-label={scene.title}
                  className={cn(
                    "relative grid content-start gap-1.5 rounded-md border border-l-4 border-rule bg-raised p-3 text-sm shadow-sm",
                    STATUS_TONE[scene.status],
                    drop?.id === scene.id && (drop.after ? "shadow-[4px_0_0_var(--ghw-accent)]" : "shadow-[-4px_0_0_var(--ghw-accent)]"),
                  )}
                >
                  <div className="flex items-start gap-1">
                    <button
                      type="button"
                      data-card-handle={scene.id}
                      draggable
                      onDragStart={(e) => {
                        dragging.current = scene.id;
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", scene.title);
                      }}
                      onDragEnd={() => {
                        dragging.current = undefined;
                        setDrop(undefined);
                      }}
                      onKeyDown={(e) => onHandleKey(e, scene)}
                      aria-label={`Move “${scene.title}”`}
                      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                      className="-ml-1 cursor-grab rounded p-0.5 text-muted hover:bg-panel"
                    >
                      <GripVertical className="size-4" aria-hidden />
                    </button>
                    <Link to={`/novels/${novelId}/scene/${scene.id}`} className="font-semibold underline-offset-2 hover:underline">
                      {scene.title}
                    </Link>
                  </div>
                  {scene.synopsis && <p className="text-muted">{scene.synopsis}</p>}
                  <p className="text-xs text-muted">
                    {scene.status}
                    {scene.pov && ` · ${name(scene.pov)}`}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No scenes yet.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string | undefined; onChange: (v: string) => void; options: string[][] }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className="h-8 rounded-md border border-rule bg-raised px-2 text-sm">
        <option value="">Any</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
