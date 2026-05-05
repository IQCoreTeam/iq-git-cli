// Drive unit + integration tests sequentially. Stops on first failure.
// Uses `bun` to execute .ts files directly — matches the build toolchain
// (tsup + bun) so no new dev dep is added (CODE-RULES §1: don't grow the
// toolbox when an existing tool fits).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function run(file: string): void {
  process.stdout.write(`▸ ${file.replace(ROOT + "/", "")} ... `);
  try {
    const out = execFileSync("bun", [file], { stdio: "pipe", encoding: "utf8", cwd: ROOT });
    const lastLine = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
    process.stdout.write(`${lastLine}\n`);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    process.stdout.write(`FAIL\n`);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: run.ts <dir...>  (e.g. tests/unit tests/integration)");
  process.exit(2);
}

for (const dir of dirs) {
  const full = resolve(ROOT, dir);
  if (!existsSync(full)) {
    console.error(`missing dir: ${full}`);
    process.exit(2);
  }
  for (const f of readdirSync(full).filter((f) => f.endsWith(".test.ts")).sort()) {
    run(resolve(full, f));
  }
}
console.log("\nall ok");
