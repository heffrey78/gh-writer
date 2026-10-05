#!/usr/bin/env node
// One-time setup for a novel created from the gh-writer template: replaces the
// template's placeholder IDs with fresh random ones (so books never share IDs,
// even in a series) and sets the title.
//
// Usage: node .github/gh-writer/init.mjs ["Title or repo-name"]
// Run from the repository root. Does nothing if the novel is already set up.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATE_IDS = ["nv_temp1a", "ch_temp1a", "sc_temp1a"];
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ROOTS = ["novel.yaml", "manuscript", "bible", "diagrams"];

if (!readFileSync("novel.yaml", "utf8").includes(`id: ${TEMPLATE_IDS[0]}`)) {
  console.log("Novel is already set up; nothing to do.");
  process.exit(0);
}

const fresh = (id) => `${id.split("_")[0]}_${[...randomBytes(6)].map((b) => ALPHABET[b & 31]).join("")}`;
const ids = new Map(TEMPLATE_IDS.map((id) => [id, fresh(id)]));
const pattern = new RegExp(`\\b(${TEMPLATE_IDS.join("|")})\\b`, "g");

const files = (path) => (statSync(path).isDirectory() ? readdirSync(path).flatMap((n) => files(join(path, n))) : [path]);
for (const file of ROOTS.filter((p) => existsSync(p)).flatMap(files)) {
  if (!/\.(md|ya?ml)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  const updated = text.replace(pattern, (id) => ids.get(id));
  if (updated !== text) writeFileSync(file, updated);
}

const name = process.argv[2]?.trim();
if (name) {
  const title = /[-_]/.test(name) || name === name.toLowerCase()
    ? name.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")
    : name;
  const novel = readFileSync("novel.yaml", "utf8");
  writeFileSync("novel.yaml", novel.replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`));
}

console.log(`Set up novel with ${[...ids.values()].join(", ")}`);
