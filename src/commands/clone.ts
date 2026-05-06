// `iqgit clone <owner>/<repo> [dir]` — pulls latest snapshot to disk.
// Read-only and anonymous: no wallet required. Cloning a public repo
// only needs an RPC (for SDK fallback) and optionally a gateway.
//
//   in:  <owner>/<repo>, optional [dir] (default = repo name)
//   reads (gateway-first, RPC fallback):
//     gwFetchAllRows on git_commits:<owner>:<repo>  → newest commit row
//     gwLoadTreeJson on commit.treeTxId             → tree.json
//     gwLoadBlobBase64 per file txId                → file bytes
//     gwFetchAllRows on git_repos_v2_<owner>        → isPublic for config
//   out: directory tree on disk + initialized .iqgit/ with HEAD set so
//        future `status` / `commit` work without re-resolving.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import type { Command } from "commander";
import {
  IQGIT_ROOT_ID,
  commitTableHint,
  repoListHint,
} from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";
import * as repo from "../core/repo";
import { gwFetchAllRows, gwLoadBlobBase64, gwLoadTreeJson } from "../core/gateway";
import { setupReadOnly } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("clone <slug> [dir]")
    .action(async (slug: string, dir: string | undefined) => {
      const [owner, repoName] = slug.split("/");
      if (!owner || !repoName) ui.fail("expected <owner>/<repo>");
      const target = dir ?? repoName;
      if (existsSync(target)) ui.fail(`${target} already exists`);
      mkdirSync(target, { recursive: true });

      // Initialize SDK RPC for the gateway functions' fallback paths.
      // No wallet prompt — clone is read-only.
      await setupReadOnly();

      const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));

      const sp = ui.spinner(`cloning ${slug}...`).start();

      // 1. latest commit
      const commitTable = getTablePda(dbRoot, toSeedBytes(commitTableHint(owner, repoName)));
      const commits = await gwFetchAllRows(commitTable.toBase58(), 200);
      if (commits.length === 0) {
        sp.fail(`no commits in ${slug}`);
        process.exit(1);
      }
      const latest = [...commits].sort(
        (a, b) => ((b as { timestamp?: number }).timestamp ?? 0) - ((a as { timestamp?: number }).timestamp ?? 0),
      )[0] as { id: string; treeTxId: string };

      // 2. tree
      const tree = await gwLoadTreeJson<Record<string, { txId: string; hash: string }>>(latest.treeTxId);
      const paths = Object.entries(tree);

      // 3. blobs — one per file
      let i = 0;
      for (const [path, entry] of paths) {
        i++;
        sp.text = `cloning ${slug}... (${i}/${paths.length}) ${path}`;
        const base64 = await gwLoadBlobBase64(entry.txId);
        const abs = join(target, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(base64, "base64"));
      }
      sp.succeed(`cloned ${paths.length} file(s) to ${target}/`);

      // 4. local config — read on-chain isPublic so cloned config is accurate
      const ownerListPda = getTablePda(dbRoot, toSeedBytes(repoListHint(owner)));
      const repos = await gwFetchAllRows(ownerListPda.toBase58(), 200);
      const meta = repos.find((r) => (r as { name?: string }).name === repoName) as
        | { isPublic?: boolean }
        | undefined;
      const isPublic = meta?.isPublic ?? true;

      repo.initRepo(target);
      repo.writeConfig(target, { owner, repo: repoName, isPublic });
      repo.writeHead(target, latest.id);
    });
}
