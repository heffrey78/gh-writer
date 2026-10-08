import type { Novel } from "@gh-writer/core";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { ago } from "../format.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/dialog.tsx";
import { Field } from "../ui/field.tsx";
import { Picker } from "../ui/picker.tsx";
import { chapterTitle } from "./navigation.tsx";
import type { Structure } from "./structure.ts";

const Frame = Modal;

/** Ask for a title, then run `submit` with it. */
export function TitleDialog({ title, label = "Title", initial = "", required = true, action, submit, onClose }: { title: string; label?: string; initial?: string; required?: boolean; action: string; submit: (value: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (required && !value.trim()) return;
    setBusy(true);
    await submit(value.trim());
    onClose();
  };
  return (
    <Frame title={title} onClose={onClose}>
      <form onSubmit={(e) => void go(e)} className="grid gap-3">
        <Field label={label} value={value} onChange={(e) => setValue(e.target.value)} required={required} autoFocus onFocus={(e) => e.target.select()} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || (required && !value.trim())}>
            {action}
          </Button>
        </div>
      </form>
    </Frame>
  );
}

/** Move a scene to another chapter (at its end), or a chapter to another part. */
export function MoveToDialog({ novel, id, kind, structure, onClose }: { novel: Novel; id: string; kind: "scene" | "chapter"; structure: Structure; onClose: () => void }) {
  const items =
    kind === "scene"
      ? novel.chapters.map((c) => ({ value: c.id, label: chapterTitle(novel, c), group: novel.parts.find((p) => p.id === c.partId)?.title ?? "" }))
      : novel.parts.map((p) => ({ value: p.id, label: p.title }));
  const [to, setTo] = useState<string>();
  const size = (target: string) =>
    kind === "scene" ? (novel.allChapters.find((c) => c.id === target)?.sceneIds.filter((s) => s !== id).length ?? 0) : (novel.allParts.find((p) => p.id === target)?.chapterIds.filter((c) => c !== id).length ?? 0);
  return (
    <Frame title={kind === "scene" ? "Move to chapter" : "Move to part"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (to) void structure.move(id, size(to), to).then(onClose);
        }}
        className="grid gap-3"
      >
        <Picker label={kind === "scene" ? "Chapter" : "Part"} items={items} value={to} onChange={setTo} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!to}>
            Move
          </Button>
        </div>
      </form>
    </Frame>
  );
}

/** Scenes, chapters and parts deleted from the manuscript, each with Restore. */
export function RecentlyDeletedDialog({ novelId, structure, onClose }: { novelId: string; structure: Structure; onClose: () => void }) {
  const deleted = useQuery({ queryKey: ["deleted", novelId], queryFn: () => api.manuscript.recentlyDeleted(novelId), staleTime: 0 });
  return (
    <Frame title="Recently deleted" onClose={onClose}>
      {deleted.isPending ? (
        <p className="text-sm text-muted">Looking…</p>
      ) : deleted.isError ? (
        <ErrorAlert title="Couldn't list them">{deleted.error.message}</ErrorAlert>
      ) : deleted.data.length ? (
        <ul className="grid gap-2">
          {deleted.data.map((d) => (
            <li key={`${d.commit}:${d.id}`} className="flex items-center justify-between gap-3 rounded-md border border-rule px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{d.title}</span>
                <span className="text-muted">
                  {" "}
                  · {d.kind}, deleted {ago(d.date)}
                </span>
              </span>
              <Button size="sm" aria-label={`Restore “${d.title}”`} onClick={() => void structure.restore(d.commit, d.id, d.title).then(onClose)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing deleted lately.</p>
      )}
      <div className="flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Frame>
  );
}
