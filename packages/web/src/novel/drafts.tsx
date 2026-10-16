import { ApiError, type Checkpoint, type Version } from "@gh-writer/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Split } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { create } from "zustand";
import { api, keys } from "../api.ts";
import { ago } from "../format.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Confirm } from "../ui/confirm.tsx";
import { Field } from "../ui/field.tsx";
import { useCurrentScene } from "./current.ts";
import { useNotice } from "./notice.tsx";
import { reload, stayIfThere, undoAdoption, useAdoption, useSwitchVersion, useVersions } from "./versions.tsx";
import type { Workspace } from "./workspace.ts";

/*
 * Drafts (#136): the book's history in one place. A version is a separate take on the book (the
 * main version, a darker ending); a checkpoint is a named moment in a version to come back to. The
 * open version comes first, with its checkpoints; then the others with theirs; then those of versions
 * since discarded.
 */

const number = new Intl.NumberFormat();
const signed = (n: number) => (n > 0 ? `+${number.format(n)}` : n < 0 ? `−${number.format(-n)}` : "±0");
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The Drafts panel, opened from the header, the ⋯ menu or the palette. */
export const useDrafts = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** The header's button: the version open, which opens Drafts. */
export function DraftsButton({ novelId, workspace }: { novelId: string; workspace: Workspace }) {
  const { open, set } = useDrafts();
  const versions = useVersions(novelId);
  const current = versions.data?.find((v) => v.current);
  return (
    <Dialog.Root open={open} onOpenChange={set}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={current ? `Drafts: ${current.name} is open` : "Drafts"}>
          <Split className="size-4" aria-hidden />
          <span className="max-w-40 truncate max-sm:sr-only">{current?.name ?? "Drafts"}</span>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed top-0 right-0 z-50 flex h-dvh w-[min(32rem,100vw)] flex-col gap-4 overflow-y-auto border-l border-rule bg-raised p-5 text-ink shadow-xl"
          // An adoption with passages to settle opens the resolver, which keeps the focus.
          onCloseAutoFocus={(e) => void (useAdoption.getState().conflicts && e.preventDefault())}
        >
          <Dialog.Title className="text-lg font-semibold">Drafts</Dialog.Title>
          <Dialog.Description className="text-sm text-muted">
            A version is a separate take on the book, with its own text and story bible. A checkpoint is a moment in a version you can come back to. Whatever you do here can be undone.
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
  const show = useNotice((s) => s.show);
  const versions = useVersions(novelId);
  const checkpoints = useQuery({ queryKey: keys.checkpoints(novelId), queryFn: () => api.checkpoints(novelId) });
  const [showAuto, setShowAuto] = useState(false);
  const autoId = useId();
  const switchTo = useSwitchVersion(novelId, workspace);
  const after = async () => {
    await reload(queryClient, novelId);
    stayIfThere(queryClient, novelId, pathname, navigate);
  };
  const compare = (from: string, to: string) => {
    close();
    void navigate(`/novels/${novelId}/compare?${new URLSearchParams({ from, to })}`);
  };

  const start = useMutation({
    mutationFn: async ({ name, from }: { name: string; from?: string }) => {
      await workspace.autosave.flush();
      return api.startVersion(novelId, name, from);
    },
    onSuccess: async (version, { from }) => {
      await after();
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
      await after();
      if (result.conflicts) {
        // Before the panel closes, so it leaves the focus to the resolver.
        useAdoption.getState().set(version, result.conflicts);
        close();
        return;
      }
      close();
      show({
        message: result.commit ? `The main version now has “${version.name}” in it, and is open. Discard “${version.name}” in Drafts when you no longer need it.` : `The main version already has everything in “${version.name}”.`,
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
      await after();
      // Closed, so the notice's Bring it back can be reached.
      close();
      show({ message: `Discarded “${version.name}”.`, action: { label: "Bring it back", run: () => start.mutate({ name: version.name, from: result.checkpoint.id }) } });
    },
  });

  const make = useMutation({
    mutationFn: async (name: string) => {
      await workspace.autosave.flush();
      return api.createCheckpoint(novelId, name);
    },
    onSuccess: () => void reload(queryClient, novelId),
  });

  const restore = useMutation({
    mutationFn: async ({ checkpoint, sceneId }: { checkpoint: Checkpoint; sceneId?: string; title: string }) => {
      // Unsaved text goes into the automatic checkpoint the restore takes first.
      await workspace.autosave.flush();
      return api.restoreCheckpoint(novelId, checkpoint.id, sceneId);
    },
    onSuccess: async (result, { checkpoint, title }) => {
      await after();
      close();
      const undo = () =>
        void api.restoreCheckpoint(novelId, result.undo.id).then(async () => {
          await reload(queryClient, novelId);
          show({ message: `Undone: ${title} is back as it was.` });
        });
      show({
        message: result.commit ? `Restored ${title} from “${checkpoint.name}”.` : `${title[0]!.toUpperCase()}${title.slice(1)} already matched “${checkpoint.name}”.`,
        ...(result.commit ? { action: { label: "Undo", run: undo } } : {}),
      });
    },
  });

  if (versions.isPending || checkpoints.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (versions.isError) return <ErrorAlert title="Couldn't load the versions">{versions.error.message}</ErrorAlert>;
  if (checkpoints.isError) return <ErrorAlert title="Couldn't load checkpoints">{checkpoints.error.message}</ErrorAlert>;

  const open = versions.data.find((v) => v.current);
  const others = versions.data.filter((v) => !v.current);
  const main = versions.data.find((v) => v.main);
  const shown = (c: Checkpoint) => showAuto || !c.auto;
  const of = (v: Version) => checkpoints.data.filter((c) => c.version === v.id && shown(c));
  // A discarded version's own keepsake shows even when the other automatic ones don't: it's how it comes back.
  const discarded = checkpoints.data.filter((c) => c.version === null && (shown(c) || /^Discarded version “/.test(c.name)));
  const autoCount = checkpoints.data.filter((c) => c.auto).length;
  const error = start.error ?? adopt.error ?? discard.error ?? restore.error;
  const busy = start.isPending || adopt.isPending || discard.isPending || restore.isPending || switchTo.isPending;

  const versionActions = (v: Version) => (
    <div className="flex flex-wrap gap-2">
      {!v.current && (
        <Button size="sm" disabled={busy} onClick={() => switchTo.mutate(v, { onSuccess: close })} aria-label={`Open “${v.name}”`}>
          Open
        </Button>
      )}
      {(!v.current || !v.main) && (
        <Button
          size="sm"
          onClick={() => (v.current ? compare("version:main", "now") : compare(`version:${v.id}`, "now"))}
          aria-label={v.current ? `Compare “${v.name}” with the main version` : `Compare “${v.name}” with the open version`}
        >
          Compare
        </Button>
      )}
      {!v.main && (
        <Confirm
          title={`Adopt “${v.name}” into the main version?`}
          description="The main version opens and takes this version's changes. What you've changed in the main version since keeps too; where both changed the same passage, you choose. The main version as it is now is kept in an automatic checkpoint."
          action="Adopt"
          onConfirm={() => adopt.mutate(v)}
          trigger={
            <Button size="sm" disabled={busy} aria-label={`Adopt “${v.name}” into the main version`}>
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
            <Button size="sm" disabled={busy} aria-label={`Discard “${v.name}”`}>
              Discard
            </Button>
          }
        />
      )}
    </div>
  );

  const list = (items: Checkpoint[], empty: string) =>
    items.length ? (
      <ul className="grid gap-2">
        {items.map((c) => (
          <CheckpointItem key={c.id} checkpoint={c} owner={versions.data.find((v) => v.id === c.version)} open={open} busy={busy} compare={compare} restore={(sceneId, title) => restore.mutate({ checkpoint: c, title, ...(sceneId ? { sceneId } : {}) })} />
        ))}
      </ul>
    ) : (
      <p className="text-sm text-muted">{empty}</p>
    );

  return (
    <>
      {error && (
        <ErrorAlert title="That didn't work" detail={error instanceof ApiError ? error.detail : undefined}>
          {error.message}
        </ErrorAlert>
      )}
      {open && (
        <Section title="Open now">
          <VersionCard version={open} main={main} current>
            <CheckpointForm make={(name) => make.mutateAsync(name)} pending={make.isPending} error={make.error} />
            {list(of(open), "No checkpoints in this version yet. Make one before a risky revision.")}
            {!open.main && versionActions(open)}
          </VersionCard>
        </Section>
      )}

      {autoCount > 0 && (
        <label htmlFor={autoId} className="flex items-center gap-1.5 text-sm text-muted">
          <input id={autoId} type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} />
          Show the checkpoints gh-writer made by itself ({autoCount})
        </label>
      )}

      {others.length > 0 && (
        <Section title="Other versions">
          {others.map((v) => (
            <VersionCard key={v.id} version={v} main={main}>
              {versionActions(v)}
              <Disclosure label={`Checkpoints in “${v.name}”`} count={of(v).length}>
                {list(of(v), "None.")}
              </Disclosure>
            </VersionCard>
          ))}
        </Section>
      )}

      <Section title="Start a new version">
        <StartForm start={(name) => start.mutate({ name })} pending={start.isPending} />
      </Section>

      {discarded.length > 0 && (
        <Section title="Discarded versions">
          <ul className="grid gap-2">
            {discarded.map((c) => {
              const name = /^Discarded version “(.*)”$/.exec(c.name)?.[1] ?? c.name;
              return (
                <li key={c.id} className="grid gap-2 rounded-md border border-rule p-3">
                  <CheckpointHeading checkpoint={c} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => start.mutate({ name, from: c.id })} aria-label={`Bring “${name}” back as a version`}>
                      Bring it back
                    </Button>
                    <Button size="sm" onClick={() => compare(`checkpoint:${c.id}`, "now")} aria-label={`Compare “${c.name}” with now`}>
                      Compare with now
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h3 id={id} className="text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function VersionCard({ version: v, main, current, children }: { version: Version; main: Version | undefined; current?: boolean; children: ReactNode }) {
  return (
    <div role="group" aria-label={v.name} className={cn("grid gap-3 rounded-md border p-3", current ? "border-accent bg-accent-soft/40" : "border-rule")}>
      <div>
        <p className="font-medium">
          {v.name}
          {current && <span className="ml-2 rounded bg-panel px-1.5 py-0.5 text-xs text-muted">open</span>}
        </p>
        <p className="text-sm text-muted">
          {number.format(v.words)} words
          {main && !v.main && ` (${signed(v.words - main.words)} vs. main)`} · changed <time dateTime={v.date}>{ago(v.date)}</time>
          {v.remoteOnly && " · from another computer"}
        </p>
      </div>
      {children}
    </div>
  );
}

function Disclosure({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="grid gap-2">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex items-center gap-1 justify-self-start rounded text-sm text-muted hover:text-ink">
        <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} aria-hidden />
        {label} ({count})
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}

function CheckpointForm({ make, pending, error }: { make: (name: string) => Promise<unknown>; pending: boolean; error: Error | null }) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void make(name.trim()).then(() => setName(""), () => {});
  };
  return (
    <form onSubmit={submit} className="grid gap-2">
      {/* Focused when Drafts opens: it may open while still loading, before the form is there. */}
      <Field label="New checkpoint" placeholder="Before the big cut" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      <Button type="submit" variant="primary" disabled={!name.trim() || pending} className="justify-self-start">
        {pending ? "Making checkpoint…" : "Make checkpoint"}
      </Button>
      {error && <ErrorAlert title="No checkpoint was made">{error.message}</ErrorAlert>}
    </form>
  );
}

function StartForm({ start, pending }: { start: (name: string) => void; pending: boolean }) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) start(name.trim());
  };
  return (
    <form onSubmit={submit} className="grid gap-2">
      <Field label="New version" placeholder="A darker ending" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      <p className="text-sm text-muted">It starts as a copy of the version open now, and opens.</p>
      <Button type="submit" variant="primary" disabled={!name.trim() || pending} className="justify-self-start">
        {pending ? "Starting…" : "Start version"}
      </Button>
    </form>
  );
}

function CheckpointHeading({ checkpoint: c }: { checkpoint: Checkpoint }) {
  return (
    <div>
      <p className="font-medium">
        {c.name}
        {c.auto && <span className="ml-2 rounded bg-panel px-1.5 py-0.5 text-xs text-muted">automatic</span>}
      </p>
      <p className="text-sm text-muted">
        <time dateTime={c.date} title={dateTime.format(new Date(c.date))}>
          {ago(c.date)}
        </time>{" "}
        · {number.format(c.words)} words
      </p>
    </div>
  );
}

/** A checkpoint: compare it with now, or bring back the manuscript or the open scene from it. */
function CheckpointItem({
  checkpoint: c,
  owner,
  open,
  busy,
  compare,
  restore,
}: {
  checkpoint: Checkpoint;
  owner: Version | undefined;
  open: Version | undefined;
  busy: boolean;
  compare: (from: string, to: string) => void;
  restore: (sceneId: string | undefined, title: string) => void;
}) {
  const scene = useCurrentScene((s) => s.scene);
  // From another version: restoring brings that version's text into the open one, and says so.
  const elsewhere = owner && open && owner.id !== open.id ? ` This checkpoint is from “${owner.name}”: its text comes into “${open.name}”, the version open now.` : "";
  return (
    <li className="grid gap-2 rounded-md border border-rule bg-raised p-3">
      <CheckpointHeading checkpoint={c} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => compare(`checkpoint:${c.id}`, "now")} aria-label={`Compare “${c.name}” with now`}>
          Compare with now
        </Button>
        <Confirm
          title={`Restore the manuscript from “${c.name}”?`}
          description={`Every scene and bible entry goes back to how it was then.${elsewhere} What you have now is kept in an automatic checkpoint, so you can undo this.`}
          action="Restore manuscript"
          onConfirm={() => restore(undefined, "the manuscript")}
          trigger={
            <Button size="sm" disabled={busy} aria-label={`Restore the manuscript from “${c.name}”`}>
              Restore manuscript
            </Button>
          }
        />
        {scene && (
          <Confirm
            title={`Restore “${scene.title}” from “${c.name}”?`}
            description={`Only this scene goes back to how it was then; it stays where it is in the manuscript.${elsewhere} What you have now is kept in an automatic checkpoint, so you can undo this.`}
            action="Restore scene"
            onConfirm={() => restore(scene.id, `“${scene.title}”`)}
            trigger={
              <Button size="sm" disabled={busy} aria-label={`Restore “${scene.title}” from “${c.name}”`}>
                Restore “{scene.title}”
              </Button>
            }
          />
        )}
      </div>
    </li>
  );
}
