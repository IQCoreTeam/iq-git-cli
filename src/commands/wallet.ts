// `iqgit wallet <action>` — manage keypair. Multiple actions in one file
// (CODE-RULES §1: don't fan out into wallet/new.ts, wallet/show.ts ...
// when each is 10 lines).
//
//   in:  iqgit wallet new       → generate Keypair, save to ~/.iq-git/wallets/default.json
//        iqgit wallet show      → print pubkey + path
//        iqgit wallet balance   → print SOL balance
//        iqgit wallet repos     → list repos owned by current pubkey
//   sdk: readOwnerRepos (for `repos` action)
//   out: stdout

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readOwnerRepos } from "@iqlabs-official/git-sdk/node";
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
  const { signer, connection } = await setup();
  const lamports = await connection.getBalance(signer.publicKey);
  ui.log.info(signer.publicKey.toBase58());
  ui.log.info(`${lamports / LAMPORTS_PER_SOL} SOL`);
}

async function walletRepos(): Promise<void> {
  const { signer, connection } = await setup();
  const repos = await readOwnerRepos(connection, signer.publicKey.toBase58());
  if (repos.length === 0) {
    ui.log.dim("no repos yet");
    return;
  }
  for (const r of repos) {
    const visibility = r.isPublic ? "public " : "private";
    ui.log.info(`${visibility}  ${r.name}  ${r.description}`);
  }
}
