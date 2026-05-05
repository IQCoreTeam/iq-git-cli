// `iqgit config` — get/set values in ~/.iq-git/config.json.
// Mirrors `git config` ergonomics but for the global CLI config only
// (not per-repo). Per-repo config is just .iqgit/config.json which
// commands edit directly.
//
//   in:  no args                → list all
//        <key>                  → print value
//        <key> <value>          → set + persist
//        --unset <key>          → remove key
//   sdk: (none)
//   out: stdout

import type { Command } from "commander";
import { readGlobalConfig, writeGlobalConfig } from "../setup";
import * as ui from "../ui";

const KNOWN_KEYS = ["walletPath", "rpcUrl"] as const;

export function register(program: Command): void {
  program
    .command("config [key] [value]")
    .option("--unset <key>")
    .action((key: string | undefined, value: string | undefined, opts: { unset?: string }) => {
      const cfg = readGlobalConfig() as Record<string, string | undefined>;

      if (opts.unset) {
        ensureKnown(opts.unset);
        delete cfg[opts.unset];
        writeGlobalConfig(cfg);
        ui.log.success(`unset ${opts.unset}`);
        return;
      }
      if (!key) {
        for (const [k, v] of Object.entries(cfg)) {
          if (v !== undefined) ui.log.info(`${k}=${v}`);
        }
        return;
      }
      ensureKnown(key);
      if (value === undefined) {
        ui.log.info(cfg[key] ?? "");
        return;
      }
      cfg[key] = value;
      writeGlobalConfig(cfg);
      ui.log.success(`set ${key}=${value}`);
    });
}

function ensureKnown(key: string): void {
  if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
    ui.fail(`unknown config key: ${key}\nknown: ${KNOWN_KEYS.join(", ")}`);
  }
}
