import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { useMemo } from "react";
import { cn } from "../ui/cn.ts";

/**
 * Markdown as GitHub shows it in issues (GitHub-flavoured: tables, task lists, strikethrough,
 * autolinks). Safe to show whatever anyone wrote: raw HTML is shown as text, not run, and links with
 * dangerous protocols are dropped (micromark's defaults). gh-writer's own hidden notes (HTML comments)
 * are left out, as github.com leaves them out.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => micromark(text.replace(/<!--[\s\S]*?-->/g, "").trim(), { extensions: [gfm()], htmlExtensions: [gfmHtml()] }), [text]);
  return <div className={cn("ghw-markdown", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
