// Tree resolution shared by commit / status. Pure logic over local pending
// state and chain reads — no commands here, no UI.
//
// `Tree` is the shape stored in pending/<id>/tree.json: {hash, size}.
// SDK's FileTree adds txId; we strip it on the way in (size=0 placeholder
// since tree.json sizes are display-only — the real size comes from the
// working tree when a path is restaged).

import {
  IQGIT_ROOT_ID,
  commitTableHint,
} from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";
import { gwFetchAllRows, gwLoadTreeJson } from "./gateway";
import * as repo from "./repo";

export type Tree = Record<string, { hash: string; size: number }>;

// Resolve the base tree against which a new commit (or status diff) layers:
//   1. last pending's tree.json   (purely local), else
//   2. on-chain tree at HEAD      (gwFetchRows + gwLoadTreeJson), else
//   3. {} for a brand-new repo.
//
// Both chain reads route through gateway when GATEWAY_URL is set, falling
// back to RPC transparently. The SDK's RPC connection must be initialized
// (via iqlabs.setRpcUrl) before this is called — setup.ts handles that.
export async function resolveBaseTree(
  cwd: string,
  owner: string,
  repoName: string,
): Promise<Tree> {
  const last = repo.listPending(cwd).at(-1);
  if (last) return repo.readPendingTree(last);

  const head = repo.readHead(cwd);
  if (head === null) return {};

  const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));
  const commitTable = getTablePda(dbRoot, toSeedBytes(commitTableHint(owner, repoName)));
  const history = (await gwFetchAllRows(commitTable.toBase58(), 200)) as Array<{
    id: string;
    treeTxId: string;
  }>;

  const headCommit = history.find((c) => c.id === head);
  if (!headCommit) {
    throw new Error(`HEAD ${head.slice(0, 7)} not found in on-chain history`);
  }
  const onChain = await gwLoadTreeJson<Record<string, { txId: string; hash: string }>>(headCommit.treeTxId);
  const out: Tree = {};
  for (const [p, entry] of Object.entries(onChain)) {
    out[p] = { hash: entry.hash, size: 0 };
  }
  return out;
}
