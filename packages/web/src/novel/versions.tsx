import { ApiError, type Conflicts, type FileResolution, type Version } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { ConflictResolver, type ResolvedFile } from "@gh-writer/editor/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Split } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { create } from "zustand";
import { api, keys } from "../api.ts";
import { ago } from "../format.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Confirm } from "../ui/confirm.tsx";
import { Field } from "../ui/field.tsx";
import { fileTitle, Frame } from "./conflicts.tsx";
import { useNotice } from "./notice.tsx";
import type { Workspace } from "./workspace.ts";

const number = new Intl.NumberFormat();
const signed = (n: number) => (n > 0 ? `+${number.format(n)}` : n < 0 ? `−${number.format(-n)}` : "±0");

/** An adoption waiting on the author: passages both versions changed. */
export const useAdoption = create<{ version: Version | undefined; conflicts: Conflicts | undefined; set: (version?: Version, conflicts?: Conflicts) => void }>((set) => ({
  version: undefined,
  conflicts: undefined,
  set: (version, conflicts) => set({ version, conflicts }),
}));

/** The novel's versions, the open one first in mind: for the header, the panel and the palette. */
export function useVersions(novelId: string) {
  return useQuery({ queryKey: keys.versions(novelId), queryFn: () => api.versions(novelId) });
}

/**
 * Open another version: what's typed is saved first, then everything about the novel is read again.
 * If the open chapter or scene isn't in that version, the book opens at its start.
 */
export function useSwitchVersion(novelId: string, workspace: Workspace | undefined) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const show = useNotice((s) => s.show);
  return useMutation({
    mutationFn: async (version: Version) => {
      await workspace?.autosave.flush();
      return api.switchVersion(novelId, version.id);
    },
    onSuccess: async (version) => {
      await reload(queryClient, novelId);
      stayIfThere(queryClient, novelId, pathname, navigate);
      show({ message: `Opened ${version.main ? "the main version" : `the version “${version.name}”`}.` });
    },
    onError: (e) => show({ message: `Couldn't open that version: ${e.message}` }),
  });
}

export async function reload(queryClient: ReturnType<typeof useQueryClient>, novelId: string) {
  await Promise.all([keys.novel(novelId), keys.versions(novelId), keys.sync(novelId), keys.checkpoints(novelId)].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** Back to the start of the book when the chapter or scene open isn't in the version now open. */
export function stayIfThere(queryClient: ReturnType<typeof useQueryClient>, novelId: string, pathname: string, navigate: (to: string) => void) {
  const novel = queryClient.getQueryData<{ novel: Novel }>(keys.novel(novelId))?.novel;
  const [, kind, id] = /\/(chapter|scene)\/([^/]+)$/.exec(pathname) ?? [];
  if (!novel || !kind) return;
  const there = kind === "chapter" ? novel.allChapters.some((c) => c.id === id) : novel.allScenes.some((s) => s.id === id);
  if (!there) void navigate(`/novels/${novelId}`);
}

/** Undo an adoption: the main version back as it was, from the checkpoint taken first. */
export async function undoAdoption(queryClient: ReturnType<typeof useQueryClient>, novelId: string, checkpointId: string, show: ReturnType<typeof useNotice.getState>["show"]) {
  await api.restoreCheckpoint(novelId, checkpointId);
  await reload(queryClient, novelId);
  show({ message: "Undone: the main version is as it was." });
}

/** Passages the main version and the adopted one both changed: the author chooses, then the adoption is committed. */
export function AdoptConflicts({ novelId, novel, workspace }: { novelId: string; novel: Novel | undefined; workspace: Workspace }) {
  const { version, conflicts, set } = useAdoption();
  const queryClient = useQueryClient();
  const show = useNotice((s) => s.show);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  if (!version || !conflicts) return null;
  const close = () => {
    setError(undefined);
    setStale(false);
    set();
  };
  const resolve = async (outcome: Record<string, ResolvedFile>) => {
    await workspace.autosave.flush();
    const files: Record<string, FileResolution> = {};
    for (const f of conflicts.files) {
      const r = outcome[f.path];
      if (r) files[f.path] = { ours: f.ours, ...r };
    }
    try {
      const result = await api.resolveAdoption(novelId, version.id, conflicts.upstream, files);
      if (result.ok) {
        close();
        await reload(queryClient, novelId);
        show({ message: `The main version now has “${version.name}” in it. Discard “${version.name}” in Drafts when you no longer need it.` });
      } else if (result.conflicts) {
        set(version, result.conflicts);
        setStale(true);
      } else close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Frame open onClose={close} title={`Adopt “${version.name}”: passages both versions changed`}>
      <div className="grid gap-2 bg-raised">
        <p className="px-4 pt-3 text-sm text-muted">
          These passages changed in the main version and in “{version.name}”. Choose what the main version keeps; nothing changes until you finish.
        </p>
        {stale && (
          <p className="px-4 text-sm text-warn" role="status">
            Something changed while you were choosing. Here they are as they are now.
          </p>
        )}
        {error && (
          <ErrorAlert title="Couldn't finish adopting" className="mx-4">
            {error}
          </ErrorAlert>
        )}
        <ConflictResolver
          key={conflicts.upstream}
          files={conflicts.files.map((f) => ({ ...f, title: fileTitle(novel, f.path) }))}
          labels={{ ours: "Main version", theirs: version.name }}
          onResolve={(o) => void resolve(o)}
          onCancel={close}
        />
      </div>
    </Frame>
  );
}
