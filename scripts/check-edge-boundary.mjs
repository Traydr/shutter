import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["apps/edge/src", "packages/protocol/src", "packages/testkit/src"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const violations = [];

async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await visit(entryPath);
      continue;
    }
    if (!sourceExtensions.has(extname(entry.name))) continue;

    const source = await readFile(entryPath, "utf8");
    if (/from\s+["']node:|import\s*\(\s*["']node:|require\s*\(\s*["'](?:node:)?/.test(source)) {
      violations.push(`${entryPath}: imports a Node built-in`);
    }
    if (/\bBuffer\b/.test(source)) violations.push(`${entryPath}: uses Buffer`);
    if (/\bprocess(?:\.|\[)/.test(source)) violations.push(`${entryPath}: uses process`);
  }
}

for (const root of roots) await visit(root);

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
