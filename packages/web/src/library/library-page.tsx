import { ApiError, type CloneProgress, type LibraryEntry } from "@gh-writer/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FolderOpen, GitBranch, Trash2, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { ago, remoteLabel } from "../format.ts";
import { Shell } from "../layout.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Confirm } from "../ui/confirm.tsx";
import { Field } from "../ui/field.tsx";

/** The author's novels: open one, add a folder, or clone from GitHub. */
export function LibraryPage() {
  const library = useQuery({ queryKey: keys.library, queryFn: api.library });
  const [dismissed, setDismissed] = useState<string[]>([]);
  const notices = library.data?.notices.filter((n) => !dismissed.includes(n.path)) ?? [];

  return (
    <Shell>
      <h1 className="text-2xl font-semibold">Your novels</h1>

      {notices.length > 0 && (
        <ul className="mt-4 grid gap-2" aria-label="Notices">
          {notices.map((n) => (
            <li key={n.path} className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm">
              <p className="flex-1">{n.message}</p>
              <Button variant="ghost" size="sm" aria-label={`Dismiss: ${n.message}`} onClick={() => setDismissed((d) => [...d, n.path])}>
                <X className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="novels-heading" className="mt-6">
        <h2 id="novels-heading" className="sr-only">
          Novels
        </h2>
        {library.isPending ? (
          <p className="text-muted" role="status">
            Loading your library…
          </p>
        ) : library.isError ? (
          <ErrorAlert title="Couldn't load your library">{library.error.message}</ErrorAlert>
        ) : library.data.novels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-rule px-6 py-10 text-center">
            <BookOpen className="mx-auto size-8 text-muted" aria-hidden />
            <p className="mt-3 font-medium">No novels yet</p>
            <p className="mt-1 text-sm text-muted">Open a novel you already have on this computer, or clone one from GitHub.</p>
          </div>
        ) : (
          <ul className="grid gap-3">
            {library.data.novels.map((novel) => (
              <NovelCard key={novel.id} novel={novel} />
            ))}
          </ul>
        )}
      </section>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <AddFolder />
        <CloneRepo />
      </div>
    </Shell>
  );
}

function NovelCard({ novel }: { novel: LibraryEntry }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeNovel(novel.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.library }),
  });
  return (
    <li className="flex items-start gap-3 rounded-lg border border-rule bg-raised p-4">
      <div className="min-w-0 flex-1">
        <Link to={`/novels/${novel.id}`} className="text-lg font-semibold underline-offset-2 hover:underline">
          {novel.title}
        </Link>
        <p className="mt-1 truncate font-mono text-xs text-muted" title={novel.path}>
          {novel.path}
        </p>
        <p className="mt-1 text-sm text-muted">
          {novel.remote ? remoteLabel(novel.remote) : "Not on GitHub yet"} · opened {ago(novel.lastOpened)}
        </p>
      </div>
      <Confirm
        title={`Remove “${novel.title}” from your library?`}
        description="Its folder and files stay where they are; you can add it again at any time."
        action="Remove"
        onConfirm={() => remove.mutate()}
        trigger={
          <Button variant="ghost" size="sm" aria-label={`Remove “${novel.title}” from the library`}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
        }
      />
    </li>
  );
}

function AddFolder() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const add = useMutation({
    mutationFn: (p: string) => api.addNovel(p),
    onSuccess: async (novel) => {
      await queryClient.invalidateQueries({ queryKey: keys.library });
      void navigate(`/novels/${novel.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path.trim()) add.mutate(path.trim());
  };
  return (
    <section aria-labelledby="add-heading" className="grid content-start gap-3 rounded-lg border border-rule p-4">
      <h2 id="add-heading" className="flex items-center gap-2 font-semibold">
        <FolderOpen className="size-4" aria-hidden /> Open a folder
      </h2>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Folder" placeholder="/home/you/novels/my-novel" value={path} onChange={(e) => setPath(e.target.value)} hint="A git repository holding novel.yaml." required />
        <Button type="submit" variant="primary" disabled={add.isPending} className="justify-self-start">
          {add.isPending ? "Opening…" : "Open"}
        </Button>
      </form>
      {add.isError && <ErrorAlert title="Couldn't open that folder">{add.error.message}</ErrorAlert>}
    </section>
  );
}

function CloneRepo() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
    onSuccess: async (novel) => {
      await queryClient.invalidateQueries({ queryKey: keys.library });
      void navigate(`/novels/${novel.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (repo.trim()) clone.mutate({ repo: repo.trim(), into: into.trim() });
  };
  const cancelled = clone.error instanceof DOMException && clone.error.name === "AbortError";
  return (
    <section aria-labelledby="clone-heading" className="grid content-start gap-3 rounded-lg border border-rule p-4">
      <h2 id="clone-heading" className="flex items-center gap-2 font-semibold">
        <GitBranch className="size-4" aria-hidden /> Clone from GitHub
      </h2>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Repository" placeholder="owner/name or a URL" value={repo} onChange={(e) => setRepo(e.target.value)} required />
        <Field label="Into folder (optional)" placeholder="~/gh-writer/<name>" value={into} onChange={(e) => setInto(e.target.value)} />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={clone.isPending}>
            {clone.isPending ? "Cloning…" : "Clone"}
          </Button>
          {clone.isPending && <Button onClick={() => abort.current?.abort()}>Cancel</Button>}
        </div>
      </form>
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
    </section>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
