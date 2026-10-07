import type { Novel, Scene } from "@gh-writer/core";
import { useMemo } from "react";
import { plural } from "../bible/types.ts";
import { gridKey } from "../diagrams/columns.ts";
import { readSize, SceneGrid, SizeSelect, type GridMark } from "../diagrams/scene-grid.tsx";
import type { Workspace } from "../novel/workspace.ts";
import { zoomed } from "../swimlanes/swimlane-model.ts";
import { useViewParams } from "../ui/view-params.ts";
import { LISTS, presence, type Presence } from "./presence-model.ts";

/** How a presence is drawn: the point of view ringed, a listing filled (a theme's by its strength), a mention alone dashed. */
function markOf(p: Presence): GridMark {
  const note = p.note ? { note: p.note } : {};
  if (!p.listed) return { size: 0.7, style: "dashed", ...note };
  if (p.weight) return { size: p.weight === "major" ? 0.95 : 0.7, style: p.weight === "major" ? "filled" : "hollow", ...note };
  if (p.strength !== undefined) return { size: 0.55 + 0.15 * p.strength, style: "filled", ...note };
  return { size: 0.8, style: "filled", ...(p.pov ? { ring: true } : {}), ...note };
}

/** What a screen reader says for a cell. */
function describe(scene: string, name: string, p: Presence | undefined): string {
  if (!p) return `${scene}: ${name} not there`;
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
  const m = useMemo(() => presence(novel, type, zoomed(novel, novel.scenes, zoom)), [novel, type, zoom]);
  const marks = useMemo(() => new Map([...m.marks].map(([k, p]) => [k, markOf(p)])), [m]);
  const shaded = useMemo(() => new Set<string>(), []);
  const listedIn = LISTS[type];

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
        <SizeSelect value={size} onChange={(v) => setParams({ size: v })} />
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
        <span className="inline-block size-2.5 rounded-full border border-dashed border-accent align-middle" aria-hidden /> mentioned in the prose{listedIn ? " but not listed" : ""}.
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
          rows={m.rows}
          scenes={m.scenes}
          marks={marks}
          shaded={shaded}
          cellLabel={(row: string, scene: Scene) => describe(scene.title, m.rows.find((r) => r.id === row)?.name ?? row, m.marks.get(gridKey(row, scene.id)))}
          onChoose={() => {}}
          size={size}
        />
      )}
    </div>
  );
}
