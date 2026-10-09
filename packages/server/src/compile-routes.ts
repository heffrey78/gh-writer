import { compileBook, CompileError } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { commitDate, fileName, isFormat, MEDIA_TYPES, render } from "@gh-writer/export";
import type { Hono } from "hono";
import { body, type Env } from "./bible-routes.ts";

/*
 * POST /:id/compile  { format: docx|epub|pdf, preset?, from?, to? } → the file (#19)
 *
 * Compiles what's saved on disk. Its dates are the latest commit's when everything saved is
 * committed (so the same commit compiles to the same file here and in the novel's GitHub Action),
 * otherwise now. X-Missing-Characters lists what the PDF's type has no letter for.
 * Refusals: 400 BAD_REQUEST (an unknown format, preset or chapter).
 */

export function compileRoutes(routes: Hono<Env>): void {
  routes.post("/:id/compile", async (c) => {
    const raw = await body(c);
    const format = raw.format;
    if (!isFormat(format)) return c.json({ code: "BAD_REQUEST", error: "Choose a format: docx, epub or pdf." }, 400);
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
    const { bytes, missing } = await render(book, format, { date: await commitDate(ws.root) });
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": MEDIA_TYPES[format],
        "content-disposition": `attachment; filename="${fileName(book, novel.chapters.length, format)}"`,
        "x-missing-characters": encodeURIComponent(missing.join("")),
        "cache-control": "no-store",
      },
    });
  });
}
