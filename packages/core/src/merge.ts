/*
 * Three-way merge for novel files, as an author thinks of them: paragraph by paragraph, and front
 * matter field by field.
 *
 * Prose is one paragraph per line (format spec v1), so lines are the unit of the body merge: edits to
 * different paragraphs merge, even neighbouring ones, and edits to the same paragraph conflict. Front matter is split into
 * top-level fields (a key line and its indented continuation), merged key by key, so a status changed
 * on one side and a synopsis on the other both survive, although their lines touch. Text is never
 * reformatted: every chunk is a run of lines from one of the inputs.
 */

/** Text all sides agree on, or a place where ours and theirs both changed `base` differently. */
export type MergeChunk =
  | { type: "same"; text: string }
  | {
      type: "conflict";
      base: string;
      ours: string;
      theirs: string;
      /** For a front matter conflict: the field's key. Such a conflict can't keep both sides. */
      field?: string;
    };

export interface MergeResult {
  chunks: MergeChunk[];
  conflicts: number;
  /** The merged text, when nothing conflicts. */
  text?: string;
}

/** How to settle one conflict: keep one side, keep both (ours first), or replace it with new text. */
export type Resolution = "ours" | "theirs" | "both" | { text: string };

/** Merge `ours` and `theirs`, two edits of `base`. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const [b, o, t] = [splitFrontMatter(base), splitFrontMatter(ours), splitFrontMatter(theirs)];
  const chunks: MergeChunk[] =
    b && o && t
      ? [
          { type: "same", text: o.open },
          ...mergeFields(b.fields, o.fields, t.fields),
          { type: "same", text: o.close },
          ...mergeBody(b.body, o.body, t.body),
        ]
      : mergeBody(base, ours, theirs);
  return result(chunks);
}

/**
 * Compare two versions with no common ancestor known (a save refused because the file changed on
 * disk): lines both have are kept, and every place they differ is a conflict.
 */
export function merge2(ours: string, theirs: string): MergeResult {
  const [o, t] = [lines(ours), lines(theirs)];
  const match = lcs(o, t);
  const chunks: MergeChunk[] = [];
  let [i, j] = [0, 0];
  const flush = (i2: number, j2: number) => {
    if (i2 > i || j2 > j) chunks.push({ type: "conflict", base: "", ours: o.slice(i, i2).join(""), theirs: t.slice(j, j2).join("") });
  };
  for (let k = 0; k < o.length; k++) {
    const m = match[k]!;
    if (m < 0) continue;
    flush(k, m);
    chunks.push({ type: "same", text: o[k]! });
    [i, j] = [k + 1, m + 1];
  }
  flush(o.length, t.length);
  return result(chunks);
}

/** The text of a merge with each conflict settled, `resolutions` in the order of the conflicts. */
export function resolveMerge(chunks: MergeChunk[], resolutions: Resolution[]): string {
  let n = 0;
  return chunks
    .map((chunk) => {
      if (chunk.type === "same") return chunk.text;
      const r = resolutions[n++];
      if (r === undefined) throw new Error(`No resolution for conflict ${n}`);
      if (r === "ours") return chunk.ours;
      if (r === "theirs") return chunk.theirs;
      if (r === "both") {
        if (chunk.field !== undefined) throw new Error(`Front matter field "${chunk.field}" can't keep both sides`);
        return joinBoth(chunk.ours, chunk.theirs);
      }
      return r.text;
    })
    .join("");
}

/** Both sides' paragraphs, ours first, kept as separate paragraphs. */
function joinBoth(ours: string, theirs: string): string {
  if (!ours || !theirs) return ours + theirs;
  const a = ours.endsWith("\n") ? ours : `${ours}\n`;
  // A blank line between them, unless one is there already: two adjacent lines would be one paragraph.
  return a.endsWith("\n\n") || theirs.startsWith("\n") ? a + theirs : `${a}\n${theirs}`;
}

function result(raw: MergeChunk[]): MergeResult {
  // Join neighbouring agreed text, and drop empty pieces.
  const chunks: MergeChunk[] = [];
  for (const c of raw) {
    if (c.type === "same") {
      if (!c.text) continue;
      const last = chunks.at(-1);
      if (last?.type === "same") last.text += c.text;
      else chunks.push({ ...c });
    } else chunks.push(c);
  }
  const conflicts = chunks.filter((c) => c.type === "conflict").length;
  return { chunks, conflicts, ...(conflicts ? {} : { text: chunks.map((c) => (c as { text: string }).text).join("") }) };
}

/** Lines with their endings, so joining them gives the text back exactly. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// ——— Body ———

/**
 * A paragraph line with the blank lines before it: deleting a paragraph takes its separator along, so
 * it doesn't touch its neighbours. Units are compared by `key`, their non-blank line.
 */
interface Unit {
  key: string;
  text: string;
}

function units(text: string): Unit[] {
  const out: Unit[] = [];
  let blank = "";
  for (const line of lines(text)) {
    if (/^[ \t]*\r?\n?$/.test(line)) blank += line;
    else {
      out.push({ key: line.replace(/\r?\n$/, ""), text: blank + line });
      blank = "";
    }
  }
  if (blank) out.push({ key: "", text: blank });
  return out;
}

/** A change one side made: base units [bs, be) became that side's units [ss, se). */
interface Hunk {
  side: "ours" | "theirs";
  bs: number;
  be: number;
  ss: number;
  se: number;
}

function hunks(side: Hunk["side"], match: Int32Array, baseLength: number, sideLength: number): Hunk[] {
  const out: Hunk[] = [];
  let [i, j] = [0, 0];
  for (let k = 0; k <= baseLength; k++) {
    if (k < baseLength && match[k]! < 0) continue;
    const m = k < baseLength ? match[k]! : sideLength;
    // n paragraphs replaced by n are n separate edits, so that one of them can meet the other side alone.
    if (k - i > 1 && k - i === m - j) for (let d = 0; d < k - i; d++) out.push({ side, bs: i + d, be: i + d + 1, ss: j + d, se: j + d + 1 });
    else if (k > i || m > j) out.push({ side, bs: i, be: k, ss: j, se: m });
    [i, j] = [k + 1, m + 1];
  }
  return out;
}

/**
 * Each side's changes are hunks over the base. Hunks of the two sides conflict only where their base
 * ranges overlap, or both insert at the same place; everything else applies as is, so edits to
 * neighbouring paragraphs (and a paragraph edited next to one deleted) merge.
 */
function mergeBody(baseText: string, oursText: string, theirsText: string): MergeChunk[] {
  const [base, ours, theirs] = [units(baseText), units(oursText), units(theirsText)];
  const keys = (us: Unit[]) => us.map((u) => u.key);
  const toOurs = lcs(keys(base), keys(ours));
  const toTheirs = lcs(keys(base), keys(theirs));
  const all = [...hunks("ours", toOurs, base.length, ours.length), ...hunks("theirs", toTheirs, base.length, theirs.length)].sort(
    (a, b) => a.bs - b.bs || a.be - b.be,
  );

  // Overlapping hunks form one group, to be settled together.
  const groups: Hunk[][] = [];
  for (const h of all) {
    const group = groups.at(-1);
    const end = group ? Math.max(...group.map((g) => g.be)) : -1;
    const sameInsert = group?.some((g) => g.bs === g.be && h.bs === h.be && g.bs === h.bs);
    if (group && (h.bs < end || sameInsert)) group.push(h);
    else groups.push([h]);
  }

  const text = (us: Unit[], from: number, to: number) => us.slice(from, to).map((u) => u.text).join("");
  /** A base unit both sides kept: ours if its spacing changed there, else theirs. */
  const kept = (k: number) => {
    const o = ours[toOurs[k]!]!.text;
    return o !== base[k]!.text ? o : theirs[toTheirs[k]!]!.text;
  };
  /** One side's version of base units [from, to), given its hunks there. */
  const version = (us: Unit[], match: Int32Array, side: Hunk[], from: number, to: number) => {
    let out = "";
    for (let b = from, n = 0; b < to || n < side.length; ) {
      const h = side[n];
      if (h && h.bs === b) {
        out += text(us, h.ss, h.se);
        b = h.be;
        n++;
      } else if (b < to) {
        out += us[match[b]!]!.text;
        b++;
      } else break;
    }
    return out;
  };

  const chunks: MergeChunk[] = [];
  let pos = 0;
  for (const group of groups) {
    const from = Math.min(...group.map((h) => h.bs));
    const to = Math.max(...group.map((h) => h.be));
    for (; pos < from; pos++) chunks.push({ type: "same", text: kept(pos) });
    const mine = group.filter((h) => h.side === "ours");
    const others = group.filter((h) => h.side === "theirs");
    const o = version(ours, toOurs, mine, from, to);
    const t = version(theirs, toTheirs, others, from, to);
    if (!mine.length) chunks.push({ type: "same", text: t });
    else if (!others.length || o === t) chunks.push({ type: "same", text: o });
    else chunks.push(...conflict(text(base, from, to), o, t));
    pos = Math.max(pos, to);
  }
  for (; pos < base.length; pos++) chunks.push({ type: "same", text: kept(pos) });
  return chunks;
}

/** A conflict, without the lines both sides have alike at its edges. */
function conflict(base: string, ours: string, theirs: string): MergeChunk[] {
  const [b, o, t] = [lines(base), lines(ours), lines(theirs)];
  let head = 0;
  while (head < o.length && head < t.length && o[head] === t[head]) head++;
  let tail = 0;
  while (tail < o.length - head && tail < t.length - head && o[o.length - 1 - tail] === t[t.length - 1 - tail]) tail++;
  // The base loses the same edges when it has them too (it's shown for reference only).
  const sharesEdges = b.length >= head + tail && b.slice(0, head).join("") === o.slice(0, head).join("") && b.slice(b.length - tail).join("") === o.slice(o.length - tail).join("");
  return [
    { type: "same", text: o.slice(0, head).join("") },
    {
      type: "conflict",
      base: sharesEdges ? b.slice(head, b.length - tail).join("") : base,
      ours: o.slice(head, o.length - tail).join(""),
      theirs: t.slice(head, t.length - tail).join(""),
    },
    { type: "same", text: o.slice(o.length - tail).join("") },
  ];
}

/** Larger than this (lines × lines) and the middle of a diff counts as all changed, rather than taking long. */
const LCS_LIMIT = 16_000_000;

/**
 * A longest common subsequence of `a` and `b`, as each line of `a`'s index in `b` (-1 if unmatched).
 * Common leading and trailing lines are matched first, so typical edits leave a small middle.
 */
function lcs(a: string[], b: string[]): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) match[start] = start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) match[--endA] = --endB;
  const n = endA - start;
  const m = endB - start;
  if (!n || !m || n * m > LCS_LIMIT) return match;
  // lengths[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = a[start + i] === b[start + j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[start + i] === b[start + j]) {
      match[start + i] = start + j;
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i++;
    else j++;
  }
  return match;
}

// ——— Front matter ———

interface FrontMatter {
  /** The opening `---` line (with any BOM), and the closing one. */
  open: string;
  close: string;
  fields: Field[];
  body: string;
}

/** A top-level key with its lines: comments and blank lines before it, the key line, indented continuation. */
interface Field {
  key: string;
  text: string;
}

const FRONT_MATTER = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m;
const CONTINUATION = /^(?:[ \t]+\S|-(?:[ \t]|\r?\n|$))/;
const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#:'"][^:]*?))[ \t]*:(?:[ \t]|\r?$|\n)/;

function splitFrontMatter(text: string): FrontMatter | undefined {
  const m = FRONT_MATTER.exec(text);
  if (!m || m.index !== 0) return undefined;
  const fields: Field[] = [];
  let pending = "";
  for (const line of lines(m[2]!)) {
    const key = /^[ \t]/.test(line) ? undefined : KEY.exec(line);
    if (key) {
      fields.push({ key: key[1] ?? key[2] ?? key[3]!, text: pending + line });
      pending = "";
    } else if (fields.length && CONTINUATION.test(line) && /^\s*$/.test(pending)) {
      // Continuation of the field above: a nested map, a list (indented or not), a block of text with blank lines.
      fields.at(-1)!.text += pending + line;
      pending = "";
    } else pending += line;
  }
  // Comments after the last field travel with the closing line.
  if (pending) fields.push({ key: "\0end", text: pending });
  return { open: m[1]!, close: m[3]!, fields, body: text.slice(m[0].length) };
}

function mergeFields(base: Field[], ours: Field[], theirs: Field[]): MergeChunk[] {
  const [b, o, t] = [byKey(base), byKey(ours), byKey(theirs)];
  // Our order, with fields only theirs has placed after the field they follow there.
  const order = ours.map((f) => f.key);
  theirs.forEach((f, n) => {
    if (o.has(f.key) || order.includes(f.key)) return;
    const after = theirs
      .slice(0, n)
      .map((p) => p.key)
      .findLast((k) => order.includes(k));
    order.splice(after === undefined ? 0 : order.indexOf(after) + 1, 0, f.key);
  });
  // A trailing comment block stays last.
  const end = order.indexOf("\0end");
  if (end >= 0 && end !== order.length - 1) order.push(...order.splice(end, 1));
  for (const f of base) if (!order.includes(f.key)) order.push(f.key);

  const chunks: MergeChunk[] = [];
  for (const key of order) {
    const [bt, ot, tt] = [b.get(key), o.get(key), t.get(key)];
    if (ot === tt) chunks.push({ type: "same", text: ot ?? "" });
    else if (ot === bt) chunks.push({ type: "same", text: tt ?? "" });
    else if (tt === bt) chunks.push({ type: "same", text: ot ?? "" });
    else chunks.push({ type: "conflict", base: bt ?? "", ours: ot ?? "", theirs: tt ?? "", field: key === "\0end" ? "comments" : key });
  }
  return chunks;
}

function byKey(fields: Field[]): Map<string, string> {
  const map = new Map<string, string>();
  // A repeated key (invalid YAML) keeps every copy, so nothing is lost.
  for (const f of fields) map.set(f.key, (map.get(f.key) ?? "") + f.text);
  return map;
}
