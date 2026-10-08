import { editYaml, type Entity, type Novel, type Scene } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "radix-ui";
import { useId, useMemo, useState } from "react";
import { api, keys } from "../api.ts";
import { GapControls } from "../diagrams/gap-controls.tsx";
import { amount, readGap, writeGap } from "../diagrams/gap-param.ts";
import { readSize, SceneGrid, SizeSelect, type GridMark } from "../diagrams/scene-grid.tsx";
import { ExportMenu } from "../diagrams/export-menu.tsx";
import { plotlinesSvg } from "@gh-writer/core/snapshots";
import { useNotice } from "../novel/notice.tsx";
import { plotlineEdits, type PlotlineChange } from "../novel/plotline-edits.ts";
import { useSceneEdit } from "../novel/scene-edit.ts";
import type { Workspace } from "../novel/workspace.ts";
import { Button } from "../ui/button.tsx";
import { useViewParams } from "../ui/view-params.ts";
import { cellKey, DEFAULT_GAP, gaps, swimlanes, zoomed, type Gap, type GapThreshold, type Mark } from "@gh-writer/core/diagrams";

const number = new Intl.NumberFormat();

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
  const size = readSize(params.get("size"));
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

  const sceneEdit = useSceneEdit(novelId, workspace);
  /** One change to a scene's link to a plotline, written to its front matter through the workspace. */
  const change = (scene: Scene, lane: Entity, what: PlotlineChange, done?: string) => sceneEdit(scene, (fm) => plotlineEdits(fm, lane.id, what), done);
  /** A cell chosen (click, Enter or Space): an empty one links its scene to the plotline; a marked one opens its editor. */
  const choose = (lane: Entity, scene: Scene, el: HTMLElement) => {
    if (s.marks.has(cellKey(lane.id, scene.id))) setEditing({ lane: lane.id, scene: scene.id, el });
    else void change(scene, lane, { link: true }, `“${scene.title}” now advances ${lane.name}.`);
  };
  const rows = s.lanes.length;
  const cols = s.scenes.length;
  const shaded = useMemo(() => new Set(inGap.keys()), [inGap]);
  const gridMarks = useMemo(() => {
    const out = new Map<string, GridMark>();
    for (const [key, m] of s.marks) out.set(key, { size: m.weight === "major" ? 0.95 : 0.7, style: m.weight === "major" ? "filled" : "hollow", ...(m.beat ? { note: m.beat } : {}) });
    return out;
  }, [s]);
  const cellEl = (lane: string, scene: string) => document.querySelector<HTMLElement>(`[data-cell="${cellKey(lane, scene)}"]`);

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
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Plotlines</h1>
        <ExportMenu name="plotlines" svg={() => plotlinesSvg(novel)} />
      </div>
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
        <SizeSelect value={size} onChange={(v) => setParams({ size: v })} />
        <GapControls
          legend="A plotline goes quiet after"
          threshold={threshold}
          onChange={(gap) => setParams({ gap })}
          extra={
            !isDefault && (
              <Button size="sm" onClick={() => void saveDefault()}>
                Make this the novel's default
              </Button>
            )
          }
        />
      </div>
      <p className="text-sm text-muted">
        Each column is a scene, in reading order. <span className="inline-block size-3 rounded-full bg-accent align-middle" aria-hidden /> a major beat,{" "}
        <span className="inline-block size-2 rounded-full border border-accent bg-accent-soft align-middle" aria-hidden /> a minor one; shaded, a plotline gone quiet for more than {amount(threshold)}.
      </p>
      <SceneGrid
        novelId={novelId}
        novel={novel}
        workspace={workspace}
        label="Plotlines by scene"
        rowHeading="Plotline"
        rows={s.lanes}
        scenes={s.scenes}
        marks={gridMarks}
        shaded={shaded}
        cellLabel={(lane, scene) => cellLabel(scene.title, s.lanes.find((l) => l.id === lane)?.name ?? lane, s.marks.get(cellKey(lane, scene.id)), inGap.get(cellKey(lane, scene.id)))}
        hasPopup={(lane, scene) => s.marks.has(cellKey(lane, scene))}
        onChoose={(lane, scene, el) => {
          const entity = s.lanes.find((l) => l.id === lane);
          if (entity) choose(entity, scene, el);
        }}
        size={size}
      />
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
