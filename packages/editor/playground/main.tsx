import type { Editor } from "@tiptap/core";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { countWords } from "@gh-writer/core";
import { useStore } from "zustand";
import { joinSceneFile, liveCounts, sessionCommands, splitSceneFile, writingModeCommands, type SceneSource } from "../src/index.ts";
import { ChapterEditor, SceneEditor, useWritingModes, WordCount } from "../src/react.tsx";
import { generatedChapter } from "./generated.ts";
import "../src/styles.css";
import "./playground.css";

declare global {
  interface Window {
    /** The current editor, for Playwright tests and the console. */
    editor?: Editor;
  }
}

interface SceneFile {
  path: string;
  title: string;
  text: string;
}

const files: Record<string, string> = {
  ...import.meta.glob("../../../examples/sample-novel/manuscript/**/*.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("./scenes/*.md", { query: "?raw", import: "default", eager: true }),
};
const scenes: SceneFile[] = Object.entries(files)
  .map(([path, text]) => ({
    path: path.replace(/^.*?(manuscript|scenes)\//, "$1/"),
    title: /^title:\s*(.+)$/m.exec(splitSceneFile(text).frontMatter)?.[1] ?? path,
    text,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

// Chapters are the sample novel's chapter folders, scenes in file name order, plus a generated
// 10,000-word chapter for performance work.
const GENERATED = "generated/10k-words";
const chapters = new Map<string, SceneFile[]>();
for (const scene of scenes.filter((s) => s.path.startsWith("manuscript/"))) {
  const dir = scene.path.slice(0, scene.path.lastIndexOf("/"));
  chapters.set(dir, [...(chapters.get(dir) ?? []), scene]);
}
chapters.set(
  GENERATED,
  generatedChapter(scenes.filter((s) => s.path.startsWith("manuscript/")).map((s) => splitSceneFile(s.text).body), 10_500).map((s) => ({
    path: `${GENERATED}/${s.id}.md`,
    title: s.title!,
    text: s.markdown,
  })),
);

function initial(): string {
  const params = new URLSearchParams(location.search);
  const chapter = params.get("chapter");
  if (chapter && chapters.has(chapter)) return `chapter:${chapter}`;
  return `scene:${scenes.find((s) => s.path === params.get("scene"))?.path ?? scenes[0]!.path}`;
}

function App() {
  const [open, setOpen] = useState(initial);
  // Edits stand in for saved files: kept for the tab's session, so a reload shows them (as the
  // real app would after saving) and session word counts can be checked across reloads.
  const [bodies, setBodies] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("playground:bodies") ?? "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("playground:bodies", JSON.stringify(bodies));
    } catch {}
  }, [bodies]);
  const [kind, target] = [open.slice(0, open.indexOf(":")), open.slice(open.indexOf(":") + 1)];
  const files = kind === "chapter" ? chapters.get(target)! : [scenes.find((s) => s.path === target)!];

  const sources: SceneSource[] = useMemo(
    () => files.map((f) => ({ id: f.path, title: f.title, markdown: bodies[f.path] ?? splitSceneFile(f.text).body })),
    [files, bodies],
  );
  const saved = files.map((f) => ({ ...f, saved: joinSceneFile({ ...splitSceneFile(f.text), body: bodies[f.path] ?? splitSceneFile(f.text).body }) }));
  const changed = saved.filter((f) => f.saved !== f.text).length;
  const setBody = (path: string, md: string) => setBodies((b) => ({ ...b, [path]: md }));
  const modes = useWritingModes();
  const [editor, setEditor] = useState<Editor>();
  const ready = (e: Editor) => {
    window.editor = e;
    setEditor(e);
  };
  // In the scene view the chapter count is the app's to give: the other scenes' saved counts plus this one live.
  const liveScene = useStore(liveCounts, (c) => c.scene);
  const sceneChapter = kind === "scene" ? scenes.filter((s) => s.path !== target && s.path.slice(0, s.path.lastIndexOf("/")) === target.slice(0, target.lastIndexOf("/"))) : [];
  const chapterWords = target.startsWith("manuscript/") && kind === "scene" ? sceneChapter.reduce((n, s) => n + countWords(bodies[s.path] ?? splitSceneFile(s.text).body), liveScene) : undefined;
  const keys = (k: string) => k.replace("Mod", navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl").replace(/-/g, "+").replace(/\+([a-z])$/, (_, c: string) => `+${c.toUpperCase()}`);

  return (
    <div className={modes.focus ? "layout focus" : "layout"}>
      {/* Announces mode changes, which are otherwise only visible. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {`Focus mode ${modes.focus ? "on" : "off"}. Typewriter scrolling ${modes.typewriter ? "on" : "off"}.`}
      </p>
      <header>
        <h1>Scene editor</h1>
        <div className="modes" role="group" aria-label="Writing modes">
          {[...writingModeCommands, ...sessionCommands].map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={"isActive" in c ? c.isActive!() : undefined}
              onClick={() => c.run(editor)}
              title={"keys" in c && c.keys ? keys(c.keys) : undefined}
            >
              {c.title}
            </button>
          ))}
        </div>
        <label>
          Open{" "}
          <select value={open} onChange={(e) => setOpen(e.target.value)}>
            <optgroup label="Chapters">
              {[...chapters.keys()].map((dir) => (
                <option key={dir} value={`chapter:${dir}`}>
                  {dir}
                </option>
              ))}
            </optgroup>
            <optgroup label="Scenes">
              {scenes.map((s) => (
                <option key={s.path} value={`scene:${s.path}`}>
                  {s.path}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      </header>
      <main>
        <WordCount className="counts" chapterWords={chapterWords} />
        {kind === "chapter" ? (
          <ChapterEditor
            key={open}
            scenes={sources}
            changeDelay={150}
            autofocus
            onChange={(changes) => changes.forEach((c) => setBody(c.id, c.markdown))}
            onReady={ready}
          />
        ) : (
          <SceneEditor
            key={open}
            sceneId={target}
            markdown={sources[0]!.markdown}
            changeDelay={150}
            autofocus
            onChange={(md) => setBody(target, md)}
            onReady={ready}
          />
        )}
      </main>
      <aside aria-labelledby="saved-heading">
        <h2 id="saved-heading">{files.length > 1 ? "Saved files" : "Saved file"}</h2>
        <p role="status" data-testid="status">
          {changed === 0 ? (files.length > 1 ? "Identical to the files on disk" : "Identical to the file on disk") : files.length > 1 ? `${changed} changed` : "Changed"}
        </p>
        {saved.map((f) => (
          <section key={f.path} aria-label={f.path}>
            {files.length > 1 && (
              <h3>
                {f.path.slice(f.path.lastIndexOf("/") + 1)} <span>{f.saved === f.text ? "unchanged" : "changed"}</span>
              </h3>
            )}
            <pre data-testid={files.length > 1 ? `saved:${f.path}` : "saved"} tabIndex={0} aria-label={`Saved contents of ${f.path}`}>
              {f.saved}
            </pre>
          </section>
        ))}
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
