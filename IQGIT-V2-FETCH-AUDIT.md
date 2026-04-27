# IQ Git v2 — Fetch / PDA Audit (Tomorrow's Work)

Goal: Catalog, app by app and screen by screen, **which PDAs each consumer derives, with which hint, and which rows it reads**, comparing the v1 and v2 behavior. Then pick the best gateway method per call site, swap consumers over, and ship.

---

## 1. Big picture — v1 → v2 fetch model changes

### 1-1. PDA seed policy

| | v1 | v2 |
|---|---|---|
| Seed hash | Hand-rolled `crypto.subtle.digest` SHA-256 in the frontend | `iqlabs.utils.toSeedBytes` → keccak-256 (the iqlabs-sdk standard) |
| Effective derivation | hint string → SHA-256 32 bytes → PDA | hint string → keccak 32 bytes → PDA |
| Practical effect | The v1 git frontend was the outlier (solchat / iqlabs-sdk / iqchan all use keccak) | v2 joins the standard — one hashing scheme across the ecosystem |

### 1-2. Table layout

| Domain | v1 | v2 |
|---|---|---|
| Repo metadata | `git_repos_v2_<owner>` (sha256 PDA, append-only — duplicate rows for the same repo) | `git_repos_v2_<owner>` (keccak, idCol=name → contract dedupes) |
| Commits | One mixed table `git_commits_<owner>` per owner; rows tagged with `repoName` to filter | **Per-repo `git_commits:<owner>:<repo>`**, writers=[owner] → "latest row = latest commit" |
| Public gallery | None (v1 had no global view of every public repo) | `git_repos:all` (open writers; create-public-repo also pushes here) |
| iqpages registration | One table per deployment under `iqpages-root/<owner>:<repo>` plus a marker row | A single `iqpages-root/deployed` table; deploy = one new row |
| Commit row schema | `{id, repoName, message, treeTxId, parentCommitId, timestamp, author}` | `{id, message, treeTxId, parentCommitId, timestamp, author}` (no `repoName` — table itself is repo-scoped) |

### 1-3. Resulting fetch shape

- **"Latest commit, please"**: v1 = full scan of the owner's mixed commit table + filter by `repoName`. v2 = `readLatestRow(commitTableHint)` once.
- **Public-repo gallery**: v1 = not possible (per-owner only). v2 = single `readTableRows("git_repos:all")`.
- **"Is this repo deployed?"**: v1 = pull every table seed under `iqpages-root` and check whether a `<owner>:<repo>` PDA exists. v2 = `find` over the `deployed` table rows.
- **Owner's repos**: v1 = `readRows("git_repos_v2_<owner>")` then dedupe in JS. v2 = same but with the keccak hint, and the row schema no longer carries `owner`.

---

## 2. App-by-app fetch matrix — before / after

Each screen lists which PDA / hint / rows are read. **Tomorrow** we'll walk this matrix cell by cell, decide the best gateway method for each, and rewire.

### 2-1. on-chaingit-frontend (IQ GitHub)

#### Screen A: `/` (home, public gallery)

| Aspect | v1 | v2 (current) |
|---|---|---|
| PDA hint | (none — this screen didn't exist in v1) | `git_repos:all` (keccak) |
| Call | — | `readRegistryPage(connection, { limit: 1000 })` → `readTableRows` |
| Gateway candidate | — | `GET /table/<pda>/rows?limit=1000` |
| Cost | — | 1 RPC (or one gateway HTTP) |

#### Screen B: `/[wallet]` (an owner's repo list)

| Aspect | v1 | v2 |
|---|---|---|
| PDA hint | `sha256("git_repos_v2_<owner>")` | `keccak("git_repos_v2_<owner>")` |
| Call | `gitService.listRepos(owner)` → `readTableRows` | `readOwnerRepos(connection, owner)` → `readTableRows` |
| Row dedupe | Append-only table, client picks latest per name | idCol=name, dedupe happens in the contract |
| Gateway candidate | (n/a — v1 didn't go through gateway) | `GET /table/<pda>/rows` |
| Cost | One getTransaction per row (chunk linked-list traversal) | Same call, but fewer rows after dedupe |

#### Screen C: `/[wallet]/[repo]` (repo view: meta + commit log + tree)

| Aspect | v1 | v2 |
|---|---|---|
| Meta PDA | (find inside the same B table) | Same |
| Commit-list PDA | `sha256("git_commits_<owner>")` — one table per owner with **all repos mixed**, filtered by `repoName` | `keccak("git_commits:<owner>:<repo>")` — per-repo table |
| Commit call | `getLog(repoName, owner)` → `readTableRows` then JS filter | `readCommitHistory(connection, owner, repo)` — already scoped |
| Latest commit | Same call, then sort, take first | `readLatestCommit` = `readLatestRow({limit:1})` |
| Tree fetch | `readCodeIn(treeTxId)` | `loadTree(treeTxId)` (same — codeIn read) |
| Blob fetch | `readCodeIn(blobTxId)` | `loadBlob(txId)` (same) |
| Gateway candidate | — | `GET /table/<pda>/rows`, `GET /data/<sig>` |
| Cost | If the owner has N repos, the commit table is N× heavier than necessary | Repo-scoped, much lighter |

#### Screen D: `/[wallet]/[repo]/pages-setup`

| Aspect | v1 | v2 |
|---|---|---|
| iqpages.json read | Per-repo marker row's `snapshot.configTxId` → readCodeIn | Latest commit's tree → `iqpages.json` entry → loadBlob |
| iqprofile.json read | Same | Same |
| Deploy state | Per-repo marker table existence | `find` in `iqpages-root/deployed` rows for `owner:repo` |
| Commit action | Append a new row to the existing commit table | Append to the per-repo commit table; SDK dedup means other files aren't re-uploaded |

#### Screen E: `/pages` (iqpages gallery)

| Aspect | v1 | v2 |
|---|---|---|
| List | `getTablelistFromRoot("iqpages-root")` then parse every table seed back into `owner/repo` | `readTableRows("iqpages-root/deployed")` once |
| Per-card metadata | Per card: readDeploymentRow + readConfig + readProfile (legacy fallback ran a full commit-log scan) | **Card shows row data only**; heavy metadata is fetched lazily on the detail page |
| Cost | N deployments × tens of RPCs | 1 RPC + lazy on click |

#### Screen F: `/api/raw/<wallet>/<repo>/<path>`

| Aspect | v1 | v2 |
|---|---|---|
| Flow | `listRepos` → `getLog` → `getTree` (latest) → `getFileContent` | `readOwnerRepos` (public check) + `isDeployed` + `readLatestCommit` + `loadTree` + `loadBlob` |
| Gateway candidate | — | `/site/<treeTxId>/<path>` is more direct (the gateway serves straight from the tx, no PDA hop) |

---

### 2-2. iqprofilenet (IQ Profile Net)

#### Right panel mount (page load)

| Aspect | v1 | v2 (already swapped) |
|---|---|---|
| Inventory feed | `iqlabs.reader.fetchInventoryTransactions(pubkey, limit)` — one `getTransaction` per signature (limit=100 ⇒ ~100 RPCs) | Same — but a great candidate to swap for the gateway's `/user/<pubkey>/assets` endpoint |
| iqgit tab | Filters inventory for `iqgit-repo` rows (v1 row shape, has an `owner` field) | Same source; but **v2 commit / repo rows may not classify** because the v2 commit row drops `repoName` and the v2 repo row drops `owner` |
| iqchan tab | Inline JSON signature match (`threadSeed + com`) | Unchanged (iqchan itself is still v1) |
| Unofficial tab | `getTablelistFromRoot("iqpages-root")` + per-card readDeploymentRow + readConfig + readProfile (RPC explosion) | `readTableRows("iqpages-root/deployed")` once + per-card lazy fetch on click |

#### "Open" click (one unofficial app)

| Aspect | v1 | v2 |
|---|---|---|
| Resolve treeTxId | `useLatestTreeTxId` = `getLog(repo, owner)` full scan + first commit | `readLatestCommit(connection, owner, repo)` = `readLatestRow` |
| iqprofile.json | Snapshot row's `profileTxId` → readCodeIn | Latest commit's tree → `iqprofile.json` entry → loadBlob |
| iqpages.json | Same (snapshot.configTxId) | Latest commit's tree → `iqpages.json` entry → loadBlob |
| URL building | Built from snapshot.treeTxId | Built from the latest commit's treeTxId (always current) |

---

### 2-3. gameboy / poiqemon

#### Save flow (`saveToChain`)

| Aspect | v1 (calling git-service directly) | v2 (`@iqlabs-official/git-sdk/browser`) |
|---|---|---|
| Repo used | None — wrote a row directly into `git_commits_<owner>` with `repoName="poiqemon"` etc. | A private repo `gb-saves` owned by the player |
| Repo ensure | n/a | `readOwnerRepos`; if the repo isn't there yet, `createRepo({isPublic:false})` |
| Pull existing saves | `getLog` full scan → latest tree → every blob | `readLatestCommit` + `loadTree` + `loadBlob` per file |
| Write new save | One commit row + tree codeIn + a codeIn for each changed blob | `client.commit("gb-saves", msg, scan)` — dedup means saves for other games aren't re-uploaded |
| Identifier | Row's `repoName` field, separate commits per game | Single repo, file path `<gameId>.sav.gz` |

#### Load flow (`loadFromChain`)

| Aspect | v1 | v2 |
|---|---|---|
| Latest commit | `getLog` full scan → latest | `readLatestCommit` |
| Save file | Tree entry matching `<repoName>` from the chosen commit → readCodeIn | Tree entry `<gameId>.sav.gz` → loadBlob |

---

## 3. Gateway endpoints to confirm

First task tomorrow: read the gateway code / routes / docs and pin down which endpoints are actually exposed. Candidates we expect:

- `GET /table/<pda>/rows?limit=&before=` — rows of a single table. If the gateway caches/indexes this, callers skip RPC entirely.
- `GET /table/<pda>/rows/latest` — the readLatestRow shortcut. We hit this pattern often.
- `GET /data/<sig>` — codeIn payload (chunks reassembled). Used by loadBlob / loadTree.
- `GET /site/<treeTxId>/<path>` — static hosting. Already in use.
- `GET /user/<pubkey>/assets?limit=` — UserInventory-backed activity feed. Core to the right panel.
- (If it exists) something like `GET /repos?limit=` — global gallery shortcut.

For each: **does it exist, what's the cache TTL, and how much does it save versus a direct RPC**.

---

## 4. Tomorrow's checklist

Flow: **analyze → swap → verify → ship**.

### Step 1. Pin down gateway endpoints (analysis)

- [ ] Read the `iq-gateway` repo / deployed OpenAPI / source directly
- [ ] For each candidate above: confirm existence, response shape, cache TTL
- [ ] Decide whether each endpoint is "1 RPC under the hood" vs "0 RPCs (own index)"
- [ ] Verify whether `/table/<pda>/rows` is byte-for-byte compatible with `readTableRows` (the SDK already prefers a gateway fallback in some paths — confirm)

### Step 2. Verify the fetch matrix (one cell at a time, with real traffic)

For each row of §2, open the dev server with the network tab on and confirm what actually happens:

- [ ] on-chaingit-frontend: `/`, `/<wallet>`, `/<wallet>/<repo>`, `/<wallet>/<repo>/pages-setup`, `/pages`, `/api/raw/...`
- [ ] iqprofilenet right panel: page load, iqgit tab, iqchan tab, unofficial click
- [ ] gameboy save / load
- [ ] Add a "measured RPCs" column to §2 and fill it in

### Step 2.5. Open question — iqprofilenet iqchan tab classification (decision needed)

**Problem**: For non-inline inventory entries we cannot tell from metadata alone whether the row is an iqchan post or a git blob.

Why:
- `prepareCodeIn` only inlines the row JSON into `metadata.data` when `useInline = (data + metadata < 900 bytes)`. Above that, metadata only carries `{filetype, total_chunks, filename}` — the row body lives in a chunk linked-list / session.
- That means non-inline metadata can't be matched against iqchan signatures (e.g. `threadSeed + com`).
- Current heuristic: filter out binary filetypes (octet-stream / image / pdf / zip / mp4) as definitely-not-posts, surface the rest as "long post" stubs that link out to BlockChan.
- Limits:
  - Git blobs default to `application/octet-stream` (base64-encoded text fails magic-byte detection). Those are correctly excluded ✓.
  - Git trees come through as `application/json` → would land in the iqchan stub bucket ✗.
  - iqpages.json / iqprofile.json commits are also `application/json` → same issue ✗.

Options under discussion:
- (A) Show inline only, drop non-inline. Accurate, but misses long posts. **Rejected** by user ("show stubs and let people open BlockChan").
- (B) Keep the heuristic and tighten the filetype whitelist for iqchan. — `prepareCodeIn` picks a mime via magic bytes on the row JSON, which always falls through to `application/octet-stream`, so any whitelist becomes useless.
- (C) When `onChainPath` is present (linked-list head sig), fetch that head tx and read a row prefix from its metadata. +1 RPC per non-inline entry. Accuracy vs cost.
- (D) Check whether the gateway's `/user/<pubkey>/assets` already includes a row prefix in its response. If yes, do `{` + `"threadSeed"` style cheap matching against the prefix. → Depends on §3 gateway investigation.
- (E) Patch iqchan so its writeRow call passes an explicit `filename` like `"iqchan-post"`. Small change in `iqchan/src/hooks/use-post.ts`. After that, `metadata.filename` is enough to classify exactly.
- (F) **App identifier in metadata — the general fix**. Every IQ ecosystem app, on its codeIn calls, writes its own app name as a tag (e.g. `filename: "iqchan-post"` / `filename: "iqgit-commit"` / `filename: "iqgit-tree"` / `filename: "iqpages-deploy"`, or a dedicated metadata field). Then non-inline inventory entries can be classified with zero RPCs by looking at `metadata.filename`. Pros:
  - Same classification logic for inline and non-inline (no heuristics)
  - Adding a new app means defining a new tag — automatic dispatch
  - The gateway needs no extra work building the inventory response (metadata passes through)
  - Cons: **every app needs a one-line patch** (iqchan, iq-git-cli/sdk, iqpages-service, gameboy save-chain). Each is just a `codeIn(..., filename: "iqchan-post", ...)` argument.
- Compare: E only fixes iqchan; rows from other apps still aren't classifiable. F fixes everything once and stays correct. **F is the principled answer.**

Recommendation: **start with D, fall back to F if D isn't available**. C stays last because the per-call extra RPC creates an asymmetric cost (inline costs 0, non-inline costs 1).

Checklist:
- [ ] Inspect `/user/<pubkey>/assets` response shape — does it carry a row prefix?
- [ ] If yes: apply the same signature checks as `parseInlineRow` to the prefix, classification accuracy → 1.
- [ ] If no: patch iqchan's `use-post.ts` writeRow with a recognizable filename, and keep the heuristic for legacy rows.
- [ ] Whichever path we pick, clean up the non-inline branch in `lib/iqchan/use-user-posts.ts`'s `toPostEntry`.

---

### Step 3. Swap (best endpoint per call site)

For each cell, prefer the gateway path when it's lighter:

- [ ] Priority ①: iqprofilenet inventory feed → gateway `/user/<pubkey>/assets` (biggest win — limit=100 means ~100 RPCs → 1 HTTP)
- [ ] Priority ②: every `readTableRows` call → gateway `/table/<pda>/rows` (gateway caches → 0 RPCs)
- [ ] Priority ③: `/api/raw` route → check whether we can redirect straight to `/site/<treeTxId>/<path>` (if `/site` is already wired, fold them together)
- [ ] Reinforce inventory `classify` for v2 row shapes: commit lacks `repoName`, so match on `treeTxId + author + parentCommitId?`; repo lacks `owner`, so match on `name + isPublic + timestamp`.

### Step 4. Verify

- [ ] Helius 429s gone (browser console / gateway metrics)
- [ ] iqprofilenet iqchan tab — your own posts show up correctly, no git-blob noise
- [ ] iqprofilenet unofficial tab — page load = 1 RPC, click = ~3
- [ ] on-chaingit-frontend load costs match §2 across every screen
- [ ] gameboy save/load works (other games' saves preserved)

### Step 5. Ship

- [ ] frontend (`on-chaingit-frontend`) push to mainnet → server redeploy
- [ ] iqprofilenet push → redeploy
- [ ] gameboy push → re-commit into the poiqemon repo (new save-chain.js)

---

## 5. Decisions / notes

- v2 SDK 0.1.2 is published. Confirm every consumer points to it (frontend / iqprofilenet OK, CLI OK, gameboy `esm.sh` URL on 0.1.2).
- Without an `iqlabs.setRpcUrl(...)` call, the reader silently falls back to public mainnet-beta and 403s. Both `providers.tsx` and `save-chain.js` set it explicitly — keep that.
- Reinforcing the inventory `classify` for v2 rows happens in §4 Step 3's last item. Skip it and the iqgit tab won't surface v2 commits.
- If a gateway candidate doesn't exist, just keep the direct RPC for that one cell. Doesn't change the overall plan.
