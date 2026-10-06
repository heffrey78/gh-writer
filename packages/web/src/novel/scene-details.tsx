import { readFrontMatter, type Novel, type YamlEdit } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { X } from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { create, useStore } from "zustand";
import { Picker, type PickerItem } from "../ui/picker.tsx";
import { useNotice } from "./notice.tsx";
import { STATUSES } from "./outline.tsx";
import type { Workspace } from "./workspace.ts";

const KEY = "ghw.sceneDetails";

/** Whether the scene details panel is open: remembered in this browser. */
export const useSceneDetails = create<{ open: boolean; toggle: () => void }>((set, get) => ({
  open: (() => {
    try {
      return localStorage.getItem(KEY) === "open";
    } catch {
      return false;
    }
  })(),
  toggle: () => {
    const open = !get().open;
    try {
      localStorage.setItem(KEY, open ? "open" : "closed");
    } catch {
      // Not remembered; it still opens.
    }
    set({ open });
  },
}));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const AT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

type Ref = string | { id: string; [key: string]: unknown };
const refId = (r: Ref) => (typeof r === "string" ? r : r.id);

/**
 * A scene's planning details beside its text: synopsis, status, point of view, the people, places,
 * plotlines and themes in it, when it happens, how long it takes, and tags. Each change rewrites only
 * the front-matter lines it touches, through the workspace (so it autosaves and merges like typing).
 */
export function SceneDetails({ novel, workspace, path, title }: { novel: Novel; workspace: Workspace; path: string; title: string }) {
  const file = useStore(workspace.store, (s) => s.files[path]);
  const show = useNotice((s) => s.show);
  const toggle = useSceneDetails((s) => s.toggle);
  const fm = useMemo(() => (file ? (readFrontMatter(joinSceneFile(file)) ?? {}) : {}), [file?.frontMatter]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (!file) return null;
  const when = fm.when && typeof fm.when === "object" ? (fm.when as { at?: string; day?: number; time?: string }) : undefined;
  const whenKind = when?.at !== undefined ? "date" : when?.day !== undefined ? "day" : "";
  const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];

  return (
    <aside aria-labelledby="scene-details-heading" className="grid content-start gap-4 border-rule bg-panel p-4 text-sm lg:overflow-y-auto lg:border-l">
      <div className="flex items-start justify-between gap-2">
        <h2 id="scene-details-heading" className="font-semibold">
          Details of “{title}”
        </h2>
        <button type="button" onClick={toggle} aria-label="Close scene details" className="rounded p-1 text-muted hover:bg-paper">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <TextField label="Synopsis" multiline value={str(fm.synopsis)} onSave={(v) => set("synopsis", v)} />
      <SelectField label="Status" value={str(fm.status) || "idea"} options={STATUSES.map((s) => [s, s])} onChange={(v) => set("status", v)} />
      <Picker
        label="Point of view"
        items={ofType("character")}
        value={str(fm.pov) || undefined}
        onChange={(v) => set("pov", v)}
        placeholder="No point of view"
        allowNone
      />

      {(
        [
          ["characters", "Characters", "character", "Add a character…"],
          ["locations", "Locations", "location", "Add a location…"],
        ] as const
      ).map(([key, label, type, placeholder]) => {
        const chosen = list(key).map(refId);
        return (
          <Group key={key} label={label}>
            <Chips
              items={chosen.map((id, i) => ({
                id,
                label: name(id),
                remove: () => removeAt(key, i),
              }))}
            />
            <Picker
              label={`Add to ${label.toLowerCase()}`}
              items={ofType(type).filter((i) => !chosen.includes(i.value))}
              value={undefined}
              onChange={(v) => v && append(key, v)}
              placeholder={placeholder}
            />
          </Group>
        );
      })}

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
        <Picker
          label="Add to plotlines"
          items={ofType("plotline").filter((i) => !list("plotlines").map(refId).includes(i.value))}
          value={undefined}
          onChange={(v) => v && append("plotlines", v)}
          placeholder="Add a plotline…"
        />
      </Group>

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
        <Picker
          label="Add to themes"
          items={ofType("theme").filter((i) => !list("themes").map(refId).includes(i.value))}
          value={undefined}
          onChange={(v) => v && append("themes", v)}
          placeholder="Add a theme…"
        />
      </Group>

      <Group label="Story time">
        <SelectField
          label="When it happens"
          value={whenKind}
          options={[
            ["", "Not set"],
            ["day", "A day of the story"],
            ["date", "A date"],
          ]}
          onChange={(v) => set("when", v === "day" ? { day: 1 } : v === "date" ? { at: new Date().toISOString().slice(0, 10) } : undefined)}
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
        <TextField
          label="Duration"
          placeholder="PT45M"
          hint="Like PT45M (45 minutes) or P2D (two days)."
          value={str(fm.duration)}
          check={(v) => !v || DURATION.test(v) || "Like PT45M or P2D"}
          onSave={(v) => set("duration", v)}
        />
      </Group>

      <TextField
        label="Tags"
        hint="Separated by commas."
        value={tags.join(", ")}
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
    </aside>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-2 border-t border-rule pt-3">
      <legend className="pr-2 text-xs font-semibold tracking-wide text-muted uppercase">{label}</legend>
      {children}
    </fieldset>
  );
}

function Chips({ items }: { items: { id: string; label: string; remove: () => void }[] }) {
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
}

/** Text edited in place: saved when it loses focus or on Enter, if it changed and passes its check. Escape puts it back. */
function TextField({ label, value, onSave, multiline, placeholder, hint, inputMode, check }: TextFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [problem, setProblem] = useState<string>();
  // Take the saved value when it changes from outside (another editor, a reload).
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
    setProblem(undefined);
  }
  const save = () => {
    const v = draft.trim();
    if (v === value) return setProblem(undefined);
    const ok = check?.(v) ?? true;
    if (ok !== true) return setProblem(ok);
    setProblem(undefined);
    onSave(v);
  };
  const common = {
    id,
    value: draft,
    placeholder,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem || hint ? `${id}-note` : undefined,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: save,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
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
