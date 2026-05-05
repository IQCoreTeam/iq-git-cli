// `iqgit status` — three-tier view, mirrors git but adapted to our model:
//
//     remote (HEAD on chain)  ──  what was last pushed
//             │
//             ▼
//     pending (.iqgit/pending/)  ─  committed locally, not yet on chain
//             │
//             ▼
//     working tree (cwd files)  ─  edited but not committed
//
//   sdk: GitClient.status(owner, repo, scan) — diffs working tree against
//        the on-chain HEAD's tree.json.

import type { Command } from "commander";
import * as repo from "../core/repo";
import { scan, toScanMap } from "../core/scan";
import { setup } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program.command("status").action(async () => {
    const cwd = repo.findRepoRoot();
    const cfg = repo.readConfig(cwd);
    const head = repo.readHead(cwd);
    const pending = repo.listPending(cwd);

    const { client } = await setup();
    const { added, modified } = await client.status(
      cfg.owner,
      cfg.repo,
      toScanMap(scan(cwd)),
    );

    ui.log.info(`On HEAD: ${head ? head.slice(0, 7) : "(no commits yet)"}`);

    if (pending.length) {
      ui.log.info("");
      ui.log.info(`Pending commits (not yet pushed): ${pending.length}`);
      for (const p of pending) {
        ui.log.info(`  ${p.meta.id.slice(0, 7)}  "${p.meta.message}"`);
      }
    }

    if (added.length || modified.length) {
      ui.log.info("");
      ui.log.info("Working tree changes:");
      for (const f of added) ui.log.info(`  added:    ${f}`);
      for (const f of modified) ui.log.info(`  modified: ${f}`);
    }

    if (!pending.length && !added.length && !modified.length) {
      ui.log.info("clean");
    }
  });
}
