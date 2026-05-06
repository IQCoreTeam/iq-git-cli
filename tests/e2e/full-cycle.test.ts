// E2E: real Solana mainnet. Costs SOL. Gated by env so it never runs
// in CI/dev unless the user explicitly opts in.
//
// Cycle: init → create → write files → add . → commit → push → log →
// registry shows it → clone roundtrip → verify content equality.
//
//   env: INTEGRATION_RPC      = mainnet RPC URL (Helius recommended)
//        INTEGRATION_KEYPAIR  = absolute path to a funded keypair JSON
//        INTEGRATION_REPO     = optional; if set, reuse existing repo
//                               (skip the ~0.05 SOL create) — useful for
//                               re-running after a partial failure.
//   cost: ~0.06 SOL on a tiny commit (mostly the create). Refuses if
//         balance < 0.05.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC = process.env.INTEGRATION_RPC;
const KEYPAIR_PATH = process.env.INTEGRATION_KEYPAIR;
const REUSE_REPO = process.env.INTEGRATION_REPO;
if (!RPC || !KEYPAIR_PATH) {
  console.log("skip: e2e requires INTEGRATION_RPC + INTEGRATION_KEYPAIR");
  process.exit(0);
}

const CLI = resolve(__dirname, "..", "..", "dist", "cli.js");
if (!existsSync(CLI)) {
  console.error(`build first: ${CLI} missing — run 'npm run build'`);
  process.exit(1);
}

const secret = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as number[];
const signer = Keypair.fromSecretKey(Uint8Array.from(secret));
const owner = signer.publicKey.toBase58();
console.log("e2e signer: " + owner);

const conn = new Connection(RPC, "confirmed");
const lamports = await conn.getBalance(signer.publicKey);
const sol = lamports / LAMPORTS_PER_SOL;
console.log("balance: " + sol.toFixed(4) + " SOL");
assert.ok(sol >= 0.05, "balance below 0.05 SOL — fund signer first");

const repoName = REUSE_REPO ?? `e2e-test-${Date.now()}`;
console.log("repo: " + repoName + (REUSE_REPO ? " (REUSED)" : " (NEW)"));

const root = mkdtempSync(join(tmpdir(), "iqgit-e2e-"));
console.log("workdir: " + root);

// Run iqgit and return merged stdout+stderr. ora spinners write to stderr;
// assertions about success messages ("Created owner/repo", "pushed ...")
// need both streams, so we redirect 2>&1 at the shell layer.
function iqgit(cwd: string, args: string[]): string {
  const escaped = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  return execFileSync("bash", ["-c", `node "${CLI}" ${escaped} 2>&1`], {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    env: { ...process.env, SOLANA_RPC_ENDPOINT: RPC, SOLANA_KEYPAIR_PATH: KEYPAIR_PATH },
  });
}

// Pre-seed the global config so create/push don't prompt
const HOME_CFG = join(process.env.HOME ?? "", ".iq-git");
mkdirSync(HOME_CFG, { recursive: true });
writeFileSync(join(HOME_CFG, "config.json"), JSON.stringify({
  walletPath: KEYPAIR_PATH,
  rpcUrl: RPC,
}));

// 1. init
console.log("[1/8] init");
let out = iqgit(root, ["init"]);
assert.match(out, /Initialized empty iqgit repo/);

// 2. create (or reuse)
if (!REUSE_REPO) {
  console.log("[2/8] create (chain write — ~0.05 SOL)");
  out = iqgit(root, ["create", repoName, "--public"]);
  assert.match(out, new RegExp(`Created ${owner}/${repoName}`));
} else {
  console.log("[2/8] create skipped (INTEGRATION_REPO set)");
  // Manually write the config the way `iqgit create` would have
  writeFileSync(
    join(root, ".iqgit", "config.json"),
    JSON.stringify({ owner, repo: repoName, isPublic: true }),
  );
}
const cfg = JSON.parse(readFileSync(join(root, ".iqgit", "config.json"), "utf8"));
assert.equal(cfg.owner, owner);
assert.equal(cfg.repo, repoName);

// 3. write tiny tree
console.log("[3/8] write files");
writeFileSync(join(root, "README.md"), `# ${repoName}\nlanded on chain via iqgit.\n`);
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "main.ts"), `console.log("hello from ${repoName}");\n`);
writeFileSync(join(root, ".iqgitignore"), ".secret\n");
writeFileSync(join(root, ".secret"), "should not land on chain\n");

// 4. add + commit (local)
console.log("[4/8] add + commit");
out = iqgit(root, ["add", "."]);
assert.match(out, /staged \d+ path/);
const stagedAfter = JSON.parse(readFileSync(join(root, ".iqgit", "index.json"), "utf8")) as string[];
assert.ok(!stagedAfter.includes(".secret"), ".secret correctly excluded by .iqgitignore");
out = iqgit(root, ["commit", "-m", "first commit"]);
assert.match(out, /commit [0-9a-f]+ saved locally/);

// 5. push (chain writes)
console.log("[5/8] push (real chain writes — be patient)");
const balanceBefore = await conn.getBalance(signer.publicKey);
out = iqgit(root, ["push"]);
const balanceAfter = await conn.getBalance(signer.publicKey);
const spent = (balanceBefore - balanceAfter) / LAMPORTS_PER_SOL;
console.log("  spent on push: " + spent.toFixed(6) + " SOL");
assert.ok(spent > 0, "push must have cost SOL");
assert.match(out, /pushed/);

// 6. log shows our commit
console.log("[6/8] log");
out = iqgit(root, ["log", "--limit", "5"]);
assert.match(out, /first commit/, "log must include 'first commit'");

// 7. registry shows the repo (because --public)
console.log("[7/8] registry");
out = iqgit(root, ["registry", "--limit", "200"]);
assert.ok(
  out.includes(repoName),
  `registry must include ${repoName}`,
);

// 8. clone roundtrip into fresh dir
console.log("[8/8] clone roundtrip + content equality");
const cloneTarget = mkdtempSync(join(tmpdir(), "iqgit-clone-"));
rmSync(cloneTarget, { recursive: true, force: true });
out = iqgit(process.env.HOME ?? "/tmp", ["clone", `${owner}/${repoName}`, cloneTarget]);
assert.match(out, /cloned to/);

// Verify the cloned config carries the actual on-chain visibility
// (we created the repo with --public so isPublic must be true). Before
// the fix, clone.ts hardcoded isPublic: true regardless of chain state.
const clonedCfg = JSON.parse(readFileSync(join(cloneTarget, ".iqgit", "config.json"), "utf8")) as { isPublic: boolean };
assert.equal(clonedCfg.isPublic, true, "cloned config reflects on-chain isPublic");

const original = readFileSync(join(root, "README.md"), "utf8");
const cloned = readFileSync(join(cloneTarget, "README.md"), "utf8");
assert.equal(cloned, original, "README.md round-trips byte-for-byte");
const originalSrc = readFileSync(join(root, "src", "main.ts"), "utf8");
const clonedSrc = readFileSync(join(cloneTarget, "src", "main.ts"), "utf8");
assert.equal(clonedSrc, originalSrc, "src/main.ts round-trips byte-for-byte");
assert.equal(existsSync(join(cloneTarget, ".secret")), false, ".secret never on chain");

rmSync(root, { recursive: true, force: true });
rmSync(cloneTarget, { recursive: true, force: true });
console.log("\ne2e ok — repo " + repoName + " is permanent on chain by " + owner);
