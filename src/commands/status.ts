// `iqgit status` — four-tier view, mirrors git plus our pending layer:
//
//     remote (HEAD on chain)   ── what was last pushed
//             │
//             ▼
//     pending (.iqgit/pending/) ── committed locally, not yet on chain
//             │
//             ▼
//     index (.iqgit/index.json) ── staged for the next commit
//             │
//             ▼
//     working tree (cwd files)  ── on disk
//
// We diff working tree vs base tree (last pending → on-chain HEAD → empty)
// to label each path: staged / unstaged-modified / unstaged-added /
// unstaged-deleted. The base resolution reuses core/tree.ts so commit and
// status agree on what "current state" means (CODE-RULES §2).

import type { Command } from "commander";
import * as repo from "../core/repo";
import { scan } from "../core/scan";
import { resolveBaseTree } from "../core/tree";
import { setupReadOnly } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program.command("status").action(async () => {
    const cwd = repo.findRepoRoot();
    const cfg = repo.readConfig(cwd);
    const head = repo.readHead(cwd);
    const pending = repo.listPending(cwd);
    const index = new Set(repo.readIndex(cwd));
    const files = scan(cwd);
    const filesByPath = new Map(files.map((f) => [f.path, f]));

    // Read base tree only if a chain fetch is actually needed (no pending
    // and HEAD set). Otherwise resolveBaseTree is purely local.
    const needsChain = pending.length === 0 && head !== null;
    const connection = needsChain ? await setupReadOnly() : null;
    const base = await resolveBaseTree(cwd, cfg.owner, cfg.repo, connection);

    const stagedAddedOrModified: string[] = [];
    const stagedDeleted: string[] = [];
    const unstagedAdded: string[] = [];
    const unstagedModified: string[] = [];
    const unstagedDeleted: string[] = [];

    // Paths present in base, working tree, or both.
    const allPaths = new Set([...Object.keys(base), ...files.map((f) => f.path)]);
    for (const p of allPaths) {
      const inBase = base[p];
      const inWorking = filesByPath.get(p);
      const isStaged = index.has(p);

      if (inWorking && !inBase) {
        (isStaged ? stagedAddedOrModified : unstagedAdded).push(p);
      } else if (!inWorking && inBase) {
        (isStaged ? stagedDeleted : unstagedDeleted).push(p);
      } else if (inWorking && inBase && inWorking.hash !== inBase.hash) {
        (isStaged ? stagedAddedOrModified : unstagedModified).push(p);
      }
    }

    ui.log.info(`On HEAD: ${head ? head.slice(0, 7) : "(no commits yet)"}`);

    if (pending.length) {
      ui.log.info("");
      ui.log.info(`Pending commits (not yet pushed): ${pending.length}`);
      for (const p of pending) {
        ui.log.info(`  ${p.meta.id.slice(0, 7)}  "${p.meta.message}"`);
      }
    }

    if (stagedAddedOrModified.length || stagedDeleted.length) {
      ui.log.info("");
      ui.log.info("Staged for next commit:");
      for (const f of stagedAddedOrModified) ui.log.info(`  ${f}`);
      for (const f of stagedDeleted) ui.log.info(`  deleted:  ${f}`);
    }

    if (unstagedAdded.length || unstagedModified.length || unstagedDeleted.length) {
      ui.log.info("");
      ui.log.info("Unstaged changes:");
      for (const f of unstagedAdded) ui.log.info(`  added:    ${f}`);
      for (const f of unstagedModified) ui.log.info(`  modified: ${f}`);
      for (const f of unstagedDeleted) ui.log.info(`  deleted:  ${f}`);
    }

    const clean =
      pending.length === 0 &&
      stagedAddedOrModified.length === 0 &&
      stagedDeleted.length === 0 &&
      unstagedAdded.length === 0 &&
      unstagedModified.length === 0 &&
      unstagedDeleted.length === 0;
    if (clean) ui.log.info("clean");
  });
}
