/*
 * Changing story files the way a careful person would by hand: only the field that changes is
 * rewritten, and every other byte (comments, key order, quoting, flow or block style, blank lines,
 * line endings) stays as it was.
 *
 * Edits are made on the source text, at the ranges the yaml parser reports. After each edit the
 * result is parsed and compared with the intended data; if a case isn't handled surgically, the
 * document is re-serialised instead, which is still correct but may reformat it.
 */
import { isMap, isScalar, isSeq, parseDocument, Scalar, stringify, type Document, type Node, type Pair } from "yaml";
import { ID_ALPHABET, ID_LENGTH } from "./ids.ts";

export type YamlPath = (string | number)[];

/** Set `path` to `value`, or remove it with `remove`. Missing maps on the way are created. */
export type YamlEdit = { path: YamlPath; value: unknown } | { path: YamlPath; remove: true };

const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Apply `edits` in order to a YAML document's text. Throws if the text isn't valid YAML. */
export function editYaml(text: string, edits: YamlEdit[]): string {
  let out = text;
  for (const edit of edits) out = applyEdit(out, edit);
  return out;
}

/**
 * Apply `edits` to a Markdown file's front matter (created if there is none), leaving the delimiters,
 * BOM, line endings and the body untouched.
 */
export function editFrontMatter(text: string, edits: YamlEdit[]): string {
  const m = FRONT_MATTER.exec(text);
  if (!m || m.index !== 0) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const yaml = withEol(editYaml("", edits), eol);
    return `---${eol}${yaml}---${eol}${text}`;
  }
  const [whole, open, yaml, close] = m as unknown as [string, string, string, string];
  return open + editYaml(yaml, edits) + close + text.slice(whole.length);
}

/** The data in a Markdown file's front matter, or undefined. */
export function readFrontMatter(text: string): Record<string, unknown> | undefined {
  const m = FRONT_MATTER.exec(text);
  if (!m || m.index !== 0) return undefined;
  const data = parseDocument(m[2]!).toJS() as unknown;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

const FRONT_MATTER = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m;

function applyEdit(text: string, edit: YamlEdit): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`Can't edit invalid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const expected = JSON.stringify(applyToData(doc.toJS() as unknown, edit));
  const surgical = edited(text, doc, edit, eol);
  if (surgical !== undefined && sameData(surgical, expected)) return surgical;
  return reserialised(doc, edit, eol);
}

function sameData(text: string, expected: string): boolean {
  const doc = parseDocument(text);
  return !doc.errors.length && JSON.stringify(doc.toJS() ?? {}) === expected;
}

/** The edit made on the text itself, or undefined when the case needs re-serialising. */
function edited(text: string, doc: Document, edit: YamlEdit, eol: string): string | undefined {
  const { path } = edit;
  if (!path.length) return undefined;
  const parentPath = path.slice(0, -1);
  const key = path.at(-1)!;
  const parent = (parentPath.length ? doc.getIn(parentPath, true) : doc.contents) as Node | null | undefined;
  const remove = "remove" in edit;

  if (isMap(parent) && !parent.flow) {
    const pair = parent.items.find((p) => keyOf(p) === key);
    if (remove) return pair ? cut(text, pairStart(text, pair), pairEnd(text, pair)) : text;
    const value = (edit as { value: unknown }).value;
    if (pair) {
      // A scalar stays a scalar in place, keeping its quoting and any comment after it.
      if (isScalar(pair.value) && isPlainValue(value)) {
        const replacement = scalarText(value, pair.value);
        if (replacement !== undefined) return splice(text, pair.value.range![0], pair.value.range![1], replacement);
      }
      // A flow collection stays flow, on its line. An empty one (`[]`, `{}`) is a placeholder: filled, it becomes a block.
      if ((isSeq(pair.value) || isMap(pair.value)) && pair.value.flow && pair.value.items.length && Array.isArray(value) === isSeq(pair.value) && typeof value === "object" && value !== null) {
        return splice(text, pair.value.range![0], pair.value.range![1], flowText(value));
      }
      // Anything else: the whole pair, written again at its indentation.
      const start = pairStart(text, pair);
      return splice(text, start, pairEnd(text, pair), block({ [key]: value }, column(text, start), eol));
    }
    // A new key goes after the map's last pair, at the same indentation.
    const last = parent.items.at(-1);
    if (!last) return undefined;
    const indent = column(text, pairStart(text, last));
    const at = pairEnd(text, last);
    const before = at > 0 && text[at - 1] !== "\n" ? eol : "";
    return splice(text, at, at, before + block({ [key]: value }, indent, eol));
  }

  if (isSeq(parent) && !parent.flow && typeof key === "number") {
    const item = parent.items[key] as Node | undefined;
    if (remove) return item ? cut(text, lineStart(text, item.range![0]), lineEnd(text, item.range![1] - 1)) : text;
    const value = (edit as { value: unknown }).value;
    if (item) {
      if (isScalar(item) && isPlainValue(value)) {
        const replacement = scalarText(value, item);
        if (replacement !== undefined) return splice(text, item.range![0], item.range![1], replacement);
      }
      const start = lineStart(text, item.range![0]);
      return splice(text, start, lineEnd(text, item.range![1] - 1), block([value], column(text, start), eol));
    }
    if (key === parent.items.length && parent.items.length) {
      const last = parent.items.at(-1) as Node;
      const at = lineEnd(text, last.range![1] - 1);
      const before = text[at - 1] !== "\n" ? eol : "";
      return splice(text, at, at, before + block([value], column(text, lineStart(text, last.range![0])), eol));
    }
    return undefined;
  }

  // Inside a flow collection: write the whole collection again, still as flow.
  if ((isSeq(parent) || isMap(parent)) && parent.flow && parentPath.length) {
    const data = doc.getIn(parentPath) as { toJSON?: () => unknown } | undefined;
    const current = (data && typeof data.toJSON === "function" ? data.toJSON() : data) as unknown;
    const next = applyToData(structuredClone(current), { ...edit, path: [key] } as YamlEdit);
    return splice(text, parent.range![0], parent.range![1], flowText(next as object));
  }

  // The map holding the key doesn't exist yet: create it, as a new pair of its own parent.
  if ((parent === undefined || parent === null) && parentPath.length && !remove) {
    const nested: Record<string | number, unknown> = {};
    nested[key] = (edit as { value: unknown }).value;
    const outer = applyEdit(text, { path: parentPath, value: nested });
    return outer;
  }
  return undefined;
}

function reserialised(doc: Document, edit: YamlEdit, eol: string): string {
  if ("remove" in edit) doc.deleteIn(edit.path);
  else doc.setIn(edit.path, doc.createNode(edit.value));
  return withEol(doc.toString(STRINGIFY), eol);
}

// ——— Text helpers ———

const keyOf = (pair: Pair): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);

function pairStart(text: string, pair: Pair): number {
  return lineStart(text, (pair.key as Node).range![0]);
}

/** Just after the pair's last line, comments on it included. */
function pairEnd(text: string, pair: Pair): number {
  const node = (pair.value ?? pair.key) as Node;
  return lineEnd(text, Math.max(node.range![1] - 1, (pair.key as Node).range![0]));
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(text: string, at: number): number {
  const nl = text.indexOf("\n", at);
  return nl === -1 ? text.length : nl + 1;
}

function column(text: string, lineStartAt: number): number {
  let n = 0;
  while (text[lineStartAt + n] === " ") n++;
  return n;
}

const splice = (text: string, from: number, to: number, insert: string) => text.slice(0, from) + insert + text.slice(to);
const cut = (text: string, from: number, to: number) => splice(text, from, to, "");

function withEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\r?\n/g, eol);
}

/** `value` as block YAML, every line indented by `indent`, ending with a line break. */
function block(value: unknown, indent: number, eol: string): string {
  const pad = " ".repeat(indent);
  const lines = stringify(value, STRINGIFY).replace(/\n$/, "").split("\n");
  return lines.map((l) => pad + l).join(eol) + eol;
}

function flowText(value: object): string {
  return stringify(value, { ...STRINGIFY, collectionStyle: "flow" }).trim();
}

const isPlainValue = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** A scalar's new text on one line, in the old one's quoting where it can be; undefined if it needs more than a line. */
function scalarText(value: unknown, old: Scalar): string | undefined {
  const quoted = old.type === Scalar.QUOTE_DOUBLE || old.type === Scalar.QUOTE_SINGLE;
  const text = stringify(value, { ...STRINGIFY, ...(typeof value === "string" && quoted ? { defaultStringType: old.type } : {}) }).replace(/\n$/, "");
  return text.includes("\n") ? undefined : text;
}

// ——— Data ———

/** The edit applied to plain data, as the text should parse afterwards. */
function applyToData(data: unknown, edit: YamlEdit): unknown {
  const root = (data ?? {}) as Record<string | number, unknown>;
  let node: Record<string | number, unknown> = root;
  for (const [i, k] of edit.path.entries()) {
    if (i === edit.path.length - 1) {
      if ("remove" in edit) {
        if (Array.isArray(node) && typeof k === "number") node.splice(k, 1);
        else delete node[k];
      } else node[k] = edit.value;
      break;
    }
    if (node[k] === undefined || node[k] === null) node[k] = {};
    node = node[k] as Record<string | number, unknown>;
  }
  return root;
}

// ——— Names ———

/** A new ID with `prefix` that isn't in `taken`. */
export function uniqueId(prefix: string, taken: ReadonlySet<string>, random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new Error(`Invalid ID prefix: ${prefix}`);
  for (;;) {
    let suffix = "";
    for (const b of random(ID_LENGTH)) suffix += ID_ALPHABET[b & 31];
    const id = `${prefix}_${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** A filesystem-safe slug from a title or name: "Ben's Ledger" → "bens-ledger". */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "untitled";
}

/** `slug` + `ext`, or `slug-2` + `ext`… whichever isn't in `taken` (names in the same folder). */
export function uniqueFileName(slug: string, ext: string, taken: ReadonlySet<string>): string {
  let name = `${slug}${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}${ext}`;
  return name;
}

/** A numbered name for the `index`th (0-based) of `count` siblings: "03-the-station". */
export function numberedName(index: number, count: number, slug: string): string {
  return `${String(index + 1).padStart(Math.max(2, String(count).length), "0")}-${slug}`;
}
