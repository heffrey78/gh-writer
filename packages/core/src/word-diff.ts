/*
 * Differences in prose as an editor marks them (#17): which words were deleted and which inserted,
 * not which lines changed. Paragraphs are paired first; within a changed pair the words are diffed.
 */

export type DiffOp = "same" | "ins" | "del";

/** A run of text kept, inserted or deleted. */
export interface DiffPart {
  op: DiffOp;
  text: string;
}

export type ParagraphDiff =
  | { kind: "same"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string }
  /** The same paragraph, reworded: its words, kept, inserted and deleted. */
  | { kind: "changed"; parts: DiffPart[] };

/**
 * The shortest edit from `a` to `b` (Myers' O(ND) algorithm), as runs of kept, deleted and inserted
 * items in order; deletions before insertions where both happen at one place. Past `maxEdits` edits
 * (unrelated texts), it gives up and answers "all of a deleted, all of b inserted".
 */
export function diffSequences<T>(a: readonly T[], b: readonly T[], maxEdits = 4000): { op: DiffOp; items: T[] }[] {
  // Common ends are trimmed first: the usual edit is small and somewhere in the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: { op: DiffOp; items: T[] }[] = [];
  const push = (op: DiffOp, item: T) => {
    const last = out.at(-1);
    if (last?.op === op) last.items.push(item);
    else out.push({ op, items: [item] });
  };
  for (let i = 0; i < start; i++) push("same", a[i]!);
  const middle = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  for (const [op, item] of middle) push(op, item);
  for (let i = endA; i < a.length; i++) push("same", a[i]!);
  return out;
}

function myers<T>(a: readonly T[], b: readonly T[], maxEdits: number): [DiffOp, T][] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((x) => ["ins", x]);
  if (!m) return a.map((x) => ["del", x]);
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset, d);
    }
  }
  return [...a.map((x): [DiffOp, T] => ["del", x]), ...b.map((x): [DiffOp, T] => ["ins", x])];
}

function backtrack<T>(a: readonly T[], b: readonly T[], trace: Int32Array[], offset: number, end: number): [DiffOp, T][] {
  const out: [DiffOp, T][] = [];
  let x = a.length;
  let y = b.length;
  for (let d = end; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push(["same", a[--x]!]);
      y--;
    }
    if (down) out.push(["ins", b[--y]!]);
    else out.push(["del", a[--x]!]);
  }
  while (x > 0 && y > 0) {
    out.push(["same", a[--x]!]);
    y--;
  }
  out.reverse();
  // Deletions before insertions at the same place, as a reader expects ("~~quick~~ slow").
  for (let i = 1; i < out.length; i++) {
    let j = i;
    while (j > 0 && out[j]![0] === "del" && out[j - 1]![0] === "ins") {
      [out[j - 1], out[j]] = [out[j]!, out[j - 1]!];
      j--;
    }
  }
  return out;
}

/** Words (with their apostrophes and hyphens), runs of space, and single other characters. */
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*|\s+|[^\s]/gu;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** The word-level difference between two versions of a paragraph. */
export function diffWords(before: string, after: string): DiffPart[] {
  const runs = diffSequences(tokenize(before), tokenize(after));
  // A lone space kept between two changes reads as part of them: "~~very old~~ new", not "~~very~~ ~~old~~".
  const parts: DiffPart[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const text = run.items.join("");
    const between = run.op === "same" && i > 0 && i < runs.length - 1 && /^\s+$/.test(text) && runs[i - 1]!.op !== "same" && runs[i + 1]!.op !== "same";
    if (between) {
      add(parts, "del", text);
      add(parts, "ins", text);
    } else add(parts, run.op, text);
  }
  return order(parts);
}

function add(parts: DiffPart[], op: DiffOp, text: string) {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.op === op) last.text += text;
  else parts.push({ op, text });
}

/** Within each stretch of changes, every deletion first, then every insertion. */
function order(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (let i = 0; i < parts.length; ) {
    if (parts[i]!.op === "same") {
      out.push(parts[i++]!);
      continue;
    }
    let del = "";
    let ins = "";
    for (; i < parts.length && parts[i]!.op !== "same"; i++) {
      if (parts[i]!.op === "del") del += parts[i]!.text;
      else ins += parts[i]!.text;
    }
    if (del) out.push({ op: "del", text: del });
    if (ins) out.push({ op: "ins", text: ins });
  }
  return slide(out);
}

/**
 * A lone insertion or deletion starting with the same space as the text after it is slid along, so it
 * starts at a word: "the ~~station ~~clock", not "the~~ station~~ clock". Same text either way.
 */
function slide(parts: DiffPart[]): DiffPart[] {
  for (let i = 1; i < parts.length - 1; i++) {
    const [prev, change, next] = [parts[i - 1]!, parts[i]!, parts[i + 1]!];
    if (prev.op !== "same" || next.op !== "same" || change.op === "same") continue;
    const space = /^\s+/.exec(change.text)?.[0];
    if (!space || !next.text.startsWith(space) || space.length === change.text.length) continue;
    prev.text += space;
    change.text = change.text.slice(space.length) + space;
    next.text = next.text.slice(space.length);
  }
  return parts.filter((p) => p.text);
}

/** How much two paragraphs share, 0 to 1: the kept share of their words. */
function similarity(a: string, b: string): number {
  const wa = tokenize(a).filter((t) => /\S/.test(t));
  const wb = tokenize(b).filter((t) => /\S/.test(t));
  if (!wa.length || !wb.length) return 0;
  const kept = diffSequences(wa, wb, 2000)
    .filter((r) => r.op === "same")
    .reduce((n, r) => n + r.items.length, 0);
  return (2 * kept) / (wa.length + wb.length);
}

/**
 * Two versions of a text, paragraph by paragraph: paragraphs kept, added and removed, and where one
 * was reworded, its words. A removed and an added paragraph at the same place are one reworded
 * paragraph when they share at least a third of their words.
 */
export function diffParagraphs(before: readonly string[], after: readonly string[]): ParagraphDiff[] {
  const out: ParagraphDiff[] = [];
  const runs = diffSequences(before, after);
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.op === "same") {
      for (const text of run.items) out.push({ kind: "same", text });
      continue;
    }
    // A deletion followed by an insertion: pair them up in order where they're alike.
    const removed = run.op === "del" ? run.items : [];
    const added = run.op === "ins" ? [...run.items] : [];
    if (run.op === "del" && runs[i + 1]?.op === "ins") added.push(...runs[++i]!.items);
    let r = 0;
    let a = 0;
    while (r < removed.length || a < added.length) {
      const old = removed[r];
      const now = added[a];
      if (old !== undefined && now !== undefined && similarity(old, now) >= 1 / 3) {
        out.push({ kind: "changed", parts: diffWords(old, now) });
        r++;
        a++;
      } else if (old !== undefined && (now === undefined || removed.length - r >= added.length - a)) {
        out.push({ kind: "removed", text: old });
        r++;
      } else {
        out.push({ kind: "added", text: now! });
        a++;
      }
    }
  }
  return out;
}
