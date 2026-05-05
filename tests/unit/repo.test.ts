// Unit: src/core/repo.ts — disk I/O, atomic meta updates, cache.
// All operations against a tmpdir; nothing touches chain.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repo from "../../src/core/repo";

const root = mkdtempSync(join(tmpdir(), "iqgit-repo-"));

// 1. initRepo creates .iqgit/pending/
repo.initRepo(root);
assert.ok(existsSync(join(root, ".iqgit", "pending")));

// 2. config round-trips
repo.writeConfig(root, { owner: "fake-owner", repo: "test", isPublic: true });
const cfg = repo.readConfig(root);
assert.equal(cfg.owner, "fake-owner");
assert.equal(cfg.repo, "test");
assert.equal(cfg.isPublic, true);

// 3. readConfig returns defaults if file missing (post-fix back-compat)
const fresh = mkdtempSync(join(tmpdir(), "iqgit-repo2-"));
repo.initRepo(fresh);
const def = repo.readConfig(fresh);
assert.equal(def.owner, "");
assert.equal(def.repo, "");
assert.equal(def.isPublic, true);
rmSync(fresh, { recursive: true, force: true });

// 4. HEAD rw
assert.equal(repo.readHead(root), null, "HEAD null when absent");
repo.writeHead(root, "abc-123");
assert.equal(repo.readHead(root), "abc-123");

// 5. index rw + dedup + sort
repo.writeIndex(root, ["b", "a", "a", "c"]);
assert.deepEqual(repo.readIndex(root), ["a", "b", "c"], "index sorted + deduped");

// 6. pending: empty list when nothing
assert.deepEqual(repo.listPending(root), []);

// 7. appendPending writes meta+tree+blobs
const tree = {
  "README.md": { hash: "h1", size: 5 },
  "src/main.ts": { hash: "h2", size: 32 },
};
const blobs = new Map<string, string>([["h1", "IyBoaQ=="], ["h2", "Y29udGVudA=="]]);
const meta: repo.PendingMeta = {
  id: "uuid-1",
  message: "first",
  parentCommitId: null,
  timestamp: 1000,
  author: "fake-owner",
  treeTxId: null,
  committedSig: null,
};
const p = repo.appendPending(root, meta, tree, blobs);
assert.equal(p.seq, 1);
assert.match(p.dir, /\/001-uuid-1$/);
assert.ok(existsSync(join(p.dir, "meta.json")));
assert.ok(existsSync(join(p.dir, "tree.json")));
assert.ok(existsSync(join(p.dir, "blobs", "h1")));
assert.ok(existsSync(join(p.dir, "blobs", "h2")));

// 8. listPending returns in seq order
const meta2: repo.PendingMeta = { ...meta, id: "uuid-2", message: "second", parentCommitId: "uuid-1", timestamp: 2000 };
repo.appendPending(root, meta2, tree, blobs);
const pending = repo.listPending(root);
assert.equal(pending.length, 2);
assert.equal(pending[0].seq, 1);
assert.equal(pending[1].seq, 2);
assert.equal(pending[0].meta.id, "uuid-1");
assert.equal(pending[1].meta.id, "uuid-2");

// 9. readPendingTree, readPendingBlob
assert.deepEqual(repo.readPendingTree(pending[0]), tree);
assert.equal(repo.readPendingBlob(pending[0], "h1"), "IyBoaQ==");

// 10. updatePendingMeta is atomic via tmp+rename + persists patch
repo.updatePendingMeta(pending[0], { treeTxId: "fake-tree-tx" });
const reloaded = repo.listPending(root)[0];
assert.equal(reloaded.meta.treeTxId, "fake-tree-tx");
assert.equal(reloaded.meta.committedSig, null, "patch is partial");

// 11. discardPending removes the dir
repo.discardPending(pending[0]);
const remaining = repo.listPending(root);
assert.equal(remaining.length, 1);
assert.equal(remaining[0].meta.id, "uuid-2");

// 12. cache rw — sync flush, get returns null when missing
assert.equal(repo.cacheGet(root, "missing"), null);
repo.cacheSet(root, "h1", { txId: "tx-h1", uploadedAt: 12345 });
assert.deepEqual(repo.cacheGet(root, "h1"), { txId: "tx-h1", uploadedAt: 12345 });
const cacheFileRaw = readFileSync(join(root, ".iqgit", "upload-cache.json"), "utf8");
assert.match(cacheFileRaw, /tx-h1/);

// 13. findRepoRoot walks up the tree
const sub = join(root, "src");
assert.equal(repo.findRepoRoot(sub), root);

rmSync(root, { recursive: true, force: true });
console.log("repo unit ok");
