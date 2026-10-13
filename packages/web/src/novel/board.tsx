import { countWords, type Novel, type Scene, type SceneStatus } from "@gh-writer/core";
import { GripVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { BoardOnGitHub, ConflictNote, useBoardStatus } from "./board-github.tsx";
import { FilterSelect, STATUS_TONE } from "./corkboard.tsx";
import { chapterTitle } from "./navigation.tsx";
import { STATUSES } from "./outline.tsx";
import { useSceneEdit } from "./scene-edit.ts";
import type { Workspace } from "./workspace.ts";

/*
 * The drafting board (#11): every scene in a column for its status, in reading order, as GitHub's
 * board shows them. Dragging a card to another column, or Alt+Left and Alt+Right on its handle,
 * changes the scene's status in its file, autosaved like any edit. Works with or without GitHub;
 * on GitHub, it can be mirrored to a project there (board-github.tsx).
 */

export const STATUS_LABEL: Record<SceneStatus, string> = { idea: "Idea", outlined: "Outlined", drafted: "Drafted", revised: "Revised", final: "Final" };

type BoardFilter = { pov?: string; part?: string; chapter?: string };

const number = new Intl.NumberFormat();
const words = (n: number) => `${number.format(n)} ${n === 1 ? "word" : "words"}`;
const scenes = (n: number) => `${number.format(n)} ${n === 1 ? "scene" : "scenes"}`;

export function OutlineBoard({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const edit = useSceneEdit(novelId, workspace);
  const conflicts = useBoardStatus(novelId)?.conflicts ?? [];
  const [params, setParams] = useSearchParams();
  const filter: BoardFilter = Object.fromEntries(["pov", "part", "chapter"].flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));
  const filtered = Object.keys(filter).length > 0;
  const dragging = useRef<string | undefined>(undefined);
  const [over, setOver] = useState<SceneStatus>();
  const name = (id: string | undefined) => novel.entities.find((e) => e.id === id)?.name;

  const counts = useMemo(() => new Map(novel.scenes.map((s) => [s.id, countWords(s.body)])), [novel]);
  const visible = novel.scenes.filter((s) => {
    const chapter = novel.chapters.find((c) => c.id === s.chapterId);
    return (!filter.pov || s.pov === filter.pov) && (!filter.chapter || s.chapterId === filter.chapter) && (!filter.part || chapter?.partId === filter.part);
  });
  const total = visible.reduce((n, s) => n + (counts.get(s.id) ?? 0), 0);

  const setFilter = (key: keyof BoardFilter, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const move = (scene: Scene, status: SceneStatus) => {
    if (scene.status === status) return Promise.resolve();
    return edit(scene, () => [{ path: ["status"], value: status }], `Moved “${scene.title}” to ${STATUS_LABEL[status]}.`);
  };

  // A card moved by keyboard keeps focus once the model reloads and draws it in its new column.
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = refocus.current;
    if (id && (document.activeElement === document.body || !document.activeElement?.isConnected)) document.querySelector<HTMLElement>(`[data-board-handle="${id}"]`)?.focus();
  }, [novel]);

  const onHandleKey = (e: KeyboardEvent, scene: Scene) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const next = STATUSES[STATUSES.indexOf(scene.status) + (e.key === "ArrowLeft" ? -1 : 1)];
    if (!next) return;
    refocus.current = scene.id;
    void move(scene, next).then(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-board-handle="${scene.id}"]`)?.focus()));
  };

  const onDragOver = (e: DragEvent, status: SceneStatus) => {
    if (!dragging.current) return;
    e.preventDefault();
    setOver(status);
  };
  const onDrop = (e: DragEvent, status: SceneStatus) => {
    e.preventDefault();
    const scene = novel.scenes.find((s) => s.id === dragging.current);
    dragging.current = undefined;
    setOver(undefined);
    if (scene) void move(scene, status);
  };

  const characters = novel.entities.filter((e) => e.type === "character").sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="grid gap-4">
      <BoardOnGitHub novelId={novelId} />
      <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Point of view" value={filter.pov} onChange={(v) => setFilter("pov", v)} options={characters.map((c) => [c.id, c.name])} />
        {novel.parts.length > 0 && <FilterSelect label="Part" value={filter.part} onChange={(v) => setFilter("part", v)} options={novel.parts.map((p, i) => [p.id, p.title || `Part ${i + 1}`])} />}
        <FilterSelect label="Chapter" value={filter.chapter} onChange={(v) => setFilter("chapter", v)} options={novel.chapters.map((c) => [c.id, chapterTitle(novel, c)])} />
        {filtered && (
          <Button size="sm" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </Button>
        )}
      </div>
      <p role="status" className="text-sm text-muted">
        {filtered ? `${visible.length} of ${scenes(novel.scenes.length)} match, ${words(total)}.` : `${scenes(visible.length)}, ${words(total)}.`}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {STATUSES.map((status) => {
          const column = visible.filter((s) => s.status === status);
          const columnWords = column.reduce((n, s) => n + (counts.get(s.id) ?? 0), 0);
          return (
            <section
              key={status}
              aria-labelledby={`board-${status}`}
              onDragOver={(e) => onDragOver(e, status)}
              onDragLeave={() => setOver((o) => (o === status ? undefined : o))}
              onDrop={(e) => onDrop(e, status)}
              className={cn("grid min-w-0 content-start gap-2 rounded-md border border-rule bg-panel p-2", over === status && "outline-2 outline-accent")}
            >
              <header className={cn("border-l-4 pl-2", STATUS_TONE[status])}>
                <h2 id={`board-${status}`} className="font-semibold">
                  {STATUS_LABEL[status]}
                </h2>
                <p className="text-xs text-muted">
                  {scenes(column.length)} · {words(columnWords)}
                </p>
              </header>
              {column.length ? (
                <ol className="grid gap-2">
                  {column.map((scene) => {
                    const chapter = novel.chapters.find((c) => c.id === scene.chapterId);
                    return (
                      <li key={scene.id} aria-label={scene.title} className="grid gap-1 rounded-md border border-rule bg-raised p-2 text-sm shadow-sm">
                        <div className="flex items-start gap-1">
                          <button
                            type="button"
                            data-board-handle={scene.id}
                            draggable
                            onDragStart={(e) => {
                              dragging.current = scene.id;
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", scene.title);
                            }}
                            onDragEnd={() => {
                              dragging.current = undefined;
                              setOver(undefined);
                            }}
                            onKeyDown={(e) => onHandleKey(e, scene)}
                            aria-label={`Move “${scene.title}”, ${STATUS_LABEL[scene.status]}`}
                            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                            className="-ml-1 cursor-grab rounded p-0.5 text-muted hover:bg-panel"
                          >
                            <GripVertical className="size-4" aria-hidden />
                          </button>
                          <Link to={`/novels/${novelId}/scene/${scene.id}`} className="min-w-0 font-semibold break-words underline-offset-2 hover:underline">
                            {scene.title}
                          </Link>
                        </div>
                        <p className="text-xs text-muted">
                          {chapter && chapterTitle(novel, chapter)}
                          {scene.pov && ` · ${name(scene.pov)}`}
                          {` · ${words(counts.get(scene.id) ?? 0)}`}
                        </p>
                        <ConflictNote conflict={conflicts.find((c) => c.scene === scene.id)} />
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="px-1 text-sm text-muted">No scenes.</p>
              )}
            </section>
          );
        })}
      </div>
      <p className="text-xs text-muted">Drag a card to another column, or press Alt+Left or Alt+Right on its handle, to change its status.</p>
    </div>
  );
}
