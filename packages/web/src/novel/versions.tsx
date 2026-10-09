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

/** The versions panel, opened from the header or the palette. */
export const useVersionsPanel = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

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

async function reload(queryClient: ReturnType<typeof useQueryClient>, novelId: string) {
  await Promise.all([keys.novel(novelId), keys.versions(novelId), keys.sync(novelId), keys.checkpoints(novelId)].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** Back to the start of the book when the chapter or scene open isn't in the version now open. */
function stayIfThere(queryClient: ReturnType<typeof useQueryClient>, novelId: string, pathname: string, navigate: (to: string) => void) {
  const novel = queryClient.getQueryData<{ novel: Novel }>(keys.novel(novelId))?.novel;
  const [, kind, id] = /\/(chapter|scene)\/([^/]+)$/.exec(pathname) ?? [];
  if (!novel || !kind) return;
  const there = kind === "chapter" ? novel.allChapters.some((c) => c.id === id) : novel.allScenes.some((s) => s.id === id);
  if (!there) void navigate(`/novels/${novelId}`);
}

/** The header button: which version is open, and the panel to start, open or discard one. */
export function VersionsButton({ novelId, workspace }: { novelId: string; workspace: Workspace }) {
  const { open, set } = useVersionsPanel();
  const versions = useVersions(novelId);
  const current = versions.data?.find((v) => v.current);
  return (
    <Dialog.Root open={open} onOpenChange={set}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={current ? `Versions: ${current.name} is open` : "Versions"}>
          <Split className="size-4" aria-hidden />
          <span className="max-w-40 truncate">{current?.name ?? "Versions"}</span>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed top-0 right-0 z-50 flex h-dvh w-[min(30rem,100vw)] flex-col gap-4 overflow-y-auto border-l border-rule bg-raised p-5 text-ink shadow-xl"
          // An adoption with passages to settle opens the resolver, which keeps the focus.
          onCloseAutoFocus={(e) => void (useAdoption.getState().conflicts && e.preventDefault())}
        >
          <Dialog.Title className="text-lg font-semibold">Versions</Dialog.Title>
          <Dialog.Description className="text-sm text-muted">
            Try a different ending or a big cut as a version of the book: it keeps its own text and story bible, and the main version stays as it is. Open either whenever you like.
          </Dialog.Description>
          <Panel novelId={novelId} workspace={workspace} close={() => set(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Panel({ novelId, workspace, close }: { novelId: string; workspace: Workspace; close: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const list = useVersions(novelId);
  const [name, setName] = useState("");
  const show = useNotice((s) => s.show);
  const switchTo = useSwitchVersion(novelId, workspace);

  const start = useMutation({
    mutationFn: async ({ name, from }: { name: string; from?: string }) => {
      await workspace.autosave.flush();
      return api.startVersion(novelId, name, from);
    },
    onSuccess: async (version, { from }) => {
      setName("");
      await reload(queryClient, novelId);
      stayIfThere(queryClient, novelId, pathname, navigate);
      close();
      show({ message: from ? `“${version.name}” is back, and open.` : `Started the version “${version.name}”. What you write now goes into it; the main version stays as it was.` });
    },
  });

  const adopt = useMutation({
    mutationFn: async (version: Version) => {
      await workspace.autosave.flush();
      return api.adoptVersion(novelId, version.id);
    },
    onSuccess: async (result, version) => {
      await reload(queryClient, novelId);
      stayIfThere(queryClient, novelId, pathname, navigate);
      if (result.conflicts) {
        // Before the panel closes, so it leaves the focus to the resolver.
        useAdoption.getState().set(version, result.conflicts);
        close();
        return;
      }
      close();
      show({
        message: result.commit ? `The main version now has “${version.name}” in it, and is open. Discard “${version.name}” in Versions when you no longer need it.` : `The main version already has everything in “${version.name}”.`,
        ...(result.commit ? { action: { label: "Undo", run: () => void undoAdoption(queryClient, novelId, result.checkpoint.id, show) } } : {}),
      });
    },
  });

  const discard = useMutation({
    mutationFn: async (version: Version) => {
      await workspace.autosave.flush();
      return api.discardVersion(novelId, version.id);
    },
    onSuccess: async (result, version) => {
      await reload(queryClient, novelId);
      stayIfThere(queryClient, novelId, pathname, navigate);
      // Closed, so the notice's Bring it back can be reached.
      close();
      show({
        message: `Discarded “${version.name}”.`,
        action: { label: "Bring it back", run: () => start.mutate({ name: version.name, from: result.checkpoint.id }) },
      });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) start.mutate({ name: name.trim() });
  };

  const main = list.data?.find((v) => v.main);
  const error = start.error ?? discard.error ?? adopt.error;
  return (
    <>
      <form onSubmit={submit} className="grid gap-2">
        <Field label="New version" placeholder="A darker ending" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <p className="text-sm text-muted">It starts as a copy of the version open now, and opens.</p>
        <Button type="submit" variant="primary" disabled={!name.trim() || start.isPending} className="justify-self-start">
          {start.isPending ? "Starting…" : "Start version"}
        </Button>
      </form>
      {error && (
        <ErrorAlert title="That didn't work" detail={error instanceof ApiError ? error.detail : undefined}>
          {error.message}
        </ErrorAlert>
      )}
      <section aria-labelledby="versions-heading" className="grid gap-2">
        <h3 id="versions-heading" className="font-semibold">
          This book's versions
        </h3>
        {list.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : list.isError ? (
          <ErrorAlert title="Couldn't load the versions">{list.error.message}</ErrorAlert>
        ) : (
          <ul className="grid gap-2">
            {list.data.map((v) => (
              <li key={v.id} className={`grid gap-2 rounded-md border p-3 ${v.current ? "border-accent bg-accent-soft" : "border-rule"}`}>
                <div>
                  <p className="font-medium">
                    {v.name}
                    {v.current && <span className="ml-2 rounded bg-panel px-1.5 py-0.5 text-xs text-muted">open</span>}
                  </p>
                  <p className="text-sm text-muted">
                    {number.format(v.words)} words
                    {main && !v.main && ` (${signed(v.words - main.words)} vs. main)`} · changed <time dateTime={v.date}>{ago(v.date)}</time>
                    {v.remoteOnly && " · from another computer"}
                  </p>
                </div>
                {!v.current || !v.main ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        close();
                        // The open version (as saved now) against this one, or against the main version.
                        void navigate(`/novels/${novelId}/compare?${new URLSearchParams(v.current ? { from: "version:main", to: "now" } : { from: `version:${v.id}`, to: "now" })}`);
                      }}
                      aria-label={v.current ? `Compare “${v.name}” with the main version` : `Compare “${v.name}” with the open version`}
                    >
                      Compare
                    </Button>
                    {!v.current && (
                      <Button size="sm" disabled={switchTo.isPending} onClick={() => switchTo.mutate(v, { onSuccess: close })} aria-label={`Open “${v.name}”`}>
                        Open
                      </Button>
                    )}
                    {!v.main && (
                      <Confirm
                        title={`Adopt “${v.name}” into the main version?`}
                        description="The main version opens and takes this version's changes. What you've changed in the main version since keeps too; where both changed the same passage, you choose. The main version as it is now is kept in an automatic checkpoint."
                        action="Adopt"
                        onConfirm={() => adopt.mutate(v)}
                        trigger={
                          <Button size="sm" disabled={adopt.isPending} aria-label={`Adopt “${v.name}” into the main version`}>
                            Adopt into main
                          </Button>
                        }
                      />
                    )}
                    {!v.main && (
                      <Confirm
                        title={`Discard “${v.name}”?`}
                        description="The version goes, here and on GitHub. Its text is kept in an automatic checkpoint, so you can bring it back."
                        action="Discard version"
                        danger
                        onConfirm={() => discard.mutate(v)}
                        trigger={
                          <Button size="sm" disabled={discard.isPending} aria-label={`Discard “${v.name}”`}>
                            Discard
                          </Button>
                        }
                      />
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Undo an adoption: the main version back as it was, from the checkpoint taken first. */
async function undoAdoption(queryClient: ReturnType<typeof useQueryClient>, novelId: string, checkpointId: string, show: ReturnType<typeof useNotice.getState>["show"]) {
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
        show({ message: `The main version now has “${version.name}” in it. Discard “${version.name}” in Versions when you no longer need it.` });
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
