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
//
// Stub config: we write .iqgit/config.json with empty `owner` so that
// `iqgit add`, `iqgit commit`, `iqgit status` work against the local
// pending state without an ENOENT crash. The empty owner is the gate
// commit.ts already checks — it triggers the friendly "run iqgit create
// first" message at the right time.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
import {
  buildDefaultPagesConfig,
  localConfigExists,
  writeLocalConfig,
} from "../core/iqpages-config";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("init")
    .option("--name <name>", "repository name")
    .option("--public", "default visibility")
    .option("--private")
    .action(async (opts: { name?: string; public?: boolean; private?: boolean }) => {
      const cwd = process.cwd();
      if (existsSync(join(cwd, ".iqgit"))) ui.fail("already an iqgit repo");
      repo.initRepo(cwd);
      repo.writeConfig(cwd, {
        owner: "",
        repo: opts.name ?? "",
        isPublic: !opts.private,
      });
      ui.log.success("Initialized empty iqgit repo in .iqgit/");

      // If this looks like a website (has index.html) and there's no Pages
      // manifest yet, offer to scaffold one now — file only, no chain write.
      // Init must never surprise the user with a transaction, so this just
      // drops iqpages.json on disk for them to commit/push when ready.
      if (existsSync(join(cwd, "index.html")) && !localConfigExists(cwd)) {
        const make = await ui.confirm({
          message:
            "index.html found — generate iqpages.json so this repo can deploy to IQ Pages?",
        });
        if (make) {
          writeLocalConfig(cwd, buildDefaultPagesConfig(opts.name ?? "site"));
          ui.log.success("wrote iqpages.json");
          ui.log.dim("Edit it if you like, then add/commit/push when ready.");
        }
      }

      ui.log.dim("Next: iqgit create <name> [--public|--private]");
    });
}
