// `iqgit registry` — browse the public gallery (git_repos:all).
// Read-only; only RPC stage of setup needed.
//
//   in:  optional --limit <n>
//   sdk: readRegistryPage({ limit })
//   out: list of { owner, repo, description } to stdout

import type { Command } from "commander";
import { readRegistryPage } from "@iqlabs-official/git-sdk/node";
import { setupReadOnly } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("registry")
    .description("browse the public on-chain repo gallery")
    .option("--limit <n>", "max entries", "20")
    .action(async (opts: { limit: string }) => {
      const connection = await setupReadOnly();
      const entries = await readRegistryPage(connection, { limit: Number(opts.limit) });
      if (entries.length === 0) {
        ui.log.dim("registry empty");
        return;
      }
      for (const e of entries) {
        ui.log.info(`${e.owner.slice(0, 8)}…/${e.repo}  ${e.description}`);
      }
    });
}
