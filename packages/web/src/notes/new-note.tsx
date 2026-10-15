import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import { create } from "zustand";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";

/** Whether the New note dialog is open: the book pane and the palette open it. */
export const useNewNote = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** Name a new note (#205); `onCreated` opens it. */
export function NewNoteDialog({ novelId, open, onOpenChange, onCreated }: { novelId: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const create = useMutation({
    mutationFn: () => api.notes.create(novelId, { title: title.trim() }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      setTitle("");
      onOpenChange(false);
      onCreated(id);
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
          <Dialog.Title className="text-lg font-semibold">New note</Dialog.Title>
          <form onSubmit={submit} className="grid gap-3">
            <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What if…" required autoFocus />
            {create.isError && <ErrorAlert title="Couldn't add it">{create.error.message}</ErrorAlert>}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={!title.trim() || create.isPending}>
                Add note
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
