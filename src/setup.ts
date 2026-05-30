// Pre-flight gate for every write command. Read-only commands skip it
// (clone, log, registry, restore-against-someone-else's-repo).
//
// Returns a ready-to-use GitClient. Centralized here so commands don't
// duplicate wallet/RPC validation. (CODE-RULES §2 — single source of truth.)
//
//   sdk: new GitClient({ connection, signer })
//        ↑ imported from "@iqlabs-official/git-sdk/node" so the
//          node:crypto SHA-256 backend is wired (required before any
//          commit/status/etc that hashes content).
//
// Side effects:
//   • creates ~/.iq-git/ on first run
//   • may write to ~/.iq-git/config.json (rpcUrl) and wallets/default.json
//   • may write SOLANA_RPC_ENDPOINT into ~/.iq-git/.env

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import iqlabs from "@iqlabs-official/solana-sdk";
import { GitClient } from "@iqlabs-official/git-sdk/node";
import { config as loadEnv } from "dotenv";
import * as ui from "./ui";

const HOME_DIR = join(homedir(), ".iq-git");
const ENV_PATH = join(HOME_DIR, ".env");
const CONFIG_PATH = join(HOME_DIR, "config.json");
export const DEFAULT_WALLET = join(HOME_DIR, "wallets", "default.json");
const HELIUS_URL = "https://www.helius.dev/";

interface GlobalConfig {
  walletPath?: string;
  rpcUrl?: string;
  /** Default solana-sdk session speed used for blob/tree uploads on push.
   *  Overridable per call with `iqgit push --speed <preset>`. */
  speed?: "light" | "medium" | "heavy" | "extreme";
}

export interface SetupResult {
  client: GitClient;
  signer: Keypair;
  connection: Connection;
}

export async function setup(): Promise<SetupResult> {
  mkdirSync(HOME_DIR, { recursive: true });
  loadEnv({ path: ENV_PATH });

  const signer = await loadOrCreateWallet();
  const rpcUrl = await loadOrPromptRpc();
  iqlabs.setRpcUrl(rpcUrl);
  const connection = new Connection(rpcUrl, "confirmed");
  await healthCheck(connection);
  await maybeWarnBalance(connection, signer);

  return { client: new GitClient({ connection, signer }), signer, connection };
}

// Read-only path for commands that only need to fetch from chain
// (e.g. commit's base tree, log, registry). Skips wallet prompts AND
// the RPC health check — when gateway is set, we may never hit the RPC,
// so a bogus RPC URL shouldn't fail-fast. The actual RPC call (via SDK
// fallback) will surface its own error if it ever runs.
export async function setupReadOnly(): Promise<Connection> {
  mkdirSync(HOME_DIR, { recursive: true });
  loadEnv({ path: ENV_PATH });
  const rpcUrl = await loadOrPromptRpc();
  iqlabs.setRpcUrl(rpcUrl);
  return new Connection(rpcUrl, "confirmed");
}

async function loadOrCreateWallet(): Promise<Keypair> {
  const cfg = readGlobalConfig();
  let path = cfg.walletPath;

  if (!path || !existsSync(path)) {
    const choice = await ui.select({
      message: "No Solana keypair configured. What would you like to do?",
      choices: [
        { name: "Generate a new keypair", value: "new" as const },
        { name: "Use an existing keypair file", value: "existing" as const },
      ],
    });
    if (choice === "new") {
      mkdirSync(dirname(DEFAULT_WALLET), { recursive: true });
      const kp = Keypair.generate();
      writeFileSync(DEFAULT_WALLET, JSON.stringify(Array.from(kp.secretKey)));
      ui.log.success(`Created ${DEFAULT_WALLET}`);
      ui.log.info(`pubkey: ${kp.publicKey.toBase58()}`);
      writeGlobalConfig({ ...cfg, walletPath: DEFAULT_WALLET });
      return kp;
    }
    path = await ui.input({ message: "Path to keypair JSON file:" });
    writeGlobalConfig({ ...cfg, walletPath: path });
  }

  return loadKeypairFromFile(path);
}

// Single source of truth for parsing a Solana keypair JSON file. Used by
// setup() above and wallet.ts:walletShow (CODE-RULES §2).
export function loadKeypairFromFile(path: string): Keypair {
  try {
    const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (e) {
    ui.fail(`Invalid keypair at ${path}: ${(e as Error).message}`);
  }
}

async function loadOrPromptRpc(): Promise<string> {
  const cfg = readGlobalConfig();
  const url = process.env.SOLANA_RPC_ENDPOINT ?? cfg.rpcUrl;
  if (url) return url;

  ui.log.warn("No Solana RPC endpoint configured.");
  ui.log.info(`Get a free RPC URL from Helius: ${HELIUS_URL}`);
  const entered = await ui.input({ message: "Paste your RPC URL:" });
  appendEnv("SOLANA_RPC_ENDPOINT", entered);
  writeGlobalConfig({ ...cfg, rpcUrl: entered });
  return entered;
}

async function healthCheck(connection: Connection): Promise<void> {
  try {
    await connection.getLatestBlockhash();
  } catch (e) {
    ui.fail(`RPC health check failed: ${(e as Error).message}`);
  }
}

async function maybeWarnBalance(connection: Connection, signer: Keypair): Promise<void> {
  const lamports = await connection.getBalance(signer.publicKey);
  if (lamports >= 0.01 * LAMPORTS_PER_SOL) return;
  ui.log.warn(
    `Low balance: ${lamports / LAMPORTS_PER_SOL} SOL on ${signer.publicKey.toBase58()}`,
  );
  ui.log.dim("On-chain writes need SOL — fund the address before pushing.");
}

// Exported because commands/config.ts edits the same file. Single source
// of truth for shape + path (CODE-RULES §2).
export function readGlobalConfig(): GlobalConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as GlobalConfig;
  } catch {
    return {};
  }
}

export function writeGlobalConfig(cfg: GlobalConfig): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function appendEnv(key: string, value: string): void {
  const line = `${key}=${value}\n`;
  let existing = "";
  try {
    existing = readFileSync(ENV_PATH, "utf8");
  } catch {
    // first write
  }
  const stripped = existing
    .split("\n")
    .filter((l) => !l.startsWith(`${key}=`))
    .join("\n");
  writeFileSync(ENV_PATH, stripped.endsWith("\n") || !stripped ? stripped + line : `${stripped}\n${line}`);
  process.env[key] = value;
}
