import { editYaml, isId, type YamlEdit } from "@gh-writer/core";
import { isMap, parseDocument } from "yaml";
import { OperationError } from "./operations.ts";
import type { Env } from "./bible-routes.ts";
import { body, operation } from "./bible-routes.ts";
import type { Hono } from "hono";
import type { NovelWorkspace } from "./workspace.ts";

export const LAYOUTS = "diagrams/layouts.yaml";
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export type Positions = Record<string, { x: number; y: number }>;

const line = (id: string, p: { x: number; y: number }) => `      ${id}: { x: ${p.x}, y: ${p.y} }\n`;

/**
 * The layouts file with `positions` saved for diagram `name`: each node on its own line, so moving
 * one changes one line. A diagram the file doesn't have yet is added as a section of its own.
 */
export function withPositions(text: string | undefined, name: string, positions: Positions): string {
  const ids = Object.keys(positions);
  if (text === undefined || !text.trim()) return `layouts:\n  ${name}:\n    nodes:\n${ids.map((id) => line(id, positions[id]!)).join("")}`;
  const doc = parseDocument(text);
  const layouts = doc.get("layouts", true);
  const diagram = isMap(layouts) ? layouts.get(name, true) : undefined;
  const nodes = isMap(diagram) ? diagram.get("nodes", true) : undefined;
  if (isMap(nodes) && !nodes.flow && nodes.items.length) {
    const edits: YamlEdit[] = ids.map((id) => ({ path: ["layouts", name, "nodes", id], value: positions[id]! }));
    return editYaml(text, edits);
  }
  // `layouts` is the file's only key: a new diagram goes at the end, once it's a block map with entries.
  if (isMap(layouts) && !layouts.flow && layouts.items.length && !diagram) {
    const end = text.endsWith("\n") ? text : `${text}\n`;
    return `${end}  ${name}:\n    nodes:\n${ids.map((id) => line(id, positions[id]!)).join("")}`;
  }
  // Anything unusual (an empty diagram, flow style): the diagram's nodes written as a whole.
  const current = (isMap(nodes) ? (nodes.toJSON() as Positions) : {}) ?? {};
  return editYaml(text, [{ path: ["layouts", name], value: { nodes: { ...current, ...positions } } }]);
}

/** Check and round positions sent by the app: IDs, and finite numbers (whole pixels are plenty). */
export function readPositions(value: unknown): Positions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationError("BAD_REQUEST", "Send { positions: { <id>: { x, y } } }.");
  const out: Positions = {};
  for (const [id, p] of Object.entries(value)) {
    const { x, y } = (p ?? {}) as { x?: unknown; y?: unknown };
    if (!isId(id) || typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new OperationError("BAD_REQUEST", `Not a position: ${id}.`);
    }
    out[id] = { x: Math.round(x), y: Math.round(y) };
  }
  if (!Object.keys(out).length) throw new OperationError("BAD_REQUEST", "No positions to save.");
  return out;
}

/** Save positions for a diagram, through the workspace's ordinary writes: they're committed with the next autosave. */
export async function saveLayout(ws: NovelWorkspace, name: string, positions: Positions): Promise<{ file: string; hash: string }> {
  if (!NAME.test(name)) throw new OperationError("BAD_REQUEST", `Not a diagram name: ${name}.`);
  // Positions are the app's to place: on a clash with another write, read again and reapply.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ws.read(LAYOUTS);
    const result = await ws.write(LAYOUTS, withPositions(current?.content, name, positions), current?.hash ?? null);
    if (result.ok) return { file: LAYOUTS, hash: result.hash };
  }
  throw new OperationError("STALE", "The layout file keeps changing; try again.");
}

/** PUT /:id/diagrams/:name/layout  { positions: { <id>: { x, y } } } → { file, hash } */
export function diagramRoutes(routes: Hono<Env>): void {
  routes.put("/:id/diagrams/:name/layout", async (c) =>
    operation(c, async () => saveLayout(c.var.ws, c.req.param("name"), readPositions((await body(c)).positions))),
  );
}
