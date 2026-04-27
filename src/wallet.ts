// Keypair + connection loader for CLI context.
//
// Resolution order (same as v1 CLI):
//   1. ./keypair.json in cwd
//   2. $SOLANA_KEYPAIR_PATH
//   3. ~/.config/solana/id.json
// RPC from SOLANA_RPC_ENDPOINT, default mainnet.

import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { Connection, Keypair } from "@solana/web3.js";

function resolveKeypairPath(): string {
  const local = path.join(process.cwd(), "keypair.json");
  if (fs.existsSync(local)) return local;
  if (process.env.SOLANA_KEYPAIR_PATH) return process.env.SOLANA_KEYPAIR_PATH;
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

export function loadWalletCtx(): { connection: Connection; signer: Keypair } {
  const keypairPath = resolveKeypairPath();
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Keypair not found: ${keypairPath}`);
  }
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  if (!Array.isArray(secret)) {
    throw new Error(`Invalid keypair file: ${keypairPath}`);
  }
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const rpc =
    process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");
  return { connection, signer };
}
