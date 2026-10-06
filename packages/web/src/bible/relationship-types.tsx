import type { Novel } from "@gh-writer/core";
import { slugify } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useId, useState } from "react";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";

type Editing = { key?: string; label: string; inverse: string; symmetric: boolean };

/** The kinds of relationship this novel uses: add one, or rename one. */
export function RelationshipTypes({ novelId, novel }: { novelId: string; novel: Novel }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const [editing, setEditing] = useState<Editing>();
  const save = useMutation({
    mutationFn: (e: Editing) =>
      e.key
        ? api.bible.updateRelationshipType(novelId, e.key, { label: e.label.trim(), ...(e.symmetric ? {} : { inverse_label: e.inverse.trim() || e.label.trim() }) })
        : api.bible.createRelationshipType(novelId, {
            key: slugify(e.label),
            label: e.label.trim(),
            symmetric: e.symmetric,
            ...(e.symmetric || !e.inverse.trim() ? {} : { inverse_label: e.inverse.trim() }),
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      setEditing(undefined);
    },
  });
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold">
          Kinds of relationship
        </h2>
        <Button size="sm" variant="ghost" onClick={() => setEditing({ label: "", inverse: "", symmetric: true })}>
          New kind
        </Button>
      </div>
      <ul className="grid gap-1 text-sm">
        {novel.relationshipTypes.map((t) => (
          <li key={t.key} className="flex items-center justify-between gap-2 rounded-md border border-rule px-3 py-1.5">
            <span>
              {t.label ?? t.key}
              {!t.symmetric && t.inverse_label && <span className="text-muted"> / {t.inverse_label}</span>}
              {t.symmetric && <span className="text-muted"> (both ways)</span>}
            </span>
            <Button size="sm" variant="ghost" aria-label={`Rename “${t.label ?? t.key}”`} onClick={() => setEditing({ key: t.key, label: t.label ?? t.key, inverse: t.inverse_label ?? "", symmetric: Boolean(t.symmetric) })}>
              Rename
            </Button>
          </li>
        ))}
      </ul>
      <Dialog.Root open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content aria-describedby={undefined} className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl">
            <Dialog.Title className="text-lg font-semibold">{editing?.key ? "Rename the relationship" : "New kind of relationship"}</Dialog.Title>
            {editing && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (editing.label.trim()) save.mutate(editing);
                }}
                className="grid gap-3"
              >
                <Field label="Name" placeholder="Rivals with" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} required autoFocus />
                {!editing.key && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={editing.symmetric} onChange={(e) => setEditing({ ...editing, symmetric: e.target.checked })} />
                    The same both ways (like “Sibling of”)
                  </label>
                )}
                {!editing.symmetric && (
                  <Field label="From the other side" placeholder="Mentee of" value={editing.inverse} onChange={(e) => setEditing({ ...editing, inverse: e.target.value })} />
                )}
                {save.isError && <ErrorAlert title="Couldn't save it">{save.error.message}</ErrorAlert>}
                <div className="flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <Button>Cancel</Button>
                  </Dialog.Close>
                  <Button type="submit" variant="primary" disabled={!editing.label.trim() || save.isPending}>
                    {editing.key ? "Rename" : "Add"}
                  </Button>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
