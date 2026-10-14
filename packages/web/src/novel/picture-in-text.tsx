import { slugify } from "@gh-writer/core";
import type { PictureAttrs } from "@gh-writer/editor";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { api } from "../api.ts";
import { megabytes, refusal, savedSize } from "../bible/pictures.ts";
import { decodeImage, renderCrop, type Rendered } from "../bible/resize.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/dialog.tsx";
import { Field } from "../ui/field.tsx";

/** What the dialog is for: a new picture to put in at `at` (from a file dropped or pasted, or one to choose), or the picture at `at` to change. */
export type PictureRequest = { kind: "add"; at: number; file?: File } | { kind: "edit"; at: number; picture: PictureAttrs };

/**
 * A picture between paragraphs (#203): the image (chosen, dropped or pasted), its description for
 * screen readers (required) and an optional caption, and what it's saved as. Resized here, in the
 * browser, and saved under images/ before it's put in the text; changing one changes only its
 * description and caption.
 */
export function PictureInTextDialog({
  novelId,
  request,
  pictureUrl,
  onDone,
  onClose,
}: {
  novelId: string;
  request: PictureRequest;
  pictureUrl: (path: string) => string | undefined;
  /** The picture to put in, or the changed one. */
  onDone: (picture: PictureAttrs) => void;
  onClose: () => void;
}) {
  const editing = request.kind === "edit" ? request.picture : undefined;
  const [file, setFile] = useState<File | undefined>(request.kind === "add" ? request.file : undefined);
  const [image, setImage] = useState<{ bitmap: ImageBitmap; url: string }>();
  const [rendered, setRendered] = useState<Rendered>();
  const [alt, setAlt] = useState(editing?.alt ?? "");
  const [caption, setCaption] = useState(editing?.caption ?? "");
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);

  // Read the image chosen, and make what will be saved.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let made: { bitmap: ImageBitmap; url: string } | undefined;
    setProblem(undefined);
    setImage(undefined);
    setRendered(undefined);
    const refused = refusal(file);
    if (refused) return setProblem(refused);
    decodeImage(file).then(
      async (bitmap) => {
        made = { bitmap, url: URL.createObjectURL(file) };
        if (cancelled) return release(made);
        setImage(made);
        const size = savedSize(bitmap);
        const result = await renderCrop(bitmap, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, size.width, size.height, { keepTransparency: file.type !== "image/jpeg" });
        if (!cancelled) setRendered(result);
      },
      (e: unknown) => !cancelled && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      if (made) release(made);
    };
  }, [file]);

  const take = (f: File | null | undefined) => {
    if (f) setFile(f);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const description = alt.trim();
    if (!description) return;
    if (editing) {
      onDone({ url: editing.url, alt: description, caption: caption.trim() || null });
      return;
    }
    if (!rendered) return;
    setSaving(true);
    setProblem(undefined);
    try {
      const { path } = await api.addPicture(novelId, rendered.blob, description);
      onDone({ url: `/${path}`, alt: description, caption: caption.trim() || null });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const size = image && savedSize(image.bitmap);
  const shown = editing ? pictureUrl(editing.url.replace(/^\//, "")) : image?.url;
  return (
    <Modal title={editing ? "Change the picture" : "Insert a picture"} onClose={onClose} className="w-[min(40rem,calc(100vw-2rem))]">
      <form
        onSubmit={(e) => void submit(e)}
        className="grid gap-4 text-sm"
        onDragOver={(e) => !editing && e.preventDefault()}
        onDrop={(e: DragEvent) => {
          if (editing) return;
          e.preventDefault();
          take(e.dataTransfer.files[0]);
        }}
        onPaste={(e: ClipboardEvent) => {
          const pasted = editing ? undefined : [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
          if (pasted) {
            e.preventDefault();
            take(pasted);
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="grid h-48 place-items-center overflow-hidden rounded-md border border-rule bg-panel">
            {shown ? (
              // The description being written is the preview's too.
              <img src={shown} alt={alt.trim() || "The picture"} className="max-h-48 max-w-full object-contain" />
            ) : (
              <p className="px-3 text-center text-muted">{file && !problem ? "Reading…" : "No picture chosen"}</p>
            )}
          </div>
          <div className="grid content-start gap-3">
            {editing ? (
              <p className="break-words">
                <code className="rounded bg-panel px-1.5 py-0.5 text-[13px]">{editing.url.replace(/^\//, "")}</code>
              </p>
            ) : (
              <>
                {file && (
                  <p className="break-words">
                    {file.name || "Pasted image"}
                    {image && (
                      <span className="text-muted">
                        {" "}
                        · {image.bitmap.width} × {image.bitmap.height} px · {megabytes(file.size)}
                      </span>
                    )}
                  </p>
                )}
                <p className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => chooser.current?.click()} autoFocus={!file}>
                    {file ? "Choose another…" : "Choose a picture…"}
                  </Button>
                  <span className="text-muted">or drop or paste one here</span>
                </p>
                <input ref={chooser} type="file" accept="image/*" hidden aria-label="Picture file" onChange={(e) => take(e.target.files?.[0])} />
                {size && (
                  <p className="text-muted">
                    Saved as <code className="rounded bg-panel px-1.5 py-0.5 text-[13px] text-ink">{`images/${alt.trim() ? slugify(alt) : "picture"}.${rendered?.png ? "png" : "jpg"}`}</code>
                    {", "}
                    {size.width === image.bitmap.width ? "at" : "resized to"} {size.width} × {size.height} px{rendered ? `, about ${megabytes(rendered.blob.size)}` : ""}.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
        <Field
          label="Description"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          required
          autoFocus={!!editing || !!file}
          hint="What the picture shows, read aloud by screen readers in place of it, and shown if it can't be."
        />
        <Field label="Caption (optional)" value={caption} onChange={(e) => setCaption(e.target.value)} hint="Shown under the picture, in the text and in the compiled book." />
        {problem && <ErrorAlert title={editing ? "Couldn't change the picture" : "Couldn't add the picture"}>{problem}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!alt.trim() || saving || (!editing && !rendered)}>
            {saving ? "Saving…" : editing ? "Save" : "Insert"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function release(made: { bitmap: ImageBitmap; url: string }) {
  made.bitmap.close();
  URL.revokeObjectURL(made.url);
}
