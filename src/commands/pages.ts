// `iqgit pages <deploy|status>` — publish a repo to the iq-pages gallery,
// the on-chain equivalent of "enable GitHub Pages". web2 git has no such
// command, so the shape is ours: a `pages` group with two subcommands.
//
//   pages deploy   write the deploy marker + one-time fee (only if not yet
//                  deployed). The site is served live from the repo's latest
//                  commit, so nothing is re-uploaded here.
//   pages status   show whether the repo is deployed and, if so, its live URL.
//
//   sdk: deployPages / isPagesDeployed / readPagesConfig from the git-sdk
//        pages layer (0.1.13+). All the on-chain logic lives there; this file
//        only does repo-config resolution + terminal output.
//
// deploy is a write → setup() (wallet gate). status is read-only →
// setupReadOnly(), and reads owner/repo from .iqgit/config.json without a
// wallet so anyone can check a checked-out repo.

import type { Command } from "commander";
import {
  deployPages,
  isPagesDeployed,
  readLatestCommit,
  commitTablePda,
  readPagesConfig,
} from "@iqlabs-official/git-sdk/node";
import chalk from "chalk";
import * as repo from "../core/repo";
import { setup, setupReadOnly } from "../setup";
import * as ui from "../ui";

// Site host. Mirrors the gateway chain in core/gateway.ts; the deployed site
// is served at `<gateway>/site/<treeTxId>/<entry>`.
const SITE_BASE =
  (process.env.GATEWAY_URL?.split(",")[0]?.trim() || "https://gateway.iqlabs.dev") +
  "/site";

export function register(program: Command): void {
  const pages = program
    .command("pages")
    .description("publish this repo to iq-pages (on-chain hosting)");

  pages
    .command("deploy")
    .description("deploy this repo to iq-pages (no-op if already deployed)")
    .action(deployAction);

  pages
    .command("status")
    .description("show whether this repo is deployed and its live URL")
    .action(statusAction);
}

async function deployAction(): Promise<void> {
  const cwd = repo.findRepoRoot();
  const { repo: repoName } = repo.readConfig(cwd);
  if (!repoName) ui.fail('no repo here — run "iqgit create <name>" first');

  const { signer, connection } = await setup();
  const owner = signer.publicKey.toBase58();

  if (await isPagesDeployed(owner, repoName)) {
    ui.log.success(`Already deployed: ${owner}/${repoName}`);
    await printSiteUrl(owner, repoName);
    return;
  }

  const sp = ui.spinner(`Deploying ${repoName} to iq-pages...`).start();
  try {
    await deployPages(connection, signer, repoName);
    sp.succeed(`Deployed ${owner}/${repoName}`);
  } catch (e) {
    sp.fail((e as Error).message);
    process.exit(1);
  }

  await printSiteUrl(owner, repoName);
  printSnsAd(repoName);
}

async function statusAction(): Promise<void> {
  const cwd = repo.findRepoRoot();
  const cfg = repo.readConfig(cwd);
  if (!cfg.repo || !cfg.owner) {
    ui.fail('no repo here — run "iqgit create <name>" first');
  }
  await setupReadOnly();

  if (await isPagesDeployed(cfg.owner, cfg.repo)) {
    ui.log.success(`Deployed on iq-pages: ${cfg.owner}/${cfg.repo}`);
    await printSiteUrl(cfg.owner, cfg.repo);
  } else {
    ui.log.info(`Not deployed. Run "iqgit pages deploy" to publish.`);
  }
}

// Resolve the live URL from the repo's latest commit tree + iqpages.json
// `entry`. Best-effort: a freshly-deployed repo always has both, but we don't
// want a missing-config edge case to mask a successful deploy.
async function printSiteUrl(owner: string, repoName: string): Promise<void> {
  const [latest, config] = await Promise.all([
    readLatestCommit(commitTablePda(owner, repoName)),
    readPagesConfig(owner, repoName),
  ]);
  if (!latest || !config) return;
  ui.log.info(`  ${SITE_BASE}/${latest.treeTxId}/${config.entry}`);
}

// Green ad nudging the user to claim a .sns domain for their fresh site.
// Placeholder copy until the .sns flow ships — swap the URL when it lands.
function printSnsAd(repoName: string): void {
  console.log(
    chalk.green(
      `\n🌐 Give ${repoName} a name: register a .sns domain for your site → https://sns.iqlabs.dev`,
    ),
  );
}
