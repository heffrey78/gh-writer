import type { Novel, Note } from "@gh-writer/core";
import { chapterTitle } from "@gh-writer/core/diagrams";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { FORMAT_MOVE, needsFormatMove } from "../events/format-move.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";

/**
 * Turn a note into story (#205): an off-page event (its prose the event's note) or a scene at the end of
 * a chapter (its prose the synopsis), keeping the note (naming what it became) or removing it. What it
 * became opens.
 */
export function PromoteNoteDialog({ novelId, novel, note, flush, open, onOpenChange }: { novelId: string; novel: Novel; note: Note; flush: () => Promise<void>; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = useId();
  const [to, setTo] = useState<"event" | "scene">("event");
  const [chapter, setChapter] = useState(novel.chapters.at(-1)?.id ?? "");
  const [keep, setKeep] = useState(true);
  const moving = to === "event" && needsFormatMove(novel);
  const promote = useMutation({
    mutationFn: async () => {
      await flush();
      return api.notes.promote(novelId, note.id, to === "scene" ? { to, chapter } : { to }, { keep, migrate: moving });
    },
    onSuccess: async ({ id: made }) => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      onOpenChange(false);
      void navigate(to === "scene" ? `/novels/${novelId}/scene/${made}` : `/novels/${novelId}/event/${made}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (to === "event" || chapter) promote.mutate();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 grid w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold">Make “{note.title}” part of the story</Dialog.Title>
          <form onSubmit={submit} className="grid gap-3 text-sm">
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 font-medium">It becomes</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-to`} checked={to === "event"} onChange={() => setTo("event")} />
                An off-page event, the note as its note
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-to`} checked={to === "scene"} onChange={() => setTo("scene")} />
                A scene at the end of a chapter, the note as its synopsis
              </label>
            </fieldset>
            {to === "scene" && (
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
            )}
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 font-medium">The note</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-keep`} checked={keep} onChange={() => setKeep(true)} />
                Keep it, noting what it became
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-keep`} checked={!keep} onChange={() => setKeep(false)} />
                Remove it
              </label>
            </fieldset>
            {moving && <p className="text-muted">{FORMAT_MOVE}</p>}
            {promote.isError && <ErrorAlert title="Couldn't make it part of the story">{promote.error.message}</ErrorAlert>}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={promote.isPending || (to === "scene" && !chapter)}>
                {to === "event" ? "Make the event" : "Write the scene"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
