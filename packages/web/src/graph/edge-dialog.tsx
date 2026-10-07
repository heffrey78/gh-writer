import type { Novel, Relationship } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { api, keys } from "../api.ts";
import { describe } from "../bible/entry-page.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Confirm } from "../ui/confirm.tsx";

/**
 * What can be done to a relationship from the graph: change it or end it from the scene the graph
 * is at (the next dialog asks, with that scene filled in), or remove it altogether.
 */
export function EdgeDialog({
  novelId,
  novel,
  relationship,
  sceneTitle,
  onChange,
  onEnd,
  onClose,
}: {
  novelId: string;
  novel: Novel;
  relationship: Relationship;
  /** The scene the graph is at, for the buttons' wording. */
  sceneTitle: string | undefined;
  onChange: () => void;
  onEnd: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const from = novel.entities.find((e) => e.id === relationship.from)?.name ?? relationship.from;
  const sentence = `${from}: ${describe(novel, relationship.from, relationship)}`;
  const remove = useMutation({
    mutationFn: () => api.bible.deleteRelationship(novelId, relationship.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      onClose();
    },
  });
  const at = sceneTitle ? ` at “${sceneTitle}”` : "";
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold">Relationship</Dialog.Title>
          <p className="text-sm">{sentence}</p>
          {remove.isError && <ErrorAlert title="Couldn't remove it">{remove.error.message}</ErrorAlert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onChange}>Change it{at}…</Button>
            <Button onClick={onEnd}>End it{at}…</Button>
            <Confirm
              title="Remove this relationship?"
              description={`“${sentence}” will no longer be in the bible, at any point in the story.`}
              action="Remove"
              danger
              onConfirm={() => remove.mutate()}
              trigger={<Button variant="danger">Remove</Button>}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
