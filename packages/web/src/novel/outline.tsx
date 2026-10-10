import { countWords, type Novel, type Scene, type SceneStatus } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { keys } from "../api.ts";
import { cn } from "../ui/cn.ts";
import { chapterTitle } from "./navigation.tsx";
import { useNotice } from "./notice.tsx";
import { dropMove, useStructure } from "./structure.ts";
import type { Workspace } from "./workspace.ts";

export const STATUSES: SceneStatus[] = ["idea", "outlined", "drafted", "revised", "final"];
const number = new Intl.NumberFormat();

/**
 * The book as an outline: every scene in reading order under its part and chapter, with synopsis,
 * status, point of view, people, plotlines and words. Synopsis and status are edited in place; rows
 * move with Alt+Up/Down on their handle, or by dragging it.
 */
/** Outline as a table: every scene in reading order, with its synopsis and status edited in place. */
export function OutlineTable({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const structure = useStructure(novelId, novel, workspace);
  const queryClient = useQueryClient();
  const show = useNotice((s) => s.show);
  const dragging = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const name = (id: string | undefined) => novel.entities.find((e) => e.id === id)?.name;

  const edit = async (scene: Scene, key: "synopsis" | "status", value: string) => {
    try {
      await workspace.editFrontMatter(scene.file, [value ? { path: [key], value } : { path: [key], remove: true }]);
      await workspace.autosave.flush();
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
    } catch (e) {
      show({ message: `Couldn't save the ${key}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // A row moved by keyboard keeps focus, even when it lands in another chapter (a new element)
  // after the model reloads: focus left on nothing goes back to its handle.
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = refocus.current;
    if (id && (document.activeElement === document.body || !document.activeElement?.isConnected)) document.querySelector<HTMLElement>(`[data-handle="${id}"]`)?.focus();
  }, [novel]);

  const onHandleKey = (e: KeyboardEvent, scene: Scene) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    refocus.current = scene.id;
    const handle = e.currentTarget as HTMLElement;
    void Promise.resolve(structure.step(scene.id, e.key === "ArrowUp" ? -1 : 1)).then(() =>
      requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-handle="${scene.id}"]`) ?? handle).focus()),
    );
  };

  const onDragOver = (e: DragEvent, scene: Scene) => {
    if (!dragging.current || dragging.current === scene.id) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDrop({ id: scene.id, after: e.clientY > rect.top + rect.height / 2 });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const id = dragging.current;
    const target = drop;
    dragging.current = undefined;
    setDrop(undefined);
    const move = id && target ? dropMove(novel, id, target.id, target.after) : undefined;
    if (id && move) void structure.move(id, move.index, move.to);
  };

  const groups = novel.chapters.map((c) => ({
    chapter: c,
    part: novel.parts.find((p) => p.id === c.partId),
    scenes: c.sceneIds.map((id) => novel.allScenes.find((s) => s.id === id)).filter((s): s is Scene => s !== undefined),
  }));

  return (
    <div className="grid gap-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <caption className="sr-only">Every scene in reading order, by chapter</caption>
          <thead>
            <tr className="border-b border-rule text-left text-xs text-muted">
              <th scope="col" className="w-8 py-2">
                <span className="sr-only">Move</span>
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
            {groups.map(({ chapter, part, scenes }, i) => (
              <Fragment key={chapter.id}>
                {part && part.id !== groups[i - 1]?.part?.id && (
                  <tr>
                    <th scope="colgroup" colSpan={8} className="pt-5 pb-1 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                      {part.title}
                    </th>
                  </tr>
                )}
                <tr>
                  <th scope="colgroup" colSpan={8} className="pt-3 pb-1 text-left font-semibold">
                    <Link to={`/novels/${novelId}/chapter/${chapter.id}`} className="underline-offset-2 hover:underline">
                      {chapterTitle(novel, chapter)}
                    </Link>
                  </th>
                </tr>
                {scenes.map((scene) => (
                  <tr
                    key={scene.id}
                    onDragOver={(e) => onDragOver(e, scene)}
                    onDrop={onDrop}
                    className={cn(
                      "border-b border-rule align-top",
                      drop?.id === scene.id && (drop.after ? "shadow-[inset_0_-2px_0_var(--ghw-accent)]" : "shadow-[inset_0_2px_0_var(--ghw-accent)]"),
                    )}
                  >
                    <td className="py-2">
                      <button
                        type="button"
                        data-handle={scene.id}
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
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        className="cursor-grab rounded p-0.5 text-muted hover:bg-panel"
                      >
                        <GripVertical className="size-4" aria-hidden />
                      </button>
                    </td>
                    <td className="py-2 pr-3">
                      <Link to={`/novels/${novelId}/scene/${scene.id}`} className="font-medium underline-offset-2 hover:underline">
                        {scene.title}
                      </Link>
                    </td>
                    <td className="py-1 pr-3">
                      <Synopsis scene={scene} onSave={(v) => void edit(scene, "synopsis", v)} />
                    </td>
                    <td className="py-1 pr-3">
                      <select
                        aria-label={`Status of “${scene.title}”`}
                        value={scene.status}
                        onChange={(e) => void edit(scene, "status", e.target.value)}
                        className="h-8 w-full rounded-md border border-rule bg-raised px-1.5"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 pr-3">{name(scene.pov) ?? <span className="text-muted">—</span>}</td>
                    <td className="py-2 pr-3">{scene.characters.map(name).filter(Boolean).join(", ") || <span className="text-muted">—</span>}</td>
                    <td className="py-2 pr-3">{scene.plotlines.map((p) => name(p.id)).filter(Boolean).join(", ") || <span className="text-muted">—</span>}</td>
                    <td className="py-2 text-right tabular-nums">{number.format(countWords(scene.body))}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The synopsis, editable in place: saved when it loses focus, or on Enter. */
function Synopsis({ scene, onSave }: { scene: Scene; onSave: (value: string) => void }) {
  const [value, setValue] = useState(scene.synopsis ?? "");
  const [seen, setSeen] = useState(scene.synopsis ?? "");
  // Take the saved value when it changes from outside (another editor, a reload).
  if ((scene.synopsis ?? "") !== seen) {
    setSeen(scene.synopsis ?? "");
    setValue(scene.synopsis ?? "");
  }
  const save = () => value.trim() !== (scene.synopsis ?? "") && onSave(value.trim());
  return (
    <textarea
      aria-label={`Synopsis of “${scene.title}”`}
      value={value}
      rows={2}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") setValue(scene.synopsis ?? "");
      }}
      placeholder="Add a synopsis"
      className="w-full resize-y rounded-md border border-transparent bg-transparent px-1.5 py-1 hover:border-rule focus:border-rule focus:bg-raised"
    />
  );
}
