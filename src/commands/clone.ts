// `iqgit clone <owner>/<repo> [dir]` — pulls latest snapshot to disk.
// Read-only; no wallet required (we still go through setup() but only
// for the RPC stage — TODO in setup.ts: add a `read-only` flag).
//
//   in:  <owner>/<repo>, optional [dir] (default = repo name)
//   sdk: GitClient.clone(repoName, owner, sink)
//        ↑ takes a sink callback. We pass one that writes base64 → fs.
//   out: directory tree on disk + initialized .iqgit/ pointing at the
//        cloned repo, HEAD set to the latest commitId so future
//        `status` / `commit` work.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
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

      repo.initRepo(target);
      repo.writeConfig(target, { owner, repo: repoName, isPublic: true });
      repo.writeHead(target, latest.id);
    });
}
