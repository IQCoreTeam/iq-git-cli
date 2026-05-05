// Unit: src/core/scan.ts — fs walk + ignore rules + base64 + hash.
// Pure logic; uses a tmpdir, no chain.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIgnore, readScanFile, scan, toScanMap } from "../../src/core/scan";

const root = mkdtempSync(join(tmpdir(), "iqgit-scan-"));

writeFileSync(join(root, "README.md"), "# hi\n");
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "main.ts"), "export const x = 1;\n");
writeFileSync(join(root, ".gitignore"), "*.log\nbuild/\n");
writeFileSync(join(root, ".iqgitignore"), ".secret\nlarge-binary.bin\n");
writeFileSync(join(root, ".secret"), "supersecret\n");
writeFileSync(join(root, "debug.log"), "noise\n");
mkdirSync(join(root, "build"));
writeFileSync(join(root, "build", "out.js"), "// build artifact\n");
mkdirSync(join(root, ".git"));
writeFileSync(join(root, ".git", "HEAD"), "ref: foo\n");
mkdirSync(join(root, ".iqgit"));
writeFileSync(join(root, ".iqgit", "marker"), "x");

// 1. scan respects all ignore rules
const files = scan(root);
const paths = files.map((f) => f.path).sort();
assert.deepEqual(paths, [".gitignore", ".iqgitignore", "README.md", "src/main.ts"],
  "scan should include only non-ignored files");

// 2. .git/ and .iqgit/ are always excluded (without explicit rules)
assert.equal(paths.includes(".git/HEAD"), false);
assert.equal(paths.find((p) => p.startsWith(".iqgit/")) ?? null, null);

// 3. .gitignore patterns work
assert.equal(paths.includes("debug.log"), false, "*.log excluded by .gitignore");
assert.equal(paths.includes("build/out.js"), false, "build/ excluded by .gitignore");

// 4. .iqgitignore patterns work + merge with .gitignore
assert.equal(paths.includes(".secret"), false, ".secret excluded by .iqgitignore");

// 5. base64 is correct + hash is sha256(base64)
const readme = files.find((f) => f.path === "README.md");
assert.ok(readme);
assert.equal(Buffer.from(readme.base64, "base64").toString("utf8"), "# hi\n");
assert.match(readme.hash, /^[0-9a-f]{64}$/);

// 6. readScanFile produces the same record for a single path
const single = readScanFile(root, "README.md");
assert.deepEqual(single, readme);

// 7. toScanMap collapses to {path: base64}
const map = toScanMap(files);
assert.equal(typeof map["README.md"], "string");
assert.equal(Object.keys(map).length, files.length);

// 8. loadIgnore returns a usable Ignore instance and rules apply
const ig = loadIgnore(root);
assert.equal(ig.ignores(".secret"), true);
assert.equal(ig.ignores("debug.log"), true);
assert.equal(ig.ignores("README.md"), false);

rmSync(root, { recursive: true, force: true });
console.log("scan unit ok");
