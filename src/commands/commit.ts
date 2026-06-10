// `iqgit commit -m "msg"` — LOCAL build of a snapshot, no chain WRITES.
// Stages a pending commit under .iqgit/pending/ that push.ts will upload.
//
//   in:  -m <message> (required), --no-warn-large
//   reads (gateway-first, SDK fallback): commit history + tree blob
//        when there's a HEAD but no local pending commits — both via
//        core/tree.ts:resolveBaseTree.
//   out: appends pending/NNN-<commitId>/ with meta.json + tree.json + blobs/
//
// Snapshot semantics (matches git):
//   final tree = base tree, with index entries overlaid.
//     • base = last pending's tree.json   (if any pending exist), else
//              loadTree(HEAD.treeTxId)    (if HEAD exists), else
//              {}                         (first ever commit)
//     • for each indexed path:
//         file exists on disk → set tree[path] from working tree
//         file missing        → delete tree[path]   (= staged removal)
//
// Empty index = nothing to do. We do NOT auto-stage everything; the user
// runs `iqgit add .` to opt in (matches `git commit` without -a).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
import { readScanFile } from "../core/scan";
import { resolveBaseTree, type Tree } from "../core/tree";
import { setupReadOnly } from "../setup";
import * as ui from "../ui";

const LARGE_FILE_THRESHOLD = 1024 * 1024;

export function register(program: Command): void {
  program
    .command("commit")
    .requiredOption("-m, --message <msg>", "commit message")
    .option("--no-warn-large", "skip 1MB confirmation prompt")
    .action(async (opts: { message: string; warnLarge: boolean }) => {
      const cwd = repo.findRepoRoot();
      const cfg = repo.readConfig(cwd);
      if (!cfg.owner) ui.fail("repo not yet created on-chain — run iqgit create first");

      const indexPaths = repo.readIndex(cwd);
      if (indexPaths.length === 0) {
        ui.fail("nothing staged — use `iqgit add <path>` first");
      }

      const committed = await buildCommit(cwd, cfg, opts);
      if (!committed) return; // user declined the large-file prompt
      ui.log.dim("Run: iqgit push  to upload on-chain");
    });
}

/** Build one pending commit from the current index and persist it under
 *  .iqgit/pending/. No chain WRITES — push.ts uploads it later. Returns the
 *  saved PendingCommit, or null when the user declines the large-file prompt.
 *
 *  Shared by the `commit` command and `pages deploy`'s auto-commit of a
 *  generated iqpages.json. Callers stage the index first (`iqgit add` /
 *  repo.writeIndex) and must have ensured cfg.owner.
 */
export async function buildCommit(
  cwd: string,
  cfg: repo.RepoConfig,
  opts: { message: string; warnLarge: boolean },
): Promise<repo.PendingCommit | null> {
  const indexPaths = repo.readIndex(cwd);
  const stagedFiles = [];
  const stagedDeletes: string[] = [];
  for (const p of indexPaths) {
    if (existsSync(join(cwd, p))) {
      stagedFiles.push(readScanFile(cwd, p));
    } else {
      stagedDeletes.push(p);
    }
  }

  const big = stagedFiles.filter((f) => f.size > LARGE_FILE_THRESHOLD);
  if (big.length > 0 && opts.warnLarge) {
    ui.log.warn("Large files (>1MB) — on-chain upload will be costly:");
    for (const b of big) ui.log.info(`  ${b.path}  ${ui.formatSize(b.size)}`);
    const ok = await ui.confirm({ message: "Include them?" });
    if (!ok) {
      ui.log.dim("Tip: add to .iqgitignore to skip on-chain upload only.");
      return null;
    }
  }

  // Ensure SDK has an RPC configured for the gwFetchRows fallback path.
  await setupReadOnly();
  const sp = ui.spinner("fetching base tree from chain...").start();
  let baseTree: Tree;
  try {
    baseTree = await resolveBaseTree(cwd, cfg.owner, cfg.repo);
    sp.succeed("fetched base tree");
  } catch (e) {
    sp.fail((e as Error).message);
    throw e;
  }
  const tree: Tree = { ...baseTree };
  const blobs = new Map<string, string>();
  for (const f of stagedFiles) {
    tree[f.path] = { hash: f.hash, size: f.size };
    blobs.set(f.hash, f.base64);
  }
  for (const p of stagedDeletes) {
    delete tree[p];
  }

  const last = repo.listPending(cwd).at(-1);
  const meta: repo.PendingMeta = {
    id: randomUUID(),
    message: opts.message,
    parentCommitId: last?.meta.id ?? repo.readHead(cwd),
    timestamp: Date.now(),
    author: cfg.owner,
    treeTxId: null,
    committedSig: null,
  };
  const pending = repo.appendPending(cwd, meta, tree, blobs);
  repo.writeIndex(cwd, []);

  const totalSize = stagedFiles.reduce((sum, f) => sum + f.size, 0);
  ui.log.success(`commit ${meta.id.slice(0, 7)} saved locally`);
  ui.log.info(
    `  ${stagedFiles.length} file(s) added/modified, ` +
      `${stagedDeletes.length} removed, ` +
      `${ui.formatSize(totalSize)}`,
  );
  return pending;
}
