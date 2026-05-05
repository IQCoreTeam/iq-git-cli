// Tree resolution shared by commit / status. Pure logic over local pending
// state and chain reads — no commands here, no UI.
//
// `Tree` is the shape stored in pending/<id>/tree.json: {hash, size}.
// SDK's FileTree adds txId; we strip it on the way in (size=0 placeholder
// since tree.json sizes are display-only — the real size comes from the
// working tree when a path is restaged).

import type { Connection } from "@solana/web3.js";
import { loadTree, readCommitHistory } from "@iqlabs-official/git-sdk/node";
import * as repo from "./repo";

export type Tree = Record<string, { hash: string; size: number }>;

// Resolve the base tree against which a new commit (or status diff) layers:
//   1. last pending's tree.json   (purely local, no chain call), else
//   2. on-chain tree at HEAD      (one read), else
//   3. {} for a brand-new repo.
//
// `connection` is only consulted for case 2; pass null and the function
// will throw if it actually needs to fetch.
export async function resolveBaseTree(
  cwd: string,
  owner: string,
  repoName: string,
  connection: Connection | null,
): Promise<Tree> {
  const last = repo.listPending(cwd).at(-1);
  if (last) return repo.readPendingTree(last);

  const head = repo.readHead(cwd);
  if (head === null) return {};

  if (!connection) {
    throw new Error("base tree on chain — caller must provide a connection");
  }
  const history = await readCommitHistory(connection, owner, repoName);
  const headCommit = history.find((c) => c.id === head);
  if (!headCommit) {
    throw new Error(`HEAD ${head.slice(0, 7)} not found in on-chain history`);
  }
  const onChain = await loadTree(headCommit.treeTxId);
  const out: Tree = {};
  for (const [p, entry] of Object.entries(onChain)) {
    out[p] = { hash: entry.hash, size: 0 };
  }
  return out;
}
