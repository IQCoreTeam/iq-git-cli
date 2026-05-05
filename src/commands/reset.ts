// `iqgit reset [pathspec...]` — unstage paths.
//
//   in:  zero or more pathspecs. No args = clear the entire index.
//        Directory args remove every staged path under them.
//   sdk: (none)
//   out: rewrites .iqgit/index.json.
//
// Mirrors `git reset` (the unstaging half — we don't have HEAD-moving
// semantics in v1).

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("reset [pathspec...]")
    .description("unstage paths (no args clears the index)")
    .action((pathspecs: string[]) => {
      const cwd = repo.findRepoRoot();

      if (pathspecs.length === 0) {
        repo.writeIndex(cwd, []);
        ui.log.success("index cleared");
        return;
      }

      const removeRels = pathspecs.map((spec) => {
        const abs = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
        return relative(cwd, abs).split(sep).join("/");
      });

      const next = repo.readIndex(cwd).filter((p) =>
        !removeRels.some((r) => p === r || p.startsWith(`${r}/`)),
      );
      repo.writeIndex(cwd, next);
      ui.log.success(`index now has ${next.length} path(s)`);
    });
}
