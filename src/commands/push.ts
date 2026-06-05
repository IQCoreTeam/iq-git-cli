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

import type { Keypair } from "@solana/web3.js";
import type { Command } from "commander";
import {
  uploadBlob,
  uploadTree,
  writeCommit,
  type Commit,
  type FileTree,
  type SessionSpeed,
} from "@iqlabs-official/git-sdk/node";

import * as repo from "../core/repo";
import { readGlobalConfig, setup } from "../setup";
import * as ui from "../ui";

const SPEEDS = ["light", "medium", "heavy", "extreme"] as const;

interface PushOpts {
  speed?: string;
  rps?: string;
  concurrency?: string;
  concurrencyUpload?: string;
}

export function register(program: Command): void {
  program
    .command("push")
    .option(
      "-s, --speed <preset>",
      `upload speed preset (${SPEEDS.join("|")}); overrides config.speed`,
    )
    .option(
      "--rps <n>",
      "raw maxRps override (wins over preset for this run)",
    )
    .option(
      "--concurrency <n>",
      "raw maxConcurrency override",
    )
    .option(
      "--concurrency-upload <n>",
      "raw maxConcurrencyUpload override (chunk-fanout concurrency)",
    )
    .action(async (opts: PushOpts) => {
      const cwd = repo.findRepoRoot();
      const cfg = repo.readConfig(cwd);
      const queue = repo.listPending(cwd);
      if (queue.length === 0) {
        ui.log.info("nothing to push");
        return;
      }
      const speed = resolveSpeed(opts);
      const { signer } = await setup();

      for (const p of queue) {
        ui.log.info(`pushing ${p.meta.id.slice(0, 7)} "${p.meta.message}"`);
        try {
          await pushOne(signer, cwd, cfg.repo, p, speed);
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

function resolveSpeed(opts: PushOpts): SessionSpeed | undefined {
  const cfg = readGlobalConfig();
  // Raw dial overrides build an object; missing keys fall back to whatever
  // preset is active (CLI flag → config.speed → SDK default).
  const overrides = parseRawOverrides(opts, cfg);
  if (overrides) return overrides;

  const raw = opts.speed ?? cfg.speed;
  if (!raw) return undefined;
  if (!(SPEEDS as readonly string[]).includes(raw)) {
    ui.fail(`invalid speed: ${raw}\nallowed: ${SPEEDS.join(", ")}`);
  }
  return raw as SessionSpeed;
}

function parseRawOverrides(
  opts: PushOpts,
  cfg: ReturnType<typeof readGlobalConfig>,
): SessionSpeed | undefined {
  const out: { maxRps?: number; maxConcurrency?: number; maxConcurrencyUpload?: number } = {};
  const flagRps = opts.rps ?? cfg.rps;
  const flagCc = opts.concurrency ?? cfg.concurrency;
  const flagCcu = opts.concurrencyUpload ?? cfg.concurrencyUpload;
  if (flagRps !== undefined) out.maxRps = parsePositiveInt("rps", flagRps);
  if (flagCc !== undefined) out.maxConcurrency = parsePositiveInt("concurrency", flagCc);
  if (flagCcu !== undefined) out.maxConcurrencyUpload = parsePositiveInt("concurrency-upload", flagCcu);
  return Object.keys(out).length === 0 ? undefined : out;
}

function parsePositiveInt(name: string, raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    ui.fail(`invalid ${name}: ${raw} (must be a positive integer)`);
  }
  return n;
}

async function pushOne(
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
      const { txId } = await uploadBlob(signer, path, base64, {}, undefined, speed);
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
    treeTxId = await uploadTree(signer, newTree, speed);
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
    const sig = await writeCommit(signer, repoName, commit);
    repo.updatePendingMeta(p, { committedSig: sig });
    // SDK's writeCommit already calls notifyGateways internally.
  }
}
