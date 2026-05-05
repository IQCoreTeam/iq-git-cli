// `iqgit log [--limit N]` — print commit history newest-first.
// Read-only; only RPC stage of setup needed.
//
//   in:  optional --limit <n>, --owner <pubkey>, --repo <name>
//   sdk: GitClient.log(owner, repo, { limit })
//   out: formatted commit list to stdout
//
// Owner/repo default from .iqgit/config.json so users can `cd` into a
// cloned repo and just run `iqgit log`. Override flags exist so users
// can peek at someone else's repo without cloning.

import type { Command } from "commander";
import * as repo from "../core/repo";
import { setup } from "../setup";
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
      const { client } = await setup();
      const commits = await client.log(owner, repoName, { limit: Number(opts.limit) });

      for (const c of commits) {
        ui.log.info(ui.formatCommit(c));
        ui.log.dim(`        author: ${c.author}`);
        ui.log.dim(`        tree:   ${c.treeTxId}`);
        ui.log.info("");
      }
    });
}
