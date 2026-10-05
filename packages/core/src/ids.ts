/** Lowercase Crockford base32: digits and letters without i, l, o, u. */
export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_LENGTH = 6;
export const ID_PATTERN = /^([a-z]{2,8})_([0-9a-hjkmnp-tv-z]{6})$/;

/** Prefixes for records that are not bible entities. */
export const STRUCTURE_PREFIXES = {
  novel: "nv",
  part: "pt",
  chapter: "ch",
  scene: "sc",
  relationship: "rel",
  event: "evt",
} as const;

export interface EntityTypeDef {
  key: string;
  prefix: string;
  folder: string;
  label: string;
  color?: string;
  builtin: boolean;
}

export const BUILTIN_ENTITY_TYPES: readonly EntityTypeDef[] = [
  { key: "character", prefix: "char", folder: "characters", label: "Character", color: "1f77b4", builtin: true },
  { key: "location", prefix: "loc", folder: "locations", label: "Location", color: "2ca02c", builtin: true },
  { key: "plotline", prefix: "plot", folder: "plotlines", label: "Plotline", color: "d62728", builtin: true },
  { key: "theme", prefix: "theme", folder: "themes", label: "Theme", color: "9467bd", builtin: true },
];

/** Prefixes custom entity types may not use. */
export const RESERVED_PREFIXES: ReadonlySet<string> = new Set([
  ...Object.values(STRUCTURE_PREFIXES),
  ...BUILTIN_ENTITY_TYPES.map((t) => t.prefix),
]);

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** The prefix of an ID, or undefined if it is not a well-formed ID. */
export function idPrefix(id: string): string | undefined {
  return ID_PATTERN.exec(id)?.[1];
}

/** Generate a new random ID with the given prefix. */
export function newId(prefix: string, randomBytes: (n: number) => Uint8Array = cryptoRandom): string {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new Error(`Invalid ID prefix: ${prefix}`);
  const bytes = randomBytes(ID_LENGTH);
  let suffix = "";
  for (const b of bytes) suffix += ID_ALPHABET[b & 31];
  return `${prefix}_${suffix}`;
}

function cryptoRandom(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
