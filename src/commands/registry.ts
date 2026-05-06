// `iqgit registry` — browse the public gallery (git_repos:all). Read-only.

import type { Command } from "commander";
import {
  IQGIT_ROOT_ID,
  REGISTRY_HINT,
  type RegistryEntry,
} from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";
import { gwFetchAllRows } from "../core/gateway";
import { setupReadOnly } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("registry")
    .description("browse the public on-chain repo gallery")
    .option("--limit <n>", "max entries", "20")
    .action(async (opts: { limit: string }) => {
      await setupReadOnly();
      const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));
      const tablePda = getTablePda(dbRoot, toSeedBytes(REGISTRY_HINT));
      const entries = (await gwFetchAllRows(tablePda.toBase58(), Number(opts.limit))) as unknown as RegistryEntry[];
      if (entries.length === 0) {
        ui.log.dim("registry empty");
        return;
      }
      for (const e of entries) {
        ui.log.info(`${e.owner.slice(0, 8)}…/${e.repo}  ${e.description ?? ""}`);
      }
    });
}
