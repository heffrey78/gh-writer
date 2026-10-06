import { merge3 } from "@gh-writer/core";
import { useMemo, useState } from "react";
import { ConflictResolver, type ConflictFileView, type ResolvedFile } from "../src/react.tsx";
import station from "../../../examples/sample-novel/manuscript/01-return/01-arrival/01-the-station.md?raw";

/** Change the paragraph that starts with `start`. */
const edit = (text: string, start: string, to: (paragraph: string) => string) => text.replace(new RegExp(`^${start}.*$`, "m"), (p) => to(p));

/**
 * The Station as two machines left it: both rewrote the second paragraph and changed the status;
 * only the other machine touched the ending, which merges by itself.
 */
function conflicts(): ConflictFileView[] {
  const ours = edit(edit(station, "status:", () => "status: revised"), "Twelve years", (p) => p.replace("Twelve years", "Twelve long years"));
  const theirs = edit(
    edit(edit(station, "status:", () => "status: final"), "Twelve years", (p) => p.replace("Twelve years had not", "*Twelve years* had not")),
    "She stood",
    (p) => `${p} Then she picked up her bag.`,
  );
  return [{ path: "manuscript/01-return/01-arrival/01-the-station.md", title: "The Station", chunks: merge3(station, ours, theirs).chunks }];
}

/** The conflict resolver on its own (?resolve), with the outcome shown as the file that would be saved. */
export function ResolverDemo() {
  const files = useMemo(conflicts, []);
  const [result, setResult] = useState<Record<string, ResolvedFile> | "cancelled">();
  return (
    <main className="resolver-demo">
      <h1>Conflict resolver</h1>
      {result === undefined ? (
        <ConflictResolver files={files} onResolve={setResult} onCancel={() => setResult("cancelled")} />
      ) : (
        <section aria-labelledby="result-heading">
          <h2 id="result-heading">{result === "cancelled" ? "Not now" : "Resolved"}</h2>
          {result !== "cancelled" &&
            Object.entries(result).map(([path, r]) => (
              <pre key={path} data-testid="resolved" tabIndex={0} aria-label={`Resolved ${path}`}>
                {"content" in r ? r.content : `keep ${r.keep}`}
              </pre>
            ))}
        </section>
      )}
    </main>
  );
}
