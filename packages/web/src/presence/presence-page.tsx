import type { Entity, Novel, Scene, YamlEdit } from "@gh-writer/core";
import { Popover } from "radix-ui";
import { useId, useMemo, useState } from "react";
import { plural } from "../bible/types.ts";
import { gridKey } from "../diagrams/columns.ts";
import { readSize, SceneGrid, SizeSelect, type GridMark } from "../diagrams/scene-grid.tsx";
import { useNotice } from "../novel/notice.tsx";
import { entryEdits, type EntryChange } from "../novel/plotline-edits.ts";
import { useSceneEdit } from "../novel/scene-edit.ts";
import type { Workspace } from "../novel/workspace.ts";
import { Button } from "../ui/button.tsx";
import { DEFAULT_GAP, gaps, zoomed, type Gap } from "../swimlanes/swimlane-model.ts";
import { GapControls } from "../diagrams/gap-controls.tsx";
import { amount, readGap, writeGap } from "../diagrams/gap-param.ts";
import { useViewParams } from "../ui/view-params.ts";
import { LISTS, presence, sortRows, totals, type Presence, type RowOrder } from "./presence-model.ts";

const number = new Intl.NumberFormat();
const ORDERS: [RowOrder, string][] = [
  ["first", "First appearance"],
  ["total", "Most scenes"],
  ["name", "Name"],
];

/** How a presence is drawn: the point of view ringed, a listing filled (a theme's by its strength), a mention alone dashed. */
function markOf(p: Presence): GridMark {
  const note = p.note ? { note: p.note } : {};
  if (!p.listed) return { size: 0.7, style: "dashed", ...note };
  if (p.weight) return { size: p.weight === "major" ? 0.95 : 0.7, style: p.weight === "major" ? "filled" : "hollow", ...note };
  if (p.strength !== undefined) return { size: 0.55 + 0.15 * p.strength, style: "filled", ...note };
  return { size: 0.8, style: "filled", ...(p.pov ? { ring: true } : {}), ...note };
}

/** What a screen reader says for a cell. */
function describe(scene: string, name: string, p: Presence | undefined, gap?: Gap): string {
  if (!p) return `${scene}: ${name} not there${gap ? `, in an absence of ${gap.scenes} scene${gap.scenes === 1 ? "" : "s"}` : ""}`;
  if (!p.listed) return `${scene}: ${name} mentioned only`;
  const how = [p.pov ? "point of view" : "", p.strength !== undefined ? `strength ${p.strength}` : "", p.weight ? `${p.weight} beat` : "", p.note ? `“${p.note}”` : ""].filter(Boolean).join(", ");
  return `${scene}: ${name} present${how ? `, ${how}` : ""}`;
}

/**
 * Who and what is where: the entries of a type (characters by default) against every scene in
 * reading order, from the scenes' metadata, with mentions in the prose shown apart. The type, zoom
 * and size live in the address.
 */
export function PresencePage({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const [params, setParams] = useViewParams();
  const type = novel.entityTypes.some((t) => t.key === params.get("type")) ? params.get("type")! : "character";
  const zoom = params.get("zoom") ?? undefined;
  const size = readSize(params.get("size"));
  const label = novel.entityTypes.find((t) => t.key === type)?.label ?? type;
  const order: RowOrder = (["first", "total", "name"] as const).find((o) => o === params.get("sort")) ?? "first";
  const threshold = readGap(params.get("gap")) ?? DEFAULT_GAP;
  // Absences are found in the whole book (one can cross the zoom's edge); the grid shows the zoom.
  const whole = useMemo(() => presence(novel, type), [novel, type]);
  const m = useMemo(() => (zoom ? presence(novel, type, zoomed(novel, novel.scenes, zoom)) : whole), [novel, type, zoom, whole]);
  const marks = useMemo(() => new Map([...m.marks].map(([k, p]) => [k, markOf(p)])), [m]);
  const rows = useMemo(() => {
    const count = totals(whole);
    return sortRows(whole, order).map((r) => ({ id: r.id, name: r.name, aside: number.format(count.get(r.id) ?? 0) }));
  }, [whole, order]);
  const absences = useMemo(() => gaps({ lanes: sortRows(whole, order), scenes: whole.scenes, marks: whole.marks, words: whole.words }, threshold), [whole, order, writeGap(threshold)]); // eslint-disable-line react-hooks/exhaustive-deps
  const inGap = useMemo(() => {
    const out = new Map<string, Gap>();
    const ids = whole.scenes.map((s) => s.id);
    for (const g of absences) for (const id of ids.slice(ids.indexOf(g.from), ids.indexOf(g.to) + 1)) out.set(gridKey(g.lane, id), g);
    return out;
  }, [absences, whole]);
  const shaded = useMemo(() => new Set(inGap.keys()), [inGap]);
  const listedIn = LISTS[type];
  const show = useNotice((n) => n.show);
  const sceneEdit = useSceneEdit(novelId, workspace);
  const [editing, setEditing] = useState<{ row: string; scene: string; el: HTMLElement }>();

  /** A change to an entry in a scene's list (and, for a character, its point of view). */
  const change = (scene: Scene, entry: Entity, what: EntryChange | { pov: boolean }, done?: string) =>
    listedIn &&
    sceneEdit(
      scene,
      (fm): YamlEdit[] => {
        if ("pov" in what) return what.pov ? [{ path: ["pov"], value: entry.id }] : fm.pov === entry.id ? [{ path: ["pov"], remove: true }] : [];
        const edits = entryEdits(fm, listedIn, entry.id, what);
        // Taken out of a scene, a character is no longer its point of view either.
        if ("remove" in what && fm.pov === entry.id) edits.push({ path: ["pov"], remove: true });
        return edits;
      },
      done,
    );

  /** A cell chosen: not listed, it's added to the scene's list; listed, its editor opens. */
  const choose = (row: string, scene: Scene, el: HTMLElement) => {
    const entry = m.rows.find((r) => r.id === row);
    if (!entry) return;
    if (!listedIn) {
      show({ message: `${plural(label)} are in a scene where its prose mentions them: type @ in the scene to add one.` });
      return;
    }
    if (m.marks.get(gridKey(row, scene.id))?.listed) setEditing({ row, scene: scene.id, el });
    else void change(scene, entry, { add: true }, `Added ${entry.name} to “${scene.title}”.`);
  };
  const editingEntry = editing && m.rows.find((r) => r.id === editing.row);
  const editingScene = editing && m.scenes.find((s) => s.id === editing.scene);

  return (
    <div className="grid content-start gap-3 px-6 py-6">
      <h1 className="text-xl font-semibold">Presence</h1>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="grid gap-1 font-medium">
          Rows
          <select value={type} onChange={(e) => setParams({ type: e.target.value === "character" ? undefined : e.target.value })} className="h-8 rounded-md border border-rule bg-raised px-2 font-normal">
            {novel.entityTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {plural(t.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 font-medium">
          Show
          <select value={zoom ?? ""} onChange={(e) => setParams({ zoom: e.target.value || undefined })} className="h-8 rounded-md border border-rule bg-raised px-2 font-normal">
            <option value="">The whole book</option>
            {novel.parts.map((p) => (
              <option key={p.id} value={p.id}>
                Part: {p.title}
              </option>
            ))}
            {novel.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                Chapter: {c.title ?? `Chapter ${novel.chapters.indexOf(c) + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 font-medium">
          Sort
          <select value={order} onChange={(e) => setParams({ sort: e.target.value === "first" ? undefined : e.target.value })} className="h-8 rounded-md border border-rule bg-raised px-2 font-normal">
            {ORDERS.map(([o, l]) => (
              <option key={o} value={o}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <SizeSelect value={size} onChange={(v) => setParams({ size: v })} />
        <GapControls legend="Flag an absence longer than" threshold={threshold} onChange={(gap) => setParams({ gap })} />
      </div>
      <p className="text-sm text-muted">
        Each column is a scene, in reading order.{" "}
        {listedIn ? (
          <>
            <span className="inline-block size-3 rounded-full bg-accent align-middle" aria-hidden /> listed in the scene's {listedIn}
            {type === "character" && (
              <>
                {" "}
                (<span className="inline-block size-3 rounded-full bg-accent align-middle ring-2 ring-accent ring-offset-1" aria-hidden /> its point of view)
              </>
            )}
            {type === "theme" && ", larger for a stronger one"},{" "}
          </>
        ) : (
          `${plural(label)} have no list in a scene's details: they're there where the prose mentions them. `
        )}
        <span className="inline-block size-2.5 rounded-full border border-dashed border-accent align-middle" aria-hidden /> mentioned in the prose{listedIn ? " but not listed" : ""}; shaded, an absence of more than{" "}
        {amount(threshold)}. The number by each name is how many scenes it's in.
      </p>
      {!m.rows.length || !m.scenes.length ? (
        <p className="text-muted">{!m.rows.length ? `No ${plural(label).toLowerCase()} yet.` : "The manuscript has no scenes yet."}</p>
      ) : (
        <SceneGrid
          novelId={novelId}
          novel={novel}
          workspace={workspace}
          label={`${plural(label)} by scene`}
          rowHeading={label}
          rows={rows}
          scenes={m.scenes}
          marks={marks}
          shaded={shaded}
          cellLabel={(row: string, scene: Scene) => describe(scene.title, m.rows.find((r) => r.id === row)?.name ?? row, m.marks.get(gridKey(row, scene.id)), inGap.get(gridKey(row, scene.id)))}
          onChoose={choose}
          hasPopup={(row, scene) => !!listedIn && !!m.marks.get(gridKey(row, scene))?.listed}
          size={size}
        />
      )}
      {m.rows.length > 0 && m.scenes.length > 0 && (
        <section aria-labelledby="absences-heading" className="grid gap-1 text-sm">
          <h2 id="absences-heading" className="font-semibold">
            Long absences
          </h2>
          {absences.length ? (
            <ul className="grid gap-1">
              {absences.map((g) => {
                const name = whole.rows.find((r) => r.id === g.lane)?.name;
                const title = (id: string) => whole.scenes.find((x) => x.id === id)?.title;
                const where = g.from === g.to ? `at “${title(g.from)}”` : `from “${title(g.from)}” to “${title(g.to)}”`;
                return (
                  <li key={`${g.lane}-${g.from}`}>
                    {name}: away for {g.scenes} scene{g.scenes === 1 ? "" : "s"} ({number.format(g.words)} words) {where}
                    {g.open ? ", and never back" : ""}.
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted">
              No {plural(label).toLowerCase()} away for more than {amount(threshold)}.
            </p>
          )}
        </section>
      )}
      {editing && editingEntry && editingScene && listedIn && (
        <PresenceEditor
          anchor={editing.el}
          type={type}
          scene={editingScene}
          entry={editingEntry}
          presence={m.marks.get(gridKey(editingEntry.id, editingScene.id))}
          onChange={(what, done) => change(editingScene, editingEntry, what, done)}
          onClose={() => {
            const el = document.querySelector<HTMLElement>(`[data-cell="${gridKey(editing.row, editing.scene)}"]`);
            setEditing(undefined);
            el?.focus();
          }}
        />
      )}
    </div>
  );
}

/** An entry in a scene: as its point of view (characters), its strength (themes) or weight (plotlines), or taken out. */
function PresenceEditor({
  anchor,
  type,
  scene,
  entry,
  presence: p,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  type: string;
  scene: Scene;
  entry: Entity;
  presence: Presence | undefined;
  onChange: (what: EntryChange | { pov: boolean }, done?: string) => unknown;
  onClose: () => void;
}) {
  const id = useId();
  // Answering at once; the saved value comes back with the model and replaces it.
  const saved = { pov: p?.pov ?? false, strength: p?.strength === undefined ? "" : String(p.strength), weight: p?.weight ?? "major" };
  const [shown, setShown] = useState(saved);
  const [seen, setSeen] = useState(saved);
  if (JSON.stringify(saved) !== JSON.stringify(seen)) {
    setSeen(saved);
    setShown(saved);
  }
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
            {entry.name} in “{scene.title}”
          </p>
          {type === "character" && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={shown.pov}
                onChange={(e) => {
                  setShown({ ...shown, pov: e.target.checked });
                  void onChange({ pov: e.target.checked });
                }}
              />
              The scene's point of view
            </label>
          )}
          {type === "theme" && (
            <label className="grid gap-1 font-medium">
              Strength
              <select
                value={shown.strength}
                onChange={(e) => {
                  setShown({ ...shown, strength: e.target.value });
                  void onChange({ field: "strength", value: e.target.value ? Number(e.target.value) : undefined });
                }}
                className="h-8 rounded-md border border-rule bg-raised px-2 font-normal"
              >
                <option value="">Not given</option>
                <option value="1">1 (faint)</option>
                <option value="2">2</option>
                <option value="3">3 (strong)</option>
              </select>
            </label>
          )}
          {type === "plotline" && (
            <label className="grid gap-1 font-medium">
              Weight
              <select
                value={shown.weight}
                onChange={(e) => {
                  setShown({ ...shown, weight: e.target.value as "major" | "minor" });
                  void onChange({ field: "weight", value: e.target.value === "major" ? undefined : e.target.value });
                }}
                className="h-8 rounded-md border border-rule bg-raised px-2 font-normal"
              >
                <option value="major">Major beat</option>
                <option value="minor">Minor beat</option>
              </select>
            </label>
          )}
          <div className="flex justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void onChange({ remove: true }, `Took ${entry.name} out of “${scene.title}”.`);
                onClose();
              }}
            >
              Remove from this scene
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
