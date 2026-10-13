// Entry point for the server bundle (scripts/build-server.ts: dist/server/gh-writer.mjs), which the
// desktop app runs on Node's official binary (D9). What the source tree finds beside its sources (the
// built web app, the novel template, the PDF type) sits beside the bundle instead, unless the
// environment already says where.
import { fileURLToPath } from "node:url";

const beside = (path: string) => fileURLToPath(new URL(path, import.meta.url));
process.env.GH_WRITER_WEB ||= beside("./web");
process.env.GH_WRITER_TEMPLATE ||= beside("./template");
process.env.GH_WRITER_FONTS ||= beside("./fonts");

// Imported after the environment is set: the template's location is read when its module loads.
await import("./main.ts");
