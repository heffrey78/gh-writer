import { slugify } from "./edit.ts";
import type { Entity, Novel } from "./model.ts";

/*
 * Every story bible entry has a GitHub label (#10, D1): <type prefix>/<slug of its name>, such as
 * char/ada-varn or loc/the-varn-bridge, in its type's colour. Its description holds the entry's name
 * and ID, so the label finds its entry after a rename (and is renamed to match).
 */

export interface LabelDef {
  name: string;
  /** Hex, no #. */
  color: string;
  description: string;
}

/** GitHub's limits on a label's name and description. */
const NAME_MAX = 50;
const DESCRIPTION_MAX = 100;
const ID_IN = /\b([a-z]{2,8}_[0-9a-hjkmnp-tv-z]{6})\b/;

/** The label for `entity`: told apart from another of its type with the same name by its ID's ending. */
export function entityLabel(novel: Novel, entity: Entity): LabelDef {
  const type = novel.entityTypes.find((t) => t.key === entity.type);
  const prefix = type?.prefix ?? entity.id.split("_")[0]!;
  const suffix = entity.id.split("_")[1]!;
  const slug = slugify(entity.name) || suffix;
  const twin = novel.entities.some((e) => e.id !== entity.id && e.type === entity.type && (slugify(e.name) || e.id.split("_")[1]) === slug);
  const tail = twin ? `-${suffix}` : "";
  const name = `${`${prefix}/${slug}`.slice(0, NAME_MAX - tail.length).replace(/-+$/, "")}${tail}`;
  const id = ` · ${entity.id}`;
  return { name, color: (type?.color ?? "ededed").replace(/^#/, "").toLowerCase(), description: `${entity.name.slice(0, DESCRIPTION_MAX - id.length)}${id}` };
}

/** The entry a label stands for: by the ID in its description, else by its name. */
export function entityOfLabel(novel: Novel, label: { name: string; description?: string }): Entity | undefined {
  const id = ID_IN.exec(label.description ?? "")?.[1];
  if (id) return novel.entities.find((e) => e.id === id);
  return novel.entities.find((e) => entityLabel(novel, e).name === label.name);
}
