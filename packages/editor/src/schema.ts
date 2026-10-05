import { getSchema } from "@tiptap/core";
import { proseContent } from "./extensions.ts";

/**
 * The ProseMirror schema for scene prose, built from the TipTap extensions so the editor and
 * headless code (parsing, serializing, tests) agree. An Editor builds its own instance from the
 * same extensions: parse with `editor.schema` for documents the editor will hold.
 */
export const proseSchema = getSchema(proseContent);
