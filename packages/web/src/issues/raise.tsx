import { ApiError } from "@gh-writer/client";
import { entityLabel, ISSUE_KINDS, type Novel } from "@gh-writer/core";
import { caretScene } from "@gh-writer/editor";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { create } from "zustand";
import { api, keys } from "../api.ts";
import { githubKey, useConnect } from "../github/connect.tsx";
import { useNotice } from "../novel/notice.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { labelChoices, LabelsField } from "./parts.tsx";
import { useIssueMeta } from "./use-issues.ts";

/** The kinds of note about a passage: each a label (kind/…) with its colour. */
export const KINDS = ISSUE_KINDS;

export interface Passage {
  /** The scene file, its ID and title. */
  path: string;
  scene: string;
  sceneTitle: string;
  quote: string;
  /** The entries mentioned in the passage. */
  mentions: string[];
}

/**
 * The selected passage: its words (mentions as written, paragraphs apart), within the scene where
 * the selection starts. Undefined with nothing selected.
 */
export function selectedPassage(editor: Editor, novel: Novel): Passage | undefined {
  const { state } = editor;
  const { from, to, empty, $from } = state.selection;
  if (empty) return undefined;
  let end = to;
  let path: string | undefined;
  if (state.doc.type.name === "chapter") {
    const i = $from.index(0);
    let start = 0;
    for (let j = 0; j < i; j++) start += state.doc.child(j).nodeSize;
    const scene = state.doc.child(i);
    path = scene.attrs.id as string;
    end = Math.min(to, start + scene.nodeSize - 1);
  } else path = caretScene(editor);
  const quote = state.doc.textBetween(from, end, "\n\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : String(leaf.attrs.label ?? ""))).trim();
  const scene = novel.allScenes.find((s) => s.file === path);
  if (!quote || !scene) return undefined;
  const mentions = new Set<string>();
  state.doc.nodesBetween(from, end, (node) => void (node.type.name === "mention" && node.attrs.id && mentions.add(String(node.attrs.id))));
  return { path: scene.file, scene: scene.id, sceneTitle: scene.title, quote, mentions: [...mentions] };
}

/** The passage an issue is being raised about, and the editor to go back to. */
export const useRaise = create<{ passage: Passage | undefined; editor: Editor | undefined; open: (passage: Passage, editor: Editor) => void; close: () => void }>((set, get) => ({
  passage: undefined,
  editor: undefined,
  open: (passage, editor) => set({ passage, editor }),
  close: () => {
    const editor = get().editor;
    set({ passage: undefined, editor: undefined });
    if (editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
  },
}));

/** Raise an issue about the selected passage, beside the text: its kind, a title, a note and labels. */
export function RaisePanel({ novelId, novel }: { novelId: string; novel: Novel }) {
  const { passage, close } = useRaise();
  if (!passage) return null;
  return <Raise key={`${passage.scene}:${passage.quote}`} novelId={novelId} novel={novel} passage={passage} close={close} />;
}

function Raise({ novelId, novel, passage, close }: { novelId: string; novel: Novel; passage: Passage; close: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const show = useNotice((n) => n.show);
  const meta = useIssueMeta(novelId);
  const [kind, setKind] = useState<string>(KINDS[0]!.key);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  // Who and what the passage is about, to start with: the scene's people, places and threads, and anything it mentions.
  const [labels, setLabels] = useState<string[]>(() => {
    const scene = novel.allScenes.find((s) => s.id === passage.scene);
    const ids = [
      ...(scene?.pov ? [scene.pov] : []),
      ...(scene?.characters ?? []),
      ...(scene?.locations ?? []),
      ...(scene?.entities ?? []),
      ...(scene?.plotlines.map((p) => p.id) ?? []),
      ...(scene?.themes.map((t) => t.id) ?? []),
      ...passage.mentions,
    ];
    return [...new Set(ids)].flatMap((id) => {
      const entity = novel.entities.find((e) => e.id === id);
      return entity ? [entityLabel(novel, entity).name] : [];
    });
  });
  const [busy, setBusy] = useState(false);
  const ids = { heading: useId(), details: useId() };
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.querySelector<HTMLInputElement>("input[type=text], input:not([type])")?.focus(), []);

  const raise = async () => {
    if (!title.trim() || busy) return;
    const k = KINDS.find((x) => x.key === kind)!;
    setBusy(true);
    try {
      const issue = await api.issues.raise(novelId, { ...passage, title, details, kind: { name: `kind/${k.key}`, color: k.color, description: k.description }, labels });
      void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) });
      close();
      show({
        message: issue.pending ? `Kept “${issue.title}”: it goes to GitHub once it can be reached.` : `Raised #${issue.number} “${issue.title}”.`,
        action: { label: "Open it", run: () => void navigate(`/novels/${novelId}/issues/${issue.number}`) },
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "NO_SIGN_IN") {
        void queryClient.invalidateQueries({ queryKey: githubKey });
        show({ message: e.message, action: { label: "Reconnect GitHub", run: () => useConnect.getState().show(() => void raise()) } });
      } else show({ message: `Couldn't raise the issue: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      ref={panel}
      aria-labelledby={ids.heading}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          close();
        }
      }}
      className="grid content-start gap-3 border-rule bg-panel p-4 text-sm lg:overflow-y-auto lg:border-l"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={ids.heading} className="font-semibold">
          Raise an issue
        </h2>
        <button type="button" onClick={close} aria-label="Back to the text" className="rounded p-1 text-muted hover:bg-paper">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <blockquote className="border-l-2 border-rule pl-3 text-muted italic">
        <span className="line-clamp-4 whitespace-pre-line">{passage.quote}</span>
        <span className="mt-1 block text-xs not-italic">in “{passage.sceneTitle}”</span>
      </blockquote>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void raise();
        }}
      >
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 font-medium">Kind</legend>
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((k) => (
              <label key={k.key} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-rule bg-raised px-2.5 py-1 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="radio" name="kind" value={k.key} checked={kind === k.key} onChange={() => setKind(k.key)} className="sr-only" />
                <span className="inline-block size-2 rounded-full" style={{ background: `#${k.color}` }} aria-hidden />
                {k.label}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <div className="grid gap-1.5">
          <label htmlFor={ids.details} className="font-medium">
            Note
          </label>
          <textarea id={ids.details} value={details} onChange={(e) => setDetails(e.target.value)} rows={4} className="rounded-md border border-rule bg-raised px-3 py-2" placeholder="Optional; Markdown, as on GitHub" />
        </div>
        <LabelsField label="Labels" chosen={labels} labels={labelChoices(meta, novel)} onChange={setLabels} />
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || busy}>
            Raise issue
          </Button>
        </div>
      </form>
    </aside>
  );
}
