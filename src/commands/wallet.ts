// `iqgit wallet <action>` — manage keypair. Multiple actions in one file
// (CODE-RULES §1: don't fan out into wallet/new.ts, wallet/show.ts ...
// when each is 10 lines).
//
//   in:  iqgit wallet new       → generate Keypair, save to ~/.iq-git/wallets/default.json
//        iqgit wallet show      → print pubkey + path
//        iqgit wallet balance   → print SOL balance
//        iqgit wallet repos     → list repos owned by current pubkey
//   reads: gwFetchAllRows on git_repos_v2_<owner> (for `repos` action)
//   out: stdout

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import chalk from "chalk";
import {
  IQGIT_ROOT_ID,
  commitTableHint,
  listPagesDeployments,
  repoListHint,
} from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";
import { gwFetchAllRows } from "../core/gateway";

// Where a deployed repo's on-chain page lives. Its base58 path segment is the
// repo's git_commits table PDA; the wide-web resolver turns that into the site.
const BROWSER_BASE = "https://browser.iqlabs.dev";
import { DEFAULT_WALLET, loadKeypairFromFile, readGlobalConfig, setup } from "../setup";

import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("wallet <action>")
    .description("new | show | balance | repos")
    .action(async (action: string) => {
      switch (action) {
        case "new":
          return walletNew();
        case "show":
          return walletShow();
        case "balance":
          return walletBalance();
        case "repos":
          return walletRepos();
        default:
          ui.fail(`unknown action: ${action}`);
      }
    });
}

function walletNew(): void {
  if (existsSync(DEFAULT_WALLET)) {
    ui.fail(`default wallet exists at ${DEFAULT_WALLET}; remove it first`);
  }
  mkdirSync(dirname(DEFAULT_WALLET), { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(DEFAULT_WALLET, JSON.stringify(Array.from(kp.secretKey)));
  ui.log.success(`created ${DEFAULT_WALLET}`);
  ui.log.info(`pubkey: ${kp.publicKey.toBase58()}`);
}

function walletShow(): void {
  const path = readGlobalConfig().walletPath ?? DEFAULT_WALLET;
  const kp = loadKeypairFromFile(path);
  ui.log.info(`path:   ${path}`);
  ui.log.info(`pubkey: ${kp.publicKey.toBase58()}`);
}

async function walletBalance(): Promise<void> {
  const { connection, chain, address } = await setup();
  if (chain === "eth") {
    ui.log.info(address);
    ui.log.info("(EVM wallet — check ETH balance on a block explorer)");
    return;
  }
  const lamports = await (connection as Connection).getBalance(new PublicKey(address));
  ui.log.info(address);
  ui.log.info(`${lamports / LAMPORTS_PER_SOL} SOL`);
}

async function walletRepos(): Promise<void> {
  const { chain, address } = await setup();
  if (chain === "eth") {
    ui.fail("iqgit wallet repos: not supported on EVM yet");
  }
  // Gateway-first read of git_repos_v2_<owner>; falls through to RPC.
  const owner = address;
  const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));
  const tablePda = getTablePda(dbRoot, toSeedBytes(repoListHint(owner)));
  const repos = (await gwFetchAllRows(tablePda.toBase58(), 200)) as Array<{
    name: string; description: string; isPublic: boolean;
  }>;
  if (repos.length === 0) {
    ui.log.dim("no repos yet");
    return;
  }

  // Which of these repos are live on iq-pages? Only those get a browser URL.
  // One gallery read covers every owner; filter to this wallet's deploys.
  const deployments = await listPagesDeployments();
  const deployedRepos = new Set(
    deployments.filter((d) => d.owner === owner).map((d) => d.repo),
  );

  for (const r of repos) {
    const visibility = r.isPublic ? "public " : "private";
    let line = `${visibility}  ${r.name}  ${r.description}`;
    if (deployedRepos.has(r.name)) {
      const pda = getTablePda(dbRoot, toSeedBytes(commitTableHint(owner, r.name)));
      line += `  ${chalk.cyan(`→ ${BROWSER_BASE}/${pda.toBase58()}`)}`;
    }
    ui.log.info(line);
  }
}
