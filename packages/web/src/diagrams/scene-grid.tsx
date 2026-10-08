import type { Novel, Scene } from "@gh-writer/core";
import { GripHorizontal } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { dropMove, useStructure } from "../novel/structure.ts";
import type { Workspace } from "../novel/workspace.ts";
import { cn } from "../ui/cn.ts";
import { gridKey, sceneColumns } from "@gh-writer/core/diagrams";

/** How big a grid is drawn: its cells and its type scale together (marks are in em). */
export const SIZES = {
  small: { cell: "2.25rem", font: "0.8125rem" },
  medium: { cell: "2.75rem", font: "0.9375rem" },
  large: { cell: "3.375rem", font: "1.0625rem" },
} as const;
export type GridSize = keyof typeof SIZES;
export const readSize = (v: string | null): GridSize => (v && v in SIZES ? (v as GridSize) : "medium");

/** What a cell shows: a dot of a size (in em), filled, hollow or dashed, with an optional note on hover and focus. */
export interface GridMark {
  size: number;
  style: "filled" | "hollow" | "dashed";
  /** A ring around a filled dot (e.g. the point of view). */
  ring?: boolean;
  note?: string;
}

export interface SceneGridProps {
  novelId: string;
  novel: Novel;
  workspace: Workspace;
  /** The grid's accessible name. */
  label: string;
  /** The rows' column heading ("Plotline", "Character"). */
  rowHeading: string;
  rows: { id: string; name: string; /** Shown after the name, e.g. a count. */ aside?: string }[];
  scenes: Scene[];
  marks: Map<string, GridMark>;
  /** Cells to shade: a long absence. */
  shaded: Set<string>;
  /** What a screen reader says for a cell. */
  cellLabel: (row: string, scene: Scene) => string;
  /** Cells that open something (a popover): announced as such. */
  hasPopup?: (row: string, scene: string) => boolean;
  /** A cell chosen by click, Enter or Space. */
  onChoose: (row: string, scene: Scene, el: HTMLElement) => void;
  size: GridSize;
}

/**
 * Rows of entities against one column per scene in reading order, under chapter and part headers:
 * an ARIA grid with one tab stop (arrows, Home/End, Ctrl+Home/End move; Enter or Space choose).
 * Each column has a move handle: Alt+Left/Right steps the scene through the book as the outline
 * does, and dragging it beside another column puts it there. Cells are memoised, so a change that
 * touches a few re-renders those.
 */
export function SceneGrid({ novelId, novel, workspace, label, rowHeading, rows, scenes, marks, shaded, cellLabel, hasPopup, onChoose, size }: SceneGridProps) {
  const { chapters, parts } = useMemo(() => sceneColumns(novel, scenes), [novel, scenes]);
  const table = useRef<HTMLTableElement>(null);
  // By IDs, not positions: rows and columns can change (an edit, a reorder) under the focus.
  const [focused, setFocused] = useState<{ row: string; scene: string }>();

  // Column moves, through the same queued operations as the outline's.
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

  // Stable for the memoised header: the handlers read the latest state through a ref.
  const handlers = useRef({ onHandleKey, onDragOver, onDrop });
  handlers.current = { onHandleKey, onDragOver, onDrop };
  const stableHandleKey = useCallback((e: KeyboardEvent, scene: Scene) => handlers.current.onHandleKey(e, scene), []);
  const stableDragOver = useCallback((e: DragEvent, scene: Scene) => handlers.current.onDragOver(e, scene), []);
  const stableDrop = useCallback((e: DragEvent) => handlers.current.onDrop(e), []);
  const stableDragStart = useCallback((e: DragEvent, scene: Scene) => {
    dragging.current = scene.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", scene.title);
  }, []);
  const stableDragEnd = useCallback(() => {
    dragging.current = undefined;
    setDrop(undefined);
  }, []);

  // Stable for the memoised cells: they read the latest props through a ref.
  const latest = useRef({ onChoose, scenes });
  latest.current = { onChoose, scenes };
  const choose = useCallback((row: string, sceneId: string, el: HTMLElement) => {
    const scene = latest.current.scenes.find((x) => x.id === sceneId);
    if (scene) latest.current.onChoose(row, scene, el);
  }, []);
  const onFocusCell = useCallback((row: string, scene: string) => setFocused({ row, scene }), []);

  const cellEl = (row: string, scene: string) => table.current?.querySelector<HTMLElement>(`[data-cell="${gridKey(row, scene)}"]`);
  const focusRow = Math.max(0, rows.findIndex((r) => r.id === focused?.row));
  const focusCol = Math.max(0, scenes.findIndex((x) => x.id === focused?.scene));
  const moveTo = (r: number, c: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, r))]!;
    const scene = scenes[Math.max(0, Math.min(scenes.length - 1, c))]!;
    setFocused({ row: row.id, scene: scene.id });
    cellEl(row.id, scene.id)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    // Only the cells' own keys: the column handles above them (Alt+arrows) are in the table too.
    if ((e.target as HTMLElement).getAttribute("role") !== "gridcell" || e.altKey) return;
    const [r, c] = [focusRow, focusCol];
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const row = rows[r]!;
      const scene = scenes[c]!;
      const el = cellEl(row.id, scene.id);
      if (el) onChoose(row.id, scene, el);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [r, c - 1],
      ArrowRight: [r, c + 1],
      ArrowUp: [r - 1, c],
      ArrowDown: [r + 1, c],
      Home: e.ctrlKey ? [0, 0] : [r, 0],
      End: e.ctrlKey ? [rows.length - 1, scenes.length - 1] : [r, scenes.length - 1],
    };
    const to = moves[e.key];
    if (!to) return;
    e.preventDefault();
    moveTo(...to);
  };

  return (
    <div className="w-fit max-w-full overflow-x-auto rounded-lg border border-rule">
      <table ref={table} role="grid" aria-label={label} onKeyDown={onKey} style={{ "--cell": SIZES[size].cell, fontSize: SIZES[size].font } as CSSProperties} className="border-collapse">
        <GridHead
          novelId={novelId}
          scenes={scenes}
          chapters={chapters}
          parts={parts}
          rowHeading={rowHeading}
          drop={drop}
          onHandleKey={stableHandleKey}
          onDragStartScene={stableDragStart}
          onDragEndScene={stableDragEnd}
          onDragOverScene={stableDragOver}
          onDropScene={stableDrop}
        />
        <tbody>
          {rows.map((row, r) => (
            <tr key={row.id}>
              <th scope="row" className="sticky left-0 z-10 max-w-[16em] truncate border-t border-rule bg-paper px-3 py-2 text-left font-medium">
                {row.name}
                {row.aside && <span className="ml-2 text-[0.85em] font-normal text-muted tabular-nums">{row.aside}</span>}
              </th>
              {scenes.map((scene, c) => {
                const key = gridKey(row.id, scene.id);
                return (
                  <Cell
                    key={scene.id}
                    row={row.id}
                    scene={scene.id}
                    label={cellLabel(row.id, scene)}
                    mark={marks.get(key)}
                    popup={hasPopup?.(row.id, scene.id) ?? false}
                    shaded={shaded.has(key)}
                    active={r === focusRow && c === focusCol}
                    onChoose={choose}
                    onFocusCell={onFocusCell}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Cell = memo(function Cell({
  row,
  scene,
  label,
  mark,
  popup,
  shaded,
  active,
  onChoose,
  onFocusCell,
}: {
  row: string;
  scene: string;
  label: string;
  mark: GridMark | undefined;
  popup: boolean;
  shaded: boolean;
  active: boolean;
  onChoose: (row: string, scene: string, el: HTMLElement) => void;
  onFocusCell: (row: string, scene: string) => void;
}) {
  return (
    <td
      role="gridcell"
      data-cell={gridKey(row, scene)}
      tabIndex={active ? 0 : -1}
      onFocus={() => !active && onFocusCell(row, scene)}
      onClick={(e) => onChoose(row, scene, e.currentTarget)}
      aria-label={label}
      aria-haspopup={popup ? "dialog" : undefined}
      className={cn(
        "group relative h-[var(--cell)] w-[var(--cell)] cursor-pointer border-t border-l border-rule p-0 text-center outline-none hover:bg-panel focus-visible:bg-accent-soft",
        shaded && "bg-warn-soft",
      )}
    >
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-rule" aria-hidden />
      {mark && (
        <>
          <span
            aria-hidden
            style={{ width: `${mark.size}em`, height: `${mark.size}em` }}
            className={cn(
              "relative inline-block rounded-full align-middle",
              mark.style === "filled" && "bg-accent",
              mark.style === "hollow" && "border border-accent bg-accent-soft",
              mark.style === "dashed" && "border border-dashed border-accent bg-paper",
              mark.ring && "ring-2 ring-accent ring-offset-2 ring-offset-[var(--ghw-paper)]",
            )}
          />
          {mark.note && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-full left-1/2 z-20 mt-1 hidden w-56 -translate-x-1/2 rounded-md border border-rule bg-raised px-2 py-1 text-left text-[0.85em] shadow-md group-hover:block group-focus:block"
            >
              {mark.note}
            </span>
          )}
        </>
      )}
    </td>
  );
});

/** The Size control the grid views share. */
export function SizeSelect({ value, onChange }: { value: GridSize; onChange: (size: GridSize | undefined) => void }) {
  return (
    <label className="grid gap-1 font-medium">
      Size
      <select value={value} onChange={(e) => onChange(e.target.value === "medium" ? undefined : (e.target.value as GridSize))} className="h-8 rounded-md border border-rule bg-raised px-2 font-normal">
        <option value="small">Small</option>
        <option value="medium">Medium</option>
        <option value="large">Large</option>
      </select>
    </label>
  );
}

/** The chapter, part and scene headers: memoised, as nothing in them changes when the cells do. */
const GridHead = memo(function GridHead({
  novelId,
  scenes,
  chapters,
  parts,
  rowHeading,
  drop,
  onHandleKey,
  onDragStartScene,
  onDragEndScene,
  onDragOverScene,
  onDropScene,
}: {
  novelId: string;
  scenes: Scene[];
  chapters: ReturnType<typeof sceneColumns>["chapters"];
  parts: ReturnType<typeof sceneColumns>["parts"];
  rowHeading: string;
  drop: { id: string; after: boolean } | undefined;
  onHandleKey: (e: KeyboardEvent, scene: Scene) => void;
  onDragStartScene: (e: DragEvent, scene: Scene) => void;
  onDragEndScene: () => void;
  onDragOverScene: (e: DragEvent, scene: Scene) => void;
  onDropScene: (e: DragEvent) => void;
}) {
  return (
    <thead>
      {parts.length > 0 && (
        <tr>
          <td className="sticky left-0 z-10 bg-paper" />
          {parts.map(({ part, span }) => (
            <th key={part.id} scope="colgroup" colSpan={span} className="border-b border-l border-rule px-2 py-1 text-left text-xs font-semibold tracking-wide text-muted uppercase">
              {part.title}
            </th>
          ))}
        </tr>
      )}
      <tr>
        <td className="sticky left-0 z-10 bg-paper" />
        {chapters.map(({ chapter, title, span }) => (
          <th key={chapter.id} scope="colgroup" colSpan={span} className="border-b border-l border-rule px-2 py-1 text-left font-semibold">
            <Link to={`/novels/${novelId}/chapter/${chapter.id}`} tabIndex={-1} className="underline-offset-2 hover:underline">
              {title}
            </Link>
          </th>
        ))}
      </tr>
      <tr>
        <th scope="col" className="sticky left-0 z-10 bg-paper px-3 py-1 text-left text-xs font-medium text-muted">
          {rowHeading}
        </th>
        {scenes.map((scene) => (
          <th
            key={scene.id}
            scope="col"
            onDragOver={(e) => onDragOverScene(e, scene)}
            onDrop={onDropScene}
            className={cn(
              "h-[calc(var(--cell)*3.6)] w-[var(--cell)] border-l border-rule align-bottom",
              drop?.id === scene.id && (drop.after ? "shadow-[inset_-3px_0_0_var(--ghw-accent)]" : "shadow-[inset_3px_0_0_var(--ghw-accent)]"),
            )}
          >
            <button
              type="button"
              data-col-handle={scene.id}
              draggable
              onDragStart={(e) => onDragStartScene(e, scene)}
              onDragEnd={onDragEndScene}
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
              className="mx-auto block max-h-[calc(var(--cell)*3.2)] truncate px-1 py-1 text-[0.85em] font-normal underline-offset-2 [writing-mode:vertical-rl] hover:underline"
            >
              {scene.title}
            </Link>
          </th>
        ))}
      </tr>
    </thead>
  );
});
