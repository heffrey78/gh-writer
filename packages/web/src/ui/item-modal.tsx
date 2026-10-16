import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useContext, useEffect, useMemo, useRef, useState, type FocusEvent, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { OpenParts, partEscapes, saveOpenParts } from "../bible/profile.tsx";
import { ErrorAlert } from "./alert.tsx";

/*
 * A note, an off-page event or a story bible entry opens as a modal over its gallery (#233), like a
 * card picked up off a board: its whole profile, edited in place, everything saved as it's made.
 * ✕, Escape or a click outside closes it, saving the part that's open first.
 */

/** Where an item's modal was opened from: its gallery (so closing goes back there, as it was). */
export type OverState = { fromGallery?: boolean; focusProse?: boolean } | null;

/**
 * Close an item's modal: back to the gallery it was opened from (as it was: its search, its scroll),
 * or, opened from elsewhere (the palette, a link), on to its gallery.
 */
export function useCloseTo(gallery: string) {
  const navigate = useNavigate();
  const state = useLocation().state as OverState;
  return () => void (state?.fromGallery ? navigate(-1) : navigate(gallery));
}

/** Escape means something else here: an open part, a list of suggestions or a menu takes it. */
function escapeTaken(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-part-editor], [role=menu], [role=listbox]")) return true;
  // The text box with its mention suggestions open.
  return target.hasAttribute("aria-haspopup") && target.hasAttribute("aria-controls") && (target as HTMLElement).isContentEditable;
}

/** The modal: a large sheet (the whole window when it's narrow), titled for screen readers. */
export function ItemModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const parts = useMemo(() => new Set<() => Promise<boolean>>(), []);
  const content = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  // Where the focus was when it opened (the card in the gallery): it goes back there when it closes.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      // A part that couldn't be saved stays open, saying why.
      if (await saveOpenParts(parts)) onClose();
    } finally {
      closing.current = false;
    }
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && void close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          ref={content}
          aria-describedby={undefined}
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            // Into what asks for it (a new item's title), or the sheet itself, so a first Tab starts at the top.
            e.preventDefault();
            (content.current?.querySelector<HTMLElement>("[data-autofocus]") ?? content.current)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener?.isConnected) opener.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (!escapeTaken(e.target)) return;
            e.preventDefault();
            partEscapes.add(e);
          }}
          className="fixed inset-0 z-50 overflow-y-auto bg-raised text-ink outline-none sm:inset-x-auto sm:top-[4vh] sm:bottom-auto sm:left-1/2 sm:max-h-[92vh] sm:w-[min(52rem,calc(100vw-3rem))] sm:-translate-x-1/2 sm:rounded-lg sm:border sm:border-rule sm:shadow-xl"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div className="px-6 pt-5 pb-8 sm:px-8">
            <OpenParts.Provider value={parts}>{children}</OpenParts.Provider>
          </div>
          {/* Last in the tab order, first in the corner. */}
          <Dialog.Close asChild>
            <button type="button" aria-label="Close" title="Close (Esc)" className="absolute top-3 right-3 rounded-md p-1.5 text-muted hover:bg-panel hover:text-ink">
              <X className="size-5" aria-hidden />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A new item, as just its title (or name) for now: made once it has one and the writer moves on
 * (Enter, or the focus leaving it), or the modal closes. Without one, closing makes nothing. `make`
 * resolves once made, and the item's profile takes the field's place.
 */
export function NewItem({ label, placeholder, make, children, heading }: { label: string; placeholder?: string; heading: string; make: (title: string) => Promise<unknown>; children?: ReactNode }) {
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState<string>();
  // "New location": what it is, for the hint.
  const noun = heading.replace(/^New /, "");
  const latest = useRef({ title, make });
  latest.current = { title, make };
  const making = useRef<Promise<boolean>>(undefined);
  // One making at a time, whichever asks first (Enter, moving on, closing); a failed one can be tried again.
  const once = useRef(() =>
    (making.current ??= (async () => {
      const t = latest.current.title.trim();
      if (!t) return ((making.current = undefined), true);
      try {
        await latest.current.make(t);
        return true;
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
        making.current = undefined;
        return false;
      }
    })()),
  ).current;
  // Closing the modal makes it too (or nothing, untitled).
  const parts = useContext(OpenParts);
  useEffect(() => {
    parts?.add(once);
    return () => void parts?.delete(once);
  }, [parts, once]);
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void once();
      }}
      onBlur={(e: FocusEvent) => {
        // Moving on: out of the form, not to something in it, nor only out of the window.
        if (e.currentTarget.contains(e.relatedTarget as Node | null) || !document.hasFocus()) return;
        if (latest.current.title.trim()) void once();
      }}
      className="grid gap-3"
    >
      <p className="text-sm text-muted">{heading}</p>
      {children}
      <input
        data-autofocus
        aria-label={label}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        aria-invalid={problem ? true : undefined}
        className="ghw-title-field w-full border-b-2 border-rule bg-transparent pb-1 text-2xl font-semibold placeholder:font-normal placeholder:text-muted focus:border-accent"
      />
      <p className="text-xs text-muted">{label === "Name" ? `Name the ${noun} and press Enter` : `Give the ${noun} a title and press Enter`}</p>
      {problem && <ErrorAlert title="Couldn't add it">{problem}</ErrorAlert>}
    </form>
  );
}
