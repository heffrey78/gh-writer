import { Pencil, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";

/*
 * The parts a story bible profile is made of (#148), in the Scene card's design: read first, each
 * part edited in place from its pencil, empty parts behind a quiet "+ Add". The full entry page,
 * and in time the Entry tab and the mention card, are built from them.
 */

/**
 * Which part of a profile is being edited, one at a time. Starting one moves the focus into its
 * editor; finishing returns it to that part's pencil (or its "+ Add").
 */
export function useInPlace(initial?: string) {
  const [editing, setEditing] = useState<string | null>(initial ?? null);
  const triggers = useRef(new Map<string, HTMLElement | null>());
  const returnTo = useRef<string | null>(null);
  const editor = useRef<HTMLDivElement | null>(null);
  const current = useRef(editing);
  current.current = editing;
  /** How many times a part was finished: a part left after it's done (Escape, Cancel) isn't saved again. */
  const finished = useRef(0);
  useEffect(() => {
    if (editing) editor.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    else if (returnTo.current) {
      // Unless the author has gone elsewhere meanwhile (typing in the notes while a save finished): not
      // just to what holds the part (a modal takes the focus when the editor goes from under it).
      const to = triggers.current.get(returnTo.current);
      const active = document.activeElement;
      const away = active && active !== document.body && !(to && active.contains(to));
      if (!away) to?.focus();
      returnTo.current = null;
    }
  }, [editing]);
  return {
    editing,
    start: (key: string) => setEditing(key),
    /**
     * Finish the part this render was editing, unless another has been opened since (a save that
     * finishes after the author moved on doesn't close what they're in now). The focus goes back to
     * `to`'s trigger, or this part's.
     */
    done: (to?: string) => {
      if (current.current !== editing) return;
      finished.current++;
      returnTo.current = to ?? editing;
      setEditing(null);
    },
    /** Where the focus returns to when `key` is done. */
    trigger: (key: string) => (el: HTMLElement | null) => void triggers.current.set(key, el),
    editor,
    finished,
  };
}

export type InPlace = ReturnType<typeof useInPlace>;

/** A part's pencil: edits it in place. */
export function PencilButton({ place, part, label }: { place: InPlace; part: string; label: string }) {
  return (
    <button
      ref={place.trigger(part)}
      type="button"
      onClick={() => place.start(part)}
      aria-label={`Edit ${label}`}
      title="Edit"
      // Out of the way until its part is pointed at or in focus; a touch screen, with no hover, shows it faintly.
      className="shrink-0 rounded p-1 text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60 hover:bg-paper hover:text-ink"
    >
      <Pencil className="size-3.5" aria-hidden />
    </button>
  );
}

/** An empty part, quietly: "+ Add a summary". */
export function AddButton({ place, part, children }: { place: InPlace; part: string; children: ReactNode }) {
  return (
    <button ref={place.trigger(part)} type="button" onClick={() => place.start(part)} className="flex items-center gap-1 justify-self-start rounded px-1.5 py-1 text-[13px] text-muted hover:bg-paper hover:text-ink">
      <Plus className="size-3.5" aria-hidden /> {children}
    </button>
  );
}

/**
 * The parts open for editing under it, each with its save, so that a modal saves them before it closes
 * (#234). A save that fails resolves false, and says why in its part.
 */
export const OpenParts = createContext<Set<() => Promise<boolean>> | undefined>(undefined);

/** Escapes a modal left to the part they were pressed in: not taken by anything else in it. */
export const partEscapes = new WeakSet<Event>();

/** Save every part open under an OpenParts; false if one couldn't be. */
export async function saveOpenParts(parts: Set<() => Promise<boolean>>): Promise<boolean> {
  let ok = true;
  for (const save of [...parts]) ok = (await save()) && ok;
  return ok;
}

/**
 * Where a part is edited: Escape (unless something in it took the key) returns to the part, as it was.
 * Leaving it saves it (#234): the focus going elsewhere on the page, or another part opened, or the
 * modal it's in closing. `save` keeps what's typed (by default the part, saved as it changed, closes).
 */
export function EditorFrame({ place, children, className, save }: { place: InPlace; children: ReactNode; className?: string; save?: () => Promise<boolean> | boolean }) {
  const latest = useRef(save);
  latest.current = save;
  // One save at a time: leaving it and closing its modal at once save it once.
  const pending = useRef<Promise<boolean>>(undefined);
  const commit = () =>
    (pending.current ??= Promise.resolve(latest.current ? latest.current() : (place.done(), true)).finally(() => {
      pending.current = undefined;
    }));
  const parts = useContext(OpenParts);
  useEffect(() => {
    if (!parts) return;
    const entry = () => commit();
    parts.add(entry);
    return () => void parts.delete(entry);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const frame = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={(el) => {
        frame.current = el;
        place.editor.current = el;
      }}
      data-part-editor=""
      // Focus that moves within it, its lists in popovers included (React carries their focus here), stays.
      onFocus={() => clearTimeout(leaving.current)}
      onBlur={() => {
        const at = place.finished.current;
        clearTimeout(leaving.current);
        leaving.current = setTimeout(() => {
          // Finished meanwhile (Escape, Cancel, Save), or only the window left: nothing to save.
          if (place.finished.current !== at || !document.hasFocus()) return;
          if (frame.current?.isConnected && frame.current.contains(document.activeElement)) return;
          void commit();
        });
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || (e.defaultPrevented && !partEscapes.has(e.nativeEvent))) return;
        e.preventDefault();
        e.stopPropagation();
        place.done();
      }}
      className={cn("grid gap-2 rounded-md bg-panel p-2", className)}
    >
      {children}
    </div>
  );
}

/**
 * Text edited in place: Enter (or Save) saves and returns to the part, Escape (or Cancel) leaves it as
 * it was. A save that fails says why and stays open. `multiline` takes Shift+Enter for a new line.
 */
export function TextEditor({
  place,
  label,
  value,
  onSave,
  multiline,
  hint,
  placeholder,
  required,
}: {
  place: InPlace;
  label: string;
  value: string;
  /** Resolves when saved; throws to say why it couldn't be. */
  onSave: (value: string) => Promise<unknown>;
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const v = draft.trim();
    if (v === value.trim()) return (place.done(), true);
    if (required && !v) return (setProblem(`${label} can't be empty.`), false);
    setSaving(true);
    try {
      await onSave(v);
      place.done();
      return true;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };
  const common = {
    id,
    value: draft,
    placeholder,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem || hint ? `${id}-note` : undefined,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onKeyDown,
    className: "w-full rounded-md border border-rule bg-raised px-2 py-1 text-sm aria-invalid:border-danger",
  };
  return (
    <EditorFrame place={place} save={save}>
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
      {(problem || hint) && (
        <p id={`${id}-note`} className={problem ? "text-xs text-danger" : "text-xs text-muted"}>
          {problem ?? hint}
        </p>
      )}
      <EditorButtons onSave={() => void save()} onCancel={() => place.done()} saving={saving} hint={multiline ? "Enter saves · Shift+Enter for a new line · Esc cancels" : "Enter saves · Esc cancels"} />
    </EditorFrame>
  );
}

export function EditorButtons({ onSave, onCancel, saving, hint }: { onSave?: () => void; onCancel: () => void; saving?: boolean; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      {onSave && (
        <Button size="sm" variant="primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      )}
      <Button size="sm" onClick={onCancel}>
        {onSave ? "Cancel" : "Done"}
      </Button>
      {hint && <span>{hint}</span>}
    </div>
  );
}

/** A profile's section: a small capitals heading and what's under it. */
export function ProfileSection({ title, children, className, action }: { title: string; children: ReactNode; className?: string; action?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("grid gap-2 border-t border-rule pt-4", className)}>
      <div className="flex items-center gap-2">
        <h2 id={id} className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** An entry's summary as the lead of a profile, its tab or its card: serif, larger the more room there is. */
export function Lead({ children, size = "page" }: { children: ReactNode; size?: "page" | "tab" | "card" }) {
  return <p className={cn("font-prose leading-normal", size === "page" ? "text-lg" : size === "tab" ? "text-base" : "text-[15px]")}>{children}</p>;
}

/** An entry's fields as rows of name and value; `value` can put an editor (or pencil) in a row. */
export function FieldRows({ fields, value, compact }: { fields: [string, string | number | boolean][]; value?: (key: string, v: string | number | boolean, i: number) => ReactNode; compact?: boolean }) {
  return (
    <dl aria-label="Fields" className="grid gap-0.5">
      {fields.map(([key, v], i) => (
        <div key={key} className={cn("group -mx-1.5 flex items-baseline gap-2.5 rounded-md px-1.5", compact ? "py-0.5" : "py-1")}>
          <dt className={cn("shrink-0 text-[13px] text-muted capitalize", compact ? "w-24" : "w-32")}>{key.replace(/_/g, " ")}</dt>
          <dd className="flex min-w-0 flex-1 items-baseline gap-1">{value ? value(key, v, i) : <span className="flex-1">{readField(v)}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export const readField = (v: string | number | boolean) => (typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
