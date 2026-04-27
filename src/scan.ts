// Filesystem → `Record<path, base64Content>` walker for the commit/status
// workflows. Runtime-specific (Node only) — kept out of the SDK on purpose
// so the SDK stays runtime-neutral.
//
// Respects `.gitignore`-style ignores with a minimal built-in list plus an
// optional `.iqignore` file at the repo root.

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  ".next",
  ".DS_Store",
  "keypair.json",
];

function loadIqIgnore(root: string): string[] {
  const p = path.join(root, ".iqignore");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function isIgnored(relativePath: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (relativePath === pat) return true;
    if (relativePath.startsWith(pat + "/")) return true;
    if (pat.startsWith("*.") && relativePath.endsWith(pat.slice(1))) return true;
  }
  return false;
}

/**
 * Walk `root` recursively, base64-encode each file's contents, and return
 * `{ relativePath → base64 }`.
 */
export function scanDirectory(root: string): Record<string, string> {
  const patterns = [...DEFAULT_IGNORES, ...loadIqIgnore(root)];
  const out: Record<string, string> = {};

  function walk(dir: string): void {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (isIgnored(relative, patterns)) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        out[relative] = fs.readFileSync(full).toString("base64");
      }
    }
  }

  walk(root);
  return out;
}
