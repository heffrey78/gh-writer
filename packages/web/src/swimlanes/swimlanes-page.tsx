import type { Novel } from "@gh-writer/core";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { cn } from "../ui/cn.ts";
import { cellKey, swimlanes, type Mark } from "./swimlane-model.ts";

/** What a screen reader says for a cell. */
function cellLabel(scene: string, plotline: string, mark: Mark | undefined) {
  if (!mark) return `${scene}: doesn't advance ${plotline}`;
  return `${scene}: ${mark.weight} beat in ${plotline}${mark.beat ? `, “${mark.beat}”` : ""}`;
}

/**
 * Plotlines as lanes across the book: one column per scene in reading order, under its chapter and
 * part, and a marker in each lane the scene advances, large for a major beat and small for a minor
 * one, with the beat's note on hover or focus. Gaps show where a thread goes quiet. The cells are a
 * grid: arrow keys move between them, Home and End go to a lane's ends.
 */
export function SwimlanesPage({ novelId, novel }: { novelId: string; novel: Novel }) {
  const s = useMemo(() => swimlanes(novel), [novel]);
  const [focus, setFocus] = useState({ row: 0, col: 0 });
  const table = useRef<HTMLTableElement>(null);
  const rows = s.lanes.length;
  const cols = s.scenes.length;

  const moveTo = (row: number, col: number) => {
    const next = { row: Math.max(0, Math.min(rows - 1, row)), col: Math.max(0, Math.min(cols - 1, col)) };
    setFocus(next);
    table.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.col}"]`)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const { row, col } = focus;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [row, col - 1],
      ArrowRight: [row, col + 1],
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
      Home: e.ctrlKey ? [0, 0] : [row, 0],
      End: e.ctrlKey ? [rows - 1, cols - 1] : [row, cols - 1],
    };
    const to = moves[e.key];
    if (!to) return;
    e.preventDefault();
    moveTo(...to);
  };

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
      <p className="text-sm text-muted">
        Each column is a scene, in reading order. <span className="inline-block size-3 rounded-full bg-accent align-middle" aria-hidden /> a major beat,{" "}
        <span className="inline-block size-2 rounded-full border border-accent bg-accent-soft align-middle" aria-hidden /> a minor one.
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
                <th key={scene.id} scope="col" className="h-32 w-10 border-l border-rule align-bottom">
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
                  const active = focus.row === row && focus.col === col;
                  return (
                    <td
                      key={scene.id}
                      role="gridcell"
                      data-cell={`${row}:${col}`}
                      tabIndex={active ? 0 : -1}
                      onFocus={() => !active && setFocus({ row, col })}
                      aria-label={cellLabel(scene.title, lane.name, mark)}
                      className="group relative h-10 w-10 border-t border-l border-rule p-0 text-center outline-none focus-visible:bg-accent-soft"
                    >
                      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-rule" aria-hidden />
                      {mark && (
                        <>
                          <span
                            aria-hidden
                            className={cn(
                              "relative inline-block rounded-full align-middle",
                              mark.weight === "major" ? "size-3.5 bg-accent" : "size-2.5 border border-accent bg-accent-soft",
                            )}
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
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
