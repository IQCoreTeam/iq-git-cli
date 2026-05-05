// `iqgit init` — local-only. Creates .iqgit/ skeleton. Does NOT touch
// chain. Mirror of `git init`.
//
//   in:  optionally `--name <repo>` `--public|--private`
//   sdk: (none)
//   out: prints next-step hint about `iqgit create`
//
// Why no auto-create on init: chain writes cost SOL. We want users to
// explicitly opt in via `iqgit create` so the first transaction is
// never a surprise.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("init")
    .option("--name <name>", "repository name")
    .option("--public", "default visibility")
    .option("--private")
    .action((opts: { name?: string; public?: boolean; private?: boolean }) => {
      const cwd = process.cwd();
      if (existsSync(join(cwd, ".iqgit"))) ui.fail("already an iqgit repo");
      repo.initRepo(cwd);

      if (opts.name) {
        repo.writeConfig(cwd, {
          owner: "",
          repo: opts.name,
          isPublic: !opts.private,
        });
      }
      ui.log.success("Initialized empty iqgit repo in .iqgit/");
      ui.log.dim("Next: iqgit create <name> [--public|--private]");
    });
}
