import type { Autosave } from "@gh-writer/client";
import type { StoreApi } from "zustand";
import { useStore } from "zustand";
import type { QuickEntriesState } from "../bible/quick-entries.ts";

const LABELS = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Not saved" } as const;

/** Whether the author's text is on disk, and the entries made from it in the story bible. */
export function SaveStatus({ autosave, entries }: { autosave: Autosave; entries?: StoreApi<QuickEntriesState> | undefined }) {
  const { status: text, error } = useStore(autosave.store);
  const pending = useStore(entries ?? EMPTY, (s) => s.pending);
  const refused = pending.find((e) => e.refused);
  const status = text === "error" || refused ? "error" : text === "saved" && pending.length ? "saving" : text;
  return (
    <p role="status" className={status === "error" ? "text-sm text-danger" : "text-sm text-muted"} title={error ?? (refused && `“${refused.name}” isn't in the story bible yet: ${refused.refused}`)}>
      {LABELS[status]}
    </p>
  );
}

const EMPTY: StoreApi<QuickEntriesState> = { getState: () => NONE, getInitialState: () => NONE, setState: () => {}, subscribe: () => () => {} };
const NONE: QuickEntriesState = { pending: [] };
