// `iqgit commit -m "msg"` — LOCAL ONLY. Stages a snapshot under
// .iqgit/pending/. No chain interaction.
//
//   in:  -m <message> (required), --no-warn-large
//   sdk: (none)              ← intentional. push.ts is where SDK is called.
//   out: appends pending/NNN-<commitId>/ with meta.json + tree.json + blobs/
//
// Why split commit/push: each on-chain codeIn costs SOL. Letting users
// commit several times offline and bundle into one push amortizes cost
// and matches the git mental model.
//
// 1MB warning lives here, not in scan.ts — scan returns sizes, the
// command decides UX (CODE-RULES §5).

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import * as repo from "../core/repo";
import { scan } from "../core/scan";
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

      const files = scan(cwd);
      if (files.length === 0) ui.fail("nothing to commit");

      const big = files.filter((f) => f.size > LARGE_FILE_THRESHOLD);
      if (big.length > 0 && opts.warnLarge) {
        ui.log.warn("Large files (>1MB) — on-chain upload will be costly:");
        for (const b of big) ui.log.info(`  ${b.path}  ${ui.formatSize(b.size)}`);
        const ok = await ui.confirm({ message: "Include them?" });
        if (!ok) {
          ui.log.dim("Tip: add to .iqgitignore to skip on-chain upload only.");
          return;
        }
      }

      const pending = repo.listPending(cwd);
      const parent = pending[pending.length - 1]?.meta.id ?? repo.readHead(cwd);
      const meta: repo.PendingMeta = {
        id: randomUUID(),
        message: opts.message,
        parentCommitId: parent,
        timestamp: Date.now(),
        author: cfg.owner,
        treeTxId: null,
        committedSig: null,
      };
      const tree: Record<string, { hash: string; size: number }> = {};
      const blobs = new Map<string, string>();
      for (const f of files) {
        tree[f.path] = { hash: f.hash, size: f.size };
        blobs.set(f.hash, f.base64);
      }

      repo.appendPending(cwd, meta, tree, blobs);

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      ui.log.success(`commit ${meta.id.slice(0, 7)} saved locally`);
      ui.log.info(`  ${files.length} files, ${ui.formatSize(totalSize)}`);
      ui.log.dim("Run: iqgit push  to upload on-chain");
    });
}
