// `iqgit log [--limit N]` — print commit history newest-first.
// Read-only. Uses gwFetchRows which transparently routes through the
// gateway when GATEWAY_URL is set, falls back to direct RPC otherwise.
//
//   in:  optional --limit <n>, --owner <pubkey>, --repo <name>
//
// Owner/repo default from .iqgit/config.json so users can `cd` into a
// cloned repo and just run `iqgit log`. Override flags exist for peeking
// at someone else's repo without cloning.

import type { Command } from "commander";
import {
  IQGIT_ROOT_ID,
  commitTableHint,
  type Commit,
} from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";
import * as repo from "../core/repo";
import { gwFetchAllRows } from "../core/gateway";
import { setupReadOnly } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("log")
    .option("--limit <n>", "max entries", "20")
    .option("--owner <pubkey>")
    .option("--repo <name>")
    .action(async (opts: { limit: string; owner?: string; repo?: string }) => {
      let owner = opts.owner;
      let repoName = opts.repo;
      if (!owner || !repoName) {
        const cfg = repo.readConfig(repo.findRepoRoot());
        owner ??= cfg.owner;
        repoName ??= cfg.repo;
      }
      // Ensure SDK has an RPC configured for the gwFetchRows fallback path.
      await setupReadOnly();

      const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));
      const tablePda = getTablePda(dbRoot, toSeedBytes(commitTableHint(owner, repoName)));
      const commits = (await gwFetchAllRows(tablePda.toBase58(), Number(opts.limit))) as unknown as Commit[];

      // Gateway returns rows in chain order; SDK returns newest-first. Sort
      // here unconditionally so output is stable regardless of source.
      const sorted = [...commits].sort((a, b) => b.timestamp - a.timestamp);
      for (const c of sorted) {
        ui.log.info(ui.formatCommit(c));
        ui.log.dim(`        author: ${c.author}`);
        ui.log.dim(`        tree:   ${c.treeTxId}`);
        ui.log.info("");
      }
    });
}
