import { countWords, dayOneFor, readFrontMatter, sceneFacts, type Novel, type YamlEdit } from "@gh-writer/core";
import { chapterTitle } from "@gh-writer/core/diagrams";
import { joinSceneFile } from "@gh-writer/editor";
import { ChevronLeft, ChevronRight, Pencil, Pin, Plus, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useParams } from "react-router";
import { create, useStore } from "zustand";
import { plural } from "../bible/types.ts";
import { MENU_ITEM } from "../layout.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Picker, type PickerItem, type PickerProps } from "../ui/picker.tsx";
import { useEntryPanel } from "./entry-tab.tsx";
import { useNotice } from "./notice.tsx";
import { STATUSES } from "./outline.tsx";
import type { Workspace } from "./workspace.ts";
import { readDate, useSetDayOne } from "../timeline/day-one.tsx";
import { storyDate } from "../format.ts";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const AT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

type Ref = string | { id: string; [key: string]: unknown };
const refId = (r: Ref) => (typeof r === "string" ? r : r.id);

const PINS = "ghw.pinnedDetails";

/** The details pinned under each scene's title in the text (#153), by row key: remembered in this browser. */
export const usePins = create<{ keys: string[]; toggle: (key: string) => void }>((set, get) => ({
  keys: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PINS) ?? "[]") as unknown;
      return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
    } catch {
      return [];
    }
  })(),
  toggle: (key) => {
    const keys = get().keys.includes(key) ? get().keys.filter((k) => k !== key) : [...get().keys, key];
    set({ keys });
    try {
      localStorage.setItem(PINS, JSON.stringify(keys));
    } catch {
      // Not remembered where storage is blocked.
    }
  },
}));

const listOf = (fm: Record<string, unknown>, key: string): Ref[] => (Array.isArray(fm[key]) ? (fm[key] as Ref[]) : []);

/** When a scene happens, as read: "Day 3, 18:30", a date, or nothing; and how long, as "45 min". */
export function whenOf(fm: Record<string, unknown>): { when: string; duration: string } {
  const w = fm.when && typeof fm.when === "object" ? (fm.when as { at?: string; day?: number; time?: string }) : undefined;
  const when = w?.at !== undefined ? storyDate(w.at) : w?.day !== undefined ? `Day ${w.day}${w.time ? `, ${w.time}` : ""}` : "";
  return { when, duration: str(fm.duration) && readableDuration(str(fm.duration)) };
}

/**
 * Each detail a scene has, as a few words for its pinned line, by row key in the card's order:
 * names for entries, "Day 3, 18:30 · 45 min" for when, the tags as written.
 */
export function detailTexts(novel: Novel, fm: Record<string, unknown>): Record<string, string> {
  const name = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  const names = (ids: string[]) => ids.map(name).join(", ");
  const typeOf = (id: string) => novel.entities.find((e) => e.id === id)?.type ?? novel.entityTypes.find((t) => id.startsWith(`${t.prefix}_`))?.key;
  const { when, duration } = whenOf(fm);
  const texts: Record<string, string> = {
    pov: str(fm.pov) && name(str(fm.pov)),
    locations: names(listOf(fm, "locations").map(refId)),
    characters: names(listOf(fm, "characters").map(refId)),
    when: [when, duration].filter(Boolean).join(" · "),
    plotlines: names(listOf(fm, "plotlines").map(refId)),
  };
  for (const t of novel.entityTypes.filter((t) => !t.builtin).sort((a, b) => a.label.localeCompare(b.label))) {
    texts[`type:${t.key}`] = names(listOf(fm, "entities").map(refId).filter((id) => typeOf(id) === t.key));
  }
  texts.themes = names(listOf(fm, "themes").map(refId));
  texts.tags = (Array.isArray(fm.tags) ? (fm.tags as unknown[]) : []).map(String).join(", ");
  return texts;
}

/** A scene's pinned line: its pinned details that it has, in the card's order. */
export function pinnedLine(novel: Novel, fm: Record<string, unknown>, keys: readonly string[]): string {
  return Object.entries(detailTexts(novel, fm))
    .filter(([k, v]) => v && keys.includes(k))
    .map(([, v]) => v)
    .join(" · ");
}

/**
 * A scene's planning details as a card on the right sidebar's Scene tab (#150): its title and place
 * in the chapter, the synopsis as a lead, the status as five steps, then a row for each detail it
 * has (point of view, where, when, plotlines, characters, other entries, themes, tags); the ones it
 * hasn't are behind "Add…". Each row's pencil edits it in place; Escape (or Done) returns to the row.
 * Names open their entry on the Entry tab. ◀ ▶ step through the chapter's scenes without moving the
 * caret. Each change rewrites only the front-matter lines it touches, through the workspace (so it
 * autosaves and merges like typing).
 */
export function SceneDetails({
  novel,
  workspace,
  path,
  title,
  onStep,
  newEntry,
  issues,
  onOpenIssue,
}: {
  novel: Novel;
  workspace: Workspace;
  path: string;
  title: string;
  /** Show another scene's card (◀ ▶), by its ID. */
  onStep?: (sceneId: string) => void;
  /** Make an entry of a type from a picker's search (see useQuickEntry): returns its ID at once. */
  newEntry?: (type: string, name: string) => string | undefined;
  /** Open issues raised about the scene's passages (a novel on GitHub), and how to open one beside the text. */
  issues?: { number: number; title: string }[] | undefined;
  onOpenIssue?: (number: number) => void;
}) {
  const file = useStore(workspace.store, (s) => s.files[path]);
  const show = useNotice((s) => s.show);
  const fm = useMemo(() => (file ? (readFrontMatter(joinSceneFile(file)) ?? {}) : {}), [file?.frontMatter]); // eslint-disable-line react-hooks/exhaustive-deps
  const headingId = useId();
  const pins = usePins();
  const [editing, setEditing] = useState<string | null>(null);
  const pencils = useRef(new Map<string, HTMLButtonElement | null>());
  const editor = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  // The Add… menu opens inside the card's landmark, not at the end of the page.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  // A neighbouring scene, stepped to, isn't open in the editor: open it here to read and edit.
  useEffect(() => void workspace.open([path]), [workspace, path]);

  // Into the editor as a row opens; back to its pencil as it closes.
  useEffect(() => {
    if (editing) {
      editor.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    } else if (returnTo.current) {
      pencils.current.get(returnTo.current)?.focus();
      returnTo.current = null;
    }
  }, [editing]);
  const start = (key: string) => setEditing(key);
  const done = () => {
    returnTo.current = editing;
    setEditing(null);
  };

  const edit = (edits: YamlEdit[]) =>
    void workspace.editFrontMatter(path, edits).catch((e: unknown) =>
      show({
        message: `Couldn't change the details: ${e instanceof Error ? e.message : String(e)}`,
      }),
    );
  const set = (key: string, value: unknown) => edit([value === undefined || value === "" ? { path: [key], remove: true } : { path: [key], value }]);

  const ofType = (type: string): PickerItem[] =>
    novel.entities
      .filter((e) => e.type === type)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ value: e.id, label: e.name, keywords: e.aliases }));
  const name = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  /** A picker's "New <type>" option, for a type key. */
  const making = (type: string): Pick<PickerProps, "create"> => {
    const noun = novel.entityTypes.find((t) => t.key === type)?.label.toLowerCase();
    return newEntry && noun ? { create: { noun, create: (n) => newEntry(type, n) } } : {};
  };
  // After the built-in four, by name.
  const customTypes = novel.entityTypes.filter((t) => !t.builtin).sort((a, b) => a.label.localeCompare(b.label));
  /** The scene's `entities` of a custom type, with each one's place in the whole list. */
  const ofCustom = (type: string) =>
    list("entities")
      .map((r, i) => ({ id: refId(r), i }))
      .filter(({ id }) => (novel.entities.find((e) => e.id === id)?.type ?? novel.entityTypes.find((t) => id.startsWith(`${t.prefix}_`))?.key) === type);

  const list = (key: string): Ref[] => (Array.isArray(fm[key]) ? (fm[key] as Ref[]) : []);
  /** Add an item to a list: appended in its place, or the list made. */
  const append = (key: string, item: Ref) => {
    const items = list(key);
    edit([items.length ? { path: [key, items.length], value: item } : { path: [key], value: [item] }]);
  };
  const removeAt = (key: string, i: number) => edit([list(key).length === 1 ? { path: [key], value: [] } : { path: [key, i], remove: true }]);
  /** Change a field of a plotline or theme: a bare ID becomes a map holding it. */
  const setField = (key: string, i: number, field: string, value: unknown) => {
    const item = list(key)[i]!;
    const empty = value === undefined || value === "";
    if (typeof item === "string") {
      if (!empty) edit([{ path: [key, i], value: { id: item, [field]: value } }]);
    } else edit([empty ? { path: [key, i, field], remove: true } : { path: [key, i, field], value }]);
  };

  // Where the scene is: its chapter, its place in it, and its neighbours.
  const scene = novel.allScenes.find((s) => s.file === path);
  const chapter = scene && novel.chapters.find((c) => c.sceneIds.includes(scene.id));
  const at = chapter && scene ? chapter.sceneIds.indexOf(scene.id) : -1;
  const prev = chapter && at > 0 ? chapter.sceneIds[at - 1] : undefined;
  const next = chapter && at >= 0 ? chapter.sceneIds[at + 1] : undefined;
  // What the rest of the book says about it: worked out again when the book is, not as it's typed.
  const facts = useMemo(() => (scene ? sceneFacts(novel, scene.id) : []), [novel, scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!file) return null;
  const when = fm.when && typeof fm.when === "object" ? (fm.when as { at?: string; day?: number; time?: string }) : undefined;
  const whenKind = when?.at !== undefined ? "date" : when?.day !== undefined ? "day" : "";
  const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
  const status = STATUSES.includes(fm.status as never) ? (fm.status as string) : "idea";
  const synopsis = str(fm.synopsis);

  const link = (id: string) => <EntityLink key={id} novel={novel} id={id} />;
  const names = (ids: string[]) => ids.map((id, i) => [i > 0 && ", ", link(id)]);
  const pickerFor = (key: string, label: string, type: string, chosen: string[], add: (id: string) => void) => (
    <Picker
      label={`Add to ${label.toLowerCase()}`}
      items={ofType(type).filter((i) => !chosen.includes(i.value))}
      value={undefined}
      onChange={(v) => v && add(v)}
      placeholder={`Add ${/^[aeiou]/i.test(type) ? "an" : "a"} ${novel.entityTypes.find((t) => t.key === type)?.label.toLowerCase() ?? type}…`}
      {...making(type)}
    />
  );

  /** Each row: its key, label, whether it has anything, how it reads and how it's edited. */
  const rows: { key: string; label: string; filled: boolean; view: ReactNode; edit: ReactNode; plain?: boolean }[] = [
    {
      key: "pov",
      label: "Point of view",
      filled: !!str(fm.pov),
      view: str(fm.pov) && link(str(fm.pov)),
      edit: (
        <Picker
          label="Point of view"
          items={ofType("character")}
          value={str(fm.pov) || undefined}
          onChange={(v) => set("pov", v)}
          placeholder="No point of view"
          allowNone
          {...making("character")}
        />
      ),
    },
    ...(
      [
        ["locations", "Where", "Locations", "location"],
        ["characters", "Characters", "Characters", "character"],
      ] as const
    ).map(([key, label, group, type]) => {
      const chosen = list(key).map(refId);
      return {
        key,
        label,
        filled: chosen.length > 0,
        view: names(chosen),
        edit: (
          <Group label={group}>
            <Chips items={chosen.map((id, i) => ({ id, label: name(id), remove: () => removeAt(key, i) }))} />
            {pickerFor(key, group, type, chosen, (v) => append(key, v))}
          </Group>
        ),
      };
    }),
    {
      key: "when",
      label: "When",
      plain: true,
      filled: whenKind !== "" || !!str(fm.duration),
      view: (
        <>
          {whenOf(fm).when || "Not set"}
          {whenOf(fm).duration && <span className="text-muted"> · {whenOf(fm).duration}</span>}
        </>
      ),
      edit: <StoryTimeFields when={when} duration={str(fm.duration)} edit={edit} novel={novel} />,
    },
    {
      key: "plotlines",
      label: "Plotlines",
      filled: list("plotlines").length > 0,
      view: list("plotlines").map((p, i) => {
        const item: Record<string, unknown> = typeof p === "string" ? {} : p;
        return (
          <span key={`${refId(p)}-${i}`}>
            {i > 0 && ", "}
            {link(refId(p))} <span className="text-muted">({item.weight === "minor" ? "minor" : "major"}){str(item.beat) && ` “${str(item.beat)}”`}</span>
          </span>
        );
      }),
      edit: (
        <Group label="Plotlines">
          <ul className="grid gap-2">
            {list("plotlines").map((p, i) => {
              const label = name(refId(p));
              const item: Record<string, unknown> = typeof p === "string" ? {} : p;
              return (
                <li key={`${refId(p)}-${i}`} className="grid gap-1.5 rounded-md border border-rule p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{label}</span>
                    <RemoveButton label={label} onClick={() => removeAt("plotlines", i)} />
                  </div>
                  <SelectField
                    label={`Weight of “${label}”`}
                    value={item.weight === "minor" ? "minor" : "major"}
                    options={[
                      ["major", "major"],
                      ["minor", "minor"],
                    ]}
                    onChange={(v) => setField("plotlines", i, "weight", v)}
                  />
                  <TextField label={`Beat of “${label}”`} value={str(item.beat)} onSave={(v) => setField("plotlines", i, "beat", v)} />
                </li>
              );
            })}
          </ul>
          {pickerFor("plotlines", "Plotlines", "plotline", list("plotlines").map(refId), (v) => append("plotlines", v))}
        </Group>
      ),
    },
    ...customTypes.map((t) => {
      const chosen = ofCustom(t.key);
      const label = plural(t.label);
      return {
        key: `type:${t.key}`,
        label,
        filled: chosen.length > 0,
        view: names(chosen.map((c) => c.id)),
        edit: (
          <Group label={label}>
            <Chips items={chosen.map(({ id, i }) => ({ id, label: name(id), remove: () => removeAt("entities", i) }))} />
            {pickerFor(`type:${t.key}`, label, t.key, chosen.map((c) => c.id), (v) => append("entities", v))}
          </Group>
        ),
      };
    }),
    {
      key: "themes",
      label: "Themes",
      filled: list("themes").length > 0,
      view: list("themes").map((t, i) => {
        const item: Record<string, unknown> = typeof t === "string" ? {} : t;
        return (
          <span key={`${refId(t)}-${i}`}>
            {i > 0 && ", "}
            {link(refId(t))}
            {item.strength !== undefined && <span className="text-muted"> ({STRENGTH[String(item.strength)] ?? String(item.strength)})</span>}
          </span>
        );
      }),
      edit: (
        <Group label="Themes">
          <ul className="grid gap-2">
            {list("themes").map((t, i) => {
              const label = name(refId(t));
              const item: Record<string, unknown> = typeof t === "string" ? {} : t;
              return (
                <li key={`${refId(t)}-${i}`} className="flex items-end gap-2 rounded-md border border-rule p-2">
                  <span className="flex-1 self-center font-medium">{label}</span>
                  <SelectField
                    label={`Strength of “${label}”`}
                    value={item.strength === undefined ? "" : String(item.strength)}
                    options={[
                      ["", "—"],
                      ["1", "1 (faint)"],
                      ["2", "2"],
                      ["3", "3 (strong)"],
                    ]}
                    onChange={(v) => setField("themes", i, "strength", v ? Number(v) : undefined)}
                  />
                  <RemoveButton label={label} onClick={() => removeAt("themes", i)} />
                </li>
              );
            })}
          </ul>
          {pickerFor("themes", "Themes", "theme", list("themes").map(refId), (v) => append("themes", v))}
        </Group>
      ),
    },
    {
      key: "tags",
      label: "Tags",
      plain: true,
      filled: tags.length > 0,
      view: tags.join(", "),
      edit: (
        <TextField
          label="Tags"
          hint="Separated by commas."
          value={tags.join(", ")}
          onEnter={done}
          onSave={(v) => {
            const next = [
              ...new Set(
                v
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              ),
            ];
            if (next.join("\n") !== tags.join("\n")) set("tags", next.length ? next : undefined);
          }}
        />
      ),
    },
  ];
  const shown = rows.filter((r) => r.filled || r.key === editing);
  const empty = rows.filter((r) => !r.filled && r.key !== editing);

  /** The editor of a row, in place: Escape (unless something in it took the key) or Done returns to the row. */
  const editorOf = (body: ReactNode) => (
    <div
      ref={editor}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        done();
      }}
      className="grid gap-2"
    >
      {body}
      <div className="flex items-center gap-2 text-xs text-muted">
        <Button size="sm" onClick={done}>
          Done
        </Button>
        <span>Escape returns to the card</span>
      </div>
    </div>
  );

  const pin = (key: string, label: string) => {
    const on = pins.keys.includes(key);
    return (
      <button
        type="button"
        onClick={() => pins.toggle(key)}
        aria-pressed={on}
        aria-label={`Pin ${label.toLowerCase()} under the scene titles`}
        title={on ? "Pinned under the scene titles" : "Pin under the scene titles"}
        className={cn("shrink-0 rounded p-1 hover:bg-paper hover:text-ink", on ? "text-accent" : "text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60")}
      >
        <Pin className="size-3.5" fill={on ? "currentColor" : "none"} aria-hidden />
      </button>
    );
  };
  const pinnedHere = rows.filter((r) => pins.keys.includes(r.key));

  const pencil = (key: string, label: string) => (
    <button
      ref={(el) => void pencils.current.set(key, el)}
      type="button"
      onClick={() => start(key)}
      aria-label={`Edit ${label.toLowerCase()}`}
      title="Edit"
      className="shrink-0 rounded p-1 text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60 hover:bg-paper hover:text-ink"
    >
      <Pencil className="size-3.5" aria-hidden />
    </button>
  );

  return (
    <section ref={setAnchor} aria-label={`Details of “${title}”`} className="grid content-start gap-4 p-4 text-sm">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-lg font-semibold">
            {title}
          </h2>
          <p className="text-xs text-muted">
            {chapter ? `${chapterTitle(novel, chapter)} · scene ${at + 1} of ${chapter.sceneIds.length}` : "Not in a chapter"}
            {/* Its length as it's written (the text's own count, from its file). */}
            {file && ` · ${words.format(countWords(file.body))} words`}
          </p>
        </div>
        {onStep && chapter && (
          <>
            <button type="button" disabled={!prev} onClick={() => prev && onStep(prev)} aria-label="Previous scene" title="Previous scene" className="rounded p-1 text-muted hover:bg-paper hover:text-ink disabled:opacity-40">
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button type="button" disabled={!next} onClick={() => next && onStep(next)} aria-label="Next scene" title="Next scene" className="rounded p-1 text-muted hover:bg-paper hover:text-ink disabled:opacity-40">
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </>
        )}
      </div>

      {editing === "synopsis" ? (
        editorOf(<TextField label="Synopsis" multiline value={synopsis} onEnter={done} onSave={(v) => set("synopsis", v)} />)
      ) : (
        <div className="group flex items-start gap-1">
          {synopsis ? (
            <p onClick={() => start("synopsis")} className="flex-1 cursor-text font-prose text-base leading-normal italic">
              {synopsis}
            </p>
          ) : (
            <p className="flex-1 text-muted">No synopsis yet.</p>
          )}
          {pencil("synopsis", "Synopsis")}
        </div>
      )}

      {editing === "status" ? (
        editorOf(<SelectField label="Status" value={status} options={STATUSES.map((s) => [s, s])} onChange={(v) => set("status", v)} />)
      ) : (
        <div className="group flex items-center gap-2">
          <div role="img" aria-label={`Status: ${status}`} className="flex gap-1" onClick={() => start("status")}>
            {STATUSES.map((s, i) => (
              <span key={s} title={s} className={cn("h-1.5 w-5 rounded-full", i <= STATUSES.indexOf(status as never) ? "bg-accent" : "bg-rule")} />
            ))}
          </div>
          <span className="flex-1 text-xs text-muted">{status}</span>
          {pencil("status", "Status")}
        </div>
      )}

      {shown.length > 0 && (
        <dl className="grid gap-0.5">
          {shown.map((r) => (
            <div key={r.key} className={cn("group -mx-1.5 flex items-baseline gap-2.5 rounded-md px-1.5 py-1.5", editing === r.key && "bg-panel")}>
              <dt className="w-24 shrink-0 text-[13px] text-muted">{r.label}</dt>
              <dd className="flex min-w-0 flex-1 items-baseline gap-1 leading-snug">
                <div className="min-w-0 flex-1" onClick={r.plain && editing !== r.key ? () => start(r.key) : undefined}>
                  {editing === r.key ? editorOf(r.edit) : r.view}
                </div>
                {editing !== r.key && pencil(r.key, r.label)}
                {editing !== r.key && pin(r.key, r.label)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {empty.length > 0 && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="flex items-center gap-1 justify-self-start rounded px-1.5 py-1 text-[13px] text-muted hover:bg-paper hover:text-ink">
              <Plus className="size-3.5" aria-hidden /> Add…
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal container={anchor}>
            <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-44 rounded-md border border-rule bg-raised p-1 shadow-lg">
              {empty.map((r) => (
                <DropdownMenu.Item key={r.key} className={MENU_ITEM} onSelect={() => start(r.key)}>
                  {r.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

      {facts.length > 0 && (
        <section aria-labelledby={`${headingId}-facts`} className="grid gap-1.5 border-t border-rule pt-3">
          <h3 id={`${headingId}-facts`} className="text-xs font-semibold tracking-wide text-muted uppercase">
            From the story
          </h3>
          <ul className="grid list-disc gap-1 pl-4">
            {facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      )}

      {pinnedHere.length > 0 && (
        <p className="text-xs text-muted">
          Pinned under each scene's title: {pinnedHere.map((r) => r.label.toLowerCase()).join(", ")}.
        </p>
      )}

      {issues && (
        <section aria-label="Open issues" className="grid gap-1.5 border-t border-rule pt-3">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Open issues</h3>
          {issues.length ? (
            <ul className="grid gap-1">
              {issues.map((i) => (
                <li key={i.number}>
                  <button type="button" onClick={() => onOpenIssue?.(i.number)} className="text-left underline-offset-2 hover:underline">
                    {i.title}
                  </button>{" "}
                  <span className="text-muted">{i.number > 0 ? `#${i.number}` : "not on GitHub yet"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">None about this scene's passages.</p>
          )}
        </section>
      )}
    </section>
  );
}

/**
 * A scene's or an event's story time, edited in place: a day of the story (and a time) or a date, and
 * how long it lasts. Each change is front matter `edits`, saved as it's made.
 */
export function StoryTimeFields({
  when,
  duration,
  edit,
  novel,
}: {
  when: { at?: string; day?: number; time?: string } | undefined;
  duration: string;
  edit: (edits: YamlEdit[]) => void;
  /** The book, for when Day 1 is: a day changed to a date offers to date Day 1 from it (#239). */
  novel?: Novel;
}) {
  const whenKind = when?.at !== undefined ? "date" : when?.day !== undefined ? "day" : "";
  const set = (key: string, value: unknown) => edit([value === undefined || value === "" ? { path: [key], remove: true } : { path: [key], value }]);
  // The day it was on before it was given a date, while Day 1 has none: that date can be that day.
  const [wasDay, setWasDay] = useState<number>();
  return (
    <Group label="Story time">
      <SelectField
        label="When it happens"
        value={whenKind}
        options={[
          ["", "Not set"],
          ["day", "A day of the story"],
          ["date", "A date"],
        ]}
        onChange={(v) => {
          setWasDay(whenKind === "day" && v === "date" ? when?.day : undefined);
          set("when", v === "day" ? { day: 1 } : v === "date" ? { at: new Date().toISOString().slice(0, 10) } : undefined);
        }}
      />
      {whenKind === "day" && (
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label="Day"
            inputMode="numeric"
            value={String(when?.day ?? "")}
            check={(v) => /^-?\d+$/.test(v) || "A whole number"}
            onSave={(v) => edit([{ path: ["when", "day"], value: Number(v) }])}
          />
          <TextField
            label="Time"
            placeholder="HH:MM"
            value={str(when?.time)}
            check={(v) => !v || TIME.test(v) || "Like 18:30"}
            onSave={(v) => edit([v ? { path: ["when", "time"], value: v } : { path: ["when", "time"], remove: true }])}
          />
        </div>
      )}
      {whenKind === "date" && (
        <TextField
          label="Date"
          placeholder="YYYY-MM-DD"
          value={str(when?.at)}
          check={(v) => AT.test(v) || "Like 1912-04-14 or 1912-04-14T23:40"}
          onSave={(v) => edit([{ path: ["when", "at"], value: v }])}
        />
      )}
      {novel && !novel.config?.calendar?.start && wasDay !== undefined && whenKind === "date" && when?.at && AT.test(when.at) && (
        <DateDayOne day={wasDay} date={when.at.slice(0, 10)} onDone={() => setWasDay(undefined)} />
      )}
      <TextField
        label="Duration"
        placeholder="PT45M"
        hint="Like PT45M (45 minutes) or P2D (two days)."
        value={duration}
        check={(v) => !v || DURATION.test(v) || "Like PT45M or P2D"}
        onSave={(v) => set("duration", v)}
      />
    </Group>
  );
}

/** "This was Day 3: make 12 Oct 2026 Day 3, so Day 1 is 10 Oct 2026?" Once, in place (#239). */
function DateDayOne({ day, date, onDone }: { day: number; date: string; onDone: () => void }) {
  const { novelId } = useParams<{ novelId: string }>();
  const setDayOne = useSetDayOne(novelId!);
  const show = useNotice((s) => s.show);
  const start = dayOneFor(date, day);
  return (
    <div role="group" aria-label="Date Day 1 from this" className="grid gap-1.5 rounded-md border border-rule bg-raised p-2 text-sm">
      <p>
        This was Day {day}. Make {readDate(date)} Day {day}, so Day 1 is {readDate(start)}? Every day of the story then has its date.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            void setDayOne(start)
              .then(() => show({ message: `Day 1 is ${readDate(start)}.` }))
              .catch((e: unknown) => show({ message: `Couldn't date Day 1: ${e instanceof Error ? e.message : String(e)}` }))
              .finally(onDone)
          }
        >
          Make it Day {day}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          No
        </Button>
      </div>
    </div>
  );
}

const words = new Intl.NumberFormat();

const STRENGTH: Record<string, string> = { "1": "faint", "2": "medium", "3": "strong" };

/** PT1H30M as "1 h 30 min", P2D as "2 days": an ISO 8601 duration read aloud, or as written if it isn't one. */
export function readableDuration(iso: string): string {
  const m = DURATION.exec(iso);
  if (!m) return iso;
  const parts: string[] = [];
  const add = (n: string | undefined, one: string, many: string) => n && parts.push(`${parseFloat(n)} ${parseFloat(n) === 1 ? one : many}`);
  add(m[1], "year", "years");
  add(m[2], "month", "months");
  add(m[3], "week", "weeks");
  add(m[4], "day", "days");
  add(m[6], "h", "h");
  add(m[7], "min", "min");
  add(m[8], "s", "s");
  return parts.join(" ") || iso;
}

/** A name in the card: opens its entry on the Entry tab. */
function EntityLink({ novel, id }: { novel: Novel; id: string }) {
  const entity = novel.entities.find((e) => e.id === id);
  if (!entity) return <span className="text-muted">{id}</span>;
  return (
    <button
      type="button"
      onClick={() => useEntryPanel.getState().open(id)}
      className="text-left text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent"
    >
      {entity.name}
    </button>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-2 border-t border-rule pt-3">
      <legend className="pr-2 text-xs font-semibold tracking-wide text-muted uppercase">{label}</legend>
      {children}
    </fieldset>
  );
}

export function Chips({ items }: { items: { id: string; label: string; remove: () => void }[] }) {
  if (!items.length) return <p className="text-muted">None yet.</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <li key={i.id} className="flex items-center gap-1 rounded-full border border-rule bg-raised py-0.5 pr-1 pl-2.5">
          {i.label}
          <RemoveButton label={i.label} onClick={i.remove} />
        </li>
      ))}
    </ul>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`Remove “${label}”`} className="rounded-full p-0.5 text-muted hover:bg-paper hover:text-ink">
      <X className="size-3.5" aria-hidden />
    </button>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[][]; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 rounded-md border border-rule bg-raised px-2">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
  inputMode?: "numeric";
  /** true if the text can be saved, or why not. */
  check?: (value: string) => true | string;
  /** After Enter has saved it (or found nothing to save). */
  onEnter?: () => void;
}

/** Text edited in place: saved when it loses focus or on Enter, if it changed and passes its check. Escape puts it back. */
function TextField({ label, value, onSave, multiline, placeholder, hint, inputMode, check, onEnter }: TextFieldProps) {
  const id = useId();
  // Escape put it back: the blur as it goes mustn't save what was typed.
  const cancelled = useRef(false);
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [problem, setProblem] = useState<string>();
  // Take the saved value when it changes from outside (another editor, a reload).
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
    setProblem(undefined);
  }
  /** Whether it's saved (or unchanged). */
  const save = (): boolean => {
    if (cancelled.current) return true;
    const v = draft.trim();
    if (v === value) {
      setProblem(undefined);
      return true;
    }
    const ok = check?.(v) ?? true;
    if (ok !== true) {
      setProblem(ok);
      return false;
    }
    setProblem(undefined);
    onSave(v);
    return true;
  };
  const common = {
    id,
    value: draft,
    placeholder,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem || hint ? `${id}-note` : undefined,
    onChange: (e: { target: { value: string } }) => {
      cancelled.current = false;
      setDraft(e.target.value);
    },
    onBlur: () => void save(),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (save()) onEnter?.();
      }
      if (e.key === "Escape") {
        cancelled.current = true;
        setDraft(value);
        setProblem(undefined);
      }
    },
    className: "w-full rounded-md border border-rule bg-raised px-2 py-1 aria-invalid:border-danger",
  };
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {multiline ? <textarea rows={3} {...common} /> : <input inputMode={inputMode} {...common} className={`${common.className} h-8`} />}
      {(problem || hint) && (
        <p id={`${id}-note`} className={problem ? "text-xs text-danger" : "text-xs text-muted"}>
          {problem ?? hint}
        </p>
      )}
    </div>
  );
}
