import type { Autosave } from "@gh-writer/client";
import { useStore } from "zustand";

const LABELS = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Not saved" } as const;

/** Whether the author's text is on disk. */
export function SaveStatus({ autosave }: { autosave: Autosave }) {
  const { status, error } = useStore(autosave.store);
  return (
    <p role="status" className={status === "error" ? "text-sm text-danger" : "text-sm text-muted"} title={error}>
      {LABELS[status]}
    </p>
  );
}
