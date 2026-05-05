// `iqgit add <pathspec...>` — stage paths for the next commit.
//
//   in:  one or more pathspecs. "." stages every non-ignored file in the repo.
//        Directory args expand to every non-ignored file under them.
//        Single-file args are staged unless ignored (with a notice).
//   sdk: (none)
//   out: writes .iqgit/index.json with merged path set.
//
// Mirrors `git add`. The repo-wide file list comes from scan() so the same
// ignore rules apply here as in commit/status (CODE-RULES §2).

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
import { loadIgnore, scan } from "../core/scan";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("add <pathspec...>")
    .description("stage paths for the next commit")
    .action((pathspecs: string[]) => {
      const cwd = repo.findRepoRoot();
      const allPaths = scan(cwd).map((f) => f.path);
      const ig = loadIgnore(cwd);
      const collected = new Set(repo.readIndex(cwd));

      for (const spec of pathspecs) {
        const abs = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
        if (!existsSync(abs)) ui.fail(`path does not exist: ${spec}`);

        if (statSync(abs).isDirectory()) {
          const prefix = relative(cwd, abs).split(sep).join("/");
          const matches = prefix === ""
            ? allPaths
            : allPaths.filter((p) => p === prefix || p.startsWith(`${prefix}/`));
          for (const p of matches) collected.add(p);
        } else {
          const rel = relative(cwd, abs).split(sep).join("/");
          if (ig.ignores(rel)) {
            ui.log.dim(`ignored: ${rel}`);
            continue;
          }
          collected.add(rel);
        }
      }

      repo.writeIndex(cwd, [...collected]);
      ui.log.success(`staged ${collected.size} path(s)`);
    });
}
