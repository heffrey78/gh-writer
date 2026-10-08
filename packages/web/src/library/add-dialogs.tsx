import { ApiError, type CloneProgress, type LibraryEntry } from "@gh-writer/client";
import { slugify } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { GitHubMark, useConnect } from "../github/connect.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/dialog.tsx";
import { Field } from "../ui/field.tsx";

/** After a novel joins the library: refresh the shelf and open the novel. */
function useOpenAdded() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async (novel: LibraryEntry) => {
    await queryClient.invalidateQueries({ queryKey: keys.library });
    void navigate(`/novels/${novel.id}`);
  };
}

/**
 * Start a novel: a title, an author, and where it goes (by default a folder named after the title in
 * the library's folder). If git doesn't know the author yet, ask for a name and email for its history.
 */
export function NewNovelDialog({ folder, authors, onClose }: { folder: string | undefined; authors: string[]; onClose: () => void }) {
  const opened = useOpenAdded();
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState(authors[0] ?? "");
  const [path, setPath] = useState("");
  const [identity, setIdentity] = useState<{ name: string; email: string }>();
  const create = useMutation({
    mutationFn: () =>
      api.createNovel({
        title: title.trim(),
        ...(author.trim() ? { author: author.trim() } : {}),
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(identity ? { identity: { name: identity.name.trim(), email: identity.email.trim() } } : {}),
      }),
    onSuccess: opened,
    onError: (e) => {
      if (e instanceof ApiError && e.code === "NEEDS_IDENTITY" && !identity) setIdentity({ name: author.trim(), email: "" });
    },
  });
  const askingIdentity = identity !== undefined;
  const ready = title.trim() && (!identity || (identity.name.trim() && identity.email.trim()));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) create.mutate();
  };
  const where = folder ? `${folder}/${slugify(title) || "novel"}` : undefined;
  const failed = create.isError && !(create.error instanceof ApiError && create.error.code === "NEEDS_IDENTITY");

  return (
    <Modal title="New novel" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        <Field label="Author" value={author} onChange={(e) => setAuthor(e.target.value)} hint="Optional. Shown on the cover and in novel.yaml." />
        <Field
          label="Folder"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={where}
          hint={where ? <>Leave empty for {where}. It must be new or empty.</> : "It must be new or empty."}
        />
        {askingIdentity && (
          <fieldset className="grid gap-3 rounded-md border border-rule p-3">
            <legend className="px-1 text-sm font-medium">Who's writing?</legend>
            <p className="text-sm text-muted">git records a name and email with every change to the novel, and doesn't know yours yet. They are kept with this novel only.</p>
            <Field label="Name" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} required autoFocus />
            <Field label="Email" type="email" value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} required />
          </fieldset>
        )}
        {failed && <ErrorAlert title="Couldn't start the novel">{create.error.message}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!ready || create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Add a novel that is already on this computer. */
export function OpenFolderDialog({ onClose }: { onClose: () => void }) {
  const opened = useOpenAdded();
  const [path, setPath] = useState("");
  const add = useMutation({ mutationFn: (p: string) => api.addNovel(p), onSuccess: opened });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path.trim()) add.mutate(path.trim());
  };
  return (
    <Modal title="Open a folder" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Folder" placeholder="~/novels/my-novel" value={path} onChange={(e) => setPath(e.target.value)} hint="A git repository holding novel.yaml." required autoFocus />
        {add.isError && <ErrorAlert title="Couldn't open that folder">{add.error.message}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={add.isPending}>
            {add.isPending ? "Opening…" : "Open"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Clone a novel from GitHub (or any git address), with progress; closing the dialog cancels it. */
export function CloneDialog({ folder, onClose }: { folder: string | undefined; onClose: () => void }) {
  const opened = useOpenAdded();
  const [repo, setRepo] = useState("");
  const [into, setInto] = useState("");
  const [progress, setProgress] = useState<CloneProgress>();
  const abort = useRef<AbortController>(undefined);
  const clone = useMutation({
    mutationFn: async ({ repo, into }: { repo: string; into: string }) => {
      abort.current = new AbortController();
      setProgress(undefined);
      return api.clone(repo, { ...(into ? { path: into } : {}), onProgress: setProgress, signal: abort.current.signal });
    },
    onSuccess: opened,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (repo.trim()) clone.mutate({ repo: repo.trim(), into: into.trim() });
  };
  const close = () => {
    abort.current?.abort();
    onClose();
  };
  const cancelled = clone.error instanceof DOMException && clone.error.name === "AbortError";
  return (
    <Modal title="Clone from GitHub" onClose={close}>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Repository" placeholder="owner/name or a URL" value={repo} onChange={(e) => setRepo(e.target.value)} required autoFocus />
        <Field label="Into folder (optional)" placeholder={`${folder ?? "~/gh-writer"}/<name>`} value={into} onChange={(e) => setInto(e.target.value)} />
        {clone.isPending && (
          <div className="grid gap-1">
            <div
              role="progressbar"
              aria-label="Cloning"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress?.progress ?? 0}
              aria-valuetext={progress ? `${progress.stage} ${progress.progress}%` : "Starting"}
              className="h-2 overflow-hidden rounded-full bg-panel"
            >
              <div className="h-full bg-accent transition-[width]" style={{ width: `${progress?.progress ?? 0}%` }} />
            </div>
            <p className="text-xs text-muted">{progress ? `${capitalise(progress.stage)}: ${progress.progress}%` : "Starting…"}</p>
          </div>
        )}
        {clone.isError && !cancelled && (
          <ErrorAlert title="Couldn't clone that repository" detail={clone.error instanceof ApiError ? clone.error.detail : undefined}>
            {clone.error.message}
          </ErrorAlert>
        )}
        {clone.error instanceof ApiError && clone.error.code === "AUTH" && (
          <Button className="justify-self-start" onClick={() => useConnect.getState().show(() => clone.mutate({ repo: repo.trim(), into: into.trim() }))}>
            <GitHubMark className="size-4" /> Connect GitHub and try again
          </Button>
        )}
        <div className="flex justify-end gap-2">
          {clone.isPending ? <Button onClick={() => abort.current?.abort()}>Cancel clone</Button> : <Button onClick={close}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={clone.isPending}>
            {clone.isPending ? "Cloning…" : "Clone"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
