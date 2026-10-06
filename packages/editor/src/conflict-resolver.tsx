import { resolveMerge, type MergeChunk, type Resolution } from "@gh-writer/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parseProse } from "./markdown.ts";
import { splitSceneFile } from "./scene-file.ts";
import { proseSchema } from "./schema.ts";

/** One file to resolve: core's merge3 (or merge2) chunks for it. */
export interface ConflictFileView {
  path: string;
  /** What to call it, e.g. the scene's title. Default: the path. */
  title?: string;
  chunks: MergeChunk[];
  /** Not text: only one side or the other can be kept. */
  binary?: boolean;
  /** Whether each side still has the file (false: that side deleted it). Default true. */
  inOurs?: boolean;
  inTheirs?: boolean;
}

/** A file's outcome: its new text (null deletes it), or one side's file kept as it is. */
export type ResolvedFile = { content: string | null } | { keep: "ours" | "theirs" };

export interface ConflictResolverProps {
  files: ConflictFileView[];
  /** Called once every conflict has a choice and the author finishes, with each file's outcome by path. */
  onResolve: (files: Record<string, ResolvedFile>) => void;
  /** "Not now": the conflicts stay as they are. */
  onCancel?: () => void;
  /** What to call each side. Default "Mine" and "Theirs". */
  labels?: { ours: string; theirs: string };
  autofocus?: boolean;
  className?: string;
}

interface Item {
  file: number;
  /** Index among the file's conflicts. */
  n: number;
  chunk: Extract<MergeChunk, { type: "conflict" }>;
  /** The agreed text just before and after, for context. */
  before: string;
  after: string;
}

/** A whole-file choice: the file is binary, or one side deleted it. */
const wholeFile = (f: ConflictFileView) => Boolean(f.binary) || f.inOurs === false || f.inTheirs === false;

/**
 * Resolve sync conflicts one at a time: both versions of a paragraph (or front matter field) side by
 * side, rendered as prose, with keyboard choices: 1 keep mine, 2 keep theirs, 3 keep both, E edit,
 * ← and → to move, Mod+Enter to finish.
 */
export function ConflictResolver({ files, onResolve, onCancel, labels = { ours: "Mine", theirs: "Theirs" }, autofocus = true, className }: ConflictResolverProps) {
  const items = useMemo(() => {
    const out: Item[] = [];
    files.forEach((f, file) => {
      let n = 0;
      f.chunks.forEach((chunk, i) => {
        if (chunk.type !== "conflict") return;
        // Context is prose around the conflict; a front matter field has none.
        const prose = chunk.field === undefined && !wholeFile(f);
        const before = splitSceneFile(f.chunks.slice(0, i).map((c) => (c.type === "same" ? c.text : c.ours)).join(""));
        const next = f.chunks[i + 1];
        out.push({
          file,
          n: n++,
          chunk,
          before: prose ? lastParagraph(before.body) : "",
          after: prose && next?.type === "same" ? firstParagraph(next.text) : "",
        });
      });
    });
    return out;
  }, [files]);
  const [choices, setChoices] = useState<(Resolution | undefined)[]>(() => items.map(() => undefined));
  const [current, setCurrent] = useState(0);
  const [draft, setDraft] = useState<string | undefined>();
  const root = useRef<HTMLElement>(null);
  const editBox = useRef<HTMLTextAreaElement>(null);
  const ids = { heading: useId(), edit: useId() };

  useEffect(() => setChoices(items.map(() => undefined)), [items]);
  useEffect(() => {
    if (autofocus) root.current?.focus();
  }, [autofocus]);
  useEffect(() => {
    if (draft !== undefined) editBox.current?.focus();
  }, [draft !== undefined]);

  const item = items[current];
  const file = item ? files[item.file]! : undefined;
  const resolved = choices.filter((c) => c !== undefined).length;
  const done = items.length > 0 && resolved === items.length;
  const canBoth = Boolean(item && file && !wholeFile(file) && item.chunk.field === undefined);

  const choose = (choice: Resolution) => {
    const next = choices.map((c, i) => (i === current ? choice : c));
    setChoices(next);
    setDraft(undefined);
    // On to the next conflict still open, after this one, then from the start.
    const open = [...items.keys()].filter((i) => next[i] === undefined);
    const after = open.find((i) => i > current) ?? open[0];
    if (after !== undefined) setCurrent(after);
    root.current?.focus();
  };

  const finish = () => {
    if (!done) return;
    const out: Record<string, ResolvedFile> = {};
    files.forEach((f, fi) => {
      const mine = items.flatMap((it, i) => (it.file === fi ? [choices[i]!] : []));
      if (wholeFile(f)) {
        const [choice] = mine;
        out[f.path] = choice === "ours" || choice === "theirs" ? { keep: choice } : { content: choice && typeof choice === "object" ? choice.text : null };
      } else out[f.path] = { content: resolveMerge(f.chunks, mine) };
    });
    onResolve(out);
  };

  const startEdit = () => {
    if (!item || (file && file.binary)) return;
    const choice = choices[current];
    const start = typeof choice === "object" ? choice.text : choice === "theirs" ? item.chunk.theirs : choice === "both" ? `${item.chunk.ours}\n${item.chunk.theirs}` : item.chunk.ours;
    setDraft(start.trim());
  };

  const applyEdit = () => {
    if (!item || draft === undefined) return;
    // Keep the paragraph's place: the blank line before it and its line ending.
    const model = item.chunk.ours || item.chunk.theirs;
    const text = draft.trim() ? `${/^\s*/.exec(model)![0]}${draft.trim()}${model.endsWith("\n") ? "\n" : ""}` : "";
    choose({ text });
  };

  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (draft !== undefined) {
      if (e.key === "Escape") {
        e.preventDefault();
        setDraft(undefined);
        root.current?.focus();
      } else if (e.key === "Enter" && mod) {
        e.preventDefault();
        applyEdit();
      }
      return;
    }
    if (e.altKey || (mod && e.key !== "Enter")) return;
    const act: Record<string, () => void> = {
      "1": () => choose("ours"),
      "2": () => choose("theirs"),
      "3": () => canBoth && choose("both"),
      e: startEdit,
      E: startEdit,
      ArrowRight: () => setCurrent((c) => Math.min(c + 1, items.length - 1)),
      ArrowLeft: () => setCurrent((c) => Math.max(c - 1, 0)),
      Enter: () => mod && finish(),
      Escape: () => onCancel?.(),
    };
    const run = act[e.key];
    if (!run || (e.key === "Enter" && !mod)) return;
    e.preventDefault();
    run();
  };

  if (!item || !file) {
    return (
      <section className={cls(className)} aria-labelledby={ids.heading} ref={root} tabIndex={-1}>
        <h2 id={ids.heading}>Nothing to resolve</h2>
        <button type="button" onClick={() => onResolve(Object.fromEntries(files.map((f) => [f.path, { content: resolveMerge(f.chunks, []) }])))}>
          Finish
        </button>
      </section>
    );
  }

  const choice = choices[current];
  const pressed = (c: Resolution) => (choice === c ? true : choice === undefined ? undefined : false);
  const where = `${file.title ?? file.path}${item.chunk.field !== undefined ? `: the “${item.chunk.field}” field` : ""}`;
  const side = (which: "ours" | "theirs") => {
    const present = which === "ours" ? file.inOurs !== false : file.inTheirs !== false;
    const text = item.chunk[which];
    if (!present) return <p className="ghw-conflict-note">The file was deleted.</p>;
    if (file.binary) return <p className="ghw-conflict-note">Not text, so it can't be shown.</p>;
    if (!text.trim()) return <p className="ghw-conflict-note">Removed.</p>;
    return item.chunk.field !== undefined ? <pre className="ghw-conflict-field">{text.trimEnd()}</pre> : <Prose markdown={text} />;
  };

  return (
    <section className={cls(className)} aria-labelledby={ids.heading} ref={root} tabIndex={-1} onKeyDown={onKey}>
      <header className="ghw-conflict-head">
        <h2 id={ids.heading}>Resolve conflicts</h2>
        <p role="status" aria-live="polite" aria-atomic="true">
          {`Conflict ${current + 1} of ${items.length} · ${resolved} resolved`}
        </p>
      </header>
      <p className="ghw-conflict-where">{where}</p>
      {item.before && (
        <div className="ghw-conflict-context" role="group" aria-label="Before">
          <Prose markdown={item.before} />
        </div>
      )}
      <div className="ghw-conflict-sides">
        {(["ours", "theirs"] as const).map((which) => (
          <div key={which} className="ghw-conflict-side" role="group" data-chosen={choice === which || choice === "both" ? "" : undefined} aria-label={labels[which]}>
            <h3>{labels[which]}</h3>
            {side(which)}
          </div>
        ))}
      </div>
      {item.after && (
        <div className="ghw-conflict-context" role="group" aria-label="After">
          <Prose markdown={item.after} />
        </div>
      )}
      {draft !== undefined ? (
        <div className="ghw-conflict-edit">
          <label htmlFor={ids.edit}>Your version</label>
          <textarea id={ids.edit} ref={editBox} value={draft} rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))} onChange={(e) => setDraft(e.target.value)} />
          <div className="ghw-conflict-row">
            <button type="button" onClick={applyEdit} aria-keyshortcuts="Control+Enter Meta+Enter">
              Use this version
            </button>
            <button type="button" onClick={() => setDraft(undefined)} aria-keyshortcuts="Escape">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="ghw-conflict-row" role="group" aria-label="Choose">
          <button type="button" aria-pressed={pressed("ours")} aria-keyshortcuts="1" onClick={() => choose("ours")}>
            Keep {labels.ours.toLowerCase()} <kbd>1</kbd>
          </button>
          <button type="button" aria-pressed={pressed("theirs")} aria-keyshortcuts="2" onClick={() => choose("theirs")}>
            Keep {labels.theirs.toLowerCase()} <kbd>2</kbd>
          </button>
          {canBoth && (
            <button type="button" aria-pressed={pressed("both")} aria-keyshortcuts="3" onClick={() => choose("both")}>
              Keep both <kbd>3</kbd>
            </button>
          )}
          {!file.binary && (
            <button type="button" aria-pressed={typeof choice === "object" ? true : choice === undefined ? undefined : false} aria-keyshortcuts="E" onClick={startEdit}>
              Edit… <kbd>E</kbd>
            </button>
          )}
        </div>
      )}
      <footer className="ghw-conflict-row">
        <button type="button" onClick={() => setCurrent((c) => Math.max(c - 1, 0))} disabled={current === 0} aria-keyshortcuts="ArrowLeft">
          Previous
        </button>
        <button type="button" onClick={() => setCurrent((c) => Math.min(c + 1, items.length - 1))} disabled={current === items.length - 1} aria-keyshortcuts="ArrowRight">
          Next
        </button>
        <span className="ghw-conflict-spacer" />
        {onCancel && (
          <button type="button" onClick={onCancel} aria-keyshortcuts="Escape">
            Not now
          </button>
        )}
        <button type="button" className="ghw-conflict-finish" onClick={finish} disabled={!done} aria-keyshortcuts="Control+Enter Meta+Enter">
          Finish
        </button>
      </footer>
    </section>
  );
}

/** Markdown rendered with the editor's own schema, so it reads as it will in the scene. */
function Prose({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const doc = parseProse(markdown.replace(/^\s+/, ""));
    el.replaceChildren(DOMSerializer.fromSchema(proseSchema).serializeFragment(doc.content, { document }));
  }, [markdown]);
  return <div className="ghw-prose ghw-conflict-prose" ref={ref} />;
}

function cls(className: string | undefined): string {
  return ["ghw-conflicts", className].filter(Boolean).join(" ");
}

const paragraphs = (text: string) => text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
const lastParagraph = (text: string) => paragraphs(text).at(-1) ?? "";
const firstParagraph = (text: string) => paragraphs(text)[0] ?? "";
