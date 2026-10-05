import { resolve } from "node:path";
import { styleText } from "node:util";
import { validate, type Diagnostic } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";

export interface ValidateOptions {
  json?: boolean;
}

/** Validate the novel in `dir`, print the report, and return the process exit code. */
export async function runValidate(dir: string, options: ValidateOptions = {}, out: (s: string) => void = console.log): Promise<number> {
  const root = resolve(dir);
  const result = await validate(nodeSource(root));

  if (options.json) {
    out(JSON.stringify({ root, errors: result.errors, warnings: result.warnings, diagnostics: result.diagnostics }, null, 2));
    return result.errors ? 1 : 0;
  }

  const byFile = new Map<string, Diagnostic[]>();
  for (const d of result.diagnostics) {
    const key = d.file ?? "(novel)";
    byFile.set(key, [...(byFile.get(key) ?? []), d]);
  }
  for (const [file, ds] of byFile) {
    out(styleText("underline", file));
    for (const d of ds) {
      const severity = d.severity === "error" ? styleText("red", "error  ") : styleText("yellow", "warning");
      const where = d.line !== undefined ? `line ${d.line}` : d.pointer ?? "";
      out(`  ${severity}  ${styleText("dim", d.code.padEnd(20))} ${where ? `${styleText("dim", where)}  ` : ""}${d.message}`);
    }
    out("");
  }

  const title = result.novel.config?.title ?? root;
  const summary = `${plural(result.errors, "error")}, ${plural(result.warnings, "warning")}`;
  out(result.errors ? styleText("red", `✖ ${title}: ${summary}`) : styleText("green", `✔ ${title}: ${summary}`));
  return result.errors ? 1 : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
