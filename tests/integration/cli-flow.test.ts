// Integration: drive the built CLI binary end-to-end without chain.
// Exercises commander wiring + every local-only command path. The
// previously-broken init→add→commit flow is the critical regression test.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "..", "..", "dist", "cli.js");
if (!existsSync(CLI)) {
  console.error(`build first: ${CLI} missing — run 'npm run build'`);
  process.exit(1);
}

function iqgit(cwd: string, args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? -1 };
  }
}

const root = mkdtempSync(join(tmpdir(), "iqgit-cli-"));

// 1. init creates .iqgit/ + stub config
let r = iqgit(root, ["init"]);
assert.equal(r.code, 0, "init exit 0");
assert.match(r.stdout, /Initialized empty iqgit repo/);
assert.ok(existsSync(join(root, ".iqgit", "config.json")), "stub config written");
const cfg = JSON.parse(readFileSync(join(root, ".iqgit", "config.json"), "utf8"));
assert.equal(cfg.owner, "", "stub owner is empty");

// 2. init twice fails cleanly
r = iqgit(root, ["init"]);
assert.notEqual(r.code, 0);
assert.match(r.stderr, /already an iqgit repo/);

// 3. status on empty repo doesn't crash (was the bug)
writeFileSync(join(root, "a.txt"), "hello\n");
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "main.js"), "console.log(1);\n");
writeFileSync(join(root, ".iqgitignore"), ".secret\n");
writeFileSync(join(root, ".secret"), "shh\n");
r = iqgit(root, ["status"]);
assert.equal(r.code, 0, "status exit 0 on fresh repo");
assert.match(r.stdout, /no commits yet/);

// 4. add . stages everything respecting ignores
r = iqgit(root, ["add", "."]);
assert.equal(r.code, 0);
assert.match(r.stdout, /staged \d+ path/);
const indexAfterAdd = JSON.parse(readFileSync(join(root, ".iqgit", "index.json"), "utf8")) as string[];
assert.ok(indexAfterAdd.includes("a.txt"));
assert.ok(indexAfterAdd.includes("src/main.js"));
assert.ok(indexAfterAdd.includes(".iqgitignore"));
assert.ok(!indexAfterAdd.includes(".secret"), ".secret stays out per .iqgitignore");

// 5. status shows staged
r = iqgit(root, ["status"]);
assert.match(r.stdout, /Staged for next commit/);
assert.match(r.stdout, /a\.txt/);

// 6. reset clears the index
r = iqgit(root, ["reset"]);
assert.equal(r.code, 0);
assert.match(r.stdout, /index cleared/);
assert.deepEqual(JSON.parse(readFileSync(join(root, ".iqgit", "index.json"), "utf8")), []);

// 7. add specific path
r = iqgit(root, ["add", "a.txt"]);
assert.equal(r.code, 0);
assert.deepEqual(JSON.parse(readFileSync(join(root, ".iqgit", "index.json"), "utf8")), ["a.txt"]);

// 8. commit before create gives FRIENDLY error (was ENOENT crash before fix)
r = iqgit(root, ["commit", "-m", "test"]);
assert.notEqual(r.code, 0);
const allOutput = r.stdout + r.stderr;
assert.match(allOutput, /repo not yet created on-chain/, "must NOT be ENOENT");
assert.doesNotMatch(allOutput, /ENOENT/, "must NOT mention ENOENT");

// 9. After hand-stubbing config with owner (simulating post-create), commit should work
writeFileSync(
  join(root, ".iqgit", "config.json"),
  JSON.stringify({ owner: "FakeOwnerPubKey", repo: "test", isPublic: true }),
);
r = iqgit(root, ["commit", "-m", "first commit"]);
assert.equal(r.code, 0, "commit succeeds with valid config");
assert.match(r.stdout, /commit [0-9a-f]+ saved locally/);
const pendingDirs = require("node:fs").readdirSync(join(root, ".iqgit", "pending"));
assert.equal(pendingDirs.length, 1, "one pending dir");
assert.match(pendingDirs[0], /^001-/);

// 10. status shows the pending commit
r = iqgit(root, ["status"]);
assert.match(r.stdout, /Pending commits \(not yet pushed\): 1/);

// 11. second commit chains via parentCommitId
writeFileSync(join(root, "b.txt"), "second\n");
iqgit(root, ["add", "b.txt"]);
r = iqgit(root, ["commit", "-m", "second"]);
assert.equal(r.code, 0);
const allPending = require("node:fs").readdirSync(join(root, ".iqgit", "pending")).sort();
assert.equal(allPending.length, 2);
const meta2 = JSON.parse(readFileSync(join(root, ".iqgit", "pending", allPending[1], "meta.json"), "utf8"));
const meta1 = JSON.parse(readFileSync(join(root, ".iqgit", "pending", allPending[0], "meta.json"), "utf8"));
assert.equal(meta2.parentCommitId, meta1.id, "second commit links to first");

// 12. add with no args fails
r = iqgit(root, ["add"]);
assert.notEqual(r.code, 0);

rmSync(root, { recursive: true, force: true });
console.log("cli-flow integration ok");
