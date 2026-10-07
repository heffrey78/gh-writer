import { ApiError } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { slugify } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";

function Frame({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Name a new entry of a type; it opens once made, unless `onCreated` takes it. */
export function NewEntryDialog({
  novelId,
  novel,
  type,
  open,
  onOpenChange,
  onCreated,
}: {
  novelId: string;
  novel: Novel;
  type: string | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (id: string, type: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState(type ?? novel.entityTypes[0]?.key ?? "character");
  const kind = type ?? chosen;
  const label = novel.entityTypes.find((t) => t.key === kind)?.label ?? "entry";
  const create = useMutation({
    mutationFn: () => api.bible.createEntity(novelId, kind, { name: name.trim() }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      setName("");
      onOpenChange(false);
      if (onCreated) onCreated(id, kind);
      else void navigate(`/novels/${novelId}/bible/${id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  return (
    <Frame open={open} onOpenChange={onOpenChange} title={`New ${label.toLowerCase()}`}>
      <form onSubmit={submit} className="grid gap-3">
        {!type && (
          <label className="grid gap-1.5 text-sm font-medium">
            Type
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2 font-normal">
              {novel.entityTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        {create.isError && <ErrorAlert title="Couldn't add it">{create.error.message}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Dialog.Close asChild>
            <Button>Cancel</Button>
          </Dialog.Close>
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
            Add {label.toLowerCase()}
          </Button>
        </div>
      </form>
    </Frame>
  );
}

/** A custom entity type: a label, and the key, ID prefix and folder derived from it (editable). */
export function NewTypeDialog({ novelId, novel, open, onOpenChange }: { novelId: string; novel: Novel; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [prefix, setPrefix] = useState<string>();
  const key = slugify(label).replace(/-/g, "_");
  const suggested = key.replace(/[^a-z]/g, "").slice(0, 4).padEnd(2, "x");
  const create = useMutation({
    mutationFn: () => api.bible.createEntityType(novelId, { key, prefix: prefix ?? suggested, label: label.trim(), folder: `${slugify(label)}s` }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      setLabel("");
      setPrefix(undefined);
      onOpenChange(false);
    },
  });
  const taken = novel.entityTypes.some((t) => t.key === key);
  return (
    <Frame open={open} onOpenChange={onOpenChange} title="New entry type">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim() && !taken) create.mutate();
        }}
        className="grid gap-3"
      >
        <Field label="Name, singular" placeholder="Artifact" value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus />
        <Field
          label="ID prefix"
          value={prefix ?? suggested}
          onChange={(e) => setPrefix(e.target.value.toLowerCase())}
          hint={`Entries get IDs like ${(prefix ?? suggested) || "art"}_4k8h2c. 2 to 8 letters, not used by another type.`}
          pattern="[a-z]{2,8}"
        />
        {taken && <p className="text-sm text-danger">There's already a type called that.</p>}
        {create.isError && <ErrorAlert title="Couldn't add the type">{create.error instanceof ApiError ? create.error.message : String(create.error)}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Dialog.Close asChild>
            <Button>Cancel</Button>
          </Dialog.Close>
          <Button type="submit" variant="primary" disabled={!label.trim() || taken || create.isPending}>
            Add type
          </Button>
        </div>
      </form>
    </Frame>
  );
}
