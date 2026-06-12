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
//        pages layer (0.1.15+). All the on-chain logic lives there; this file
//        only does repo-config resolution + terminal output. The pages layer
//        is chain-neutral, so deploy works on Solana and EVM alike — the fee is
//        charged in the active chain's native currency by the SDK.
//
// deploy is a write → setup() (wallet gate). status is read-only →
// setupReadOnly(), and reads owner/repo from .iqgit/config.json without a
// wallet so anyone can check a checked-out repo.

import { join } from "node:path";
import type { Command } from "commander";
import {
  readLatestCommit,
  commitTableRef,
  deployPages,
  isPagesDeployed,
  readPagesConfig,
} from "@iqlabs-official/git-sdk/node";
import type { GitSigner } from "@iqlabs-official/git-sdk";
import chalk from "chalk";
import * as repo from "../core/repo";
import {
  IQPAGES_CONFIG_FILENAME,
  buildDefaultPagesConfig,
  writeLocalConfig,
} from "../core/iqpages-config";
import { browserUrl } from "../core/browser-url";
import { buildCommit } from "./commit";
import { pushPending } from "./push";
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

  const { signer, address } = await setup();
  const owner = address;

  if (await isPagesDeployed(owner, repoName)) {
    ui.log.success(`Already deployed: ${owner}/${repoName}`);
    await printSiteUrl(owner, repoName);
    return;
  }

  // deployPages requires iqpages.json in the repo's latest on-chain commit.
  // If it isn't there, offer to scaffold + push it so deploy is one step.
  if (!(await readPagesConfig(owner, repoName))) {
    const ok = await ensurePagesConfig(signer, cwd, repoName);
    if (!ok) return; // user opted to author it themselves — guidance printed
  }

  const sp = ui.spinner(`Deploying ${repoName} to iq-pages...`).start();
  try {
    await deployPages(signer, repoName);
    sp.succeed(`Deployed ${owner}/${repoName}`);
  } catch (e) {
    sp.fail((e as Error).message);
    process.exit(1);
  }

  await printSiteUrl(owner, repoName);
  printSnsAd(repoName);
}

// iqpages.json isn't on-chain yet. Show the default we'd write and let the user
// choose: Yes → scaffold + add/commit/push it so deploy can proceed; No → write
// nothing, print where to author it themselves, and bail out of deploy.
// Returns true when the config is now committed on-chain (deploy may proceed).
async function ensurePagesConfig(
  signer: GitSigner,
  cwd: string,
  repoName: string,
): Promise<boolean> {
  const cfg = buildDefaultPagesConfig(repoName);
  ui.log.warn(`${IQPAGES_CONFIG_FILENAME} is missing — IQ Pages needs it to deploy.`);
  ui.log.info("Proposed iqpages.json:");
  ui.log.info(chalk.gray(JSON.stringify(cfg, null, 2)));

  const ok = await ui.confirm({
    message: "Generate this iqpages.json and push it now, then deploy?",
  });
  if (!ok) {
    const path = join(cwd, IQPAGES_CONFIG_FILENAME);
    ui.log.info("No problem. To author it yourself:");
    ui.log.info(`  1. Create/edit ${path}`);
    ui.log.info(`  2. iqgit add ${IQPAGES_CONFIG_FILENAME}`);
    ui.log.info('  3. iqgit commit -m "add iqpages.json"');
    ui.log.info("  4. iqgit push");
    ui.log.info("  5. iqgit pages deploy");
    return false;
  }

  // Yes → write the file, stage it (alongside anything already staged), commit,
  // and push on-chain. writeIndex de-dupes, so re-adding is safe.
  writeLocalConfig(cwd, cfg);
  const repoCfg = repo.readConfig(cwd);
  repo.writeIndex(cwd, [...repo.readIndex(cwd), IQPAGES_CONFIG_FILENAME]);
  const pending = await buildCommit(cwd, repoCfg, {
    message: "add iqpages.json",
    warnLarge: true,
  });
  if (!pending) return false; // declined large-file prompt (unlikely for a tiny json)
  await pushPending(signer, cwd, repoName, [pending]);
  return true;
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

// Show where the deployed site lives. Two URLs, different jobs:
//   • browser.iqlabs.dev/<pda>  — the shareable link. browser resolves the
//     owner's latest commit itself, so it survives re-commits. Always printable
//     (the PDA is derived from owner/repo — no chain read needed).
//   • <gateway>/site/<treeTxId>/<entry> — pins THIS commit's files. Best-effort:
//     skipped if the latest commit / iqpages.json can't be read right now.
async function printSiteUrl(owner: string, repoName: string): Promise<void> {
  ui.log.info(`  ${chalk.cyan(browserUrl(owner, repoName))}`);

  const [latest, config] = await Promise.all([
    readLatestCommit(commitTableRef(owner, repoName)),
    readPagesConfig(owner, repoName),
  ]);
  if (!latest || !config) return;
  ui.log.dim(`  ${SITE_BASE}/${latest.treeTxId}/${config.entry}`);
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
