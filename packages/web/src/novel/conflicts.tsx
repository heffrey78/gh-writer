import { type Conflicts, type FileResolution } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { ConflictResolver, type ResolvedFile } from "@gh-writer/editor/react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, VisuallyHidden } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { api } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import type { Workspace } from "./workspace.ts";

/** What to call a file: its scene title or bible entry name, else its path. */
export function fileTitle(novel: Novel | undefined, path: string): string {
  return novel?.allScenes.find((s) => s.file === path)?.title ?? novel?.entities.find((e) => e.file === path)?.name ?? path;
}

export function Frame({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg"
          // The resolver focuses itself.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <VisuallyHidden.Root>
            <Dialog.Title>{title}</Dialog.Title>
          </VisuallyHidden.Root>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A sync conflict: the same passage changed here and on GitHub. Resolving commits the merge and
 * syncs; if things moved on meanwhile, the fresh conflicts are shown instead.
 */
export function SyncConflicts({ novelId, novel, workspace, open, onClose }: { novelId: string; novel: Novel | undefined; workspace: Workspace; open: boolean; onClose: () => void }) {
  const query = useQuery({ queryKey: ["conflicts", novelId], queryFn: () => api.conflicts(novelId), enabled: open, staleTime: 0 });
  const [fresh, setFresh] = useState<Conflicts | null>();
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const conflicts = fresh ?? query.data;

  const close = () => {
    setFresh(undefined);
    setStale(false);
    setError(undefined);
    onClose();
  };

  const resolve = async (outcome: Record<string, ResolvedFile>) => {
    if (!conflicts) return;
    // Unsaved text first: it's part of "mine".
    await workspace.autosave.flush();
    const files: Record<string, FileResolution> = {};
    for (const f of conflicts.files) {
      const r = outcome[f.path];
      if (r) files[f.path] = { ours: f.ours, ...r };
    }
    try {
      const result = await api.resolveConflicts(novelId, conflicts.upstream, files);
      if (result.ok) close();
      else if (result.conflicts) {
        setFresh(result.conflicts);
        setStale(true);
      } else close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Frame open={open} onClose={close} title="Resolve sync conflicts">
      <div className="grid gap-2 bg-raised">
        {stale && <p className="px-4 pt-3 text-sm text-warn" role="status">The conflicts changed while you were choosing. Here they are as they are now.</p>}
        {error && <ErrorAlert title="Couldn't resolve the conflicts" className="mx-4 mt-3">{error}</ErrorAlert>}
        {query.isError && <ErrorAlert title="Couldn't load the conflicts" className="m-4">{query.error.message}</ErrorAlert>}
        {conflicts && (
          <ConflictResolver
            key={conflicts.upstream + (fresh ? ":fresh" : "")}
            files={conflicts.files.map((f) => ({ ...f, title: fileTitle(novel, f.path) }))}
            onResolve={(o) => void resolve(o)}
            onCancel={close}
          />
        )}
        {conflicts === null && <p className="p-4">Nothing to resolve any more.</p>}
      </div>
    </Frame>
  );
}

/** A save refused because the scene changed on disk in the same passage. */
export function SaveConflicts({ novel, workspace }: { novel: Novel | undefined; workspace: Workspace }) {
  const conflict = useStore(workspace.store, (s) => s.conflicts[0]);
  if (!conflict) return null;
  const title = fileTitle(novel, conflict.path);
  return (
    <Frame open onClose={() => {}} title={`${title} changed on disk while you were writing`}>
      <div className="bg-raised">
        <p className="px-4 pt-3 text-sm text-muted">“{title}” changed on disk while you were writing. Choose what to keep; nothing is saved until you finish.</p>
        <ConflictResolver
          key={conflict.path}
          files={[{ path: conflict.path, title, chunks: conflict.chunks, inTheirs: !conflict.deleted }]}
          labels={{ ours: "Yours", theirs: "On disk" }}
          onResolve={(outcome) => {
            const r = outcome[conflict.path]!;
            if ("keep" in r) workspace.resolve(conflict.path, r.keep === "ours" ? conflict.chunks.map((c) => (c.type === "same" ? c.text : c.ours)).join("") : null);
            else workspace.resolve(conflict.path, r.content);
          }}
        />
      </div>
    </Frame>
  );
}
