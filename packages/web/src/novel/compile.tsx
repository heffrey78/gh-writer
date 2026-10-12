import type { Novel } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, keys } from "../api.ts";
import { Picture, usePictureFlow, usePictureUrl } from "../bible/picture.tsx";
import { pictureAlt, SHAPES } from "../bible/pictures.ts";
import { Button } from "../ui/button.tsx";
import { Confirm } from "../ui/confirm.tsx";
import { Modal } from "../ui/dialog.tsx";
import { chapterTitle } from "./navigation.tsx";
import { useNotice } from "./notice.tsx";
import type { Workspace } from "./workspace.ts";

const FORMATS = [
  { key: "docx", label: "Word (DOCX)", hint: "standard manuscript format, for agents and editors" },
  { key: "epub", label: "E-book (EPUB)", hint: "for readers and e-readers" },
  { key: "pdf", label: "PDF", hint: "laid out like the Word file" },
] as const;
type Format = (typeof FORMATS)[number]["key"];

/** Hand a file to the browser to save. */
function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Compile the manuscript (or some of its chapters) with a preset, to Word, EPUB and PDF: the files download. */
export function CompileDialog({ novelId, novel, workspace, onClose }: { novelId: string; novel: Novel; workspace: Workspace; onClose: () => void }) {
  const show = useNotice((n) => n.show);
  const presets = Object.keys(novel.compile?.presets ?? { manuscript: {} });
  const [preset, setPreset] = useState(presets[0]!);
  const [whole, setWhole] = useState(true);
  const [from, setFrom] = useState(novel.chapters[0]?.id ?? "");
  const [to, setTo] = useState(novel.chapters.at(-1)?.id ?? "");
  const [formats, setFormats] = useState<Set<Format>>(new Set(["docx", "epub", "pdf"]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = { preset: useId(), from: useId(), to: useId() };
  const reversed = !whole && novel.chapters.findIndex((c) => c.id === from) > novel.chapters.findIndex((c) => c.id === to);

  const compile = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // What's typed is saved first: the files are what's on disk.
      await workspace.autosave.flush();
      const names: string[] = [];
      const missing = new Set<string>();
      let coverProblem: string | undefined;
      for (const { key } of FORMATS.filter((f) => formats.has(f.key))) {
        const file = await api.compile(novelId, { format: key, ...(presets.length > 1 ? { preset } : {}), ...(whole ? {} : { from, to }) });
        save(file.blob, file.filename);
        names.push(file.filename);
        file.missing.forEach((c) => missing.add(c));
        coverProblem ??= file.coverProblem;
      }
      onClose();
      show({ message: `Compiled ${names.join(", ")}.${missing.size ? ` The PDF's type has no letter for ${[...missing].join(" ")}: it shows boxes there.` : ""}${coverProblem ? ` ${coverProblem}` : ""}` });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Compile the manuscript" onClose={onClose}>
      <form
        className="grid gap-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (formats.size && !reversed && !busy) void compile();
        }}
      >
        {presets.length > 1 && (
          <div className="grid gap-1.5">
            <label htmlFor={ids.preset} className="font-medium">
              Preset
            </label>
            <select id={ids.preset} value={preset} onChange={(e) => setPreset(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2">
              {presets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        )}
        <fieldset className="grid gap-2">
          <legend className="mb-1 font-medium">What to compile</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="range" checked={whole} onChange={() => setWhole(true)} /> The whole book
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="range" checked={!whole} onChange={() => setWhole(false)} /> Some chapters
          </label>
          {!whole && (
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <label htmlFor={ids.from}>From</label>
              <select id={ids.from} value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2">
                {novel.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {chapterTitle(novel, c)}
                  </option>
                ))}
              </select>
              <label htmlFor={ids.to}>to</label>
              <select id={ids.to} value={to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2">
                {novel.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {chapterTitle(novel, c)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {reversed && (
            <p role="alert" className="text-danger">
              The range ends before it starts.
            </p>
          )}
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-1 font-medium">Formats</legend>
          {FORMATS.map((f) => (
            <label key={f.key} className="flex items-baseline gap-2">
              <input
                type="checkbox"
                checked={formats.has(f.key)}
                onChange={(e) => {
                  const next = new Set(formats);
                  if (e.target.checked) next.add(f.key);
                  else next.delete(f.key);
                  setFormats(next);
                }}
              />
              <span>
                {f.label} <span className="text-muted">— {f.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <CoverRow novelId={novelId} novel={novel} />
        <p className="text-muted">What's saved is compiled; anything typed is saved first. Presets live in compile.yaml.</p>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!formats.size || reversed || busy}>
            {busy ? "Compiling…" : "Compile"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The book's cover (#168): the one in novel.yaml, its file and size, Change… and Remove; or Add a
 * cover…. It goes on the EPUB and the PDF, not the Word manuscript.
 */
function CoverRow({ novelId, novel }: { novelId: string; novel: Novel }) {
  const queryClient = useQueryClient();
  const path = novel.config?.cover;
  const url = usePictureUrl(novelId, path);
  const title = novel.config?.title ?? "the book";
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [removing, setRemoving] = useState(false);
  const shown = () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.novel(novelId) }), queryClient.invalidateQueries({ queryKey: keys.library })]);
  const flow = usePictureFlow({
    name: title,
    shape: SHAPES.cover,
    onSave: async (picture) => {
      await api.setCover(novelId, picture);
      await shown();
    },
  });
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h3 id={headingId} className="font-medium">
        Cover
      </h3>
      <div className="flex items-start gap-4">
        {url ? (
          <Picture src={url} alt={pictureAlt(SHAPES.cover, title)} onSize={setSize} className="aspect-[5/8] w-[75px] shrink-0 rounded-sm shadow" />
        ) : (
          <span className="grid aspect-[5/8] w-[75px] shrink-0 place-items-center rounded-sm border border-dashed border-rule text-center text-xs text-muted">{path ? "Not shown" : "No cover"}</span>
        )}
        <div className="grid min-w-0 gap-1.5">
          {path ? (
            <>
              <code className="justify-self-start rounded bg-panel px-1.5 py-0.5 text-[13px] break-all">{path}</code>
              {size && (
                <span className="text-muted">
                  {size.width} × {size.height} px
                </span>
              )}
              <span className="flex flex-wrap gap-2">
                <Button size="sm" onClick={flow.choose}>
                  Change…
                </Button>
                <Button size="sm" onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              </span>
            </>
          ) : (
            <span>
              <Button size="sm" onClick={flow.choose}>
                Add a cover…
              </Button>
            </span>
          )}
        </div>
      </div>
      <p className="text-muted">On the EPUB's cover and the PDF's first page. Word manuscripts go out without one, as agents expect.</p>
      {flow.problem && (
        <p role="alert" className="text-danger">
          {flow.problem}
        </p>
      )}
      {flow.element}
      <Confirm
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the book's cover?"
        description="E-books and PDFs go out without one, and the shelf shows a generated cover again. Its file is deleted from images/; the novel's history keeps it."
        action="Remove"
        danger
        onConfirm={() => void api.removeCover(novelId).then(shown, (e: unknown) => flow.setProblem(e instanceof Error ? e.message : String(e)))}
      />
    </section>
  );
}
