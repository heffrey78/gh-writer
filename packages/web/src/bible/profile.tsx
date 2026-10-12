import { Pencil, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  useEffect(() => {
    if (editing) editor.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    else if (returnTo.current) {
      // Unless the author has gone elsewhere meanwhile (typing in the notes while a save finished).
      const away = document.activeElement && document.activeElement !== document.body;
      if (!away) triggers.current.get(returnTo.current)?.focus();
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
      returnTo.current = to ?? editing;
      setEditing(null);
    },
    /** Where the focus returns to when `key` is done. */
    trigger: (key: string) => (el: HTMLElement | null) => void triggers.current.set(key, el),
    editor,
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
      className="shrink-0 rounded p-1 text-muted opacity-60 group-hover:opacity-100 hover:bg-paper hover:text-ink focus-visible:opacity-100"
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

/** Where a part is edited: Escape (unless something in it took the key) returns to the part. */
export function EditorFrame({ place, children, className }: { place: InPlace; children: ReactNode; className?: string }) {
  return (
    <div
      ref={place.editor}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
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
    if (v === value.trim()) return place.done();
    if (required && !v) return setProblem(`${label} can't be empty.`);
    setSaving(true);
    try {
      await onSave(v);
      place.done();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
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
    <EditorFrame place={place}>
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
export function ProfileSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("grid gap-2 border-t border-rule pt-4", className)}>
      <h2 id={id} className="text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
