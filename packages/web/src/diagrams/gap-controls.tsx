import type { ReactNode } from "react";
import type { GapThreshold } from "../swimlanes/swimlane-model.ts";
import { writeGap } from "./gap-param.ts";

/** How long an absence must last to count: a number, in scenes or words. `extra` goes beside them. */
export function GapControls({ legend, threshold, onChange, extra }: { legend: string; threshold: GapThreshold; onChange: (gap: string) => void; extra?: ReactNode }) {
  return (
    <fieldset className="flex items-end gap-2">
      <legend className="mb-1 font-medium">{legend}</legend>
      <input
        type="number"
        min={0}
        aria-label="How many"
        value={"scenes" in threshold ? threshold.scenes : threshold.words}
        onChange={(e) => {
          const n = Math.max(0, Math.round(Number(e.target.value) || 0));
          onChange(writeGap("scenes" in threshold ? { scenes: n } : { words: n }));
        }}
        className="h-8 w-24 rounded-md border border-rule bg-raised px-2"
      />
      <select
        aria-label="Counted in"
        value={"scenes" in threshold ? "scenes" : "words"}
        onChange={(e) => onChange(writeGap(e.target.value === "words" ? { words: 5000 } : { scenes: 3 }))}
        className="h-8 rounded-md border border-rule bg-raised px-2"
      >
        <option value="scenes">scenes</option>
        <option value="words">words</option>
      </select>
      {extra}
    </fieldset>
  );
}
