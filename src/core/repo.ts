// All .iqgit/ disk I/O lives here. One file, function-prefixed by concern,
// because all four pieces (config / HEAD / pending / cache) are tiny JSON
// reads/writes that share the same root path resolution. Splitting them
// would be premature (CODE-RULES §1).
//
// Layout this file owns (per repo):
//
//   <repoRoot>/.iqgit/
//     ├── config.json        { owner, repo, isPublic }
//     ├── HEAD               last successfully-pushed commitId (utf8)
//     ├── index.json         string[] — paths staged for the next commit
//     ├── pending/
//     │   └── NNN-<commitId>/
//     │       ├── meta.json  { id, message, parentCommitId, timestamp,
//     │       │                author, treeTxId|null, committedSig|null }
//     │       ├── tree.json  { [path]: { hash, size } }   ← size for stats
//     │       └── blobs/<hash>   raw base64 content (push reads from here)
//     └── upload-cache.json  { [hash]: { txId, uploadedAt } }
//
// CRITICAL: every cache mutation flushes synchronously. Process kill
// during push must leave a recoverable state. Don't batch writes here.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DIR = ".iqgit";

export interface RepoConfig {
  owner: string;
  repo: string;
  isPublic: boolean;
}

export interface PendingMeta {
  id: string;
  message: string;
  parentCommitId: string | null;
  timestamp: number;
  author: string;
  treeTxId: string | null;
  committedSig: string | null;
}

export interface PendingCommit {
  dir: string;
  seq: number;
  meta: PendingMeta;
}

export interface CacheEntry {
  txId: string;
  uploadedAt: number;
}

// === bootstrap / discovery ===

export function findRepoRoot(cwd = process.cwd()): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("not an iqgit repo (or any parent)");
    }
    dir = parent;
  }
}

export function initRepo(cwd: string): void {
  mkdirSync(join(cwd, DIR, "pending"), { recursive: true });
}

// === config.json ===

export function readConfig(repoRoot: string): RepoConfig {
  // Defensive: pre-fix repos may lack config.json. Return defaults so
  // `add` / `status` / `commit` give the friendly "run iqgit create first"
  // message via commit.ts:41 instead of an ENOENT stack trace.
  try {
    return JSON.parse(readFileSync(join(repoRoot, DIR, "config.json"), "utf8")) as RepoConfig;
  } catch {
    return { owner: "", repo: "", isPublic: true };
  }
}

export function writeConfig(repoRoot: string, cfg: RepoConfig): void {
  writeFileSync(join(repoRoot, DIR, "config.json"), JSON.stringify(cfg, null, 2));
}

// === HEAD ===

export function readHead(repoRoot: string): string | null {
  try {
    return readFileSync(join(repoRoot, DIR, "HEAD"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeHead(repoRoot: string, commitId: string): void {
  writeFileSync(join(repoRoot, DIR, "HEAD"), commitId);
}

// === index.json ===
//
// Set of staged paths for the next commit. Stored as a plain string[] —
// order doesn't matter, and a Set serialized as sorted array keeps diffs
// readable for anyone who peeks at the file.

export function readIndex(repoRoot: string): string[] {
  try {
    return JSON.parse(readFileSync(join(repoRoot, DIR, "index.json"), "utf8")) as string[];
  } catch {
    return [];
  }
}

export function writeIndex(repoRoot: string, paths: string[]): void {
  const sorted = Array.from(new Set(paths)).sort();
  writeFileSync(join(repoRoot, DIR, "index.json"), JSON.stringify(sorted, null, 2));
}

// === pending ===

export function listPending(repoRoot: string): PendingCommit[] {
  const dir = join(repoRoot, DIR, "pending");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const seqStr = e.name.split("-")[0];
      if (!seqStr) throw new Error(`malformed pending dir: ${e.name}`);
      const dirPath = join(dir, e.name);
      return {
        dir: dirPath,
        seq: Number(seqStr),
        meta: JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf8")) as PendingMeta,
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

// blobs is hash → base64. Caller (commit.ts) builds it from a ScanFile[]
// where Map deduplication already collapsed identical-content files.
export function appendPending(
  repoRoot: string,
  meta: PendingMeta,
  tree: Record<string, { hash: string; size: number }>,
  blobs: Map<string, string>,
): PendingCommit {
  const existing = listPending(repoRoot);
  const seq = (existing[existing.length - 1]?.seq ?? 0) + 1;
  const seqStr = String(seq).padStart(3, "0");
  const dir = join(repoRoot, DIR, "pending", `${seqStr}-${meta.id}`);
  mkdirSync(join(dir, "blobs"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, "tree.json"), JSON.stringify(tree, null, 2));
  for (const [hash, base64] of blobs) {
    writeFileSync(join(dir, "blobs", hash), base64);
  }
  return { dir, seq, meta };
}

// Atomic-ish meta update. Write to .tmp then rename — survives process kill
// mid-update. Used to checkpoint treeTxId / committedSig during push.
export function updatePendingMeta(p: PendingCommit, patch: Partial<PendingMeta>): void {
  const next = { ...p.meta, ...patch };
  const target = join(p.dir, "meta.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, target);
  p.meta = next;
}

export function readPendingTree(p: PendingCommit): Record<string, { hash: string; size: number }> {
  return JSON.parse(readFileSync(join(p.dir, "tree.json"), "utf8")) as Record<
    string,
    { hash: string; size: number }
  >;
}

export function readPendingBlob(p: PendingCommit, hash: string): string {
  return readFileSync(join(p.dir, "blobs", hash), "utf8");
}

export function discardPending(p: PendingCommit): void {
  rmSync(p.dir, { recursive: true, force: true });
}

// === upload-cache.json ===
//
// Per-repo (under .iqgit/), not global — keeps repos self-contained,
// simpler to reason about, and cross-repo dedup wasn't a stated need.
// In-memory cache loaded lazily; every set() rewrites the whole file
// synchronously so a process kill leaves the latest entry on disk.

const cacheMem = new Map<string, Record<string, CacheEntry>>();

export function cacheGet(repoRoot: string, hash: string): CacheEntry | null {
  return loadCache(repoRoot)[hash] ?? null;
}

export function cacheSet(repoRoot: string, hash: string, entry: CacheEntry): void {
  const c = loadCache(repoRoot);
  c[hash] = entry;
  writeFileSync(cachePath(repoRoot), JSON.stringify(c, null, 2));
}

function cachePath(repoRoot: string): string {
  return join(repoRoot, DIR, "upload-cache.json");
}

function loadCache(repoRoot: string): Record<string, CacheEntry> {
  const cached = cacheMem.get(repoRoot);
  if (cached) return cached;
  let parsed: Record<string, CacheEntry> = {};
  try {
    parsed = JSON.parse(readFileSync(cachePath(repoRoot), "utf8")) as Record<string, CacheEntry>;
  } catch {
    // absent — start empty
  }
  cacheMem.set(repoRoot, parsed);
  return parsed;
}

