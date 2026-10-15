import { mentions, type Novel, type StoryEvent } from "@gh-writer/core";
import { chapterTitle } from "@gh-writer/core/diagrams";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { FORMAT_MOVE, needsFormatMove } from "./format-move.tsx";

/**
 * Write an off-page event as a scene (#165): which chapter it ends, and whether the event is kept
 * (naming the scene that dramatizes it) or removed. One the prose mentions is kept. The new scene opens.
 */
export function WriteAsSceneDialog({ novelId, novel, event, open, onOpenChange }: { novelId: string; novel: Novel; event: StoryEvent; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = useId();
  const [chapter, setChapter] = useState(novel.chapters.at(-1)?.id ?? "");
  const mentioned = [...novel.allScenes, ...novel.entities, ...novel.events].some((r) => mentions(r.body).some((m) => m.id === event.id));
  const [keep, setKeep] = useState(true);
  const moving = needsFormatMove(novel);
  const write = useMutation({
    mutationFn: () => api.bible.writeAsScene(novelId, event.id, { chapter, keep: keep || mentioned, migrate: moving }),
    onSuccess: async ({ scene }) => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      onOpenChange(false);
      void navigate(`/novels/${novelId}/scene/${scene}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chapter) write.mutate();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={`${id}-what`}
          className="fixed top-1/2 left-1/2 z-50 grid w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold">Write “{event.title}” as a scene</Dialog.Title>
          <p id={`${id}-what`} className="text-sm text-muted">
            A new scene at the end of the chapter, with the event's title, time, people, places and plotlines, and its note as the synopsis.
          </p>
          <form onSubmit={submit} className="grid gap-3 text-sm">
            <label className="grid gap-1.5 font-medium">
              Chapter
              <select value={chapter} onChange={(e) => setChapter(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2 font-normal">
                {novel.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {chapterTitle(novel, c)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 font-medium">The event</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-keep`} checked={keep || mentioned} onChange={() => setKeep(true)} />
                Keep it, noting the scene that dramatizes it
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-keep`} checked={!keep && !mentioned} disabled={mentioned} onChange={() => setKeep(false)} aria-describedby={mentioned ? `${id}-mentioned` : undefined} />
                Remove it: the scene takes its place
              </label>
              {mentioned && (
                <p id={`${id}-mentioned`} className="text-xs text-muted">
                  The story mentions it, so it's kept.
                </p>
              )}
            </fieldset>
            {moving && <p className="text-muted">{FORMAT_MOVE}</p>}
            {write.isError && <ErrorAlert title="Couldn't write it as a scene">{write.error.message}</ErrorAlert>}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={!chapter || write.isPending}>
                Write the scene
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
