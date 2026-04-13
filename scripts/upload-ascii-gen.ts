/**
 * Upload the IQ_ASCII_GENERATOR repository to on-chain git via the iq-git CLI's GitService.
 *
 * Network: mainnet-beta (default) or override with RPC env var.
 * Wallet:  ~/.config/solana/id.json (FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c)
 *
 * Usage:
 *   # dry run (no tx, just print what would happen)
 *   DRY_RUN=1 npx tsx scripts/upload-ascii-gen.ts
 *
 *   # real run on mainnet
 *   npx tsx scripts/upload-ascii-gen.ts
 *
 *   # devnet rehearsal
 *   RPC=https://api.devnet.solana.com npx tsx scripts/upload-ascii-gen.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";

const REPO_SRC = "/Users/sumin/WebstormProjects/IQ_ASCII_GENERATOR";
const REPO_NAME = "IQ_ASCII_GENERATOR";
const REPO_DESC = "ASCII art generator — uploaded to on-chain git";

async function main() {
    const rpc =
        process.env.RPC ||
        process.env.SOLANA_RPC_ENDPOINT ||
        "https://api.mainnet-beta.solana.com";
    process.env.SOLANA_RPC_ENDPOINT = rpc;

    console.log(`[upload-ascii-gen] RPC: ${rpc}`);
    console.log(`[upload-ascii-gen] Source dir: ${REPO_SRC}`);

    if (!fs.existsSync(REPO_SRC)) {
        throw new Error(`Source repo not found: ${REPO_SRC}`);
    }

    // GitService reads process.cwd() for file scanning, so chdir into the repo.
    process.chdir(REPO_SRC);
    console.log(`[upload-ascii-gen] cwd -> ${process.cwd()}`);

    const { GitService } = await import("../src/git-service.js");
    const svc = new GitService();
    const wallet = svc.signer.publicKey.toBase58();
    console.log(`[upload-ascii-gen] Wallet: ${wallet}`);

    // Check balance up front
    const lamports = await svc.connection.getBalance(svc.signer.publicKey);
    console.log(
        `[upload-ascii-gen] Balance: ${(lamports / 1e9).toFixed(6)} SOL`,
    );
    if (lamports < 0.02 * 1e9) {
        console.warn(
            `[upload-ascii-gen] ⚠️  Balance is low (<0.02 SOL). ensureInfrastructure alone may fail partway.`,
        );
    }

    if (process.env.DRY_RUN) {
        const files = fs
            .readdirSync(REPO_SRC)
            .filter((f) => !f.startsWith("."))
            .map((f) => {
                const full = path.join(REPO_SRC, f);
                const stat = fs.statSync(full);
                return {
                    name: f,
                    size: stat.size,
                    isDir: stat.isDirectory(),
                };
            });
        console.log("[upload-ascii-gen] DRY_RUN — files that would be tracked:");
        for (const f of files) {
            console.log(
                `  ${f.isDir ? "DIR " : "FILE"} ${f.name.padEnd(30)} ${f.size} bytes`,
            );
        }
        console.log("\n[upload-ascii-gen] DRY_RUN complete. No transactions sent.");
        return;
    }

    // Step 1: createRepo — this will:
    //   a) initialize db_root if not present
    //   b) ensureTable for all git tables (repos, commits, refs, collaborators, forks)
    //   c) writer.writeRow into the repos table
    console.log(
        `\n[upload-ascii-gen] STEP 1/2 — createRepo('${REPO_NAME}') — this creates tables + writes repo row`,
    );
    try {
        await svc.createRepo(REPO_NAME, REPO_DESC, /* isPublic */ true);
    } catch (e: any) {
        // If the repo already exists, createRepo will just add another row (it doesn't dedupe).
        // Any other failure we re-throw.
        console.error(`[upload-ascii-gen] createRepo failed: ${e.message}`);
        throw e;
    }

    // Step 2: commit — this will:
    //   a) chunk every file in cwd and call writer.codeIn (skipping .gitignored files)
    //   b) upload the file-tree manifest as its own codeIn tx
    //   c) writer.writeRow a commit row into the commits table
    console.log(
        `\n[upload-ascii-gen] STEP 2/2 — commit('${REPO_NAME}', 'initial upload')`,
    );
    await svc.commit(REPO_NAME, "initial upload");

    console.log(`\n[upload-ascii-gen] ✅ Upload complete!`);
    console.log(
        `[upload-ascii-gen] View at: https://git.iqlabs.dev/${wallet}/${REPO_NAME}`,
    );

    // Post-check: list commits
    const logs = await svc.getLog(REPO_NAME);
    console.log(`\n[upload-ascii-gen] Commit history (${logs.length} entries):`);
    for (const c of logs) {
        console.log(
            `  ${c.id.slice(0, 8)}  ${new Date(c.timestamp).toISOString()}  ${c.message}`,
        );
    }
}

main().catch((e) => {
    console.error("\n❌ upload failed:", e);
    process.exit(1);
});
