import * as fs from "node:fs";
import * as path from "node:path";
import os from "node:os";
import { Connection, Keypair } from "@solana/web3.js";

const DEFAULT_RPC_ENDPOINT =
    process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

// Check for local keypair.json first, then env var, then default solana cli keypair
const resolveKeypairPath = (): string => {
    const localKeypair = path.join(process.cwd(), "keypair.json");
    if (fs.existsSync(localKeypair)) return localKeypair;
    if (process.env.SOLANA_KEYPAIR_PATH) return process.env.SOLANA_KEYPAIR_PATH;
    return path.join(os.homedir(), ".config", "solana", "id.json");
};

const loadKeypair = (keypairPath: string): Keypair => {
    const raw = fs.readFileSync(keypairPath, "utf8");
    const secret = JSON.parse(raw);
    if (!Array.isArray(secret)) {
        throw new Error(`Invalid keypair file: ${keypairPath}`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(secret));
};

export const getWalletCtx = (mode: "web" | "command" = "command") => {
    if (mode === "web") {
        if (typeof require !== "function") {
            throw new Error("Web mode requires wallet-adapter with bundler support.");
        }
        const adapter = require("@solana/wallet-adapter-react") as any;
        if (!adapter.useConnection || !adapter.useWallet) {
            throw new Error("wallet-adapter hooks not available.");
        }
        const { connection } = adapter.useConnection();
        const wallet = adapter.useWallet();
        return { connection, signer: wallet };
    }

    const keypairPath = resolveKeypairPath();
    if (!fs.existsSync(keypairPath)) {
        throw new Error(`Keypair not found: ${keypairPath}`);
    }

    const signer = loadKeypair(keypairPath);
    const connection = new Connection(DEFAULT_RPC_ENDPOINT, "confirmed");

    return { connection, signer };
};
