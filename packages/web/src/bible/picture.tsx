import { imageUrl } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { useQuery } from "@tanstack/react-query";
import { ImagePlus, Pencil } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useId, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { api, keys } from "../api.ts";
import { Confirm } from "../ui/confirm.tsx";
import { cn } from "../ui/cn.ts";
import { PictureDialog, type PictureSource } from "./picture-dialog.tsx";
import { objectPosition, pictureAlt, refusal, type PictureShape } from "./pictures.ts";

/** The version of each picture the model shows (from the server's `images`), for its URL. */
export function useImageVersions(novelId: string): Record<string, string> {
  // The novel's own query, already loaded by the novel's page: only read here, never fetched again.
  return useQuery({ queryKey: keys.novel(novelId), queryFn: () => api.novel<Novel>(novelId), enabled: false, select: (d) => d.images }).data ?? {};
}

/** Where a picture is shown from, or undefined when it can't be (none, or kept outside images/). */
export function usePictureUrl(novelId: string, path: string | undefined): string | undefined {
  const versions = useImageVersions(novelId);
  return path ? imageUrl(novelId, path, versions[path]) : undefined;
}

/**
 * A picture at the size it's shown, centred on its focal point; loaded lazily, at its own pace. Its
 * alternative text names what it shows ("Portrait of Ada Varn"), unless it sits beside that name and
 * says nothing more (`decorative`).
 */
export function Picture({ src, alt, focus, className, decorative, onSize }: { src: string; alt: string; focus?: [number, number] | undefined; className?: string; decorative?: boolean; onSize?: (size: { width: number; height: number }) => void }) {
  return (
    <img
      src={src}
      alt={decorative ? "" : alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn("object-cover", className)}
      style={{ objectPosition: objectPosition(focus) }}
      {...(onSize ? { onLoad: (e: { currentTarget: HTMLImageElement }) => onSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }) } : {})}
    />
  );
}

/** "portrait", "picture" or "cover": what the slot calls its picture. */
export function pictureWord(shape: PictureShape): string {
  return shape.key === "cover" ? "cover" : shape.key === "wide" ? "picture" : "portrait";
}

/**
 * Giving a picture, wherever it's given (a profile, the shelf, Compile): `take` a file (refused at
 * once if it's too large or not an image), `choose` one, or `recrop` the saved one, then frame it in
 * the dialog. `element` holds the file chooser and the dialog; render it once.
 */
export function usePictureFlow({ name, shape, onSave }: { name: string; shape: PictureShape; onSave: (picture: Blob, focus: [number, number] | undefined) => Promise<unknown> }): {
  take: (file: File | null | undefined) => void;
  choose: () => void;
  recrop: (url: string, path: string, focus: [number, number] | undefined) => Promise<void>;
  problem: string | undefined;
  setProblem: (problem: string | undefined) => void;
  element: ReactNode;
} {
  const [source, setSource] = useState<{ source: PictureSource; focus?: [number, number] | undefined } | null>(null);
  const [problem, setProblem] = useState<string>();
  const chooser = useRef<HTMLInputElement>(null);
  const word = pictureWord(shape);
  const take = (file: File | null | undefined) => {
    if (!file) return;
    // Refused at once, before anything is read.
    const refused = refusal(file);
    setProblem(refused);
    if (!refused) setSource({ source: { blob: file, name: file.name || "Pasted image" } });
  };
  const recrop = async (url: string, path: string, focus: [number, number] | undefined) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't open the ${word}: HTTP ${res.status}`);
      setSource({ source: { blob: await res.blob(), name: path.split("/").at(-1)! }, focus });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };
  const element = (
    <>
      <input ref={chooser} type="file" accept="image/*" hidden onChange={(e) => (take(e.target.files?.[0]), (e.target.value = ""))} />
      {source && (
        <PictureDialog
          title={pictureAlt(shape, name)}
          name={name}
          shape={shape}
          source={source.source}
          focus={source.focus}
          saveLabel={`Use this ${word}`}
          onSave={onSave}
          onClose={() => setSource(null)}
        />
      )}
    </>
  );
  return { take, choose: () => chooser.current?.click(), recrop, problem, setProblem, element };
}

/** Drop and paste handlers that hand an image to `take`; `over` while a file is dragged over. */
export function usePictureDrop(take: (file: File | null | undefined) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files[0]);
      },
      onPaste: (e: ClipboardEvent) => {
        const pasted = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
        if (!pasted) return;
        e.preventDefault();
        take(pasted);
      },
    },
  };
}

/**
 * Where a profile shows its picture, and where one is given: drop a file on it, paste one while it
 * has the focus, or choose one; then crop it. Once there, its pencil changes, recrops or removes it.
 */
export function PictureSlot({
  novelId,
  name,
  shape,
  image,
  focus,
  onSave,
  onRemove,
  className,
}: {
  novelId: string;
  /** What it's a picture of: the entry's name, or the book's title. */
  name: string;
  shape: PictureShape;
  image: string | undefined;
  focus?: [number, number] | undefined;
  onSave: (picture: Blob, focus: [number, number] | undefined) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  className?: string;
}) {
  const url = usePictureUrl(novelId, image);
  const [removing, setRemoving] = useState(false);
  const hint = useId();
  const word = pictureWord(shape);
  const alt = pictureAlt(shape, name);
  const { take, choose, recrop, problem, setProblem, element } = usePictureFlow({ name, shape, onSave });
  const { over, handlers: drop } = usePictureDrop(take);
  const box = cn("relative shrink-0 overflow-hidden rounded-lg", shape.key === "wide" ? "aspect-video w-48" : "aspect-[4/5] w-32", className);

  return (
    <div className="grid justify-items-start gap-1">
      {image ? (
        <div {...drop} className={cn(box, "group border border-rule bg-panel", over && "ring-2 ring-accent")}>
          {url ? (
            <Picture src={url} alt={alt} focus={focus} className="size-full" />
          ) : (
            // A picture kept elsewhere in the repository: named, but not shown.
            <span className="grid size-full place-items-center p-2 text-center text-[11px] break-all text-muted">{image.split("/").at(-1)}</span>
          )}
          <PictureMenu word={word} onChange={choose} {...(url ? { onRecrop: () => void recrop(url, image, focus) } : {})} onRemove={() => setRemoving(true)}>
            <button
              type="button"
              aria-label={`Change the ${word}`}
              title={`Change the ${word}`}
              className="absolute top-1 right-1 rounded-md bg-raised/90 p-1.5 text-ink shadow-sm hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <Pencil className="size-3.5" aria-hidden />
            </button>
          </PictureMenu>
          {over && <DropHint word={word} />}
        </div>
      ) : (
        <button
          type="button"
          {...drop}
          onClick={choose}
          aria-label={`Add a ${word}`}
          aria-describedby={hint}
          className={cn(box, "grid place-items-center content-center gap-1 border border-dashed border-rule bg-panel p-2 text-center text-[12px] text-muted hover:border-accent hover:text-ink", over && "border-2 border-accent bg-accent-soft text-ink")}
        >
          <ImagePlus className="size-5" aria-hidden />
          <span>{over ? `Drop to add a ${word}` : `Add a ${word}`}</span>
          <span id={hint} className={cn("text-[11px]", over && "sr-only")}>
            Drop, paste or choose
          </span>
        </button>
      )}
      {element}
      {problem && (
        <p role="alert" className="max-w-64 text-xs text-danger">
          {problem}
        </p>
      )}
      <Confirm
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove the ${word}?`}
        description={image?.startsWith("images/") ? `${alt} is taken away, and its file deleted from images/. The novel's history keeps it.` : `${alt} is taken away; its file stays where it is.`}
        action="Remove"
        danger
        onConfirm={() => void onRemove().catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))}
      />
    </div>
  );
}

/** A picture's menu, on `children` (its trigger): Change…, Recrop… (when it can be shown) and Remove…. */
export function PictureMenu({ word, onChange, onRecrop, onRemove, children }: { word: string; onChange: () => void; onRecrop?: () => void; onRemove: () => void; children: ReactNode }) {
  const item = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft";
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" aria-label={`The ${word}`} className="z-50 grid w-48 rounded-md border border-rule bg-raised p-1 text-ink shadow-lg">
          <DropdownMenu.Item className={item} onSelect={onChange}>
            Change…
          </DropdownMenu.Item>
          {onRecrop && (
            <DropdownMenu.Item className={item} onSelect={onRecrop}>
              Recrop…
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className={item} onSelect={onRemove}>
            Remove…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function DropHint({ word }: { word: string }) {
  return <span className="absolute inset-0 grid place-items-center bg-accent/80 p-2 text-center text-[12px] font-medium text-paper">Drop to replace the {word}</span>;
}
