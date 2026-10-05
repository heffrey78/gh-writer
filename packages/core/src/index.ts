/** Highest novel repository schema version this build understands. */
export const SCHEMA_VERSION = 1;

export * from "./ids.ts";
export * from "./types.ts";
export { checkSchema, SCHEMAS, type SchemaKind } from "./schemas.ts";
