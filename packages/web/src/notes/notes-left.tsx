import type { Note } from "@gh-writer/core";
import { AlertDialog } from "radix-ui";
import { create } from "zustand";
import { Button } from "../ui/button.tsx";

type Choice = "keep" | "delete";

interface Question {
  what: string;
  notes: Note[];
  answer: (choice: Choice | null) => void;
}

/** Asking, before a delete, what becomes of notes that would be left on no scene (#222). */
export const useNotesLeft = create<{ question: Question | null; ask: (what: string, notes: Note[]) => Promise<Choice | null> }>((set) => ({
  question: null,
  ask: (what, notes) =>
    new Promise((resolve) =>
      set({
        question: {
          what,
          notes,
          answer: (choice) => {
            set({ question: null });
            resolve(choice);
          },
        },
      }),
    ),
}));

/** The question, when there is one: keep the notes unattached, delete them too, or don't delete. */
export function NotesLeftDialog() {
  const question = useNotesLeft((s) => s.question);
  return (
    <AlertDialog.Root open={question !== null} onOpenChange={(o) => !o && question?.answer(null)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-[60] grid w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl">
          <AlertDialog.Title className="text-base font-semibold">Delete {question?.what}, and its notes?</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted">
            {question?.notes.length === 1 ? "This note is" : "These notes are"} only on what's being deleted. Keep {question?.notes.length === 1 ? "it" : "them"} as notes on no scene, or delete {question?.notes.length === 1 ? "it" : "them"} too?
          </AlertDialog.Description>
          <ul className="grid gap-1 text-sm">
            {question?.notes.map((n) => (
              <li key={n.id}>“{n.title}”</li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button>Don't delete</Button>
            </AlertDialog.Cancel>
            <Button onClick={() => question?.answer("keep")}>Keep the notes</Button>
            <Button variant="danger" onClick={() => question?.answer("delete")}>
              Delete them too
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
