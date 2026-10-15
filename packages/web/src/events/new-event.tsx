import type { Novel } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { create } from "zustand";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { FORMAT_MOVE, needsFormatMove } from "./format-move.tsx";

/** Whether the New off-page event dialog is open: the Timeline, the book pane and the palette open it. */
export const useNewEvent = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/**
 * Name a new off-page event; it opens once made, unless `onCreated` takes it. In a novel in format v1,
 * the dialog says the novel moves to v2 with it (D11), and Cancel leaves it as it was.
 */
export function NewEventDialog({ novelId, novel, open, onOpenChange, onCreated }: { novelId: string; novel: Novel; open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const moving = needsFormatMove(novel);
  const create = useMutation({
    mutationFn: () => api.bible.createEvent(novelId, { title: title.trim() }, { migrate: moving }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      setTitle("");
      onOpenChange(false);
      if (onCreated) onCreated(id);
      else void navigate(`/novels/${novelId}/event/${id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold">New off-page event</Dialog.Title>
          <form onSubmit={submit} className="grid gap-3">
            <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The flood of '09" required autoFocus />
            {moving && <p className="text-sm text-muted">{FORMAT_MOVE}</p>}
            {create.isError && <ErrorAlert title="Couldn't add it">{create.error.message}</ErrorAlert>}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={!title.trim() || create.isPending}>
                {moving ? "Move the novel and add the event" : "Add event"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
