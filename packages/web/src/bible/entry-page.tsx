import type { EntityFields, Reference } from "@gh-writer/client";
import { backlinks, type Entity, type Novel, type Relationship, type SceneLink } from "@gh-writer/core";
import { SceneEditor, type SpellService } from "@gh-writer/editor/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useStore } from "zustand";
import { api, keys } from "../api.ts";
import type { Workspace } from "../novel/workspace.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { RelationshipsPanel } from "./relationships.tsx";
import { mentionEntities, typeOf } from "./types.ts";

const VIA: Record<SceneLink, string> = { pov: "point of view", characters: "present", locations: "set here", entities: "present", plotlines: "plotline", themes: "theme", mention: "mentioned" };

type FieldRow = { key: string; value: string; kind: "string" | "number" | "boolean" };

/** A bible entry: its details, its notes, and everywhere the story refers to it. */
export function EntryPage({
  novelId,
  novel,
  entity,
  workspace,
  spell,
  embedded,
}: {
  novelId: string;
  novel: Novel;
  entity: Entity;
  workspace: Workspace;
  spell?: { service: SpellService; onAddWord: (w: string) => void } | undefined;
  /** Shown in a side panel beside the text: its name is a level-2 heading with this ID, and it takes the panel's width. */
  embedded?: { headingId: string };
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const type = typeOf(novel, entity);
  const file = useStore(workspace.store, (s) => s.files[entity.file]);
  const mentions = useMemo(() => mentionEntities(novel), [novel]);
  const links = useMemo(() => backlinks(novel, entity.id), [novel, entity.id]);
  const ids = { form: useId(), notes: useId(), links: useId() };

  useEffect(() => void workspace.open([entity.file]), [workspace, entity.file]);

  // The details form, from the entry as loaded; saved together as one change.
  const initial = useMemo(
    () => ({
      name: entity.name,
      aliases: entity.aliases.join(", "),
      summary: entity.summary ?? "",
      image: entity.image ?? "",
      tags: entity.tags.join(", "),
      fields: Object.entries(entity.fields).map(([key, value]): FieldRow => ({ key, value: String(value), kind: typeof value as FieldRow["kind"] })),
    }),
    [entity],
  );
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  /** The file's current hash, after any notes still being saved. */
  const base = async () => {
    await workspace.autosave.flush();
    return workspace.store.getState().files[entity.file]?.hash ?? "";
  };

  const save = useMutation({
    mutationFn: async () => {
      const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      const changes: EntityFields = {};
      if (form.name.trim() !== entity.name) changes.name = form.name.trim();
      if (form.aliases !== initial.aliases) changes.aliases = list(form.aliases);
      if (form.summary !== initial.summary) changes.summary = form.summary.trim() || null;
      if (form.image !== initial.image) changes.image = form.image.trim() || null;
      if (form.tags !== initial.tags) changes.tags = list(form.tags);
      if (JSON.stringify(form.fields) !== JSON.stringify(initial.fields)) {
        changes.fields = Object.fromEntries(
          form.fields.filter((f) => f.key.trim()).map((f) => [f.key.trim(), f.kind === "number" && f.value.trim() !== "" && !Number.isNaN(Number(f.value)) ? Number(f.value) : f.kind === "boolean" ? f.value === "true" : f.value]),
        );
      }
      return api.bible.updateEntity(novelId, entity.id, await base(), changes);
    },
    onSuccess: refresh,
  });

  const [references, setReferences] = useState<Reference[]>();
  const remove = useMutation({
    mutationFn: async (confirm: boolean) => api.bible.deleteEntity(novelId, entity.id, await base(), confirm),
    onSuccess: async (result) => {
      if (!result.ok) return setReferences(result.references);
      setReferences(undefined);
      await refresh();
      void navigate(`/novels/${novelId}/bible`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty && form.name.trim()) save.mutate();
  };
  const setField = (i: number, patch: Partial<FieldRow>) => setForm((f) => ({ ...f, fields: f.fields.map((row, j) => (j === i ? { ...row, ...patch } : row)) }));

  return (
    <div className={embedded ? "grid gap-6" : "mx-auto grid w-full max-w-[calc(var(--ghw-prose-measure)+3rem)] gap-6 px-6 py-6"}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            <Link to={`/novels/${novelId}/bible`} className="underline-offset-2 hover:underline">
              Story bible
            </Link>{" "}
            · {type?.label ?? entity.type}
          </p>
          {embedded ? (
            <h2 id={embedded.headingId} className="text-lg font-semibold">
              {entity.name}
            </h2>
          ) : (
            <h1 className="text-xl font-semibold">{entity.name}</h1>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => remove.mutate(false)} disabled={remove.isPending}>
          <Trash2 className="size-4" aria-hidden /> Delete
        </Button>
      </div>

      <form onSubmit={submit} aria-labelledby={`${ids.form}-h`} className="grid gap-3 rounded-lg border border-rule p-4">
        <h2 id={`${ids.form}-h`} className="font-semibold">
          Details
        </h2>
        <Field label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <Field label="Other names" hint="Separated by commas. Recognised when suggesting mentions." value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
        <label className="grid gap-1.5 text-sm font-medium">
          Summary
          <textarea
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
            rows={2}
            className="rounded-md border border-rule bg-raised px-3 py-2 font-normal"
          />
        </label>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Fields</legend>
          {form.fields.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input aria-label={`Field ${i + 1} name`} value={row.key} onChange={(e) => setField(i, { key: e.target.value })} className="h-9 w-36 rounded-md border border-rule bg-raised px-2 text-sm" />
              {row.kind === "boolean" ? (
                <input type="checkbox" aria-label={`${row.key || `Field ${i + 1}`} value`} checked={row.value === "true"} onChange={(e) => setField(i, { value: String(e.target.checked) })} />
              ) : (
                <input aria-label={`${row.key || `Field ${i + 1}`} value`} value={row.value} onChange={(e) => setField(i, { value: e.target.value })} className="h-9 min-w-0 flex-1 rounded-md border border-rule bg-raised px-2 text-sm" />
              )}
              <Button size="sm" variant="ghost" aria-label={`Remove ${row.key || `field ${i + 1}`}`} onClick={() => setForm((f) => ({ ...f, fields: f.fields.filter((_, j) => j !== i) }))}>
                <X className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
          <Button size="sm" className="justify-self-start" onClick={() => setForm((f) => ({ ...f, fields: [...f.fields, { key: "", value: "", kind: "string" }] }))}>
            <Plus className="size-4" aria-hidden /> Add a field
          </Button>
        </fieldset>
        <Field label="Tags" hint="Separated by commas." value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        <Field label="Image" hint="A path in the repository, e.g. bible/images/ada.jpg." value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })} />
        {save.isError && <ErrorAlert title="Couldn't save the details">{save.error.message}</ErrorAlert>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={!dirty || !form.name.trim() || save.isPending}>
            {save.isPending ? "Saving…" : "Save details"}
          </Button>
          {dirty && <Button onClick={() => setForm(initial)}>Discard changes</Button>}
        </div>
      </form>

      <section aria-labelledby={`${ids.notes}-h`} className="grid gap-2">
        <h2 id={`${ids.notes}-h`} className="font-semibold">
          Notes
        </h2>
        {file ? (
          <div className="rounded-lg border border-rule px-4">
            <SceneEditor
              key={entity.file}
              sceneId={entity.file}
              label={`Notes on ${entity.name}`}
              placeholder="Backstory, voice, anything worth remembering…"
              markdown={file.body}
              onChange={(md) => workspace.change(entity.file, md)}
              entities={mentions}
              className="[&_.ghw-prose]:min-h-24 [&_.ghw-prose]:py-3"
              {...(spell ? { spell } : {})}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">Opening…</p>
        )}
      </section>

      <section aria-labelledby={`${ids.links}-h`} className="grid gap-3">
        <h2 id={`${ids.links}-h`} className="font-semibold">
          In the story
        </h2>
        {links.scenes.length ? (
          <ul className="grid gap-1 text-sm">
            {links.scenes.map(({ scene, via }) => (
              <li key={scene.id}>
                <Link to={`/novels/${novelId}/scene/${scene.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                  {scene.title}
                </Link>
                <span className="text-muted"> · {via.map((v) => VIA[v]).join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No scene refers to {entity.name} yet.</p>
        )}
      </section>

      <RelationshipsPanel novelId={novelId} novel={novel} entity={entity} />

      <AlertDialog.Root open={references !== undefined} onOpenChange={(o) => !o && setReferences(undefined)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-[60] grid max-h-[80vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl">
            <AlertDialog.Title className="text-base font-semibold">Delete “{entity.name}”? The story still refers to it.</AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-muted">These will point at an entry that no longer exists, and the validator will list them until they're changed:</AlertDialog.Description>
            <ul className="grid gap-1 text-sm">
              {references?.map((r) => (
                <li key={`${r.kind}:${r.id}`}>
                  {r.kind === "scene" ? `Scene “${r.title}” (${r.via.map((v) => VIA[v as SceneLink] ?? v).join(", ")})` : r.kind === "event" ? `Event “${r.title}”` : `Relationship: ${r.type} ${novel.entities.find((e) => e.id === r.other)?.name ?? r.other}`}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button>Keep it</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant="danger" onClick={() => remove.mutate(true)}>
                  Delete anyway
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      {remove.isError && <ErrorAlert title="Couldn't delete it">{remove.error.message}</ErrorAlert>}
    </div>
  );
}

/** "Rival of Ben Varn, from “The Betrayal”", read from this entry's side. */
export { describeRelationship as describe } from "@gh-writer/core/diagrams";
