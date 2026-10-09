/*
 * Finding an issue's passage again (#9): the scene is found by its ID wherever its file has moved; in
 * its text (as plain text, the way the editor reads it), the quoted words are looked for exactly,
 * then with spacing, quote marks, dashes and case evened out, then approximately, word by word, for a
 * passage edited a little since. Not found: the issue is orphaned (shown with its quote, never lost).
 */

export interface AnchorMatch {
  /** Where the passage is now, as offsets into the text. */
  from: number;
  to: number;
  /** How it was found: as quoted, with spacing/punctuation/case evened out, or approximately. */
  kind: "exact" | "normalized" | "approximate";
  /** How much of the quote is still there word for word (1 for exact or normalized). */
  similarity: number;
}

export interface AnchorOptions {
  /** The share of the quote's words that must still be there, in order, for an approximate match. */
  threshold?: number;
}

/** Where `quote` is in `text` now, or undefined if it can't be found (the passage was rewritten or deleted). */
export function resolveAnchor(text: string, quote: string, { threshold = 0.75 }: AnchorOptions = {}): AnchorMatch | undefined {
  const q = quote.trim();
  if (!q || !text) return undefined;
  const exact = text.indexOf(q);
  if (exact >= 0) return { from: exact, to: exact + q.length, kind: "exact", similarity: 1 };

  const t = normalize(text);
  const nq = normalize(q).text;
  const at = nq ? t.text.indexOf(nq) : -1;
  if (at >= 0) return { from: t.map[at]!, to: t.map[at + nq.length - 1]! + 1, kind: "normalized", similarity: 1 };

  return approximate(text, q, threshold);
}

/** Spacing collapsed, curly quotes and dashes made plain, lower case; with each character's place in the original. */
function normalize(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]!;
    if (/\s/.test(ch)) {
      space = text.length > 0;
      continue;
    }
    if (space) {
      text += " ";
      map.push(i - 1);
      space = false;
    }
    ch = ch.replace(/[‘’‚‛′]/, "'").replace(/[“”„‟″]/, '"').replace(/[‐‑‒–—―]/, "-").toLowerCase();
    text += ch;
    map.push(i);
  }
  return { text, map };
}

interface Word {
  key: string;
  start: number;
  end: number;
}

/** The text's words, compared by their letters and digits only (any case), with where each is. */
function words(s: string): Word[] {
  const out: Word[] = [];
  for (const m of s.matchAll(/\S+/g)) {
    const key = m[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (key) out.push({ key, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * The stretch of `text` closest to `quote`, word by word: the fewest words changed, added or taken out
 * (an edit distance where the stretch may start and end anywhere). Accepted when at least `threshold`
 * of the quote is still there.
 */
function approximate(text: string, quote: string, threshold: number): AnchorMatch | undefined {
  const q = words(quote);
  const t = words(text);
  const m = q.length;
  if (!m || !t.length) return undefined;
  // prev[j] / cur[j]: the distance of q[0..i) against a stretch of t ending at word j; start[j]: where it began.
  let prev = new Array<number>(t.length + 1).fill(0);
  let prevStart = Array.from({ length: t.length + 1 }, (_, j) => j);
  let cur = new Array<number>(t.length + 1);
  let curStart = new Array<number>(t.length + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    curStart[0] = 0;
    const key = q[i - 1]!.key;
    for (let j = 1; j <= t.length; j++) {
      const sub = prev[j - 1]! + (t[j - 1]!.key === key ? 0 : 1);
      const del = prev[j]! + 1;
      const ins = cur[j - 1]! + 1;
      if (sub <= del && sub <= ins) {
        cur[j] = sub;
        curStart[j] = prevStart[j - 1]!;
      } else if (del <= ins) {
        cur[j] = del;
        curStart[j] = prevStart[j]!;
      } else {
        cur[j] = ins;
        curStart[j] = curStart[j - 1]!;
      }
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let best = 1;
  for (let j = 2; j <= t.length; j++) if (prev[j]! < prev[best]!) best = j;
  const similarity = Math.max(0, 1 - prev[best]! / m);
  if (similarity < threshold) return undefined;
  const first = Math.min(prevStart[best]!, best - 1);
  return { from: t[first]!.start, to: t[best - 1]!.end, kind: "approximate", similarity };
}
