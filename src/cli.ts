// Entry point. Wires commander, registers every command in `commands/`,
// and dispatches to them. The only file that touches process.argv directly.
//
// SDK dependency: "@iqlabs-official/git-sdk" >= 0.1.4
//   0.1.4 is the first version that re-exports the write-side layer fns
//   (uploadBlob, uploadTree, writeCommit) which push.ts depends on.

import { Command } from "commander";
import { register as initCmd } from "./commands/init";
import { register as createCmd } from "./commands/create";
import { register as addCmd } from "./commands/add";
import { register as resetCmd } from "./commands/reset";
import { register as commitCmd } from "./commands/commit";
import { register as pushCmd } from "./commands/push";
import { register as cloneCmd } from "./commands/clone";
import { register as restoreCmd } from "./commands/restore";
import { register as logCmd } from "./commands/log";
import { register as statusCmd } from "./commands/status";
import { register as registryCmd } from "./commands/registry";
import { register as configCmd } from "./commands/config";
import { register as walletCmd } from "./commands/wallet";
import { register as pagesCmd } from "./commands/pages";

const NETWORKS = "devnet|mainnet|eth|sepolia|monad|monadTestnet";

const program = new Command("iqgit")
  .description("On-chain Git for Solana and EVM")
  .version("0.1.0")
  .option(
    "-n, --network <token>",
    `chain/network to use (${NETWORKS}); overrides IQGIT_NETWORK and config.network`,
  )
  .hook("preAction", () => {
    const token = program.opts().network as string | undefined;
    if (token) process.env.IQGIT_NETWORK = token;
  });

initCmd(program);
createCmd(program);
addCmd(program);
resetCmd(program);
commitCmd(program);
pushCmd(program);
cloneCmd(program);
restoreCmd(program);
logCmd(program);
statusCmd(program);
registryCmd(program);
configCmd(program);
walletCmd(program);
pagesCmd(program);

program.parseAsync(process.argv);
