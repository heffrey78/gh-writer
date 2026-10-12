import type { Entity, Novel, Relationship } from "@gh-writer/core";
import { describeRelationship as describe } from "@gh-writer/core/diagrams";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { Picker } from "../ui/picker.tsx";
import { entityItems, sceneItems } from "./pickers.ts";

/** A way to relate this entry to another: a type, read from this entry's side. */
interface Role {
  type: string;
  /** This entry is the relationship's `from`. */
  forward: boolean;
  label: string;
}

/** The relationship types that fit between entries of these types, each from this side (and the other way, if not symmetric). */
export function roles(novel: Novel, mine: string, theirs: string | undefined): Role[] {
  const fits = (types: string[] | undefined, t: string | undefined) => !types?.length || (t !== undefined && types.includes(t)) || t === undefined;
  return novel.relationshipTypes.flatMap((t): Role[] => {
    const label = t.label ?? t.key;
    const forward = fits(t.from_types, mine) && fits(t.to_types, theirs);
    if (t.symmetric) return forward ? [{ type: t.key, forward: true, label }] : [];
    const backward = fits(t.from_types, theirs) && fits(t.to_types, mine);
    return [...(forward ? [{ type: t.key, forward: true, label }] : []), ...(backward ? [{ type: t.key, forward: false, label: t.inverse_label ?? `${label} (the other way)` }] : [])];
  });
}

function Frame({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 grid w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


/** A new relationship for `entity`, with `other` and a starting scene (`since`) filled in when given. */
export function AddRelationshipDialog({
  novelId,
  novel,
  entity,
  onClose,
  other: initialOther,
  since: initialSince,
}: {
  novelId: string;
  novel: Novel;
  entity: Entity;
  onClose: () => void;
  other?: string | undefined;
  since?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [other, setOther] = useState<string | undefined>(initialOther);
  const [role, setRole] = useState("");
  const [since, setSince] = useState<string | undefined>(initialSince);
  const [until, setUntil] = useState<string>();
  const [note, setNote] = useState("");
  const otherType = novel.entities.find((e) => e.id === other)?.type;
  const options = roles(novel, entity.type, otherType);
  const chosen = options.find((r) => `${r.type}:${r.forward}` === role) ?? options[0];
  const add = useMutation({
    mutationFn: () =>
      api.bible.createRelationship(novelId, {
        from: chosen!.forward ? entity.id : other!,
        to: chosen!.forward ? other! : entity.id,
        type: chosen!.type,
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (other && chosen) add.mutate();
  };
  return (
    <Frame open onOpenChange={(o) => !o && onClose()} title={`New relationship for ${entity.name}`}>
      <form onSubmit={submit} className="grid gap-3">
        <RoleSelect options={options} value={chosen} onChange={setRole} />
        <Picker label="With" items={entityItems(novel, entity.id)} value={other} onChange={setOther} placeholder="Choose an entry…" />
        <Picker label="From" items={sceneItems(novel)} value={since} onChange={setSince} placeholder="The beginning" allowNone />
        <Picker label="Until" items={sceneItems(novel)} value={until} onChange={setUntil} placeholder="The end" allowNone />
        <Field label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        {add.isError && <ErrorAlert title="Couldn't add it">{add.error.message}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!other || !chosen || add.isPending}>
            Add relationship
          </Button>
        </div>
      </form>
    </Frame>
  );
}

/** Change a relationship from a scene on (a new type or note), or end it at a scene; `at` fills in the scene. */
export function RelationshipAtSceneDialog({
  novelId,
  novel,
  entity,
  kind,
  relationship,
  onClose,
  at: initialAt,
}: {
  novelId: string;
  novel: Novel;
  entity: Entity;
  kind: "change" | "end";
  relationship: Relationship;
  onClose: () => void;
  at?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [at, setAt] = useState<string | undefined>(initialAt);
  const forward = relationship.from === entity.id;
  const otherType = novel.entities.find((e) => e.id === (forward ? relationship.to : relationship.from))?.type;
  const options = roles(novel, entity.type, otherType).filter((r) => r.forward === forward || novel.relationshipTypes.find((t) => t.key === r.type)?.symmetric);
  const [role, setRole] = useState(`${relationship.type}:${forward}`);
  const chosen = options.find((r) => `${r.type}:${r.forward}` === role);
  const [note, setNote] = useState(relationship.note ?? "");
  const save = useMutation({
    mutationFn: () =>
      kind === "end"
        ? api.bible.endRelationship(novelId, relationship.id, at!)
        : api.bible.changeRelationship(novelId, relationship.id, at!, { ...(chosen ? { type: chosen.type } : {}), note: note.trim() || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      onClose();
    },
  });
  const title = describe(novel, entity.id, relationship);
  return (
    <Frame open onOpenChange={(o) => !o && onClose()} title={kind === "end" ? "End this relationship" : "Change this relationship"}>
      <p className="text-sm text-muted">{title}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (at) save.mutate();
        }}
        className="grid gap-3"
      >
        <Picker label={kind === "end" ? "It no longer holds from" : "It changes at"} items={sceneItems(novel)} value={at} onChange={setAt} placeholder="Choose a scene…" />
        {kind === "change" && (
          <>
            <RoleSelect options={options} value={chosen} onChange={setRole} label="From then on" />
            <Field label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
          </>
        )}
        {save.isError && <ErrorAlert title="Couldn't save it">{save.error.message}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!at || save.isPending}>
            {kind === "end" ? "End it" : "Change it"}
          </Button>
        </div>
      </form>
    </Frame>
  );
}

function RoleSelect({ options, value, onChange, label = "Relationship" }: { options: Role[]; value: Role | undefined; onChange: (v: string) => void; label?: string }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select id={id} value={value ? `${value.type}:${value.forward}` : ""} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2 text-sm">
        {options.map((r) => (
          <option key={`${r.type}:${r.forward}`} value={`${r.type}:${r.forward}`}>
            {r.label}
          </option>
        ))}
      </select>
    </div>
  );
}
