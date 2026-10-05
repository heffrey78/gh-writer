import { parseDocument } from "yaml";
import type { Diagnostic } from "./types.ts";

export interface Parsed {
  data: unknown;
  diagnostics: Diagnostic[];
}

/** Parse YAML text. Syntax errors (including duplicate keys) become E_PARSE diagnostics. */
export function parseYaml(text: string, file: string, lineOffset = 0): Parsed {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length) {
    return {
      data: undefined,
      diagnostics: doc.errors.map((e) => ({
        severity: "error",
        code: "E_PARSE",
        file,
        line: lineAt(text, e.pos[0]) + lineOffset,
        message: `Invalid YAML: ${e.message.split("\n")[0]}`,
      })),
    };
  }
  return { data: doc.toJS(), diagnostics: [] };
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export interface MarkdownFile {
  data: unknown;
  body: string;
  /** 1-based line number where the body starts. */
  bodyLine: number;
  diagnostics: Diagnostic[];
}

/** Split a Markdown file into YAML front matter and body. */
export function parseMarkdown(text: string, file: string): MarkdownFile {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n?^---[ \t]*(?:\n|$)/m.exec(src);
  if (!match || match.index !== 0) {
    return {
      data: undefined,
      body: src,
      bodyLine: 1,
      diagnostics: [{ severity: "error", code: "E_PARSE", file, line: 1, message: "Missing YAML front matter (the file must start with a --- block)" }],
    };
  }
  const { data, diagnostics } = parseYaml(match[1]!, file, 1);
  const bodyLine = match[0].split("\n").length - (match[0].endsWith("\n") ? 0 : 1);
  return { data, body: src.slice(match[0].length), bodyLine, diagnostics };
}
