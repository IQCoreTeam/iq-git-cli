// `iqgit config`: get/set values in ~/.iq-git/config.json.
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

const KNOWN_KEYS = [
  "walletPath",
  "rpcUrl",
  "network",
  "evmPrivateKey",
  "speed",
  "rps",
  "concurrency",
  "concurrencyUpload",
] as const;
const SPEED_VALUES = ["light", "medium", "heavy", "extreme"] as const;
const POSITIVE_INT_KEYS = new Set(["rps", "concurrency", "concurrencyUpload"]);

export function register(program: Command): void {
  program
    .command("config [key] [value]")
    .description("get or set global config (keys: walletPath, rpcUrl, network, speed, rps, concurrency, concurrencyUpload)")
    .addHelpText("after", `
Examples:
  iqgit config                                  list all
  iqgit config rpcUrl                           print current RPC URL
  iqgit config rpcUrl "https://my-rpc.example"    change RPC URL
  iqgit config speed heavy                      default push preset (light|medium|heavy|extreme)
  iqgit config rps 80                           raw maxRps override (wins over preset)
  iqgit config concurrencyUpload 30             raw maxConcurrencyUpload override
  iqgit config --unset rpcUrl                   reset (re-prompts next run)
  iqgit config network eth                      default to EVM (sepolia)
  iqgit config network mainnet                  back to Solana mainnet`)
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
      if (key === "speed" && !(SPEED_VALUES as readonly string[]).includes(value)) {
        ui.fail(`invalid speed: ${value}\nallowed: ${SPEED_VALUES.join(", ")}`);
      }
      if (POSITIVE_INT_KEYS.has(key)) {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          ui.fail(`invalid ${key}: ${value} (must be a positive integer)`);
        }
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
