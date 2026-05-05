// Thin display layer. chalk + ora + @inquirer/prompts wrapped behind
// named functions so commands don't import them directly. Keeps colors
// and prompt styles consistent across commands.
//
// Functions are intentionally minimal — if a command needs a one-off
// formatter, do it inline in the command file (CODE-RULES §1: no
// meaningless wrapper). This file only holds things used by ≥2 commands.

import { confirm as inqConfirm, input as inqInput, select as inqSelect } from "@inquirer/prompts";
import chalk from "chalk";
import ora, { type Ora } from "ora";

// Free function (not a method) so TS narrows callers' control flow on
// `never` return — see https://github.com/microsoft/TypeScript/issues/12825.
export function fail(msg: string): never {
  console.error(chalk.red("✗"), msg);
  process.exit(1);
}

export const log = {
  info(msg: string): void {
    console.log(msg);
  },
  success(msg: string): void {
    console.log(chalk.green("✓"), msg);
  },
  warn(msg: string): void {
    console.log(chalk.yellow("⚠"), msg);
  },
  dim(msg: string): void {
    console.log(chalk.gray(msg));
  },
};

export function spinner(label: string): Ora {
  return ora(label);
}

export const confirm = inqConfirm;
export const input = inqInput;
export const select = inqSelect;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Format: "a3f5b2  fix login bug  (2h ago)". Caller passes a Commit-shaped
// object; we only read the three fields we need to keep this loosely coupled.
export function formatCommit(c: { id: string; message: string; timestamp: number }): string {
  return `${chalk.yellow(c.id.slice(0, 7))}  ${c.message}  ${chalk.gray(timeAgo(c.timestamp))}`;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
