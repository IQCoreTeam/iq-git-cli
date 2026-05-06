// `iqgit clone <owner>/<repo> [dir]` — pulls latest snapshot to disk.
// Read-only intent; we go through setup() because GitClient requires
// a signer in its constructor (an SDK constraint, not ours).
//
//   in:  <owner>/<repo>, optional [dir] (default = repo name)
//   sdk: GitClient.clone(repoName, owner, sink) — fetches latest commit
//                                                  + tree + every blob
//        gwFetchAllRows(ownerListPda, ...)         repo metadata for the
//                                                  cloned config's isPublic
//   out: directory tree on disk + initialized .iqgit/ pointing at the
//        cloned repo, HEAD set to the latest commitId so future
//        `status` / `commit` work.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { IQGIT_ROOT_ID, repoListHint } from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";
import * as repo from "../core/repo";
import { gwFetchAllRows } from "../core/gateway";
import { setup } from "../setup";

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

      const { client } = await setup();

      const sp = ui.spinner(`cloning ${slug}...`).start();
      const latest = await client.clone(repoName, owner, async (path, base64) => {
        const abs = join(target, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(base64, "base64"));
      });
      sp.succeed(`cloned to ${target}/`);

      // Read repo metadata for the cloned config — git_repos_v2_<owner>
      // includes an `isPublic` column (SDK REPO_COLUMNS). gwFetchAllRows
      // routes through gateway when GATEWAY_URL is set, RPC otherwise.
      // SDK doesn't expose readRepoMeta(owner, name) so we filter by name.
      const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));
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
