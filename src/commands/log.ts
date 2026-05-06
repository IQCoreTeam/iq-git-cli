// `iqgit log [--limit N]` — print commit history newest-first.
// Read-only; uses setupReadOnly so an unconfigured wallet doesn't
// trigger an interactive generation prompt for what is fundamentally
// a public chain read.
//
//   in:  optional --limit <n>, --owner <pubkey>, --repo <name>
//   sdk: readCommitHistory(connection, owner, repo, { limit })
//        ↑ exported directly from the SDK; same call GitClient.log
//          would have made internally.
//   out: formatted commit list to stdout
//
// Owner/repo default from .iqgit/config.json so users can `cd` into a
// cloned repo and just run `iqgit log`. Override flags exist so users
// can peek at someone else's repo without cloning.

import type { Command } from "commander";
import { readCommitHistory } from "@iqlabs-official/git-sdk/node";
import * as repo from "../core/repo";
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
      const connection = await setupReadOnly();
      const commits = await readCommitHistory(connection, owner, repoName, {
        limit: Number(opts.limit),
      });

      for (const c of commits) {
        ui.log.info(ui.formatCommit(c));
        ui.log.dim(`        author: ${c.author}`);
        ui.log.dim(`        tree:   ${c.treeTxId}`);
        ui.log.info("");
      }
    });
}
