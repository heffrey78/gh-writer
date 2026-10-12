import type { EntityFields, Reference } from "@gh-writer/client";
import { entityOfLabel, type Entity, type Novel, type Relationship, type SceneLink } from "@gh-writer/core";
import { useGitHubRepo } from "../github/repo.ts";
import { EntryIssues } from "../issues/entry-issues.tsx";
import { useIssueList } from "../issues/use-issues.ts";
import { useNotice } from "../novel/notice.tsx";
import { SceneEditor, type SpellService } from "@gh-writer/editor/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Image, Trash2, X } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useStore } from "zustand";
import { api, keys } from "../api.ts";
import type { Workspace } from "../novel/workspace.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { AddButton, EditorButtons, EditorFrame, PencilButton, TextEditor, useInPlace, type InPlace } from "./profile.tsx";
import { RelationshipsPanel } from "./relationships.tsx";
import { InTheStory } from "./strip.tsx";
import { mentionEntities, typeOf } from "./types.ts";

const VIA: Record<SceneLink, string> = { pov: "point of view", characters: "present", locations: "set here", entities: "present", plotlines: "plotline", themes: "theme", mention: "mentioned" };

type FieldValue = string | number | boolean;

/**
 * A bible entry as a profile (#158), read first: its type, tags, name and other names, a portrait,
 * the summary as a lead, its fields as rows, then its notes, issues, scenes and relationships. Each
 * part edits in place from its pencil (or "+ Add…" while empty), saved to the entry's file at once.
 */
export function EntryPage({
  novelId,
  novel,
  entity,
  workspace,
  spell,
  embedded,
  startEditing,
}: {
  novelId: string;
  novel: Novel;
  entity: Entity;
  workspace: Workspace;
  spell?: { service: SpellService; onAddWord: (w: string) => void } | undefined;
  /** Shown in a side panel beside the text: its name is a level-2 heading with this ID, and it takes the panel's width. */
  embedded?: { headingId: string };
  /** A part to open for editing at once ("name" after a quick entry's Add details). */
  startEditing?: "name";
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const type = typeOf(novel, entity);
  const file = useStore(workspace.store, (s) => s.files[entity.file]);
  const mentions = useMemo(() => mentionEntities(novel), [novel]);
  const ids = { notes: useId() };
  const place = useInPlace(startEditing);

  useEffect(() => void workspace.open([entity.file]), [workspace, entity.file]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  /** The file's current hash, after any notes still being saved. */
  const base = async () => {
    await workspace.autosave.flush();
    return workspace.store.getState().files[entity.file]?.hash ?? "";
  };
  /**
   * Save some of the entry's details, then reload the book; throws to say why it couldn't. One at a
   * time: each is based on the file as the one before left it (read back at once, not when the
   * change is heard of), so two parts saved in quick succession don't refuse each other.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const change = (changes: EntityFields) => {
    const run = queue.current.then(async () => {
      const { file: path } = await api.bible.updateEntity(novelId, entity.id, await base(), changes);
      if (path === entity.file) await workspace.fileChanged({ type: "change", path, hash: null });
      else await workspace.open([path]);
      await refresh();
    });
    queue.current = run.catch(() => undefined);
    return run;
  };
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const [references, setReferences] = useState<Reference[]>();
  // On GitHub, the entry's label (if it's there): offered for removal when the entry goes.
  const repo = useGitHubRepo(novelId);
  const githubLabel = useIssueList(novelId, { state: "open" }, { enabled: !!repo }).data?.labels.find((l) => entityOfLabel(novel, l)?.id === entity.id);
  const show = useNotice((n) => n.show);
  const remove = useMutation({
    mutationFn: async (confirm: boolean) => api.bible.deleteEntity(novelId, entity.id, await base(), confirm),
    onSuccess: async (result) => {
      if (!result.ok) return setReferences(result.references);
      setReferences(undefined);
      await refresh();
      void navigate(`/novels/${novelId}/bible`);
      if (repo && githubLabel) {
        show({
          message: `Deleted “${entity.name}”. Its label ${githubLabel.name} is still on GitHub, on its issues.`,
          action: {
            label: "Remove label",
            run: () =>
              void api.issues
                .deleteLabel(novelId, githubLabel.name)
                .then(() => show({ message: `Removed the label ${githubLabel.name} from GitHub.` }))
                .catch((e: unknown) => show({ message: `Couldn't remove the label: ${e instanceof Error ? e.message : String(e)}` }))
                .finally(() => void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) })),
          },
        });
      }
    },
  });

  const fields = Object.entries(entity.fields);
  /** The fields with one changed, added (`at` past the end) or removed (`to` undefined), in their order. */
  const withField = (at: number, to: [string, FieldValue] | undefined) => {
    const next = [...fields];
    if (to === undefined) next.splice(at, 1);
    else next.splice(at, 1, to);
    return Object.fromEntries(next);
  };

  const Heading = embedded ? "h2" : "h1";
  return (
    <div className={embedded ? "grid gap-5" : "mx-auto grid w-full max-w-[calc(var(--ghw-prose-measure)+3rem)] gap-5 px-6 py-6"}>
      <div className="flex flex-wrap items-start gap-4">
        <Portrait place={place} image={entity.image} name={entity.name} onSave={(image) => change({ image: image || null })} />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm text-muted">
              <Link to={`/novels/${novelId}/bible`} className="underline-offset-2 hover:underline">
                Story bible
              </Link>{" "}
              · {type?.label ?? entity.type}
            </p>
            <Button variant="ghost" size="sm" onClick={() => remove.mutate(false)} disabled={remove.isPending}>
              <Trash2 className="size-4" aria-hidden /> Delete
            </Button>
          </div>

          {place.editing === "name" ? (
            <>
              {/* Still the page's (or panel's) heading while it's edited. */}
              <Heading id={embedded?.headingId} className="sr-only">
                {entity.name}
              </Heading>
              <TextEditor place={place} label="Name" value={entity.name} required onSave={(name) => change({ name })} />
            </>
          ) : (
            <div className="group flex items-center gap-1">
              <Heading id={embedded?.headingId} className={embedded ? "text-xl font-semibold" : "text-2xl font-semibold"}>
                {entity.name}
              </Heading>
              <PencilButton place={place} part="name" label="name" />
            </div>
          )}

          {place.editing === "aliases" ? (
            <TextEditor place={place} label="Other names" hint="Separated by commas. Recognised when suggesting mentions." value={entity.aliases.join(", ")} onSave={(v) => change({ aliases: list(v) })} />
          ) : entity.aliases.length ? (
            <div className="group flex items-center gap-1 text-sm text-muted">
              <span>Also {entity.aliases.join(", ")}</span>
              <PencilButton place={place} part="aliases" label="other names" />
            </div>
          ) : (
            <AddButton place={place} part="aliases">
              Add other names
            </AddButton>
          )}

          {place.editing === "tags" ? (
            <TextEditor place={place} label="Tags" hint="Separated by commas." value={entity.tags.join(", ")} onSave={(v) => change({ tags: list(v) })} />
          ) : entity.tags.length ? (
            <div className="group flex flex-wrap items-center gap-1.5">
              <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
                {entity.tags.map((t) => (
                  <li key={t} className="rounded-full border border-rule px-2 py-0.5 text-xs">
                    {t}
                  </li>
                ))}
              </ul>
              <PencilButton place={place} part="tags" label="tags" />
            </div>
          ) : (
            <AddButton place={place} part="tags">
              Add tags
            </AddButton>
          )}
        </div>
      </div>

      {place.editing === "summary" ? (
        <TextEditor place={place} label="Summary" multiline value={entity.summary ?? ""} onSave={(v) => change({ summary: v || null })} />
      ) : entity.summary ? (
        <div className="group flex items-start gap-1">
          <p className="flex-1 font-prose text-lg leading-normal">{entity.summary}</p>
          <PencilButton place={place} part="summary" label="summary" />
        </div>
      ) : (
        <AddButton place={place} part="summary">
          Add a summary
        </AddButton>
      )}

      <div className="grid gap-1">
        {fields.length > 0 && (
          <dl aria-label="Fields" className="grid gap-0.5">
            {fields.map(([key, value], i) => (
              <div key={key} className="group -mx-1.5 flex items-baseline gap-2.5 rounded-md px-1.5 py-1">
                <dt className="w-32 shrink-0 text-[13px] text-muted capitalize">{key.replace(/_/g, " ")}</dt>
                <dd className="flex min-w-0 flex-1 items-baseline gap-1">
                  {place.editing === `field:${key}` ? (
                    <FieldEditor place={place} name={key} value={value} others={fields.map(([k]) => k).filter((k) => k !== key)} onSave={(to) => change({ fields: withField(i, to) })} />
                  ) : (
                    <>
                      <span className="flex-1">{typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</span>
                      <PencilButton place={place} part={`field:${key}`} label={key.replace(/_/g, " ")} />
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {place.editing === "field:" ? (
          <FieldEditor place={place} name="" value="" others={fields.map(([k]) => k)} onSave={(to) => change({ fields: withField(fields.length, to) })} />
        ) : (
          <AddButton place={place} part="field:">
            Add a field
          </AddButton>
        )}
      </div>

      <section aria-labelledby={`${ids.notes}-h`} className="grid gap-1 border-t border-rule pt-4">
        <h2 id={`${ids.notes}-h`} className="text-xs font-semibold tracking-wide text-muted uppercase">
          Notes
        </h2>
        {file ? (
          // Prose that edits in place, as part of the page.
          <div className="-mx-1 rounded-md px-1 focus-within:bg-panel/60">
            <SceneEditor
              key={entity.file}
              sceneId={entity.file}
              label={`Notes on ${entity.name}`}
              placeholder="Backstory, voice, anything worth remembering…"
              markdown={file.body}
              onChange={(md) => workspace.change(entity.file, md)}
              entities={mentions}
              className="[&_.ghw-prose]:min-h-16 [&_.ghw-prose]:py-1"
              {...(spell ? { spell } : {})}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">Opening…</p>
        )}
      </section>

      <EntryIssues novelId={novelId} novel={novel} entity={entity} />

      <InTheStory novelId={novelId} novel={novel} entity={entity} />

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

/**
 * A field edited in place: its name and value (a number stays a number, true/false a checkbox), saved
 * together; Remove takes it off. A name another field has is refused.
 */
function FieldEditor({
  place,
  name,
  value,
  others,
  onSave,
}: {
  place: InPlace;
  name: string;
  value: FieldValue;
  others: string[];
  onSave: (to: [string, FieldValue] | undefined) => Promise<unknown>;
}) {
  const [key, setKey] = useState(name);
  const [text, setText] = useState(String(value));
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const isNew = name === "";
  const run = async (to: [string, FieldValue] | undefined) => {
    setSaving(true);
    try {
      await onSave(to);
      // Back to the field under its name now, or, removed, to "+ Add a field".
      place.done(to ? `field:${to[0]}` : "field:");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const save = () => {
    const k = key.trim();
    if (!k) return setProblem("A field needs a name.");
    if (others.includes(k)) return setProblem(`There's already a field “${k}”.`);
    const v: FieldValue = typeof value === "boolean" ? text === "true" : typeof value === "number" && text.trim() !== "" && !Number.isNaN(Number(text)) ? Number(text) : text.trim();
    if (k === name && v === value) return place.done();
    void run([k, v]);
  };
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };
  return (
    <EditorFrame place={place} className="flex-1">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <label className="grid gap-1 text-xs font-medium">
          Field name
          <input value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={enter} className="h-8 w-full min-w-0 rounded-md border border-rule bg-raised px-2 text-sm font-normal" />
        </label>
        {typeof value === "boolean" ? (
          <label className="flex items-center gap-2 self-end pb-1.5 text-sm">
            <input type="checkbox" checked={text === "true"} onChange={(e) => setText(String(e.target.checked))} />
            {key || "Value"}
          </label>
        ) : (
          <label className="grid gap-1 text-xs font-medium">
            Value
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={enter} inputMode={typeof value === "number" ? "decimal" : undefined} className="h-8 w-full min-w-0 rounded-md border border-rule bg-raised px-2 text-sm font-normal" />
          </label>
        )}
      </div>
      {problem && <p className="text-xs text-danger">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <EditorButtons onSave={save} onCancel={() => place.done()} saving={saving} hint="Enter saves · Esc cancels" />
        {!isNew && (
          <Button size="sm" variant="ghost" onClick={() => void run(undefined)} disabled={saving}>
            <X className="size-4" aria-hidden /> Remove the field
          </Button>
        )}
      </div>
    </EditorFrame>
  );
}

/** The entry's image, or a slot for one: its path in the repository, edited in place. */
function Portrait({ place, image, name, onSave }: { place: InPlace; image: string | undefined; name: string; onSave: (image: string) => Promise<unknown> }) {
  if (place.editing === "image") {
    return (
      <div className="w-full sm:w-72">
        <TextEditor place={place} label="Portrait" hint="A path in the repository, e.g. bible/images/ada.jpg." value={image ?? ""} onSave={onSave} />
      </div>
    );
  }
  return (
    <button
      ref={place.trigger("image")}
      type="button"
      onClick={() => place.start("image")}
      aria-label={image ? `Portrait of ${name}: ${image}. Edit the portrait` : "Add a portrait"}
      className="grid size-24 shrink-0 place-items-center gap-1 rounded-lg border border-dashed border-rule bg-panel p-2 text-center text-[11px] text-muted hover:border-accent hover:text-ink"
    >
      <Image className="size-5" aria-hidden />
      <span className={image ? "line-clamp-2 break-all" : undefined}>{image ? image.split("/").at(-1) : "Add a portrait"}</span>
    </button>
  );
}

/** "Rival of Ben Varn, from “The Betrayal”", read from this entry's side. */
export { describeRelationship as describe } from "@gh-writer/core/diagrams";
