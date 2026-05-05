// `iqgit restore [commitId]` — restore working tree to a commit's
// snapshot. Defaults to "latest" (functionally a re-pull).
//
// NAMING NOTE: in git this would be `checkout`, but git's `checkout` is
// overloaded with branch-switching, which we don't have in v1. Calling
// it `restore` matches `git restore --source=<commit>` and is unambiguous.
// FUTURE: when branches land, a real `checkout` command may be added for
// branch-switching, and this `restore` may be folded into it.
//
//   in:  optional <commitId> (full or short prefix); default = "latest"
//   sdk: GitClient.checkout(repoName, commitId | "latest", sink)
//   out: overwrites/creates files in cwd from the target tree;
//        updates .iqgit/HEAD only when restore("latest").
//
// SAFETY: this destroys uncommitted local changes. We bail unless
// `iqgit status` shows clean OR --force is passed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
import { scan, toScanMap } from "../core/scan";
import { setup } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("restore [commitId]")
    .option("--force", "discard uncommitted changes")
    .action(async (commitId: string | undefined, opts: { force?: boolean }) => {
      const cwd = repo.findRepoRoot();
      const cfg = repo.readConfig(cwd);
      const { client } = await setup();

      if (!opts.force) {
        const { added, modified } = await client.status(
          cfg.owner,
          cfg.repo,
          toScanMap(scan(cwd)),
        );
        if (added.length || modified.length) {
          ui.fail("uncommitted changes — commit them or pass --force");
        }
      }

      const target = commitId ?? "latest";
      const sp = ui.spinner(`restoring ${target}...`).start();
      const c = await client.checkout(cfg.repo, target, async (path, base64) => {
        const abs = join(cwd, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(base64, "base64"));
      });
      sp.succeed(`restored ${c.id.slice(0, 7)} "${c.message}"`);

      if (target === "latest") repo.writeHead(cwd, c.id);
    });
}
