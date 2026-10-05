import type { Editor } from "@tiptap/core";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { SceneMarkdown } from "./chapter.ts";
import { closeFind, findPanel } from "./find.ts";
import {
  editorScenes,
  replaceAll,
  replaceInEditor,
  replaceInMarkdown,
  searchManuscript,
  setSearchHighlights,
  type ChapterResult,
  type Manuscript,
  type SceneResult,
  type SearchMatch,
  type SearchScope,
} from "./search.ts";

export interface FindReplaceProps {
  /** Every chapter in reading order, with each scene's saved Markdown. */
  manuscript: Manuscript;
  /** The open editor. Its scenes are searched and replaced live, and undo works there. */
  editor?: Editor | null;
  /** Saves new Markdown for scenes that aren't open in the editor. */
  onReplace?: (changed: SceneMarkdown[]) => void;
  /** Opens a scene that isn't in the editor, to show a match in it. The panel selects the match once it is. */
  onOpenScene?: (sceneId: string) => void;
  className?: string;
}

interface Hit {
  chapter: ChapterResult;
  scene: SceneResult;
  match: SearchMatch;
  /** The match's position among its scene's matches. */
  nth: number;
}

/** Most results listed at once; the rest are still counted, found and replaced. */
const LIST_LIMIT = 500;

const SCOPES: [SearchScope, string][] = [
  ["scene", "Scene"],
  ["chapter", "Chapter"],
  ["manuscript", "Manuscript"],
];

/**
 * Find and replace across the manuscript: a keyboard-first panel that opens on Mod-F (this
 * scene) and Mod-Shift-H (the manuscript) from the editor, or from the command palette.
 */
export function FindReplace({ manuscript, editor, onReplace, onOpenScene, className }: FindReplaceProps) {
  const panel = useStore(findPanel);
  const [text, setText] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [current, setCurrent] = useState(0);
  const [version, setVersion] = useState(0);
  const [undo, setUndo] = useState<{ previous: SceneMarkdown[]; editorDoc: unknown; replaced: number; scenes: number } | null>(null);
  const pending = useRef<{ sceneId: string; nth: number } | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const ids = { find: useId(), replace: useId(), status: useId() };
  const query = useDeferredValue(text);

  // Opening (or re-requesting) the panel: take the scope and seed, focus the query.
  useEffect(() => {
    if (!panel.open) return;
    if (panel.seed) setText(panel.seed);
    findInput.current?.focus();
    findInput.current?.select();
  }, [panel.open, panel.request]);

  // Search again as the open document changes.
  useEffect(() => {
    if (!editor || !panel.open) return;
    const bump = () => setVersion((v) => v + 1);
    editor.on("update", bump);
    editor.on("selectionUpdate", bump);
    return () => {
      editor.off("update", bump);
      editor.off("selectionUpdate", bump);
    };
  }, [editor, panel.open]);

  const results = useMemo(
    () =>
      panel.open
        ? searchManuscript({ manuscript, query: { text: query, caseSensitive, wholeWord, regex }, scope: panel.scope, editor })
        : { chapters: [], count: 0 },
    // `version` re-runs the search when the editor's document changes.
    [panel.open, manuscript, query, caseSensitive, wholeWord, regex, panel.scope, editor, version],
  );

  const hits = useMemo(() => {
    const out: Hit[] = [];
    for (const chapter of results.chapters) for (const scene of chapter.scenes) scene.matches.forEach((match, nth) => out.push({ chapter, scene, match, nth }));
    return out;
  }, [results]);
  const hitIndex = useMemo(() => new Map(hits.map((h, i) => [h.match, i])), [hits]);
  const index = hits.length ? Math.min(current, hits.length - 1) : -1;
  const hit = index >= 0 ? hits[index] : undefined;

  // Highlight the open document's matches, the current one distinctly.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (!panel.open) return setSearchHighlights(editor, []);
    const live = hits.filter((h) => h.scene.live).map((h) => h.match);
    setSearchHighlights(editor, live, hit?.scene.live ? hit.match : undefined);
  }, [editor, panel.open, hits, hit]);
  useEffect(() => () => void (editor && !editor.isDestroyed && setSearchHighlights(editor, [])), [editor]);

  // A match in a scene that had to be opened first: select it once the editor holds the scene.
  useEffect(() => {
    const want = pending.current;
    if (!want || !editor) return;
    const i = hits.findIndex((h) => h.scene.live && h.scene.sceneId === want.sceneId && h.nth === Math.min(want.nth, h.scene.matches.length - 1));
    if (i < 0) return;
    pending.current = null;
    setCurrent(i);
    // A new editor applies its autofocus (which moves the selection) just before "create".
    if (editor.isInitialized) return select(hits[i]!, true);
    const afterCreate = () => {
      editor.off("create", afterCreate);
      select(hits[i]!, true);
    };
    editor.on("create", afterCreate);
    return () => void editor.off("create", afterCreate);
  }, [hits, editor]);

  function select(h: Hit, focusText: boolean) {
    if (!h.scene.live) {
      pending.current = { sceneId: h.scene.sceneId, nth: h.nth };
      onOpenScene?.(h.scene.sceneId);
      return;
    }
    if (!editor || editor.isDestroyed) return;
    const chain = focusText ? editor.chain().focus() : editor.chain();
    chain.setTextSelection({ from: h.match.from, to: h.match.to }).scrollIntoView().run();
  }

  function go(step: number) {
    if (!hits.length) return;
    const next = (index + step + hits.length) % hits.length;
    setCurrent(next);
    select(hits[next]!, false);
  }

  function replaceOne() {
    if (!hit || !hit.match.replaceable) return;
    if (hit.scene.live && editor) replaceInEditor(editor, hit.match, replacement, regex);
    else {
      const scene = manuscript.flatMap((c) => c.scenes).find((s) => s.id === hit.scene.sceneId);
      if (scene) onReplace?.([{ id: scene.id, markdown: replaceInMarkdown(scene.markdown, [hit.match], replacement, regex) }]);
    }
    setUndo(null);
    // The replaced match drops out of the results; the same index is now the next one.
  }

  function replaceEverything() {
    const r = replaceAll(results, manuscript, replacement, regex, editor);
    if (r.changed.length) onReplace?.(r.changed);
    const scenes = new Set([...r.changed.map((c) => c.id), ...hits.filter((h) => h.scene.live && h.match.replaceable).map((h) => h.scene.sceneId)]);
    setUndo({ previous: r.previous, editorDoc: r.editorChanged ? editor?.state.doc : null, replaced: r.replaced, scenes: scenes.size });
  }

  function undoReplaceAll() {
    if (!undo) return;
    if (undo.previous.length) onReplace?.(undo.previous);
    // Undo in the editor only if nothing has happened there since; otherwise Mod-Z is the writer's.
    if (undo.editorDoc && editor && editor.state.doc === undo.editorDoc) editor.commands.undo();
    setUndo(null);
    findInput.current?.focus();
  }

  function close() {
    closeFind();
    setUndo(null);
    if (editor && !editor.isDestroyed) editor.commands.focus();
  }

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    }
  };
  const onPanelKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      replaceEverything();
    }
  };

  const sceneCount = results.chapters.reduce((n, c) => n + c.scenes.length, 0);
  const status = results.error
    ? `Invalid search: ${results.error}`
    : !text
      ? "Type to search"
      : results.count === 0
        ? "No matches"
        : `${index + 1} of ${results.count} ${results.count === 1 ? "match" : "matches"}${sceneCount > 1 ? ` in ${sceneCount} scenes` : ""}`;
  const openScenes = editor && !editor.isDestroyed ? editorScenes(editor) : new Map();
  let listed = 0;

  return (
    <section className={["ghw-find", className].filter(Boolean).join(" ")} role="search" aria-label="Find and replace" hidden={!panel.open} onKeyDown={onPanelKey}>
      <div className="ghw-find-row">
        <label htmlFor={ids.find}>Find</label>
        <input
          id={ids.find}
          ref={findInput}
          type="search"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCurrent(0);
            setUndo(null);
          }}
          onKeyDown={onFindKey}
          aria-describedby={ids.status}
          aria-invalid={!!results.error}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="button" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} aria-label="Match case" title="Match case">
          Aa
        </button>
        <button type="button" aria-pressed={wholeWord} onClick={() => setWholeWord((v) => !v)} aria-label="Whole words" title="Whole words">
          W
        </button>
        <button type="button" aria-pressed={regex} onClick={() => setRegex((v) => !v)} aria-label="Regular expression" title="Regular expression">
          .*
        </button>
        <button type="button" onClick={() => go(-1)} disabled={!hits.length} aria-label="Previous match" title="Previous match (Shift+Enter)">
          ↑
        </button>
        <button type="button" onClick={() => go(1)} disabled={!hits.length} aria-label="Next match" title="Next match (Enter)">
          ↓
        </button>
      </div>
      <div className="ghw-find-row">
        <label htmlFor={ids.replace}>Replace</label>
        <input id={ids.replace} type="text" value={replacement} onChange={(e) => setReplacement(e.target.value)} spellCheck={false} autoComplete="off" />
        <button type="button" onClick={replaceOne} disabled={!hit?.match.replaceable}>
          Replace
        </button>
        <button type="button" onClick={replaceEverything} disabled={!hits.some((h) => h.match.replaceable)} title="Replace all (Alt+Enter)">
          Replace all
        </button>
      </div>
      <div className="ghw-find-row">
        <fieldset className="ghw-find-scope">
          <legend>Search in</legend>
          {SCOPES.map(([scope, label]) => (
            <label key={scope}>
              <input
                type="radio"
                name={`${ids.find}-scope`}
                checked={panel.scope === scope}
                onChange={() => {
                  findPanel.setState({ scope });
                  setCurrent(0);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <button type="button" className="ghw-find-close" onClick={close} title="Close (Escape)">
          Close
        </button>
      </div>
      <p className="ghw-find-status" id={ids.status} role="status">
        {undo ? `Replaced ${undo.replaced} in ${undo.scenes} ${undo.scenes === 1 ? "scene" : "scenes"}.` : status}
        {undo && (
          <button type="button" onClick={undoReplaceAll}>
            Undo
          </button>
        )}
      </p>
      {hit && !hit.match.replaceable && <p className="ghw-find-note">This match is part of a mention, which can only be replaced whole.</p>}
      {results.chapters.length > 0 && (
        <div className="ghw-find-results">
          {results.chapters.map((chapter) => (
            <section key={chapter.chapterId} aria-label={chapter.title}>
              <h3>{chapter.title}</h3>
              {chapter.scenes.map((scene) => (
                <section key={scene.sceneId} aria-label={scene.title}>
                  <h4>
                    {scene.title} <span>{scene.matches.length}</span>
                    {openScenes.has(scene.sceneId) ? null : <span className="ghw-visually-hidden"> (opens the scene)</span>}
                  </h4>
                  <ol>
                    {scene.matches.map((match, nth) => {
                      if (listed++ >= LIST_LIMIT) return null;
                      const i = hitIndex.get(match)!;
                      return (
                        <li key={nth}>
                          <button
                            type="button"
                            aria-current={i === index ? "true" : undefined}
                            onClick={() => {
                              setCurrent(i);
                              select(hits[i]!, true);
                            }}
                          >
                            {match.before}
                            <mark>{match.text}</mark>
                            {match.after}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </section>
          ))}
          {results.count > LIST_LIMIT && <p className="ghw-find-note">Showing the first {LIST_LIMIT} of {results.count}.</p>}
        </div>
      )}
    </section>
  );
}
