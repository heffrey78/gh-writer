import { DEFAULT_GAP, presentIn } from "./diagrams.ts";
import type { Novel, Relationship } from "./model.ts";
import { storyInstant, storyTimeline } from "./time.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A stretch of story time, as read: "40 min", "8 h 10 min", "3 days", "2 years". */
export function readableSpan(ms: number): string {
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms % HOUR) / MINUTE);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  if (ms < 365 * DAY) {
    const d = Math.round(ms / DAY);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  const y = Math.round(ms / (365 * DAY));
  return `${y} year${y === 1 ? "" : "s"}`;
}

/**
 * What the rest of the book says about a scene, worked out from the model (#154): where it stands
 * in the book, how it sits in story time against the scene before, who appears for the first time
 * or comes back after a long absence, the plotlines that begin or end in it, and the relationships
 * that start or end there. Only what holds and is worth saying; nothing for a scene that isn't in
 * the reading order.
 */
export function sceneFacts(novel: Novel, sceneId: string): string[] {
  const scenes = novel.scenes;
  const at = scenes.findIndex((s) => s.id === sceneId);
  if (at < 0) return [];
  const scene = scenes[at]!;
  const facts: string[] = [];
  const name = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  const list = (ids: string[]) => (ids.length < 3 ? ids.map(name).join(" and ") : `${ids.slice(0, -1).map(name).join(", ")} and ${name(ids.at(-1)!)}`);

  // Where it stands in the book.
  if (scenes.length === 1) facts.push("The book's only scene.");
  else if (at === 0) facts.push("The book's first scene.");
  else if (at === scenes.length - 1) facts.push("The book's last scene.");

  // Off-page events it was written from, and kept (#165).
  for (const e of novel.events) if (e.scene === sceneId) facts.push(`Dramatizes the off-page event “${e.title}”.`);

  // Story time, against the latest point the story had reached before it (the scene before, or
  // after a flashback the one it went back from), on the same scale.
  const calendar = novel.config?.calendar?.start;
  const here = storyInstant(scene.when, scene.duration, calendar);
  if (here) {
    let latest: { title: string; start: number; end: number } | undefined;
    for (const before of scenes.slice(0, at)) {
      const then = storyInstant(before.when, before.duration, calendar);
      if (then && then.dated === here.dated && (!latest || then.end >= latest.end)) latest = { title: before.title, ...then };
    }
    if (latest) {
      if (here.start < latest.start) facts.push(`A flashback: ${readableSpan(latest.start - here.start)} before “${latest.title}”.`);
      else if (here.start < latest.end) facts.push(`Overlaps “${latest.title}” in story time.`);
      else if (here.start === latest.end) facts.push(`Follows straight on from “${latest.title}”.`);
      else facts.push(`${readableSpan(here.start - latest.end)} after “${latest.title}”.`);
    }
  }

  // An off-page event right before or after it in story time, with no scene between (#165).
  if (here) {
    const items = storyTimeline(novel).items;
    const i = items.findIndex((x) => x.kind === "scene" && x.scene.id === sceneId);
    const neighbour = (j: number) => {
      const x = items[j];
      return x?.kind === "event" && x.at.dated === here.dated && x.event.scene !== sceneId ? { title: x.event.title, ...x.at } : undefined;
    };
    const before = neighbour(i - 1);
    const after = neighbour(i + 1);
    if (before) {
      if (here.start < before.end) facts.push(`During the off-page event “${before.title}”.`);
      else if (here.start === before.end) facts.push(`Straight after the off-page event “${before.title}”.`);
      else facts.push(`${readableSpan(here.start - before.end)} after the off-page event “${before.title}”.`);
    }
    if (after) facts.push(after.start <= here.end ? `The off-page event “${after.title}” begins during it.` : `${readableSpan(after.start - here.end)} before the off-page event “${after.title}”.`);
  }

  // Characters: first seen here, or back after a long absence.
  const present = scenes.map((s) => presentIn(s));
  const characters = [...present[at]!].filter((id) => novel.entities.find((e) => e.id === id)?.type === "character");
  const first = characters.filter((id) => !present.slice(0, at).some((p) => p.has(id)));
  if (first.length) facts.push(`First appearance of ${list(first)}.`);
  for (const id of characters) {
    if (first.includes(id)) continue;
    let last = at - 1;
    while (last >= 0 && !present[last]!.has(id)) last--;
    const away = at - last - 1;
    if ("scenes" in DEFAULT_GAP && away >= DEFAULT_GAP.scenes) facts.push(`${name(id)} is back after ${away} scenes away.`);
  }

  // Plotlines beginning or ending here.
  for (const { id } of scene.plotlines) {
    const scenesWith = scenes.flatMap((s, i) => (s.plotlines.some((p) => p.id === id) ? [i] : []));
    const begins = scenesWith[0] === at;
    const ends = scenesWith.at(-1) === at;
    if (begins && ends) facts.push(`${name(id)} begins and ends here.`);
    else if (begins) facts.push(`${name(id)} begins here.`);
    else if (ends) facts.push(`${name(id)} ends here.`);
  }

  // Relationships that start or end here.
  const said = (r: Relationship) => {
    const type = novel.relationshipTypes.find((t) => t.key === r.type);
    return `${name(r.from)}: ${(type?.label ?? r.type).toLowerCase()} ${name(r.to)}`;
  };
  for (const r of novel.relationships) {
    if (r.since === sceneId) facts.push(`Starts here: ${said(r)}.`);
    if (r.until === sceneId) facts.push(`Ends here: ${said(r)}.`);
  }
  return facts;
}
