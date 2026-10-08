import { useId, useLayoutEffect, useRef, type CSSProperties } from "react";
import { cn } from "../ui/cn.ts";

export type CoverDesign = "night" | "waves" | "sun" | "band";

/** Each design's palettes: background, ink, and an accent for its pattern. */
const PALETTES: Record<CoverDesign, { bg: string; ink: string; accent: string; soft: string }[]> = {
  night: [
    { bg: "#25213d", ink: "#ffffff", accent: "#3a3460", soft: "#d9d4f2" },
    { bg: "#1d3330", ink: "#ffffff", accent: "#2c4a45", soft: "#cfe6df" },
    { bg: "#3d1f24", ink: "#ffffff", accent: "#5a2e35", soft: "#f0d3d6" },
    { bg: "#1f2a3d", ink: "#ffffff", accent: "#2d3d58", soft: "#d3def0" },
  ],
  waves: [
    { bg: "#e9e2e4", ink: "#161616", accent: "#2fb5a3", soft: "#3a3a3a" },
    { bg: "#e6e8e1", ink: "#161616", accent: "#d9643a", soft: "#3a3a3a" },
    { bg: "#e3e6ee", ink: "#161616", accent: "#4766d1", soft: "#3a3a3a" },
  ],
  sun: [
    { bg: "#b5532f", ink: "#fff8ef", accent: "#e8a33c", soft: "#fff8ef" },
    { bg: "#2f5d62", ink: "#fffaf0", accent: "#e2b660", soft: "#fffaf0" },
    { bg: "#5b3a6b", ink: "#fff7fb", accent: "#e98a7a", soft: "#fff7fb" },
  ],
  band: [
    { bg: "#f1ead9", ink: "#1e1b16", accent: "#7a2e2e", soft: "#4a4237" },
    { bg: "#eef0ea", ink: "#1b1e1a", accent: "#2f5a3a", soft: "#424a40" },
    { bg: "#f0ebe4", ink: "#1c1b1e", accent: "#283c6b", soft: "#43414a" },
  ],
};
const DESIGNS = Object.keys(PALETTES) as CoverDesign[];

/** FNV-1a: a small, stable hash, so a novel keeps its cover from one visit to the next. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The design and palette for a novel, chosen from its ID. */
export function coverFor(id: string): { design: CoverDesign; palette: (typeof PALETTES)[CoverDesign][number] } {
  const h = hash(id);
  const design = DESIGNS[h % DESIGNS.length]!;
  const palettes = PALETTES[design];
  return { design, palette: palettes[Math.floor(h / DESIGNS.length) % palettes.length]! };
}

/** Smaller type for longer titles, so most fit on a cover without being cut. */
function titleSize(title: string): string {
  const longest = Math.max(...title.split(/\s+/).map((w) => w.length));
  const n = title.length;
  if (n <= 8 && longest <= 8) return "1.55rem";
  if (n <= 16 && longest <= 10) return "1.25rem";
  if (n <= 30 && longest <= 13) return "1.05rem";
  return "0.9rem";
}

/**
 * A generated book cover: the title and author over one of a few designs, coloured from the novel's
 * ID. Decorative patterns are hidden from assistive technology; the text is real text.
 */
export function Cover({ id, title, author, className }: { id: string; title: string; author?: string | undefined; className?: string }) {
  const { design, palette: p } = coverFor(id);
  const size = titleSize(title);
  return (
    <div
      className={cn("relative aspect-[2/3] w-36 overflow-hidden rounded-[2px_5px_5px_2px] text-left select-none", className)}
      style={{ background: p.bg, color: p.ink, boxShadow: "0 1px 0 rgb(0 0 0 / 0.2), 5px 6px 12px -6px rgb(0 0 0 / 0.55)" }}
    >
      <Pattern design={design} palette={p} />
      {design === "night" && (
        <div className="absolute inset-x-3 top-[46%] grid justify-items-center gap-2 text-center">
          <Title text={title} size={size} maxHeight="5.5rem" className="w-full font-semibold tracking-[0.08em] uppercase" style={{ lineHeight: 1.1 }} />
          <span className="h-0.5 w-6" style={{ background: p.ink }} aria-hidden />
          {author && <span className="text-[0.6rem] font-semibold tracking-[0.18em] uppercase">{author}</span>}
        </div>
      )}
      {design === "waves" && (
        <>
          <Title text={title} size={`${Math.min(parseFloat(size) * 1.5, 2.4)}rem`} maxHeight="4.4rem" className="absolute inset-x-3 top-3 font-black tracking-tight uppercase" style={{ lineHeight: 1, fontStretch: "condensed" }} />
          {author && (
            <span className="absolute inset-x-3 bottom-2.5 text-center text-[0.55rem] font-semibold tracking-[0.2em] uppercase" style={{ color: p.soft }}>
              {author}
            </span>
          )}
        </>
      )}
      {design === "sun" && (
        <div className="absolute inset-x-3 bottom-3 grid gap-1">
          <Title text={title} size={size} maxHeight="5rem" className="font-serif" style={{ lineHeight: 1.1 }} />
          {author && <span className="text-[0.6rem] tracking-[0.12em] uppercase">{author}</span>}
        </div>
      )}
      {design === "band" && (
        <>
          <div className="absolute inset-x-0 top-[30%] grid gap-1 px-4 py-3" style={{ background: p.accent, color: p.bg }}>
            <Title text={title} size={size} maxHeight="5rem" className="font-serif italic" style={{ lineHeight: 1.1 }} />
          </div>
          {author && (
            <span className="absolute inset-x-4 bottom-3 text-[0.6rem] tracking-[0.14em] uppercase" style={{ color: p.soft }}>
              {author}
            </span>
          )}
        </>
      )}
      {/* The spine's crease. */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-2" style={{ background: "linear-gradient(to right, rgb(0 0 0 / 0.28), rgb(255 255 255 / 0.12) 55%, transparent)" }} aria-hidden />
    </div>
  );
}

/**
 * A cover's title at `size`, made smaller until its longest word fits the width and the whole title
 * fits `maxHeight`: words are never broken.
 */
function Title({ text, size, maxHeight, className, style }: { text: string; size: string; maxHeight: string; className: string; style: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let rem = parseFloat(size);
    el.style.fontSize = `${rem}rem`;
    // Against the limit, not clientHeight: a heavy face's glyphs reach past a tight line height.
    const max = parseFloat(getComputedStyle(el).maxHeight);
    while (rem > 0.6 && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > max + 2)) {
      rem = Math.round((rem - 0.05) * 100) / 100;
      el.style.fontSize = `${rem}rem`;
    }
  }, [text, size]);
  return (
    <span ref={ref} className={cn("block overflow-hidden", className)} style={{ ...style, fontSize: size, maxHeight }}>
      {text}
    </span>
  );
}

function Pattern({ design, palette: p }: { design: CoverDesign; palette: (typeof PALETTES)[CoverDesign][number] }) {
  const weave = useId();
  if (design === "night") {
    // A woven cloth texture.
    return (
      <svg className="absolute inset-0 size-full" aria-hidden>
        <defs>
          <pattern id={weave} width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M0 6 6 0M-1 1 1 -1M5 7 7 5" stroke={p.accent} strokeWidth="1.2" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${CSS.escape(weave)})`} />
      </svg>
    );
  }
  if (design === "waves") {
    const lines = Array.from({ length: 9 }, (_, i) => i);
    return (
      <svg className="absolute inset-x-0 top-[38%] h-[50%] w-full" viewBox="0 0 144 120" preserveAspectRatio="none" aria-hidden>
        {lines.map((i) => (
          <path
            key={i}
            d={`M-10 ${8 + i * 13} C 20 ${-4 + i * 13}, 40 ${20 + i * 13}, 72 ${8 + i * 13} S 124 ${-4 + i * 13}, 154 ${8 + i * 13}`}
            fill="none"
            stroke={i % 3 === 1 ? p.accent : "#2a2a2a"}
            strokeWidth={i % 3 === 1 ? 1.4 : 0.8}
            opacity={i % 3 === 1 ? 0.9 : 0.7}
          />
        ))}
      </svg>
    );
  }
  if (design === "sun") {
    return (
      <svg className="absolute inset-0 size-full" viewBox="0 0 144 216" aria-hidden>
        <circle cx="96" cy="70" r="46" fill={p.accent} />
        {[58, 70, 82].map((r) => (
          <circle key={r} cx="96" cy="70" r={r} fill="none" stroke={p.accent} strokeWidth="1" opacity="0.45" />
        ))}
      </svg>
    );
  }
  return (
    <svg className="absolute inset-0 size-full" viewBox="0 0 144 216" aria-hidden>
      <rect x="16" y="20" width="112" height="2" fill={p.accent} />
      <rect x="16" y="26" width="112" height="0.8" fill={p.accent} />
      <rect x="16" y="190" width="112" height="0.8" fill={p.accent} />
    </svg>
  );
}
