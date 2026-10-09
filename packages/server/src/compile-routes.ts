import { compileBook, CompileError, slugify } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { toDocx, toEpub, toPdf } from "@gh-writer/export";
import type { Hono } from "hono";
import { body, type Env } from "./bible-routes.ts";
import { git } from "./git.ts";

/*
 * POST /:id/compile  { format: docx|epub|pdf, preset?, from?, to? } → the file (#19)
 *
 * Compiles what's saved on disk. Its dates are the latest commit's when everything saved is
 * committed (so the same commit compiles to the same file here and in the novel's GitHub Action),
 * otherwise now. X-Missing-Characters lists what the PDF's type has no letter for.
 * Refusals: 400 BAD_REQUEST (an unknown format, preset or chapter).
 */

const TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  pdf: "application/pdf",
} as const;

/** When the novel's text was last committed, if everything saved is; otherwise now. */
export async function compileDate(root: string): Promise<Date> {
  const g = git(root);
  const dirty = (await g.raw(["status", "--porcelain", "--", "."]).catch(() => "x")).trim();
  const when = dirty ? "" : (await g.raw(["log", "-1", "--format=%cI"]).catch(() => "")).trim();
  return when ? new Date(when) : new Date();
}

export function compileRoutes(routes: Hono<Env>): void {
  routes.post("/:id/compile", async (c) => {
    const raw = await body(c);
    const format = raw.format;
    if (format !== "docx" && format !== "epub" && format !== "pdf") return c.json({ code: "BAD_REQUEST", error: "Choose a format: docx, epub or pdf." }, 400);
    const text = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined);
    const ws = c.var.ws;
    const { novel } = await ws.loadModel();
    let book;
    try {
      book = await compileBook(novel, nodeSource(ws.root), { ...(text("preset") ? { preset: text("preset")! } : {}), ...(text("from") ? { from: text("from")! } : {}), ...(text("to") ? { to: text("to")! } : {}) });
    } catch (e) {
      if (e instanceof CompileError) return c.json({ code: "BAD_REQUEST", error: e.message }, 400);
      throw e;
    }
    const date = await compileDate(ws.root);
    let bytes: Uint8Array;
    let missing: string[] = [];
    if (format === "docx") bytes = toDocx(book, { date });
    else if (format === "epub") bytes = toEpub(book, { date });
    else ({ pdf: bytes, missing } = await toPdf(book, { date }));
    const whole = book.chapters.length === novel.chapters.length;
    const range = whole || !book.chapters.length ? "" : `-chapters-${book.chapters[0]!.number}-${book.chapters.at(-1)!.number}`;
    const filename = `${slugify(book.title) || "novel"}${range}.${format}`;
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": TYPES[format],
        "content-disposition": `attachment; filename="${filename}"`,
        "x-missing-characters": encodeURIComponent(missing.join("")),
        "cache-control": "no-store",
      },
    });
  });
}
