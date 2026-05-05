// fs walker — the only thing the SDK can't do for us, because the SDK
// also runs in browsers without `fs`. Produces the `Record<string, string>`
// shape (path → base64 content) that GitClient.commit() / .status() expect.
//
// Reads .gitignore AND .iqgitignore (both optional, both merged via the
// `ignore` package) plus always-ignore [".git/", ".iqgit/"].
//
// Returns enough info that the caller (commit.ts) can warn about >1MB files
// without re-walking. Hash is sha256(base64) — same convention as SDK
// (storage.ts:33), so cache lookups match SDK's internal dedup.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

export interface ScanFile {
  path: string;
  base64: string;
  hash: string;
  size: number;
}

export function scan(repoRoot: string): ScanFile[] {
  const ig = ignore().add([".git/", ".iqgit/"]);
  for (const name of [".gitignore", ".iqgitignore"]) {
    try {
      ig.add(readFileSync(join(repoRoot, name), "utf8"));
    } catch {
      // file absent — fine
    }
  }

  const out: ScanFile[] = [];
  walk(repoRoot, repoRoot, ig, out);
  return out;
}

// Convert ScanFile[] → Record<string,string> for SDK calls. Inlined as a
// helper because both commit.ts and status.ts need this exact shape; not
// worth a generic utility (CODE-RULES §1).
export function toScanMap(files: ScanFile[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path, f.base64]));
}

function walk(root: string, dir: string, ig: Ignore, out: ScanFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).split(sep).join("/");
    const relForIgnore = entry.isDirectory() ? `${rel}/` : rel;
    if (ig.ignores(relForIgnore)) continue;

    if (entry.isDirectory()) {
      walk(root, abs, ig, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const buf = readFileSync(abs);
    const base64 = buf.toString("base64");
    out.push({
      path: rel,
      base64,
      hash: createHash("sha256").update(base64).digest("hex"),
      size: statSync(abs).size,
    });
  }
}
