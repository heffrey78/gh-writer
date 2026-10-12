import { entryPresence, locationProfile, plotlineProfile, readFrontMatter, themeProfile, type Entity, type Novel, type Scene, type Tally } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { useMemo } from "react";
import { Link } from "react-router";
import type { Workspace } from "../novel/workspace.ts";
import { cn } from "../ui/cn.ts";
import { AddButton, PencilButton, ProfileSection, TextEditor, useInPlace } from "./profile.tsx";
import { StripHeader, StripRow } from "./strip.tsx";

/*
 * The parts of a profile shaped by its type (#161): who comes to a location and when, a plotline's
 * beats (and the ones still to write), a theme's strength scene by scene. A character's are its
 * strip and arcs, shared with every type.
 */

const LINK = "text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent";

export function TypeSections({ novelId, novel, entity, workspace }: { novelId: string; novel: Novel; entity: Entity; workspace: Workspace }) {
  if (entity.type === "location") return <LocationSection novelId={novelId} novel={novel} entity={entity} />;
  if (entity.type === "plotline") return <PlotlineSection novelId={novelId} novel={novel} entity={entity} workspace={workspace} />;
  if (entity.type === "theme") return <ThemeSection novel={novel} entity={entity} />;
  return null;
}

/** "Ada Varn (4), Ben Varn (4)", each a link to the entry. */
function Tallied({ novelId, tally, unit }: { novelId: string; tally: Tally[]; unit: string }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {tally.map((t) => (
        <li key={t.id}>
          <Link to={`/novels/${novelId}/bible/${t.id}`} className={LINK}>
            {t.name}
          </Link>{" "}
          <span className="text-muted">
            ({t.scenes} {t.scenes === 1 ? unit : `${unit}s`})
          </span>
        </li>
      ))}
    </ul>
  );
}

const sceneLink = (novelId: string, scene: Scene) => (
  <Link to={`/novels/${novelId}/scene/${scene.id}`} className={LINK}>
    {scene.title}
  </Link>
);

function LocationSection({ novelId, novel, entity }: { novelId: string; novel: Novel; entity: Entity }) {
  const p = useMemo(() => locationProfile(novel, entity.id), [novel, entity.id]);
  return (
    <ProfileSection title="Who comes here">
      {p.visitors.length ? <Tallied novelId={novelId} tally={p.visitors} unit="scene" /> : <p className="text-sm text-muted">No one yet: no scene set here has characters.</p>}
      {p.span && <p className="text-sm">Story time: {p.span.from === p.span.to ? p.span.from : `${p.span.from} to ${p.span.to}`}.</p>}
    </ProfileSection>
  );
}

function PlotlineSection({ novelId, novel, entity, workspace }: { novelId: string; novel: Novel; entity: Entity; workspace: Workspace }) {
  const p = useMemo(() => plotlineProfile(novel, entity.id), [novel, entity.id]);
  const place = useInPlace();
  const title = (id: string) => novel.allScenes.find((s) => s.id === id)?.title ?? id;

  /** Write a beat into its scene's front matter: a bare ID becomes a map holding it. */
  const writeBeat = async (scene: Scene, index: number, beat: string) => {
    await workspace.open([scene.file]);
    const file = workspace.store.getState().files[scene.file];
    const item = file ? (readFrontMatter(joinSceneFile({ ...file, body: "" }))?.plotlines as unknown[] | undefined)?.[index] : undefined;
    const edits =
      typeof item === "string"
        ? [{ path: ["plotlines", index], value: { id: item, ...(beat ? { beat } : {}) } }]
        : [beat ? { path: ["plotlines", index, "beat"], value: beat } : { path: ["plotlines", index, "beat"], remove: true as const }];
    await workspace.editFrontMatter(scene.file, edits);
  };

  return (
    <ProfileSection title="Beats">
      {p.beats.length === 0 ? (
        <p className="text-sm text-muted">No scene has a beat of {entity.name} yet.</p>
      ) : (
        <ol className="grid gap-1.5 text-sm">
          {p.beats.map((b) => {
            const part = `beat:${b.scene.id}`;
            return (
              <li key={b.scene.id} className="group grid grid-cols-[1.25rem_minmax(0,10rem)_minmax(0,1fr)] items-baseline gap-x-2">
                <span
                  title={b.weight === "major" ? "A major beat" : "A minor beat"}
                  className={cn("size-2.5 translate-y-[-1px] self-center justify-self-center rounded-full border-2 border-accent", b.weight === "major" ? "bg-accent" : "bg-transparent")}
                />
                <span className="truncate">
                  {sceneLink(novelId, b.scene)}
                  <span className="sr-only">, {b.weight === "major" ? "a major beat" : "a minor beat"}</span>
                </span>
                {place.editing === part ? (
                  <TextEditor place={place} label={`Beat in “${b.scene.title}”`} value={b.beat ?? ""} onSave={(v) => writeBeat(b.scene, b.index, v)} />
                ) : b.beat ? (
                  <span className="flex items-baseline gap-1">
                    <span className="flex-1">{b.beat}</span>
                    <PencilButton place={place} part={part} label={`the beat in “${b.scene.title}”`} />
                  </span>
                ) : (
                  <AddButton place={place} part={part}>
                    Write the beat <span className="sr-only">in “{b.scene.title}”</span>
                  </AddButton>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <ul className="grid list-disc gap-1 pl-5 text-sm">
        {p.skips.length > 0 && (
          <li>
            Skips {p.skips.length === 1 ? "one scene" : `${p.skips.length} scenes`} between its first beat and its last:{" "}
            {p.skips.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ", "}
                {sceneLink(novelId, s)}
              </span>
            ))}
            .
          </li>
        )}
        {p.quiet.map((q) => (
          <li key={q.from}>
            Quiet for {q.scenes} scenes, “{title(q.from)}” to “{title(q.to)}”{q.open ? ", to the end of the book" : ""}.
          </li>
        ))}
      </ul>
      {p.who.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className="text-[13px] text-muted">Who's in it</h3>
          <Tallied novelId={novelId} tally={p.who} unit="scene" />
        </div>
      )}
      {p.where.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className="text-[13px] text-muted">Where it happens</h3>
          <Tallied novelId={novelId} tally={p.where} unit="scene" />
        </div>
      )}
    </ProfileSection>
  );
}

const STRENGTH = ["not there", "faint", "present", "strong"] as const;

function ThemeSection({ novel, entity }: { novel: Novel; entity: Entity }) {
  const p = useMemo(() => themeProfile(novel, entity.id), [novel, entity.id]);
  const presence = useMemo(() => entryPresence(novel, entity.id), [novel, entity.id]);
  const n = p.strengths.length;
  if (!presence || n === 0) return null;
  return (
    <ProfileSection title="Strength, scene by scene">
      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-end gap-x-3 gap-y-1.5">
        <StripHeader presence={presence} />
        <StripRow label="Strength" columns={n} className="h-12 items-end">
          <ol aria-label="Strength in each scene, in reading order" className="contents">
            {p.strengths.map(({ scene, strength, note }) => {
              const said = `${scene.title}: ${STRENGTH[strength]}${strength ? ` (${strength})` : ""}${note ? `, ${note}` : ""}`;
              return (
                <li key={scene.id} title={said} className="contents">
                  <span className={cn("block rounded-t-[4px]", strength ? "bg-accent" : "bg-rule/60")} style={{ height: strength ? `${(strength / 3) * 100}%` : "2px" }}>
                    <span className="sr-only">{said}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </StripRow>
      </div>
    </ProfileSection>
  );
}
