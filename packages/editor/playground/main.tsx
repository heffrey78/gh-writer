import type { Editor } from "@tiptap/core";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { joinSceneFile, splitSceneFile } from "../src/index.ts";
import { SceneEditor } from "../src/react.tsx";
import "../src/styles.css";
import "./playground.css";

declare global {
  interface Window {
    /** The current editor, for Playwright tests and the console. */
    editor?: Editor;
  }
}

const files: Record<string, string> = {
  ...import.meta.glob("../../../examples/sample-novel/manuscript/**/*.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("./scenes/*.md", { query: "?raw", import: "default", eager: true }),
};
const scenes = Object.entries(files)
  .map(([path, text]) => ({ path: path.replace(/^.*?(manuscript|scenes)\//, "$1/"), text }))
  .sort((a, b) => a.path.localeCompare(b.path));

function App() {
  const params = new URLSearchParams(location.search);
  const [path, setPath] = useState(scenes.find((s) => s.path === params.get("scene"))?.path ?? scenes[0]!.path);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const scene = scenes.find((s) => s.path === path)!;
  const file = splitSceneFile(scene.text);
  const body = bodies[path] ?? file.body;
  const saved = joinSceneFile({ ...file, body });

  return (
    <div className="layout">
      <header>
        <h1>Scene editor</h1>
        <label>
          Scene{" "}
          <select value={path} onChange={(e) => setPath(e.target.value)}>
            {scenes.map((s) => (
              <option key={s.path}>{s.path}</option>
            ))}
          </select>
        </label>
      </header>
      <main>
        <SceneEditor
          key={path}
          markdown={body}
          changeDelay={150}
          autofocus
          onChange={(md) => setBodies((b) => ({ ...b, [path]: md }))}
          onReady={(editor) => (window.editor = editor)}
        />
      </main>
      <aside aria-labelledby="saved-heading">
        <h2 id="saved-heading">Saved file</h2>
        <p role="status" data-testid="status">
          {saved === scene.text ? "Identical to the file on disk" : "Changed"}
        </p>
        <pre data-testid="saved" tabIndex={0} aria-label="Saved file contents">
          {saved}
        </pre>
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
