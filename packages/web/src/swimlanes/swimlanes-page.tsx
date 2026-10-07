import { editYaml, readFrontMatter, type Entity, type Novel, type Scene } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "radix-ui";
import { GripHorizontal } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { api, keys } from "../api.ts";
import { useNotice } from "../novel/notice.tsx";
import { plotlineEdits, type PlotlineChange } from "../novel/plotline-edits.ts";
import { dropMove, useStructure } from "../novel/structure.ts";
import type { Workspace } from "../novel/workspace.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { useViewParams } from "../ui/view-params.ts";
import { cellKey, DEFAULT_GAP, gaps, swimlanes, zoomed, type Gap, type GapThreshold, type Mark } from "./swimlane-model.ts";

const number = new Intl.NumberFormat();
const amount = (t: GapThreshold) => ("scenes" in t ? `${t.scenes} scene${t.scenes === 1 ? "" : "s"}` : `${number.format(t.words)} words`);
/** The threshold in the address: "3" scenes, or "5000w" words. */
const readGap = (v: string | null): GapThreshold | undefined => {
  const m = v ? /^(\d+)(w?)$/.exec(v) : null;
  return m ? (m[2] ? { words: Number(m[1]) } : { scenes: Number(m[1]) }) : undefined;
};
const writeGap = (t: GapThreshold) => ("scenes" in t ? String(t.scenes) : `${t.words}w`);

/** What a screen reader says for a cell. */
function cellLabel(scene: string, plotline: string, mark: Mark | undefined, gap?: Gap) {
  if (!mark) return `${scene}: doesn't advance ${plotline}${gap ? `, in a quiet stretch of ${gap.scenes} scene${gap.scenes === 1 ? "" : "s"}` : ""}`;
  return `${scene}: ${mark.weight} beat in ${plotline}${mark.beat ? `, “${mark.beat}”` : ""}`;
}

/**
 * Plotlines as lanes across the book: one column per scene in reading order, under its chapter and
 * part, and a marker in each lane the scene advances, large for a major beat and small for a minor
 * one, with the beat's note on hover or focus. Gaps show where a thread goes quiet. The cells are a
 * grid: arrow keys move between them, Home and End go to a lane's ends.
 */
export function SwimlanesPage({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const [params, setParams] = useViewParams();
  const zoom = params.get("zoom") ?? undefined;
  const saved = novel.config?.plotline_gap ?? DEFAULT_GAP;
  const threshold = readGap(params.get("gap")) ?? saved;
  // Gaps are found in the whole book (a quiet stretch can cross the zoom's edge); the grid shows the zoom.
  const whole = useMemo(() => swimlanes(novel), [novel]);
  const s = useMemo(() => swimlanes(novel, zoomed(novel, novel.scenes, zoom)), [novel, zoom]);
  const gapList = useMemo(() => gaps(whole, threshold), [whole, writeGap(threshold)]); // eslint-disable-line react-hooks/exhaustive-deps
  const inGap = useMemo(() => {
    const out = new Map<string, Gap>();
    const order = whole.scenes.map((x) => x.id);
    for (const g of gapList) for (const id of order.slice(order.indexOf(g.from), order.indexOf(g.to) + 1)) out.set(cellKey(g.lane, id), g);
    return out;
  }, [gapList, whole]);
  const isDefault = writeGap(threshold) === writeGap(saved);
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  // The cell whose link is being edited, and its element, for the popover to sit by.
  // By IDs, not positions: the lanes and columns can change (an edit, a reorder) under them.
  const [editing, setEditing] = useState<{ lane: string; scene: string; el: HTMLElement }>();

  /** The threshold shown becomes the novel's own, in novel.yaml (committed with the next autosave). */
  const saveDefault = async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { content, hash } = await api.readFile(novelId, "novel.yaml");
        const result = await api.writeFile(novelId, "novel.yaml", editYaml(content, [{ path: ["plotline_gap"], value: threshold }]), hash);
        if (result.ok) break;
      }
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      setParams({ gap: undefined });
      show({ message: `Gaps are now ${amount(threshold)} for this novel.` });
    } catch (e) {
      show({ message: `Couldn't save it: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  /** One change to a scene's link to a plotline, written to its front matter through the workspace. */
  const change = async (scene: Scene, lane: Entity, what: PlotlineChange, done?: string) => {
    try {
      const open = workspace.store.getState().files[scene.file];
      const text = open ? joinSceneFile(open) : (await api.readFile(novelId, scene.file)).content;
      const edits = plotlineEdits(readFrontMatter(text) ?? {}, lane.id, what);
      if (!edits.length) return;
      await workspace.editFrontMatter(scene.file, edits);
      await workspace.autosave.flush();
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      if (done) show({ message: done });
    } catch (e) {
      show({ message: `Couldn't change “${scene.title}”: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  /** A cell chosen (click, Enter or Space): an empty one links its scene to the plotline; a marked one opens its editor. */
  const choose = (lane: Entity, scene: Scene, el: HTMLElement) => {
    if (s.marks.has(cellKey(lane.id, scene.id))) setEditing({ lane: lane.id, scene: scene.id, el });
    else void change(scene, lane, { link: true }, `“${scene.title}” now advances ${lane.name}.`);
  };
  const [focused, setFocused] = useState<{ lane: string; scene: string }>();
  const table = useRef<HTMLTableElement>(null);
  const rows = s.lanes.length;
  const cols = s.scenes.length;

  // Columns move like the outline's rows: Alt+Left/Right steps a scene through the book, a drag puts
  // it beside the column it's dropped on. A moved column keeps focus, even in another chapter.
  const structure = useStructure(novelId, novel, workspace);
  const dragging = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = refocus.current;
    if (id && (document.activeElement === document.body || !document.activeElement?.isConnected)) document.querySelector<HTMLElement>(`[data-col-handle="${id}"]`)?.focus();
  }, [novel]);
  const onHandleKey = (e: KeyboardEvent, scene: Scene) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    refocus.current = scene.id;
    void Promise.resolve(structure.step(scene.id, e.key === "ArrowLeft" ? -1 : 1)).then(() =>
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-col-handle="${scene.id}"]`)?.focus()),
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
    const move = id && target ? dropMove(novel, id, target.id, target.after) : undefined;
    if (id && move) void structure.move(id, move.index, move.to);
  };

  // Stable for the memoised cells: they read the latest page state through refs.
  const latest = useRef({ choose: (_l: Entity, _s: Scene, _e: HTMLElement) => {}, s });
  latest.current = { choose, s };
  const onChoose = useCallback((laneId: string, sceneId: string, el: HTMLElement) => {
    const { choose: pick, s: now } = latest.current;
    const lane = now.lanes.find((l) => l.id === laneId);
    const scene = now.scenes.find((x) => x.id === sceneId);
    if (lane && scene) pick(lane, scene, el);
  }, []);
  const onFocusCell = useCallback((lane: string, scene: string) => setFocused({ lane, scene }), []);

  const cellEl = (lane: string, scene: string) => table.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(lane, scene)}"]`);
  // The focused cell's place now: where its lane and scene are (the first cell if they're gone).
  const focusRow = Math.max(0, s.lanes.findIndex((l) => l.id === focused?.lane));
  const focusCol = Math.max(0, s.scenes.findIndex((x) => x.id === focused?.scene));
  const moveTo = (r: number, c: number) => {
    const lane = s.lanes[Math.max(0, Math.min(rows - 1, r))]!;
    const scene = s.scenes[Math.max(0, Math.min(cols - 1, c))]!;
    setFocused({ lane: lane.id, scene: scene.id });
    cellEl(lane.id, scene.id)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    // Only the cells' own keys: the column handles above them (Alt+arrows) are in the table too.
    if ((e.target as HTMLElement).getAttribute("role") !== "gridcell" || e.altKey) return;
    const [row, col] = [focusRow, focusCol];
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [row, col - 1],
      ArrowRight: [row, col + 1],
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
      Home: e.ctrlKey ? [0, 0] : [row, 0],
      End: e.ctrlKey ? [rows - 1, cols - 1] : [row, cols - 1],
    };
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const lane = s.lanes[row]!;
      const scene = s.scenes[col]!;
      const el = cellEl(lane.id, scene.id);
      if (el) choose(lane, scene, el);
      return;
    }
    const to = moves[e.key];
    if (!to) return;
    e.preventDefault();
    moveTo(...to);
  };

  const editingLane = editing && s.lanes.find((l) => l.id === editing.lane);
  const editingScene = editing && s.scenes.find((x) => x.id === editing.scene);

  if (!rows || !cols) {
    return (
      <div className="grid gap-3 px-6 py-6">
        <h1 className="text-xl font-semibold">Plotlines</h1>
        <p className="text-muted">{!rows ? "No plotlines yet. Add some in the story bible, then mark the scenes that advance them." : "The manuscript has no scenes yet."}</p>
      </div>
    );
  }

  return (
    <div className="grid content-start gap-3 px-6 py-6">
      <h1 className="text-xl font-semibold">Plotlines</h1>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="grid gap-1 font-medium">
          Show
          <select value={zoom ?? ""} onChange={(e) => setParams({ zoom: e.target.value || undefined })} className="h-8 rounded-md border border-rule bg-raised px-2 font-normal">
            <option value="">The whole book</option>
            {novel.parts.map((p) => (
              <option key={p.id} value={p.id}>
                Part: {p.title}
              </option>
            ))}
            {whole.chapters.map(({ chapter, title }) => (
              <option key={chapter.id} value={chapter.id}>
                Chapter: {title}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex items-end gap-2">
          <legend className="mb-1 font-medium">A plotline goes quiet after</legend>
          <input
            type="number"
            min={0}
            aria-label="How many"
            value={"scenes" in threshold ? threshold.scenes : threshold.words}
            onChange={(e) => {
              const n = Math.max(0, Math.round(Number(e.target.value) || 0));
              setParams({ gap: writeGap("scenes" in threshold ? { scenes: n } : { words: n }) });
            }}
            className="h-8 w-24 rounded-md border border-rule bg-raised px-2"
          />
          <select
            aria-label="Counted in"
            value={"scenes" in threshold ? "scenes" : "words"}
            onChange={(e) => setParams({ gap: writeGap(e.target.value === "words" ? { words: 5000 } : { scenes: 3 }) })}
            className="h-8 rounded-md border border-rule bg-raised px-2"
          >
            <option value="scenes">scenes</option>
            <option value="words">words</option>
          </select>
          {!isDefault && (
            <Button size="sm" onClick={() => void saveDefault()}>
              Make this the novel's default
            </Button>
          )}
        </fieldset>
      </div>
      <p className="text-sm text-muted">
        Each column is a scene, in reading order. <span className="inline-block size-3 rounded-full bg-accent align-middle" aria-hidden /> a major beat,{" "}
        <span className="inline-block size-2 rounded-full border border-accent bg-accent-soft align-middle" aria-hidden /> a minor one; shaded, a plotline gone quiet for more than {amount(threshold)}.
      </p>
      <div className="overflow-x-auto rounded-lg border border-rule">
        <table ref={table} role="grid" aria-label="Plotlines by scene" onKeyDown={onKey} className="border-collapse text-sm">
          <thead>
            {s.parts.length > 0 && (
              <tr>
                <td className="sticky left-0 z-10 bg-paper" />
                {s.parts.map(({ part, span }) => (
                  <th key={part.id} scope="colgroup" colSpan={span} className="border-b border-l border-rule px-2 py-1 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                    {part.title}
                  </th>
                ))}
              </tr>
            )}
            <tr>
              <td className="sticky left-0 z-10 bg-paper" />
              {s.chapters.map(({ chapter, title, span }) => (
                <th key={chapter.id} scope="colgroup" colSpan={span} className="border-b border-l border-rule px-2 py-1 text-left font-semibold">
                  <Link to={`/novels/${novelId}/chapter/${chapter.id}`} tabIndex={-1} className="underline-offset-2 hover:underline">
                    {title}
                  </Link>
                </th>
              ))}
            </tr>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-paper px-3 py-1 text-left text-xs font-medium text-muted">
                Plotline
              </th>
              {s.scenes.map((scene) => (
                <th
                  key={scene.id}
                  scope="col"
                  onDragOver={(e) => onDragOver(e, scene)}
                  onDrop={onDrop}
                  className={cn(
                    "h-36 w-10 border-l border-rule align-bottom",
                    drop?.id === scene.id && (drop.after ? "shadow-[inset_-3px_0_0_var(--ghw-accent)]" : "shadow-[inset_3px_0_0_var(--ghw-accent)]"),
                  )}
                >
                  <button
                    type="button"
                    data-col-handle={scene.id}
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
                    className="mx-auto block cursor-grab rounded p-0.5 text-muted hover:bg-panel"
                  >
                    <GripHorizontal className="size-4" aria-hidden />
                  </button>
                  <Link
                    to={`/novels/${novelId}/scene/${scene.id}`}
                    tabIndex={-1}
                    title={scene.title}
                    className="mx-auto block max-h-32 truncate px-1 py-1 text-xs font-normal underline-offset-2 [writing-mode:vertical-rl] hover:underline"
                  >
                    {scene.title}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.lanes.map((lane, row) => (
              <tr key={lane.id}>
                <th scope="row" className="sticky left-0 z-10 max-w-48 truncate border-t border-rule bg-paper px-3 py-2 text-left font-medium">
                  {lane.name}
                </th>
                {s.scenes.map((scene, col) => {
                  const mark = s.marks.get(cellKey(lane.id, scene.id));
                  const gap = inGap.get(cellKey(lane.id, scene.id));
                  const active = row === focusRow && col === focusCol;
                  return (
                    <Cell
                      key={scene.id}
                      lane={lane.id}
                      scene={scene.id}
                      label={cellLabel(scene.title, lane.name, mark, gap)}
                      mark={mark}
                      quiet={gap !== undefined}
                      active={active}
                      onChoose={onChoose}
                      onFocusCell={onFocusCell}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section aria-labelledby="quiet-heading" className="grid gap-1 text-sm">
        <h2 id="quiet-heading" className="font-semibold">
          Quiet stretches
        </h2>
        {gapList.length ? (
          <ul className="grid gap-1">
            {gapList.map((g) => {
              const lane = whole.lanes.find((l) => l.id === g.lane)?.name;
              const title = (id: string) => whole.scenes.find((x) => x.id === id)?.title;
              const where = g.from === g.to ? `at “${title(g.from)}”` : `from “${title(g.from)}” to “${title(g.to)}”`;
              return (
                <li key={`${g.lane}-${g.from}`}>
                  {lane}: quiet for {g.scenes} scene{g.scenes === 1 ? "" : "s"} ({number.format(g.words)} words) {where}
                  {g.open ? ", and never picked up again" : ""}.
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted">No plotline goes quiet for more than {amount(threshold)}.</p>
        )}
      </section>
      {editingLane && editingScene && editing && (
        <CellEditor
          anchor={editing.el}
          scene={editingScene}
          lane={editingLane}
          mark={s.marks.get(cellKey(editingLane.id, editingScene.id))}
          onChange={(what, done) => change(editingScene, editingLane, what, done)}
          onClose={() => {
            const el = cellEl(editing.lane, editing.scene);
            setEditing(undefined);
            el?.focus();
          }}
        />
      )}
    </div>
  );
}

/** A scene's link to a plotline: its weight, its beat, or taking it away. */
function CellEditor({
  anchor,
  scene,
  lane,
  mark,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  scene: Scene;
  lane: Entity;
  mark: Mark | undefined;
  onChange: (what: PlotlineChange, done?: string) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [beat, setBeat] = useState(mark?.beat ?? "");
  const saveBeat = () => beat.trim() !== (mark?.beat ?? "") && void onChange({ beat });
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor virtualRef={{ current: anchor }} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          sideOffset={4}
          aria-labelledby={`${id}-title`}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-[80] grid w-72 gap-3 rounded-lg border border-rule bg-raised p-4 text-sm text-ink shadow-lg"
        >
          <p id={`${id}-title`} className="font-semibold">
            “{scene.title}” in {lane.name}
          </p>
          <label className="grid gap-1 font-medium">
            Weight
            <select
              value={mark?.weight ?? "major"}
              onChange={(e) => void onChange({ weight: e.target.value as "major" | "minor" })}
              className="h-8 rounded-md border border-rule bg-raised px-2 font-normal"
            >
              <option value="major">Major beat</option>
              <option value="minor">Minor beat</option>
            </select>
          </label>
          <label className="grid gap-1 font-medium">
            Beat
            <input
              value={beat}
              onChange={(e) => setBeat(e.target.value)}
              onBlur={saveBeat}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveBeat();
                }
              }}
              placeholder="What happens to it here"
              className="h-8 rounded-md border border-rule bg-raised px-2 font-normal"
            />
          </label>
          <div className="flex justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void onChange({ remove: true }, `“${scene.title}” no longer advances ${lane.name}.`);
                onClose();
              }}
            >
              Remove from this plotline
            </Button>
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * One cell of the grid: memoised, so a change that touches a few cells (an edit, a new gap
 * threshold) re-renders those, not all of them.
 */
const Cell = memo(function Cell({
  lane,
  scene,
  label,
  mark,
  quiet,
  active,
  onChoose,
  onFocusCell,
}: {
  lane: string;
  scene: string;
  label: string;
  mark: Mark | undefined;
  quiet: boolean;
  active: boolean;
  onChoose: (lane: string, scene: string, el: HTMLElement) => void;
  onFocusCell: (lane: string, scene: string) => void;
}) {
  return (
    <td
      role="gridcell"
      data-cell={cellKey(lane, scene)}
      tabIndex={active ? 0 : -1}
      onFocus={() => !active && onFocusCell(lane, scene)}
      onClick={(e) => onChoose(lane, scene, e.currentTarget)}
      aria-label={label}
      aria-haspopup={mark ? "dialog" : undefined}
      className={cn(
        "group relative h-10 w-10 cursor-pointer border-t border-l border-rule p-0 text-center outline-none hover:bg-panel focus-visible:bg-accent-soft",
        quiet && "bg-warn-soft",
      )}
    >
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-rule" aria-hidden />
      {mark && (
        <>
          <span
            aria-hidden
            className={cn("relative inline-block rounded-full align-middle", mark.weight === "major" ? "size-3.5 bg-accent" : "size-2.5 border border-accent bg-accent-soft")}
          />
          {mark.beat && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-full left-1/2 z-20 mt-1 hidden w-48 -translate-x-1/2 rounded-md border border-rule bg-raised px-2 py-1 text-left text-xs shadow-md group-hover:block group-focus:block"
            >
              {mark.beat}
            </span>
          )}
        </>
      )}
    </td>
  );
});
