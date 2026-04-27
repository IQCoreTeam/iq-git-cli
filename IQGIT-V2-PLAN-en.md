# IQ Git v2 — Per-Repo Commit Tables + Open Registry

**A schema migration to fundamentally lower read cost.**

It consists of two axes:

1. **Per-repo commit table split** — the single-per-owner `git_commits_<owner>` becomes one independent table per repo. Write permission is locked to an owner-wallet whitelist. The reader can trust that the **most recent successful tx in that table is the latest commit** and read it directly.
2. **A shared registry table** — a single open-writer table called `git_repos:all` is bootstrapped once via `createTable`. When a public repo is created, the owner writes one row into the owner's personal list, and in a separate tx writes another row into this registry. The gallery reader paginates with `readTableRows(git_repos:all, { limit, before })` and gets already-parsed rows.

---

## Current structure (v1)

```
iq-git-v1 (DbRoot)
│
├─ Table "git_repos_v2_<owner>"
│   └─ row per repo: { name, description, isPublic, timestamp }
│
└─ Table "git_commits_<owner>"        ← ALL commits by the owner (all repos mixed)
    └─ row per commit: { id, repoName, message, treeTxId, parentCommitId, timestamp, author }
```

### Problems with v1

To obtain **a single latest treeTxId** for one repo, the reader has to:

1. `readTableRows(git_commits_<owner>)` → **download every commit row across every repo that owner has**
2. Filter in JS with `row.repoName === "<repo>"`
3. Sort by `timestamp` → take `[0].treeTxId`

So the structure is **"I need one latest item, but I first pull and then throw away everything."** Consequences:

- Inside the SDK's `readTableRows`, each signature triggers a `readCodeIn` which may walk a chunk linked list per tx
- If the owner has been committing actively across multiple repos, hundreds of RPCs burst out at once
- The `{ limit: N }` option trims only the most recent N signatures; there is no guarantee the repo I care about is among them — if the neighbor repo has 10 recent commits mine might not show up at all
- Anyone can push a spam/ad tx into the table, forcing readers to independently verify "is this really a commit?"

This cost explodes most visibly in **iqprofilenet's Unofficial Apps dropdown**:

```
for each deployment in iqpages-root:
  getLog(owner, repo)  ← v1 does the full-scan above
  getLog(owner, repo)  ← called again from readConfig
  getLog(owner, repo)  ← called again from the latestTree query
```

Result: opening the dropdown fires thousands of RPCs, blowing past Helius rate limits.

And there is **no public-repo gallery**. To view someone else's repo you have to already know their owner wallet address and query their `git_repos_v2_<owner>` directly. There is no API to list "every public repo currently on-chain" from chain state alone.

---

## Proposed structure (v2)

```
iq-git-v1 (DbRoot)                                    ← DbRoot stays the same
│
├─ Table  hint = "git_repos_v2_<owner>"               ← unchanged (my repo list)
│   │   • writers = [owner.publicKey]
│   └─ row per repo: { name, description, isPublic, timestamp }
│
├─ Table  hint = "git_repos:all"                      ★ NEW open registry (gallery source)
│   │   • writers = [] (anyone can writeRow)
│   │   • schema: [owner, repo, description, timestamp]
│   │   • bootstrapped once via createTable
│   └─ row per public repo — only recorded when `isPublic = true`
│
├─ Table  hint = "git_commits:<owner>:<repo>"         ★ NEW per-repo commit table
│   │   • writers = [owner.publicKey]                   (owner-only writes — ads/spam blocked)
│   │   • schema: [id, message, treeTxId, parentCommitId, timestamp, author]
│   └─ row per commit — the most recent successful tx is the latest commit
│
└─ Table  hint = "git_commits:<owner>:<otherRepo>"
```

### Terminology: `table_hint` and navigation

The iqlabs contract's `create_table` (see `programs/iqlabs/src/iqdb/instructions.rs:27`) distinguishes two identifiers:

- **`table_seed`**: hashed bytes used only for PDA derivation. Not human-visible.
- **`table_hint`**: a "human-readable" string. Stored as-is in `db_root.table_seeds` / `global_table_seeds`.

Because the hint is pre-hash, **there are no restrictions on special characters or whitespace in repo names** — the SDK keccak-hashes it when deriving the actual PDA seed. If the naming convention is used consistently you can **re-derive the PDA from just the owner address and repo name** via `getTablePda(dbRoot, toSeedBytes(hint))`. This is the primary mechanism for "go directly to the thing you want".

#### Routes per query

| Question | Path | Cost |
|---|---|---|
| List an owner's repos (when you know the owner address) | derive PDA from hint `git_repos_v2_<owner>` → `readTableRows` | 1 RPC |
| Latest commit of a specific repo | derive PDA from hint `git_commits:<owner>:<repo>` → `readTableRows({ limit: 1 })` | 1 RPC |
| Full commit history of a specific repo | same PDA → `readTableRows` | ~1 RPC-tier (table is already per-repo isolated, no filter needed) |
| **Full public-repo listing (gallery / discovery)** | **`git_repos:all` registry → `readTableRows({ limit, before })`** | 1 RPC per page |

#### DbRoot hint scan is not an "app path"

> There is a way to list every table hint registered under a DbRoot by reading its `table_seeds` array (`iqlabs.reader.getTablelistFromRoot`). But that array **grows linearly with the number of entries**. Once owner count passes ~10k the DbRoot account is hundreds of KB to MBs, and forcing readers to download the whole thing and filter via `startsWith("git_repos_v2_")` becomes non-trivial. It gets worse when solchat / iqpages / git tables share the same DbRoot.
>
> So `getTablelistFromRoot` is for **debugging / admin views / one-off migration scripts** only. App read paths (gallery, discovery, listings) must never depend on it. Gallery / discovery are served by a dedicated registry table.

### writers whitelist

The `writers_opt` argument to `createTable` controls who may `writeRow`. The contract (`instructions.rs:52`) treats an empty list as "anyone", a non-empty list as "only those wallets".

- **`git_commits:<owner>:<repo>`** → `writers = [owner.publicKey]`. Only the owner commits. If someone else tries to ad-spam the table, `validateRowJson` rejects → readers can safely treat "a tx in this table" as "an authentic commit".
- **`git_repos_v2_<owner>`** → `writers = [owner.publicKey]`, same as today.
- **`git_repos:all`** → `writers = []` (open). Anyone has to be able to register their own public repo. Rows carry `{ owner, repo, description, timestamp }`, and at render time the reader enforces the minimal guard `row.owner === tx.signer`. If spam actually shows up, tighten via a gateway whitelist / rate-limit or a future contract constraint.
- To allow collaborators later, extend writers via the `manage_table_creators` instruction — the on-chain equivalent of real git's collaborator ACL.

### Reading the latest commit

```ts
const pda = getTablePda(dbRoot, toSeedBytes(`git_commits:${owner}:${repo}`));
const rows = await iqlabs.reader.readTableRows(pda, { limit: 1 });
const latest = rows[0];          // { id, treeTxId, message, ... }
```

**1 RPC range.** The writers constraint guarantees "the most recent successful tx" = "the real latest commit".

Call the gateway's `/table/<pda>/rows` first to get parsed rows in one shot; on an empty response fall back to the SDK. Even if the gateway picked up a bogus tx, the table itself only holds legitimate entries thanks to writers, so **readers sweep from the newest backwards until they find a valid successful tx carrying the expected instruction**.

### Reading full history

```ts
const rows = await iqlabs.reader.readTableRows(pda);   // this repo only — no filter
rows.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
```

JS filtering is gone; pagination becomes honest.

---

## The shared registry: `git_repos:all`

This is the source of truth for the chain-wide public-repo gallery.

### Design

- Single open table, `writers = []` so anyone can writeRow
- Bootstrapped **once** via `createTable` (one-time rent). Done by an admin-owned bootstrap script
- Row schema: `{ owner, repo, description, timestamp }`
- Paginate with signature-based `{ limit, before }` (SDK `readTableRows` options)
- Every time a repo is created or flipped to public, the owner writes a row
- Private repos are **not recorded**

### Why "initialized table" was chosen

The first candidate was "marker PDA touch" — attaching an uninitialized PDA as `remainingAccounts` so the event is only recorded in that PDA's tx history.

- **Pros**: no rent, single tx
- **Cons**:
  - Any troll can attach the same PDA to arbitrary txs, forcing the reader to decode and filter each time
  - Rows aren't returned parsed — recovery requires `getSignaturesForAddress` + `getTransaction` + `readCodeIn` every time
  - Can't use the `/table/<pda>/rows` gateway API

With a real table:
- **Rows come back pre-parsed** → one gateway call via `/table/<pda>/rows`
- A one-time rent charge
- Easy to tighten writers later if needed

Given the possibility of trolling, **"an initialized open table" is slightly more defensive**. Tx count grows to 2 but the cost delta is negligible.

### Writer path (when a public repo is registered)

```ts
// tx 1: append to the personal repo list
await iqlabs.writer.writeRow(
  connection, signer,
  IQGIT_ROOT_ID,
  `git_repos_v2_${owner}`,
  JSON.stringify({ name, description, isPublic: true, timestamp }),
);

// tx 2: for public repos, also append to the registry
if (isPublic) {
  await iqlabs.writer.writeRow(
    connection, signer,
    IQGIT_ROOT_ID,
    "git_repos:all",
    JSON.stringify({ owner, repo: name, description, timestamp }),
  );
}
```

Private repos skip the second tx — they never appear in the gallery.

### Reader path (gallery)

```ts
// most recent 100
const recent = await iqlabs.reader.readTableRows(
  getTablePda(dbRoot, toSeedBytes("git_repos:all"), programId),
  { limit: 100 },
);

// next page
const next = await iqlabs.reader.readTableRows(pda, {
  limit: 100,
  before: recent[recent.length - 1].signature,
});
```

Rows come back already parsed as `{ owner, repo, description, timestamp }`. At render time the minimal guard `row.owner === tx.signer` filters obvious spam / forgeries.

---

## "Registration" on repo creation

When a new repo is created the following happens:

1. A row is appended to **`git_repos_v2_<owner>`** (owner's personal list, always)
2. If **`isPublic === true`**, a row is also appended to **`git_repos:all`** (separate tx)
3. The **`git_commits:<owner>:<repo>`** table can optionally be `createTable`d here to spread the cost ahead of the first commit

A repo created with `isPublic = false` skips step (2). It stays out of the gallery; cloning/reading is limited to people looking at the owner's personal list directly.

> **Private-repo encryption (TODO)**
> Today `isPublic = false` only guarantees "not listed in the shared registry" — commit contents still land on-chain in plaintext.
> Later, `git_commits:<owner>:<repo>` rows can be encrypted with iq-locker-style DH multi-recipient encryption, limiting decryption to a collaborator whitelist.
> That combines extending `writers` via `manage_table_creators` with per-writer encryption pubkey lookup (`UserInventory.metadata`). Out of MVP scope, separate issue.

### Transaction structure (summary)

```ts
// During repo creation (createRepo)

// 1. Pre-create the commits table (writers = [owner]). Once per repo.
if (!(await isTableExists(commitsPda))) {
  await iqlabs.writer.createTable(
    connection, signer,
    IQGIT_ROOT_ID,
    `git_commits:${owner}:${repo}`,        // seed hint — SDK hashes this
    "git_commits",                         // table_name (human readable)
    ["id", "message", "treeTxId", "parentCommitId", "timestamp", "author"],
    "id",
    [],
    undefined,                             // no gate
    [signer.publicKey],                    // writers
    `git_commits:${owner}:${repo}`,        // tableHint (stored in DbRoot)
  );
}

// 2. writeRow into the personal list
await iqlabs.writer.writeRow(
  connection, signer,
  IQGIT_ROOT_ID,
  `git_repos_v2_${owner}`,
  JSON.stringify({ name, description, isPublic, timestamp }),
);

// 3. Public → also writeRow into the registry
if (isPublic) {
  await iqlabs.writer.writeRow(
    connection, signer,
    IQGIT_ROOT_ID,
    "git_repos:all",
    JSON.stringify({ owner, repo: name, description, timestamp }),
  );
}
```

Cost:
- **Bootstrap**: `git_repos:all` createTable once (network-wide, done by an admin)
- **Per repo creation**: `createTable × 1` (commits, once per repo) + `writeRow × 1~2` (2 if public)

---

## iq-git-cli changes (writer path)

### On commit

```ts
// 1. Create the per-repo commits table if absent
if (!(await this.isTableExists(owner, repo, "commits"))) {
  await iqlabs.writer.createTable(..., writers=[signer.publicKey]);
}

// 2. Store the commit row
await iqlabs.writer.writeRow(..., JSON.stringify(commit));
```

`createTable` cost lands only on the first commit (rent ~0.002 SOL). Every subsequent commit is just a writeRow.

### fetch / log / clone

Switch to `readTableRows(git_commits:<owner>:<repo>)`. JS filter dropped.

### createRepo

Follows the "registration" contract above. The `isPublic` flag defaults to `true`. For private, `createRepo(name, { isPublic: false })`.

### (Optional) gallery CLI command

Add an `iq-git public-repos [--limit N] [--before SIG]` subcommand that reads `git_repos:all` with pagination.

---

## on-chaingit-frontend changes (read + write)

### Commit UI

Same path as the CLI.

### Repo page / commit list

Because the table is per-repo isolated, the page renders without JS filtering. Pagination becomes honest.

### deploy()

Previously: `readConfig` → `readFileFromLatest` → `getLog(owner)` with the full-owner scan. In v2: `readTableRows(git_commits:<owner>:<repo>, { limit: 1 })`, one shot.

The Phase 0 logic that writes a snapshot JSON into the iqpages marker row stays as **"pin the deployed version"** — later commits don't change what's deployed; the pinned treeTxId remains. If someone wants "auto-follow latest", ignore the iqpages row and go directly to `git_commits:<owner>:<repo>`. Of the two defaults pinned is safer, so iqprofilenet should keep the pinned default.

### Public gallery

New page: paginate `git_repos:all` via `readTableRows({ limit, before })`. Build per-row links to repo detail pages from `owner`/`repo`.

---

## iqprofilenet changes (read only)

### Unofficial Apps dropdown

```ts
for each deployment (owner, repoName) in iqpages-root:
  // Option 1 (default): deploy-time snapshot. 1 RPC to iqpages marker row.
  snapshot = await svc.readDeploymentRow(owner, repoName)

  // Option 2 (if desired): live latest. 1 RPC to per-repo commit table.
  latest = await git.getLatestCommit(owner, repoName)  // readTableRows limit:1
```

Both land in **the 1-RPC range**. Compared to v1's owner-wide scan this is hundreds of times cheaper.

`useDeploymentDetails`'s `useQueries` also stops calling `getLog` three times per deployment. Each deployment is 2–3 RPCs at most (`readDeploymentRow` + optional `getFile(configTxId)` + `getFile(profileTxId)`).

---

## Migration

### Inventory

The **existing repos needing migration are extracted from the iqpages-root deployment list**. Currently confirmed:

| Owner | Repos | Notes |
|---|---|---|
| `FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c` | `iq-snake`, `poiqemon` | Deployed from the keypair at `~/Desktop/deploy/deploy.json`. https://git.iqlabs.dev/pages/FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c/{repo} |

If other users have deployments, just harvest coordinates with `getTablelistFromRoot(iqpages-root)` (migration-script scope only, never app runtime). Then iterate through each owner's `git_commits_<owner>` and push into v2 tables.

### Backward-compat policy: no v1 fallback

Since the v1 user count is effectively zero, **the SDK does not carry a v1 read path**. SDK v2 only looks at v2 tables. Consequences:

- Repos that were committed via v1 are **invisible to v2 readers until migrated** (iqprofilenet / on-chaingit-frontend included)
- Unmigrated repos show up in v2 apps as "no commits" — whoever cares about that repo runs the script
- No fallback code clutters the SDK. The full-scan logic that caused the burst is gone from the codebase

**However, file blobs / tree txs remain on-chain and are directly reusable.** Migration only rewrites commit rows — no file/tree re-upload.

### The migration script — separate repo `iqgit-v1-migrator`

Lives at `~/WebstormProjects/iqgit-v1-migrator/`. The SDK repo stays free of one-off scripts. Because this tool is **written to be run a handful of times and then retired**, it has no place in the SDK's publish artifacts; keeping it as its own CLI app cleanly separates its dependencies, build, and execution.

Structure:

```
~/WebstormProjects/iqgit-v1-migrator/
├─ package.json                   ← dependencies: "@iqlabs/git", "iqlabs-sdk", "commander"
├─ tsconfig.json
├─ README.md                      ← purpose, usage, cost estimate
└─ src/
    ├─ bin.ts                     ← commander entry (migrate / verify / dry-run)
    ├─ v1-reader.ts               ← directly scans the legacy git_commits_<owner> table
    ├─ migrate.ts                 ← main flow (ensureCommitTable → writeRow × N)
    └─ util/
        ├─ keypair.ts             ← loads local keypair json
        └─ log.ts                 ← progress-log formatter
```

This repo serves as **the first real consumer of `@iqlabs/git/node`**, so it also doubles as a smoke test of the SDK's public interface. If writing the script keeps forcing you into SDK internals, the public API is under-specified.

**Inputs**:
- owner keypair (json file path)
- RPC URL (env)

**Flow**:

```ts
import { Keypair, Connection } from "@solana/web3.js";
import { GitClient } from "@iqlabs/git/node";
import iqlabs from "iqlabs-sdk";

const keypair   = loadKeypair(process.argv[2]);
const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const client    = GitClient.forNode({ connection, keypair });
const owner     = keypair.publicKey.toBase58();

// 1. Collect all of the owner's commit rows from the v1 table
//    (v2 SDK doesn't expose this path, so the script calls iqlabs-sdk directly)
const v1Pda   = iqlabs.contract.getTablePda(
  iqGitDbRoot,
  iqlabs.utils.toSeedBytes(`git_commits_${owner}`),
  PROGRAM_ID,
);
const v1Rows  = await iqlabs.reader.readTableRows(v1Pda);
const byRepo  = groupBy(v1Rows, r => r.repoName);

for (const [repoName, commits] of Object.entries(byRepo)) {
  commits.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));  // oldest first

  // 2. Create the v2 per-repo commit table if missing (writers = [owner])
  await client.ensureCommitTable(repoName);

  // 3. writeRow in chronological order — treeTxId / author / timestamp preserved.
  //    Rebuild the DAG link by setting parentCommitId to the previous row's id
  let parent: string | undefined = undefined;
  for (const c of commits) {
    await client.writeCommitRow(repoName, {
      id: c.id,
      message: c.message,
      treeTxId: c.treeTxId,
      parentCommitId: parent,
      timestamp: Number(c.timestamp),
      author: c.author,
    });
    parent = c.id;
  }

  // 4. If the repo is currently public, also register it in (git_repos:all)
  const repoMeta = await client.getRepoMeta(owner, repoName);
  if (repoMeta?.isPublic) {
    await client.registerPublicRepo({
      owner, repo: repoName,
      description: repoMeta.description,
      timestamp: Date.now(),
    });
  }

  // 5. Verify
  const latest = await client.getLatestCommit(owner, repoName);
  if (latest.treeTxId !== commits[commits.length - 1].treeTxId) {
    throw new Error(`migration verify failed for ${repoName}`);
  }
  console.log(`✓ ${repoName}: ${commits.length} commits migrated`);
}
```

**Key properties**:
- File blobs / tree txs are left untouched. Zero re-upload. Cost is `createTable × repo count` + `writeRow × commit count`
- The owner keypair must sign, otherwise it can't pass `writers=[owner]` → **you can only migrate your own repos**
- The script is idempotent — `ensureCommitTable` skips if the v2 table already exists. Safe to re-run after a partial failure
- `parentCommitId` is reconstructed from sort order. The DAG link that v1 never persisted is filled in here

### Example run

```bash
# 1. The SDK must already be published or linked
cd ~/WebstormProjects/iqlabs-git-sdk
npm run build && npm link

# 2. Prepare the migrator repo
cd ~/WebstormProjects/iqgit-v1-migrator
npm install
npm link @iqlabs/git        # only while developing locally
npm run build

# 3. The owner runs this with their own keypair
SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..." \
  npx iqgit-v1-migrator migrate ~/Desktop/deploy/deploy.json
```

Output:
```
scanning v1 table git_commits_FPSYQm...
found 2 repos: iq-snake, poiqemon
creating git_commits:FPSYQm...:iq-snake (writers=[FPSYQm...])
writing 7 commits...
✓ iq-snake: 7 commits migrated
...
✓ poiqemon: 3 commits migrated
migration complete
```

Ship a `dry-run` subcommand that simulates the conversion and only prints the log lines without writing anything to chain. A `verify` subcommand re-checks, after the fact, that v1 and v2 agree on the latest commit's treeTxId.

### Cost estimate

For the currently known targets (`FPSYQmFh...rf1c` with `iq-snake`, `poiqemon`):
- `createTable × 2` ≈ 0.004 SOL (commits tables)
- `writeRow × (commits count)` ≈ 0.00001 SOL × dozens = negligible
- Public → `git_repos:all` writeRow × 2 ≈ 0.00002 SOL

**Total expected: under 0.005 SOL.** Having at least 0.01 SOL in the owner account gives comfortable headroom.

### Exception: the two legacy iqpages deployments

`iq-snake` / `poiqemon` were deployed under v1 with the iqpages table's `writers` incorrectly set to `[SystemProgram.programId]`, which means **that table's marker row can't be updated**. So:

- The v2 commit-table migration itself works fine (separate PDA)
- But the iqpages-side "which tree was deployed" snapshot row can't be written
- → These two repos are **hidden via a legacy filter** instead (below)

### Legacy iqpages filter

```ts
// Shared by every v2 consumer app
const LEGACY_IQPAGES = new Set([
  "FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c:iq-snake",
  "FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c:poiqemon",
]);
```

Apply this filter to iqprofilenet / on-chaingit-frontend deployment listings before rendering. The two repos' commit history is still queryable via v2, but they do **not appear as "deployed iq-pages"**. To relaunch them under v2, redeploy with a different repo name or wait until the iq-pages account can be rotated.

---

## Phases (plan)

### Phase 0 — current (skipped, not committed / pushed)
- on-chaingit-frontend got the marker snapshot logic (deploy writes a JSON row)
- iqprofilenet got `readDeploymentRow` + fallback
- **Not committed or pushed.** Some of it survives v2, some of it gets replaced, so hold the commit until v2 work lands together

### Phase 1 — introduce v2 schema
1. **Bootstrap**: create the `git_repos:all` registry table once via `createTable(writers=[])` using an admin key. Freeze the resulting PDA as a constant (`GIT_REPOS_ALL_PDA`)
2. iq-git-cli: rewrite `commit`, `fetch`, `log`, `clone` against per-repo tables. First commit runs `createTable(writers=[owner])`
3. iq-git-cli: `createRepo` writeRow into `git_repos_v2_<owner>` and, if public, into `git_repos:all`
4. iq-git-cli: (optional) `public-repos` subcommand paginating `git_repos:all`
5. on-chaingit-frontend: same writer paths + per-repo reads + public gallery page
6. Confirm no SDK changes needed (writers + `{ limit: N }` + tableHint + `before` already supported)

### Phase 2 — migration
1. iqpages-root coordinate-collection script
2. For each (owner, repo), create the v2 table + migrate rows + verify
3. Register public repos into `git_repos:all`
4. **Record un-migrateable legacy deploys (writers fixed)** in the LEGACY list
5. Update iqpages marker rows (only for deployments that actually moved)

### Phase 3 — read-path switch
1. on-chaingit-frontend: deploy / repo / commit list all read from v2 only. Remove v1 fallback
2. iqprofilenet: collapse `useDeploymentDetails` into a 1-RPC `readDeploymentRow` path. Remove all `getLog` calls
3. Apply the LEGACY filter in both apps so drop-down / gallery hides them

### Phase 4 — cleanup
1. Delete v1 code paths (commit-log scan in `readFileFromLatest`, fallback inside iqpages-service, etc.)
2. Refresh documentation (README, IQPAGES-PLAN)
3. E2E check that new deploys only hit v2 paths

---

## Cost / risk

- **Low-user-count window now** is the clean time to migrate. Before users pile up, the migration script stays light
- SDK / contract changes **none** → iq-locker, iqprofilenet, solchat, etc. are unaffected except where they read/write commits
- Risky interval: new commits landing on v1 during migration. Sequence: (Phase 1 deployed) → (new commits already flow through v2) → (Phase 2 migrates history). Or declare a maintenance window
- **`git_repos:all` spam**: writers open = anyone can try to post fake rows. Default reader guard is `row.owner === tx.signer`; if abuse actually shows up, add a gateway whitelist / rate-limit or introduce a contract constraint. Acceptable for MVP
- Private-repo content encryption stays out of scope. Make sure the UI states clearly that `isPublic` only controls "shared directory visibility"

---

## Git's internal model — what the current implementation borrows, what it skips

The v2 design has room to branch further, so it's worth laying out **what real git uses internally** and how much of that we actually reproduce. Decisions during modularization / SDK-ification flow from this.

### Git's three core objects

Git abstracts the disk into three objects: blob / tree / commit. All are **identified by the hash of their content** (SHA-1 in v2, SHA-256 in v3) — same content, same hash; same hash, same object. This is the root of "already uploaded, don't upload again".

- **blob**: the bytes of one file. No name, no permissions, content only. Commit the same content under two names → still one blob.
- **tree**: a directory snapshot. Each entry is `{mode, name, hash_of_blob_or_tree}`. The tree itself is hashed and addressable. Because a subtree's hash appears directly in the parent entry, **unchanged subtrees leave the parent tree unchanged too**.
- **commit**: `{tree_hash, parent_hash, author, committer, message, timestamp}`. Also hashed. Walking parents backwards reproduces the full history.

So "commit points at tree, tree points at blob/subtree, every pointer is a hash" — a **Merkle DAG**.

#### Dedup comes for free

- `git add` hashes file content → if `.git/objects/<first 2>/<rest 38>` already exists, skip the write
- At `git commit` time the tree is built by hashing each entry → identical files just reuse the existing blob hash
- Remote `git push` uses the send-pack protocol to omit "hashes the other side already has", so duplicate blobs aren't shipped over the wire

### What the current iq-git borrows

How `src/git-service.ts:284-409` (the commit function) mimics incremental commit:

- **Dedup by file hash**
  ```ts
  const currentHash = sha256(content).toString("hex");
  if (oldTree[relativePath] && oldTree[relativePath].hash === currentHash) {
      fileTree[relativePath] = oldTree[relativePath];    // reuse the existing txId
      reusedCount++;
      continue;                                           // skip the codeIn upload
  }
  ```
  This is the "don't re-upload what's already on-chain" implementation. Same content hash → **reuse the previous commit's txId** straight into the new tree. Equivalent effect to blob reuse.

- **Tree concept = the `tree.json` manifest**
  ```ts
  const fileTree: FileTree = {};    // { [path]: { txId, hash } }
  // ...
  const treeTxId = await iqlabs.writer.codeIn(..., ["tree.json"], ...);
  ```
  The directory snapshot is one JSON file, uploaded via codeIn; its tx signature is the `treeTxId`. Equivalent to a real git tree object.

- **Commit points at the tree**
  ```ts
  const commit: Commit = {
      id: randomUUID(), repoName, message, author,
      timestamp, treeTxId,
  };
  await iqlabs.writer.writeRow(..., commit);
  ```
  The commit row's `treeTxId` serves as "the snapshot address of this commit".

- **Chunking**
  ```ts
  const chunks = chunkString(content, DEFAULT_CHUNK_SIZE);   // 850 bytes/chunk
  ```
  Large files exceed Solana's tx payload limit, so they are split into chunks and stored as a codeIn linked list. Plays a similar role to git packfiles / delta compression, but the implementation is plain byte slicing.

### What the current iq-git skips (intentional or just missing)

- **Dedup is "path+hash", not blob-level**
  Real git says "same content" = same blob, reusable even across renames. iq-git gates on `oldTree[relativePath].hash === currentHash`, so **the path also has to match** — renames trigger a full re-upload. Adding a `hash → txId` secondary index to the tree fixes this. Do it during the v2 refactor.
- **No structural subtree reuse**
  Real git reuses the subtree object itself when an inner directory is unchanged. iq-git's tree is a flat `path → {txId, hash}` map with no subtree concept — every commit re-uploads the full tree JSON. Manifest size balloons for large repos.
- **Parent-commit link (history traversal) isn't populated**
  `Commit.parentCommitId` exists in the type but isn't set at commit time (`src/git-service.ts:402-409`). There's no `git log --graph` equivalent; log is just the per-repo table sorted by timestamp. Branches / merges need this.
- **branch / ref / HEAD**
  `types.ts` defines a `Ref` type but in practice "latest commit = newest row in the table" stands in. There is no `refs/heads/main`, no `refs/tags/*`, and therefore no logic to resolve them during merge / checkout.
- **Packfile / delta compression**
  Real git shrinks storage by deltaing between similar blobs; iq-git always stores raw base64 + chunking. Expensive for big repos. Fine to skip for MVP.

### Worth fixing in v2

| Item | Cost | Payoff |
|---|---|---|
| Add hash → txId index (rename dedup) | Small | Avoid re-upload on file move / rename |
| Introduce subtree (recursive `tree.json`) | Medium | Shrink tree manifest / rent. Essential for big repos |
| Actually record `parentCommitId` | ~0 | Foundation for history / revert / blame |
| Model `branch`, `ref` | Medium | Real collaboration (PR · merge) preconditions |

MVP tackles only the **hash dedup index** and **parentCommitId recording**, leaving the rest to separate issues. The modularization should leave space for these to each land as their own small modules.

---

## The new package layout — `@iqlabs/git` SDK and its thin consumers

Working from a clean-slate rewrite assumption. The CLI / protocol / chain-access code currently mixed across 6 files in `iq-git-cli/src/` is pulled out into an **independent npm package `@iqlabs/git`**. The CLI, frontends, and other apps all become thin wrappers that consume the SDK as a dependency.

### Repo layout (NOT a monorepo — each repo is independent)

All repos live together under `~/WebstormProjects/` so local development with `npm link` / `pnpm link` stays simple, while **each repo remains its own git repository and its own npm package**.

```
~/WebstormProjects/
│
├─ iqlabs-git-sdk/                       ← NEW repo, the npm package "@iqlabs/git"
│   ├─ package.json                      ← exports map: ".", "./browser", "./node"
│   ├─ tsconfig.json
│   ├─ rollup.config.mjs                 ← 3-target build (shared / browser / node)
│   │
│   ├─ src/                              ← all real logic. No CLI.
│   │    ├─ index.ts                     ← "@iqlabs/git" (shared)
│   │    ├─ browser.ts                   ← "@iqlabs/git/browser"
│   │    ├─ node.ts                      ← "@iqlabs/git/node"
│   │    ├─ core/                        ← L0  types, seed, hash, chunk, codec
│   │    ├─ wallet/                      ← L0  Signer abstraction
│   │    ├─ chain/                       ← L1  iqlabs-sdk wrapper + gateway fallback
│   │    ├─ storage/                     ← L2  BlobStore, TreeStore
│   │    ├─ model/                       ← L3  RepoService, CommitService, RegistryService
│   │    ├─ client/                      ← L4  GitClient (facade)
│   │    └─ platform/                    ← fs-node / fs-browser split
│   │
│   ├─ test/
│   └─ scripts/
│        └─ bootstrap-registry.ts        ← first-time createTable for git_repos:all (admin key)
│                                          (kept in the SDK because it's a reusable
│                                           bootstrap, not a one-off migration)
│
├─ iqgit-v1-migrator/                    ← NEW repo, one-off v1→v2 migration tool
│   ├─ package.json                      ← dependencies: "@iqlabs/git", "iqlabs-sdk", "commander"
│   └─ src/
│        ├─ bin.ts                       ← commander (migrate / verify / dry-run)
│        ├─ v1-reader.ts                 ← scans legacy git_commits_<owner>
│        ├─ migrate.ts                   ← main flow
│        └─ util/
│
├─ iq-git-cli/                           ← existing repo, converted into a thin CLI wrapper
│   ├─ package.json
│   │   └─ dependencies:
│   │       "@iqlabs/git": "^0.1.0"
│   │       "commander": "^x"
│   │   └─ bin: { "iq-git": "./dist/bin.js" }
│   │
│   └─ src/
│        ├─ bin.ts                       ← shebang + commander setup
│        ├─ commands/
│        │   ├─ init.ts                  ← new GitClient({...}).createRepo(...)
│        │   ├─ commit.ts
│        │   ├─ log.ts
│        │   ├─ clone.ts
│        │   ├─ checkout.ts
│        │   ├─ status.ts
│        │   ├─ public-repos.ts          ← git_repos:all pagination query
│        │   └─ deploy.ts                ← iqpages deploy
│        └─ config.ts                    ← ~/.iq-git/config, keypair path resolution
│
├─ on-chaingit-frontend/                 ← existing repo
│   └─ package.json
│       └─ dependencies:
│           "@iqlabs/git": "^0.1.0"
│   → import { GitClient } from "@iqlabs/git/browser"
│     (drop self-written GitChainService / IqpagesService)
│
└─ iqprofilenet/                         ← existing repo
    └─ package.json
        └─ dependencies:
            "@iqlabs/git": "^0.1.0"
    → import { readDeploymentRow, lookupLatestCommit } from "@iqlabs/git/browser"
      (remove all of src/lib/iqgit/)
```

The SDK is the "source" of the logic; CLI / frontends are the UX layer that consumes it. The two have **independent release cycles**.

### Why independent repos instead of a monorepo

| Independent repos | Monorepo |
|---|---|
| SDK version pins explicitly (`"@iqlabs/git": "^0.1.2"`) | Workspace linking can blur this |
| External users `npm i @iqlabs/git` and they're done | Can be misread as "workspace-only" |
| Issues / PRs / history isolated per repo | Mixed |
| Simpler CI / release automation | Workspace build ordering to track |
| Local dev needs one `npm link` | Workspace auto-links |

`npm link` (or `pnpm link`) solves the local-dev ergonomics; clarity of structure matters more.

### Subentries (exports map)

`@iqlabs/git` `package.json`:

```jsonc
{
  "name": "@iqlabs/git",
  "version": "0.1.0",
  "exports": {
    ".":         { "import": "./dist/shared/index.js",   "types": "./dist/shared/index.d.ts" },
    "./browser": { "import": "./dist/browser/index.js",  "types": "./dist/browser/index.d.ts" },
    "./node":    { "import": "./dist/node/index.js",     "types": "./dist/node/index.d.ts" }
  },
  "peerDependencies": {
    "@solana/web3.js": "^1.98.0",
    "iqlabs-sdk": "^0.1.21"
  }
}
```

- `@iqlabs/git` — runtime-neutral (types, seed, chunk, hash interface, row schemas). No DOM / node-fs dependency
- `@iqlabs/git/browser` — above + `WalletAdapter`, Web Crypto hashing, fetch-based gateway
- `@iqlabs/git/node` — above + `node:fs`, `node:crypto`, Keypair loader

CLI and Node migration scripts import from `@iqlabs/git/node`; web apps import from `@iqlabs/git/browser`. Any static helpers or config that only need shared types live in the root `@iqlabs/git`.

### Dependency rules

- Root (`shared`) only peer-deps on `@solana/web3.js`, `iqlabs-sdk`, `buffer`. DOM / node fs **forbidden**
- `browser` additionally depends on `@solana/wallet-adapter-base` (types only)
- `node` additionally uses `fs/promises`, `path`, `node:crypto` built-ins
- CLI (`iq-git-cli`) depends on `@iqlabs/git` plus UI libs (`commander` / `kleur` / `prompts`). **Direct chain-access code is forbidden** — always go through the SDK

Enforce these with eslint `no-restricted-imports` so node APIs leaking into the web bundle are caught at build time.

### Local development workflow

Since every repo lives under `~/WebstormProjects/`, `npm link` (or `pnpm link`) is straightforward.

```bash
# Run the SDK build in watch mode
cd ~/WebstormProjects/iqlabs-git-sdk
npm install
npm run build -- --watch    # rollup/tsup watch
npm link                    # register the global symlink

# Link the local SDK into the CLI
cd ~/WebstormProjects/iq-git-cli
npm link @iqlabs/git
npm run dev

# Link the local SDK into the frontends
cd ~/WebstormProjects/on-chaingit-frontend
npm link @iqlabs/git
npm run dev

cd ~/WebstormProjects/iqprofilenet
npm link @iqlabs/git
npm run dev

# Unlink before release
cd ~/WebstormProjects/iq-git-cli
npm unlink --no-save @iqlabs/git
npm install                 # reinstall the pinned version
```

A single SDK edit → watch build propagates to all three consumers (CLI + two frontends) in real time. This is the main reason the dev loop stays short and safe.

### Extension pattern (the same rule in other domains)

The same principle scales across the IQ Labs codebase. Every repo sits under `~/WebstormProjects/`.

| SDK (independent repo, npm-published) | Path | Thin consumers |
|---|---|---|
| `@iqlabs/git` | `~/WebstormProjects/iqlabs-git-sdk/` | `iq-git-cli`, `on-chaingit-frontend`, `iqprofilenet`, `iqgit-v1-migrator` |
| `@iqlabs/iqpages` | `~/WebstormProjects/iqlabs-iqpages-sdk/` | `on-chaingit-frontend` (deploy UI), `iqprofilenet` (read) |
| `@iqlabs/chat` (solchat core) | `~/WebstormProjects/iqlabs-chat-sdk/` | `solchat-web`, `simplechatcli` |
| `@iqlabs/iqchan` | `~/WebstormProjects/iqlabs-iqchan-sdk/` | iqchan-related apps |

One-off tooling (migrations, bootstraps, etc.) does not live inside an SDK — it goes into its own repo. Example: `iqgit-v1-migrator` is the v1→v2 migration CLI.

**Shared logic = SDK, UX = thin consumers.** Multiple apps import the same SDK so fixing a bug once benefits them all. Version pinning keeps breaking changes explicit — they only propagate by deliberate upgrade.

An eslint `no-restricted-imports` rule catches the case where a web user accidentally pulls in `node`-only code.

---

## Modularization plan — internal layer breakdown

The current `git-service.ts` (831 lines) mixes "repo creation · commit · fetch · collaborator · iqpages hookups" together. The rewrite splits it into these layers; each layer only imports from the one below.

```
┌─────────────────────────────────────────────┐
│  L5  Apps                                   │
│  iq-git-cli's thin commands,                │
│  on-chaingit-frontend, iqprofilenet         │
└─────────────────────────────────────────────┘
                  ↓ uses
┌─────────────────────────────────────────────┐
│  L4  GitClient (facade)                     │
│    • commit, clone, log, checkout, status   │
│    • createRepo, setVisibility, fork        │
│    • high-level workflows only,             │
│      orchestrates layers below              │
└─────────────────────────────────────────────┘
                  ↓ uses
┌──────────────────┐  ┌──────────────────────┐
│ L3 RepoService   │  │ L3 CommitService     │
│  git_repos_v2,   │  │  git_commits:<o>:<r>,│
│  git_repos:all   │  │  per-repo writeRow,  │
│  CRUD            │  │  latest / history     │
└──────────────────┘  └──────────────────────┘
                  ↓ uses
┌──────────────────┐  ┌──────────────────────┐
│ L2 TreeStore     │  │ L2 BlobStore         │
│  tree.json       │  │  codeIn file upload, │
│  serialize/read, │  │  hash → txId index,  │
│  (later) subtree │  │  dedup, retry         │
└──────────────────┘  └──────────────────────┘
                  ↓ uses
┌─────────────────────────────────────────────┐
│  L1  ChainAdapter                           │
│    • createTable, writeRow, readTableRows   │
│    • getSignaturesForAddress, readCodeIn    │
│    • gateway fetch + SDK fallback           │
│    • rate-limited retry                     │
└─────────────────────────────────────────────┘
                  ↓ uses
┌─────────────────────────────────────────────┐
│  L0  Platform                               │
│    core/hash.ts      — SHA-256 (web/node split)│
│    core/chunk.ts     — byte-safe chunking    │
│    core/seed.ts      — table_hint convention │
│    core/fs.ts (node) — directory scanning    │
│    core/wallet.ts    — Signer abstraction    │
└─────────────────────────────────────────────┘
```

### Responsibilities per layer

- **L0 `core/`** — contains every runtime-specific dependency (hash, fs scan, wallet signing) in one place. Browser `core/hash.ts` is `SubtleCrypto`-based, Node is `node:crypto`-based. Higher layers only see the interface.
- **L1 `chain/`** — SDK-call wrappers. Only layer that imports `iqlabs-sdk`. Gateway `/table/<pda>/rows` first, SDK `readTableRows` fallback on empty. Rate-limited retry lives here. L2+ talks to this adapter via interface so tests can mock easily.
- **L2 `storage/`**
  - `BlobStore`: file content → codeIn upload. **Holds the hash → txId cache** here so renames can still dedup. Chunking lives here too.
  - `TreeStore`: path-map tree (`tree.json`) serialize / parse / upload. When subtree support lands, only the inside of this file changes.
- **L3 `model/`**
  - `RepoService`: owner's repo list, visibility, registering in the shared registry. Implements the schema and navigation rules above.
  - `CommitService`: per-repo commit table creation / writeRow / `readTableRows({limit:1})` / filling in `parentCommitId`.
- **L4 `client/GitClient`** — user-facing workflows (commit, clone, status, checkout, etc.) implemented by composing the modules above. Complex commit state-machine logic is orchestrated here.
- **L5 Apps** — CLI / frontends / iqprofilenet all use `GitClient`. They only contain UI-specific code.

### Test strategy across layers

- L0 / L1 are **unit-tested**. The chain adapter mocks `SystemProgram` calls.
- L2 / L3 use a **fake chain adapter** for in-memory simulation → quick coverage of dedup, hash reuse, etc.
- L4 `GitClient` is tested against a **local Solana test validator** for integration, real codeIn round trips included.

### Mapping from legacy code (where to copy from)

| v2 module | Existing source |
|---|---|
| `core/chunk.ts` | `iq-git-cli/src/chunk.ts` as-is |
| `core/hash.ts` | `git-service.ts`'s use of `sha256`. Rewrite with node / web split |
| `core/wallet.ts` | `iq-git-cli/src/wallet_manager.ts` + `iqlabs-sdk`'s `SignerInput` as reference |
| `core/fs.ts` (node) | `git-service.ts`'s `scanDirectory`, `fs.readFileSync` loop |
| `chain/` | `iqlabs-sdk` call sites + the solchat `gateway/reader.ts`'s `readTableRows` fallback pattern |
| `storage/BlobStore` | `git-service.ts:314-366` (file upload loop + hash skip + retry) |
| `storage/TreeStore` | `git-service.ts:381-391` (`tree.json` codeIn) + the `readCodeIn` recovery logic in `checkout` |
| `model/RepoService` | `git-service.ts`'s `createRepo`, `listRepos`, `setVisibility`, fork |
| `model/CommitService` | `git-service.ts`'s `commit`, `getLog`, the commit part of `checkout` |
| `client/GitClient` | the overall glue logic in `git-service.ts` (commit → blob upload → tree upload → commit row write) |
| `cli/` | Rewritten from the existing `iq-git-cli/package.json` bin + `index.ts` |

---

## Phases (plan — incl. repackaging)

Each phase assumes **independent repos**. The SDK publishes first, then CLI / frontends consume it.

### Phase 0 (skipped, not committed / pushed)
> See the section above. The Phase 0 changes in on-chaingit-frontend + iqprofilenet are scheduled to be superseded by v2, so hold the commit.

### Phase 1 — implement `@iqlabs/git` SDK (new repo: `~/WebstormProjects/iqlabs-git-sdk/`)

Create a new repo at `~/WebstormProjects/iqlabs-git-sdk/` and do all the SDK work there. Do **not touch** existing `iq-git-cli` / frontend code during this phase.

1. Create `~/WebstormProjects/iqlabs-git-sdk/` + `git init` + `npm init`. `package.json` (name = `@iqlabs/git`, exports map configured), `tsconfig.json`, rollup/tsup build, eslint rules (inter-layer import constraints)
2. Write L0 `core/` (chunk, hash, seed, wallet, codec, errors)
3. Write L1 `chain/` (chain-adapter interface + iqlabs-sdk implementation + gateway fallback + rate-limit)
4. Write L2 `storage/` (BlobStore + hash → txId index, TreeStore, tree-walker)
5. Write L3 `model/` (RepoService, CommitService, RegistryService — reflects the per-repo table convention)
6. Implement `client/GitClient` with commit / clone / log / checkout / status (L4)
7. `scripts/bootstrap-registry.ts` — one-time createTable of `git_repos:all` (admin key). First consumer of `@iqlabs/git/node`
8. vitest unit tests (core / storage / model) + fake chain adapter
9. `npm publish` (as e.g. `0.1.0-rc.1`) — once published the next phase can consume it

### Phase 2 — convert `iq-git-cli` into a thin wrapper

Keep the existing repo but **hollow out its internals and turn it into an SDK consumer**.

1. Add `"@iqlabs/git": "^0.1.0"` to `iq-git-cli/package.json`. Drop direct dependencies (`iqlabs-sdk`, `@solana/web3.js`, etc.) — they move to peer
2. Rewrite under a `src/bin.ts` + `src/commands/*` shape. Each command only calls `GitClient` methods and focuses on UX (prompts / error messages / progress bars)
3. **Remove** existing `git-service.ts`, `iqpages-service.ts`, `chunk.ts`, `wallet_manager.ts`
4. During local development, `npm link @iqlabs/git` so SDK edits take effect immediately
5. Bump the CLI version and (optionally) `npm publish`

### Phase 3 — migration (separate repo `iqgit-v1-migrator`)

A new repo at `~/WebstormProjects/iqgit-v1-migrator/` builds the v1 → v2 data-migration tool. Rather than mixing one-off scripts into the SDK repo, it lives as its own project. This tool is **the second real consumer of `@iqlabs/git/node`**, using only the SDK's public interface (the same API the CLI uses).

1. Initialize `iqgit-v1-migrator` — `git init` + `npm init` + add `@iqlabs/git` as a dependency
2. Implement iqpages-root coordinate collection (`getTablelistFromRoot(iqpages-root)` → list of `(owner, repo)`)
3. For each (owner, repo), create the v2 per-repo table + migrate rows + verify
4. Public repos also get registered into `git_repos:all`
5. Record un-migrateable legacy deploys into the `LEGACY_IQPAGES` constant (hosted in the SDK repo or in each consumer app, wherever it's shared)
6. Provide `migrate`, `verify`, `dry-run` subcommands

### Phase 4 — frontend rewire

1. **on-chaingit-frontend**: add `@iqlabs/git` to `package.json`. Replace self-written code under `services/git/`, `services/iqpages/` with `import { GitClient } from "@iqlabs/git/browser"`. Re-wire deploy / gallery / repo page / commit list
2. **iqprofilenet**: same deal. Drop `src/lib/iqgit/`, `src/lib/iqpages/` → import from `@iqlabs/git/browser`. Collapse `useDeploymentDetails` into a 1-RPC path
3. Apply `LEGACY_IQPAGES` filter in both apps so the drop-down / gallery hides the ones that couldn't migrate
4. PR per repo → deploy

### Phase 5 — cleanup

1. Delete v1 code paths (commit-log scan in `readFileFromLatest`, fallback inside iqpages-service, etc.)
2. Tag `@iqlabs/git` as the official `0.1.0` release
3. Refresh README / IQPAGES-PLAN / this document, and add dependency notes to each consumer repo's README
4. E2E confirm that new deploys only touch v2 paths
5. Replicate the same pattern with `@iqlabs/iqpages`, `@iqlabs/chat`, etc. (roadmap)

---

## Rewrite scope / risks

- **~70–80% of lines end up as new code**. Existing sources are raw material for logic extraction. Getting the module boundaries right from the start is key to long-term maintenance
- The migration script being the second consumer of `@iqlabs/git/node` also **validates the SDK boundary**. If you keep peeling into core / chain internals while writing the script, the public interface is under-specified
- **Frontends stay untouched until Phase 1 is finished and published** — parallel development happens inside `iqlabs-git-sdk`. Let `iq-git-cli/src/` sit as-is and replace it wholesale in Phase 2
- Web-bundle size: `@iqlabs/git/browser` carries iqlabs-sdk + web3.js so it's at least several hundred KB. Ship ESM-only + `sideEffects: false` so tree-shaking works. CommonJS is only published under the `node/` subentry
- **Three independent repos (iqlabs-git-sdk + iq-git-cli + each consumer)** need coordinated releases. Document the order `sdk publish → cli bump → frontend deploy` in the release notes
