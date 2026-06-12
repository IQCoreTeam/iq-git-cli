// browser.iqlabs.dev deep links for a deployed repo.
//
// A deployed IQ Pages site is opened by its git_commits table PDA:
// `https://browser.iqlabs.dev/<pda>`. The wide-web resolver there serves the
// owner's latest commit + entry itself, so the link stays correct across
// re-commits — unlike a gateway `/site/<treeTxId>` URL that pins one commit.

import { IQGIT_ROOT_ID, commitTableHint } from "@iqlabs-official/git-sdk/node";
import { getDbRootPda, getTablePda } from "@iqlabs-official/solana-sdk/contract";
import { toSeedBytes } from "@iqlabs-official/solana-sdk/utils";

const BROWSER_BASE = "https://browser.iqlabs.dev";

/** The base58 git_commits table PDA for `<owner>/<repo>` — the path segment of
 *  its browser.iqlabs.dev URL. */
export function commitTablePda(owner: string, repo: string): string {
  const dbRoot = getDbRootPda(toSeedBytes(IQGIT_ROOT_ID));
  return getTablePda(dbRoot, toSeedBytes(commitTableHint(owner, repo))).toBase58();
}

/** Shareable browser.iqlabs.dev URL for a deployed repo's site. */
export function browserUrl(owner: string, repo: string): string {
  return `${BROWSER_BASE}/${commitTablePda(owner, repo)}`;
}
