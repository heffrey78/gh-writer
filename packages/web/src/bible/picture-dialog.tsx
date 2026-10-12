import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/dialog.tsx";
import { cropScale, expectedPath, initialCrop, megabytes, MIN_SCALE, moveCrop, moveFocus, outputSize, refusal, scaledCrop, type Crop, type PictureShape } from "./pictures.ts";
import { decodeImage, renderCrop, type Rendered } from "./resize.ts";

/** A file to make a picture from: what was dropped, pasted or chosen, or the saved picture to recrop. */
export interface PictureSource {
  blob: Blob;
  name: string;
}

/** The largest the image is shown at while it's cropped. */
const STAGE = { width: 340, height: 400 };

/**
 * Making a picture (#168): the image chosen (its name, pixel size and file size), a crop frame at
 * the slot's shape, dragged or moved with the arrow keys (+ and − resize it, as does Size), a focal
 * point for thumbnails, and what will be saved: where, at what size, about how large. Another image
 * can be chosen, dropped or pasted in. Cancel saves nothing; the result is resized here, in the
 * browser, and only it is sent.
 */
export function PictureDialog({
  title,
  name,
  shape,
  source,
  focus: initialFocus,
  saveLabel,
  onSave,
  onClose,
}: {
  title: string;
  /** What it's a picture of: names the file it's saved as. */
  name: string;
  shape: PictureShape;
  source: PictureSource;
  focus?: [number, number] | undefined;
  saveLabel: string;
  onSave: (picture: Blob, focus: [number, number] | undefined) => Promise<unknown>;
  onClose: () => void;
}) {
  const [file, setFile] = useState(source);
  const [image, setImage] = useState<{ bitmap: ImageBitmap; url: string }>();
  const [crop, setCrop] = useState<Crop>();
  const [focus, setFocus] = useState<[number, number]>(initialFocus ?? [0.5, 0.5]);
  const [rendered, setRendered] = useState<{ crop: Crop; result: Rendered }>();
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const chooser = useRef<HTMLInputElement>(null);
  const ids = { size: useId(), help: useId(), focusHelp: useId() };
  const hasFocus = shape.key !== "cover";
  // A cover goes on paper: no transparency. A portrait from a PNG may keep it.
  const keepTransparency = shape.key !== "cover" && file.blob.type !== "image/jpeg";

  // Read the image chosen; a new one starts a new crop.
  useEffect(() => {
    let cancelled = false;
    setProblem(undefined);
    const refused = refusal({ size: file.blob.size, type: file.blob.type, name: file.name });
    if (refused) return setProblem(refused);
    let made: { bitmap: ImageBitmap; url: string } | undefined;
    decodeImage(file.blob).then(
      (bitmap) => {
        made = { bitmap, url: URL.createObjectURL(file.blob) };
        if (cancelled) return release(made);
        setImage(made);
        setCrop(initialCrop(bitmap, shape.aspect));
        setRendered(undefined);
      },
      (e: unknown) => !cancelled && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      if (made) release(made);
    };
  }, [file, shape.aspect]);

  // What it will be saved as, worked out shortly after the crop stops changing: its real size.
  const size = crop && outputSize(crop, shape);
  useEffect(() => {
    if (!image || !crop || !size) return;
    const timer = setTimeout(() => void renderCrop(image.bitmap, crop, size.width, size.height, { keepTransparency }).then((result) => setRendered({ crop, result }), () => {}), 250);
    return () => clearTimeout(timer);
  }, [image, crop, size?.width, size?.height, keepTransparency]);

  const take = (blob: File | Blob | null | undefined, fallback = "Pasted image") => {
    if (!blob) return;
    setFile({ blob, name: blob instanceof File && blob.name ? blob.name : fallback });
  };

  const save = async () => {
    if (!image || !crop || !size) return;
    setSaving(true);
    setProblem(undefined);
    try {
      const result = rendered?.crop === crop ? rendered.result : await renderCrop(image.bitmap, crop, size.width, size.height, { keepTransparency });
      await onSave(result.blob, hasFocus ? focus : undefined);
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const png = rendered?.result.png ?? false;
  return (
    <Modal title={title} onClose={onClose} className="w-[min(48rem,calc(100vw-2rem))]">
      <div
        className="grid gap-5 text-sm sm:grid-cols-[auto_minmax(0,1fr)]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          take(e.dataTransfer.files[0]);
        }}
        onPaste={(e: ClipboardEvent) => {
          const pasted = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
          if (pasted) {
            e.preventDefault();
            take(pasted);
          }
        }}
      >
        <Stage
          image={image}
          reading={!image && !problem}
          name={file.name}
          crop={crop}
          shape={shape}
          focus={hasFocus ? focus : undefined}
          helpId={ids.help}
          focusHelpId={ids.focusHelp}
          onCrop={(next, said) => {
            setCrop(next);
            if (said && image) setAnnouncement(`Frame ${placeOf(next, image.bitmap)}.`);
          }}
          onFocus={(next, said) => {
            setFocus(next);
            if (said) setAnnouncement(`Focal point ${Math.round(next[0] * 100)}% across, ${Math.round(next[1] * 100)}% down.`);
          }}
        />
        <div className="grid min-w-0 content-start gap-4">
          <Part title="The image">
            <p className="break-words">
              {file.name}
              {image && (
                <span className="text-muted">
                  {" "}
                  · {image.bitmap.width} × {image.bitmap.height} px · {megabytes(file.blob.size)}
                </span>
              )}
            </p>
            <p className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => chooser.current?.click()}>
                Choose another…
              </Button>
              <span className="text-muted">or drop or paste one here</span>
            </p>
            <input ref={chooser} type="file" accept="image/*" hidden onChange={(e) => take(e.target.files?.[0])} />
          </Part>
          <Part title="Crop">
            <p id={ids.help}>Drag the frame, or move it with the arrow keys (Shift for further); + and − make it smaller and larger.</p>
            {hasFocus && <p id={ids.focusHelp}>The dot is where cards and thumbnails centre the picture: drag it, or move it with the arrow keys.</p>}
            {image && crop && (
              <label htmlFor={ids.size} className="flex items-center gap-2">
                Size
                <input
                  id={ids.size}
                  type="range"
                  min={MIN_SCALE * 100}
                  max={100}
                  value={Math.round(cropScale(image.bitmap, crop) * 100)}
                  aria-valuetext={`${Math.round(cropScale(image.bitmap, crop) * 100)}% of the largest`}
                  onChange={(e) => setCrop(scaledCrop(image.bitmap, shape.aspect, Number(e.target.value) / 100, centreOf(crop)))}
                  className="flex-1"
                />
              </label>
            )}
          </Part>
          <Part title="Saved as">
            <p>
              <code className="rounded bg-panel px-1.5 py-0.5 text-[13px]">{expectedPath(shape, name, png)}</code>
            </p>
            {size && (
              <p className="text-muted">
                {crop && crop.width >= shape.width ? "Resized to" : "At"} {size.width} × {size.height} px
                {rendered ? `, about ${megabytes(rendered.result.blob.size)}` : ""}: small enough to keep every copy of the book quick to sync.
              </p>
            )}
          </Part>
          {problem && (
            <p role="alert" className="text-danger">
              {problem}
            </p>
          )}
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} disabled={!image || !crop || saving}>
              {saving ? "Saving…" : saveLabel}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function release(made: { bitmap: ImageBitmap; url: string }) {
  made.bitmap.close();
  URL.revokeObjectURL(made.url);
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function centreOf(crop: Crop) {
  return { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
}

/** "52% across, 30% down": where the frame's middle is in the image. */
function placeOf(crop: Crop, image: { width: number; height: number }): string {
  const c = centreOf(crop);
  return `${Math.round((c.x / image.width) * 100)}% across, ${Math.round((c.y / image.height) * 100)}% down`;
}

/**
 * The image at a size that fits, the crop frame over it (outside it dimmed) and the focal point in
 * it. The frame and the dot are buttons: they take the focus, and the arrow keys move them.
 */
function Stage({
  image,
  reading,
  name,
  crop,
  shape,
  focus,
  helpId,
  focusHelpId,
  onCrop,
  onFocus,
}: {
  image: { bitmap: ImageBitmap; url: string } | undefined;
  reading: boolean;
  name: string;
  crop: Crop | undefined;
  shape: PictureShape;
  focus: [number, number] | undefined;
  helpId: string;
  focusHelpId: string;
  onCrop: (crop: Crop, announce: boolean) => void;
  onFocus: (focus: [number, number], announce: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(STAGE.width);
  useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const measure = () => setRoom(Math.min(STAGE.width, el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  const frame = useRef<HTMLButtonElement>(null);

  if (!image || !crop) {
    return <div ref={box} className="grid place-items-center rounded-lg bg-panel text-muted" style={{ width: room, height: STAGE.height }}>{reading ? "Reading the image…" : "No image"}</div>;
  }
  const { width: w, height: h } = image.bitmap;
  const k = Math.min(room / w, STAGE.height / h);
  const step = (e: KeyboardEvent) => (e.shiftKey ? 0.1 : 0.01);

  const onFrameKey = (e: KeyboardEvent) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      onCrop(moveCrop(crop, move[0] * step(e) * w, move[1] * step(e) * h, image.bitmap), true);
    } else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "−") {
      e.preventDefault();
      const by = e.key === "-" || e.key === "−" ? 0.05 : -0.05;
      onCrop(scaledCrop(image.bitmap, shape.aspect, cropScale(image.bitmap, crop) + by, centreOf(crop)), true);
    }
  };
  const onDotKey = (e: KeyboardEvent) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const move = moves[e.key];
    if (!move || !focus) return;
    e.preventDefault();
    e.stopPropagation();
    const by = e.shiftKey ? 0.1 : 0.02;
    onFocus(moveFocus(focus, move[0] * by, move[1] * by), true);
  };
  const onFramePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, crop };
  };
  const onFramePointerMove = (e: PointerEvent) => {
    const start = drag.current;
    if (start) onCrop(moveCrop(start.crop, (e.clientX - start.x) / k, (e.clientY - start.y) / k, image.bitmap), false);
  };
  const onDotPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDotPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !frame.current) return;
    const r = frame.current.getBoundingClientRect();
    onFocus(moveFocus([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height], 0, 0), false);
  };

  return (
    <div ref={box} className="relative shrink-0 justify-self-center overflow-hidden rounded-lg bg-panel" style={{ width: w * k, height: h * k }}>
      <img src={image.url} alt={`The image chosen: ${name}`} className="size-full select-none" draggable={false} />
      <button
        ref={frame}
        type="button"
        aria-label={`Crop frame, ${placeOf(crop, image.bitmap)}`}
        aria-describedby={helpId}
        onKeyDown={onFrameKey}
        onPointerDown={onFramePointerDown}
        onPointerMove={onFramePointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        className="absolute cursor-move touch-none rounded border-2 border-white outline-none focus-visible:ring-4 focus-visible:ring-accent"
        style={{ left: crop.x * k, top: crop.y * k, width: crop.width * k, height: crop.height * k, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)" }}
      >
        <span aria-hidden className="absolute bottom-1.5 left-2 text-xs text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]">
          {shape.ratio}
        </span>
      </button>
      {focus && (
        <button
          type="button"
          aria-label={`Focal point, ${Math.round(focus[0] * 100)}% across, ${Math.round(focus[1] * 100)}% down`}
          aria-describedby={focusHelpId}
          onKeyDown={onDotKey}
          onPointerDown={onDotPointerDown}
          onPointerMove={onDotPointerMove}
          className="absolute size-5 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-white bg-accent/85 outline-none focus-visible:ring-4 focus-visible:ring-accent"
          style={{ left: (crop.x + focus[0] * crop.width) * k, top: (crop.y + focus[1] * crop.height) * k }}
        />
      )}
    </div>
  );
}
