import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle } from "lucide-react";
import { create } from "zustand";
import { api, keys } from "./api.ts";
import { Markdown } from "./issues/markdown.tsx";
import { Modal } from "./ui/dialog.tsx";

/** Whether the About dialog is open: from the ⋯ menu, the palette, or the update button. */
export const useAbout = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** The app's version and what it runs on, and a newer release: asked once a session (the server checks GitHub daily). */
export function useAppInfo() {
  return useQuery({ queryKey: keys.app, queryFn: api.app, staleTime: Infinity, retry: false });
}

/** In the top bar while a newer release is out (the desktop app only): opens About, with the notes and the download. */
export function UpdateButton() {
  const update = useAppInfo().data?.update;
  if (!update) return null;
  return (
    <button
      type="button"
      onClick={() => useAbout.getState().set(true)}
      className="flex items-center gap-1.5 rounded-md border border-rule px-2 py-1 text-sm text-ink hover:bg-paper"
    >
      <ArrowUpCircle className="size-4 text-accent" aria-hidden />
      gh-writer {update.version} is out
    </button>
  );
}

/**
 * About gh-writer: its version, the Node and git it runs on, a newer release's notes and download,
 * and, in the desktop app, the licences of what it ships (git's with where its source is: GPL-2.0).
 */
export function AboutDialog() {
  const { open, set } = useAbout();
  const info = useAppInfo().data;
  const licenses = useQuery({ queryKey: keys.licenses, queryFn: api.licenses, enabled: open && !!info?.desktop, staleTime: Infinity });
  if (!open) return null;
  return (
    <Modal title="About gh-writer" onClose={() => set(false)} className="max-w-2xl">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Version</dt>
        <dd>{info?.version ?? "Run from its source (gh-writer serve)"}</dd>
        <dt className="text-muted">Node.js</dt>
        <dd>{info?.node ?? "…"}</dd>
        <dt className="text-muted">git</dt>
        <dd>{info ? `${info.git.version ?? "not found"}${info.git.bundled ? " (comes with gh-writer)" : " (this computer's)"}` : "…"}</dd>
      </dl>

      {info?.update && (
        <section aria-labelledby="about-update" className="mt-5 rounded-md border border-rule p-3">
          <h3 id="about-update" className="font-semibold">
            gh-writer {info.update.version} is out
          </h3>
          {info.update.notes && <Markdown text={info.update.notes} className="mt-2 max-h-60 overflow-auto text-sm" />}
          <p className="mt-2 text-sm">
            <a href={info.update.url} target="_blank" rel="noreferrer" className="text-accent underline">
              Download it from GitHub
            </a>
            , then install it over this one. Your novels and settings stay as they are.
          </p>
        </section>
      )}

      {info?.desktop && (
        <section aria-labelledby="about-licenses" className="mt-5">
          <h3 id="about-licenses" className="font-semibold">
            Licences
          </h3>
          <p className="mt-1 text-sm text-muted">gh-writer is free software under the MIT licence. It comes with Node.js and git, each under its own licence.</p>
          {licenses.data?.map((l) => (
            <details key={l.name} className="mt-2 text-sm">
              <summary className="cursor-pointer">{l.name.replace(/\.(txt|md)$/, "")}</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-paper p-2 text-xs whitespace-pre-wrap">{l.text}</pre>
            </details>
          ))}
        </section>
      )}
    </Modal>
  );
}
