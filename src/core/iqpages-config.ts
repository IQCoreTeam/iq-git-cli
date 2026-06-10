// iqpages.json scaffolding — the on-chain "enable Pages" manifest.
//
// The SDK owns the schema (PagesConfig) and the filename (IQPAGES_CONFIG_FILENAME);
// we reuse both rather than re-declaring. This module only adds the bits the SDK
// can't: building a sensible default and reading/writing the file in the working
// tree (the SDK only ever reads it back from the on-chain commit tree).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IQPAGES_CONFIG_FILENAME, type PagesConfig } from "@iqlabs-official/git-sdk/node";

export { IQPAGES_CONFIG_FILENAME };

/** Boilerplate iqpages.json for a repo that hasn't authored one. `entry` points
 *  at index.html — the conventional site root the gateway serves by default. */
export function buildDefaultPagesConfig(repoName: string): PagesConfig {
  return {
    name: repoName,
    version: "1.0.0",
    description: "Deploy using IQ Pages",
    entry: "index.html",
  };
}

/** True if the working tree already has an iqpages.json (regardless of whether
 *  it's been committed/pushed yet). */
export function localConfigExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, IQPAGES_CONFIG_FILENAME));
}

/** Read the working-tree iqpages.json, or null if absent/unparseable. */
export function readLocalConfig(repoRoot: string): PagesConfig | null {
  try {
    return JSON.parse(
      readFileSync(join(repoRoot, IQPAGES_CONFIG_FILENAME), "utf8"),
    ) as PagesConfig;
  } catch {
    return null;
  }
}

/** Write a pretty-printed iqpages.json to the working tree. Does not stage,
 *  commit, or push — callers own that. */
export function writeLocalConfig(repoRoot: string, cfg: PagesConfig): void {
  writeFileSync(
    join(repoRoot, IQPAGES_CONFIG_FILENAME),
    `${JSON.stringify(cfg, null, 2)}\n`,
  );
}
