/**
 * Upload ANY local folder as an on-chain git repo.
 *
 * Usage:
 *   npx tsx scripts/upload-any.ts <folder> [repo-name] [commit-message]
 *
 * Examples:
 *   npx tsx scripts/upload-any.ts /Users/sumin/WebstormProjects/my-project
 *   npx tsx scripts/upload-any.ts ~/code/foo foo-repo
 *   npx tsx scripts/upload-any.ts ~/code/foo foo-repo "initial commit"
 *
 * Env vars (loaded from iq-git/.env automatically if present):
 *   SOLANA_RPC_ENDPOINT or RPC  — RPC url (default: mainnet-beta public)
 *   DRY_RUN=1                   — list files that would be tracked, no tx
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the iq-git project root (one level up from scripts/)
// so process.env.SOLANA_RPC_ENDPOINT is populated before GitService reads it.
function loadDotEnv() {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
    }
}
loadDotEnv();

async function main() {
    const [, , folderArg, nameArg, messageArg] = process.argv;

    if (!folderArg) {
        console.error("Usage: npx tsx scripts/upload-any.ts <folder> [repo-name] [commit-message]");
        process.exit(1);
    }

    // expand ~
    const folder = folderArg.startsWith("~")
        ? path.join(process.env.HOME || "", folderArg.slice(1))
        : path.resolve(folderArg);

    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        throw new Error(`Not a directory: ${folder}`);
    }

    const repoName = nameArg || path.basename(folder);
    const commitMessage = messageArg || "initial upload";

    const rpc =
        process.env.RPC ||
        process.env.SOLANA_RPC_ENDPOINT ||
        "https://api.mainnet-beta.solana.com";
    process.env.SOLANA_RPC_ENDPOINT = rpc;

    console.log(`[upload-any] RPC:         ${rpc}`);
    console.log(`[upload-any] Source:      ${folder}`);
    console.log(`[upload-any] Repo name:   ${repoName}`);
    console.log(`[upload-any] Commit msg:  ${commitMessage}`);

    // GitService reads process.cwd() for file scanning, so chdir into the repo.
    process.chdir(folder);

    const { GitService } = await import("../src/git-service.js");
    const svc = new GitService();
    const wallet = svc.signer.publicKey.toBase58();
    console.log(`[upload-any] Wallet:      ${wallet}`);

    const lamports = await svc.connection.getBalance(svc.signer.publicKey);
    const sol = lamports / 1e9;
    console.log(`[upload-any] Balance:     ${sol.toFixed(6)} SOL`);
    if (lamports < 0.02 * 1e9) {
        console.warn(`[upload-any] ⚠️  Low balance (<0.02 SOL) — may fail partway`);
    }

    if (process.env.DRY_RUN) {
        console.log("\n[upload-any] DRY_RUN — scanning files...");
        const files = listFilesRecursive(folder, folder);
        let total = 0;
        for (const f of files) {
            const full = path.join(folder, f);
            const size = fs.statSync(full).size;
            total += size;
            console.log(`  ${size.toString().padStart(8)}  ${f}`);
        }
        console.log(`\n[upload-any] ${files.length} files, ${total} bytes total`);
        console.log("[upload-any] DRY_RUN complete. No transactions sent.");
        return;
    }

    console.log(`\n[upload-any] STEP 1/2 — createRepo('${repoName}')`);
    await svc.createRepo(repoName, `Uploaded via upload-any.ts`, /* isPublic */ true);

    console.log(`\n[upload-any] STEP 2/2 — commit('${repoName}', '${commitMessage}')`);
    await svc.commit(repoName, commitMessage);

    console.log(`\n[upload-any] ✅ Upload complete!`);
    console.log(`[upload-any] View: https://git.iqlabs.dev/${wallet}/${repoName}`);

    const logs = await svc.getLog(repoName);
    console.log(`\n[upload-any] Commit history (${logs.length}):`);
    for (const c of logs) {
        console.log(`  ${c.id.slice(0, 8)}  ${new Date(c.timestamp).toISOString()}  ${c.message}`);
    }
}

function listFilesRecursive(dir: string, rootDir: string): string[] {
    const out: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...listFilesRecursive(full, rootDir));
        } else if (e.isFile()) {
            out.push(path.relative(rootDir, full));
        }
    }
    return out;
}

main().catch((e) => {
    console.error("\n❌ upload failed:", e);
    process.exit(1);
});
