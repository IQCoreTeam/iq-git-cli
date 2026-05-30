// `iqgit push` — drains .iqgit/pending/ to chain. The single most
// involved command; everything else is short. Resume-safe by design.
//
//   in:  (no flags in v1; --dry-run could be added later)
//   sdk: NOT GitClient.commit() directly — we re-implement the workflow
//        because we need granular cache between blob/tree/row steps.
//        Per pending commit, we call the SDK's layer-level fns
//        (re-exported from the SDK root entry as of 2026-05-05):
//          • uploadBlob(connection, signer, relativePath, base64, reuse, onProgress?)
//              — per blob. We pass `reuse={}` because our upload-cache
//                already filtered hits before the call.
//          • uploadTree(connection, signer, tree)
//              — once per pending commit, after all blobs done.
//          • writeCommit(connection, signer, repoName, commit)
//              — once per pending commit, last step.
//
// Resume invariants:
//   • A blob's cache entry is written ONLY after uploadBlob returns.
//   • Tree's txId is persisted into pending/NNN/meta.json BEFORE writing
//     the commit row. If row write fails, next push reuses the tree.
//   • Commit row's signature is persisted into meta.json BEFORE deleting
//     the pending dir. If we crash between those two, next push sees
//     committedSig present and just cleans up + advances HEAD.

import type { Connection, Keypair } from "@solana/web3.js";
import type { Command } from "commander";
import { IQGIT_ROOT_ID,
  commitTableHint,
  uploadBlob,
  uploadTree,
  writeCommit,
  type Commit,
  type FileTree,
  type SessionSpeed,
} from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";
import { gwNotify } from "../core/gateway";

import * as repo from "../core/repo";
import { readGlobalConfig, setup } from "../setup";
import * as ui from "../ui";

const SPEEDS = ["light", "medium", "heavy", "extreme"] as const;

export function register(program: Command): void {
  program
    .command("push")
    .option(
      "-s, --speed <preset>",
      `upload speed preset (${SPEEDS.join("|")}); overrides config.speed`,
    )
    .action(async (opts: { speed?: string }) => {
      const cwd = repo.findRepoRoot();
      const cfg = repo.readConfig(cwd);
      const queue = repo.listPending(cwd);
      if (queue.length === 0) {
        ui.log.info("nothing to push");
        return;
      }
      const speed = resolveSpeed(opts.speed);
      const { signer, connection } = await setup();

      for (const p of queue) {
        ui.log.info(`pushing ${p.meta.id.slice(0, 7)} "${p.meta.message}"`);
        try {
          await pushOne(connection, signer, cwd, cfg.repo, p, speed);
        } catch (e) {
          ui.fail(
            `failed at ${p.meta.id.slice(0, 7)}: ${(e as Error).message}\n` +
              `re-run "iqgit push" to resume.`,
          );
        }
        repo.writeHead(cwd, p.meta.id);
        repo.discardPending(p);
        ui.log.success(`  pushed ${p.meta.id.slice(0, 7)}`);
      }
    });
}

function resolveSpeed(flag: string | undefined): SessionSpeed | undefined {
  const raw = flag ?? readGlobalConfig().speed;
  if (!raw) return undefined;
  if (!(SPEEDS as readonly string[]).includes(raw)) {
    ui.fail(`invalid speed: ${raw}\nallowed: ${SPEEDS.join(", ")}`);
  }
  return raw as SessionSpeed;
}

async function pushOne(
  connection: Connection,
  signer: Keypair,
  cwd: string,
  repoName: string,
  p: repo.PendingCommit,
  speed: SessionSpeed | undefined,
): Promise<void> {
  const tree = repo.readPendingTree(p);
  const newTree: FileTree = {};

  // ---- 1. blobs ----
  const total = Object.keys(tree).length;
  const sp = ui.spinner(`  blobs 0/${total}`).start();
  let done = 0;
  let reused = 0;

  for (const [path, { hash }] of Object.entries(tree)) {
    const cached = repo.cacheGet(cwd, hash);
    if (cached) {
      newTree[path] = { txId: cached.txId, hash };
      reused++;
    } else {
      const base64 = repo.readPendingBlob(p, hash);
      const { txId } = await uploadBlob(connection, signer, path, base64, {}, undefined, speed);
      repo.cacheSet(cwd, hash, { txId, uploadedAt: Date.now() });
      newTree[path] = { txId, hash };
    }
    done++;
    sp.text = `  blobs ${done}/${total} (${reused} reused)`;
  }
  sp.succeed(`  blobs ${done}/${total} (${reused} reused)`);

  // ---- 2. tree ----
  let treeTxId = p.meta.treeTxId;
  if (!treeTxId) {
    treeTxId = await uploadTree(connection, signer, newTree, speed);
    repo.updatePendingMeta(p, { treeTxId });
  }

  // ---- 3. commit row ----
  if (!p.meta.committedSig) {
    const commit: Commit = {
      id: p.meta.id,
      message: p.meta.message,
      treeTxId,
      parentCommitId: p.meta.parentCommitId ?? undefined,
      timestamp: p.meta.timestamp,
      author: p.meta.author,
    };
    const sig = await writeCommit(connection, signer, repoName, commit);
    repo.updatePendingMeta(p, { committedSig: sig });
    // Cache warm hint to gateway — fire-and-forget, gateway will pull tx
    // on its own anyway.
    const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));
    const tablePda = getTablePda(dbRoot, toSeedBytes(commitTableHint(commit.author, repoName)));
    void gwNotify(tablePda.toBase58(), sig, undefined, signer.publicKey.toBase58());
  }
}
