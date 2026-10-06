import { ApiError, type Checkpoint } from "@gh-writer/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId, useState, type FormEvent } from "react";
import { api, keys } from "../api.ts";
import { ago } from "../format.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Confirm } from "../ui/confirm.tsx";
import { Field } from "../ui/field.tsx";
import { useCurrentScene } from "./current.ts";
import { useNotice } from "./notice.tsx";
import type { Workspace } from "./workspace.ts";

const number = new Intl.NumberFormat();
const signed = (n: number) => (n > 0 ? `+${number.format(n)}` : n < 0 ? `−${number.format(-n)}` : "±0");
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Open the checkpoints panel: make a named checkpoint, or bring back the manuscript or a scene from one. */
export function CheckpointsButton({ novelId, workspace, open, onOpenChange }: { novelId: string; workspace: Workspace; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm">
          <History className="size-4" aria-hidden />
          Checkpoints
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-0 right-0 z-50 flex h-dvh w-[min(30rem,100vw)] flex-col gap-4 overflow-y-auto border-l border-rule bg-raised p-5 text-ink shadow-xl">
          <Dialog.Title className="text-lg font-semibold">Checkpoints</Dialog.Title>
          <Dialog.Description className="text-sm text-muted">
            A checkpoint keeps the manuscript as it is now. Bring it back, or one scene from it, whenever you like; a restore can always be undone.
          </Dialog.Description>
          <Panel novelId={novelId} workspace={workspace} close={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Panel({ novelId, workspace, close }: { novelId: string; workspace: Workspace; close: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: keys.checkpoints(novelId), queryFn: () => api.checkpoints(novelId) });
  const [name, setName] = useState("");
  const [showAuto, setShowAuto] = useState(false);
  const autoId = useId();
  const scene = useCurrentScene((s) => s.scene);
  const show = useNotice((s) => s.show);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.checkpoints(novelId) });
    void queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  };

  const create = useMutation({
    mutationFn: async (n: string) => {
      await workspace.autosave.flush();
      return api.createCheckpoint(novelId, n);
    },
    onSuccess: () => {
      setName("");
      refresh();
    },
  });

  const restore = useMutation({
    mutationFn: async ({ checkpoint, sceneId }: { checkpoint: Checkpoint; sceneId?: string; title: string }) => {
      // Unsaved text goes into the automatic checkpoint the restore takes first.
      await workspace.autosave.flush();
      return api.restoreCheckpoint(novelId, checkpoint.id, sceneId);
    },
    onSuccess: (result, { checkpoint, title }) => {
      refresh();
      close();
      const undo = () =>
        void api.restoreCheckpoint(novelId, result.undo.id).then(() => {
          refresh();
          show({ message: `Undone: ${title} is back as it was.` });
        });
      show({
        message: result.commit ? `Restored ${title} from “${checkpoint.name}”.` : `${title[0]!.toUpperCase()}${title.slice(1)} already matched “${checkpoint.name}”.`,
        ...(result.commit ? { action: { label: "Undo", run: undo } } : {}),
      });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  };

  const checkpoints = list.data?.filter((c) => showAuto || !c.auto) ?? [];
  const autoCount = list.data?.filter((c) => c.auto).length ?? 0;
  const latestWords = list.data?.[0]?.words;

  return (
    <>
      <form onSubmit={submit} className="grid gap-2">
        <Field label="New checkpoint" placeholder="Before the big cut" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending} className="justify-self-start">
          {create.isPending ? "Making checkpoint…" : "Make checkpoint"}
        </Button>
        {create.isError && <ErrorAlert title="No checkpoint was made">{create.error.message}</ErrorAlert>}
      </form>

      {restore.isError && (
        <ErrorAlert title="Couldn't restore" detail={restore.error instanceof ApiError ? restore.error.detail : undefined}>
          {restore.error.message}
        </ErrorAlert>
      )}

      <section aria-labelledby={`${autoId}-heading`} className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id={`${autoId}-heading`} className="font-semibold">
            Saved checkpoints
          </h3>
          {autoCount > 0 && (
            <label htmlFor={autoId} className="flex items-center gap-1.5 text-sm text-muted">
              <input id={autoId} type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} />
              Show automatic ({autoCount})
            </label>
          )}
        </div>
        {list.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : list.isError ? (
          <ErrorAlert title="Couldn't load checkpoints">{list.error.message}</ErrorAlert>
        ) : checkpoints.length === 0 ? (
          <p className="text-sm text-muted">No checkpoints yet. Make one before a risky revision.</p>
        ) : (
          <ul className="grid gap-2">
            {checkpoints.map((c) => (
              <li key={c.id} className="grid gap-2 rounded-md border border-rule p-3">
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
                    {latestWords !== undefined && c !== list.data?.[0] && ` (${signed(c.words - latestWords)} vs. latest)`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Confirm
                    title={`Restore the manuscript from “${c.name}”?`}
                    description="Every scene and bible entry goes back to how it was then. What you have now is kept in an automatic checkpoint, so you can undo this."
                    action="Restore manuscript"
                    onConfirm={() => restore.mutate({ checkpoint: c, title: "the manuscript" })}
                    trigger={
                      <Button size="sm" disabled={restore.isPending} aria-label={`Restore the manuscript from “${c.name}”`}>
                        Restore manuscript
                      </Button>
                    }
                  />
                  {scene && (
                    <Confirm
                      title={`Restore “${scene.title}” from “${c.name}”?`}
                      description="Only this scene goes back to how it was then; it stays where it is in the manuscript. What you have now is kept in an automatic checkpoint, so you can undo this."
                      action="Restore scene"
                      onConfirm={() => restore.mutate({ checkpoint: c, sceneId: scene.id, title: `“${scene.title}”` })}
                      trigger={
                        <Button size="sm" disabled={restore.isPending} aria-label={`Restore “${scene.title}” from “${c.name}”`}>
                          Restore “{scene.title}”
                        </Button>
                      }
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
