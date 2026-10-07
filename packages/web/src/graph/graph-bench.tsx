import { useEffect, useMemo, useRef, useState } from "react";
import { GraphCanvas, type GraphEdge, type GraphNode } from "./graph-canvas.tsx";

const TYPES = ["Allied with", "Rivals with", "Sibling of", "Mentor of", "Owes", "Loves"];
const TONES = ["accent", "danger", "ok", "warn", "ink", "muted"];

/** A deterministic pseudo-random sequence, so every run measures the same graph. */
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

/**
 * The graph benchmark (#68): `nodes` entities and `edges` relationships on the real canvas, with a
 * button that changes every edge at once, as moving the story-position slider can. The time from
 * the click to the next painted frame is written to data-update-ms.
 */
export function GraphBench() {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get("nodes") ?? 60);
  const m = Number(params.get("edges") ?? 200);
  const nodes: GraphNode[] = useMemo(() => {
    const cols = Math.ceil(Math.sqrt(n));
    return Array.from({ length: n }, (_, i) => ({ id: `char_${i}`, label: `Character ${i + 1}`, type: "Character", x: (i % cols) * 220, y: Math.floor(i / cols) * 140 }));
  }, [n]);
  const [phase, setPhase] = useState(0);
  const edges: GraphEdge[] = useMemo(() => {
    const next = random(7);
    return Array.from({ length: m }, (_, i) => {
      const a = Math.floor(next() * n);
      const b = (a + 1 + Math.floor(next() * (n - 1))) % n;
      const t = (Math.floor(next() * TYPES.length) + phase) % TYPES.length;
      return { id: `rel_${i}`, source: `char_${a}`, target: `char_${b}`, label: TYPES[t]!, tone: TONES[t]!, line: t % 3 === 0 ? "dashed" : "solid", directed: t > 2 };
    });
  }, [n, m, phase]);

  const clicked = useRef(0);
  const [updateMs, setUpdateMs] = useState<number>();
  useEffect(() => {
    if (!clicked.current) return;
    requestAnimationFrame(() => setUpdateMs(Math.round(performance.now() - clicked.current)));
  }, [edges]);

  return (
    <main className="grid h-screen grid-rows-[auto_1fr] bg-paper">
      <div className="flex items-center gap-3 border-b border-rule p-2 text-sm">
        <h1 className="font-semibold">Graph benchmark</h1>
        <button
          type="button"
          className="rounded-md border border-rule px-2 py-1"
          onClick={() => {
            clicked.current = performance.now();
            setUpdateMs(undefined);
            setPhase((p) => p + 1);
          }}
        >
          Change every edge
        </button>
        <output data-testid="update" data-update-ms={updateMs ?? ""}>
          {updateMs === undefined ? "" : `${updateMs} ms`}
        </output>
      </div>
      <GraphCanvas nodes={nodes} edges={edges} label="Benchmark graph" />
    </main>
  );
}
