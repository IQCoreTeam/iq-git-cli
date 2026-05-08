# iq-git CLI

Command-line client for on-chain Git on Solana. Stores repos, files, and
commit history entirely on chain via [@iqlabs-official/git-sdk](https://www.npmjs.com/package/@iqlabs-official/git-sdk).

```
# create your own
iqgit init
iqgit create my-app --public
iqgit add .
iqgit commit -m "first"
iqgit push

# read someone else's (no wallet needed)
iqgit clone <owner>/<repo>
iqgit log
```

## Install

```bash
npm install -g @iqlabs-official/iq-git-cli
```

Once installed, `iqgit` is available from any directory.

### Local development

```bash
git clone <this-repo>
cd iq-git-cli
npm install
npm run build
npm link            # registers `iqgit` against this build
```

## First-run setup

The first time you run a write command (`create`, `push`, `wallet balance`),
the CLI walks you through:

1. **Wallet**: generate a new Solana keypair, or point at an existing
   keypair JSON file. Stored in `~/.iq-git/wallets/default.json` by default.
2. **RPC URL**: required for any chain interaction. Free option is
   [Helius](https://www.helius.dev/). Paste the URL when prompted.
   Saved to `~/.iq-git/.env`.

Read-only commands (`clone`, `log`, `status`, `registry`) only need the
RPC. `clone` does not even prompt for a keypair, so anyone can pull a
public repo without setting up a wallet first.

### Changing the RPC URL later

```bash
iqgit config rpcUrl                           # show current value
iqgit config rpcUrl https://my-rpc.example    # set a new one
iqgit config --unset rpcUrl                   # reset (will re-prompt)
```

You can also override per-command via environment variable:

```bash
SOLANA_RPC_ENDPOINT=https://my-rpc.example iqgit log
```

## Gateway

`log`, `registry`, `clone`, `status` (when fetching base tree), and
`wallet repos` route reads through the IQ Gateway HTTP cache by default.
The default chain is the same 3-gateway list iq-chan uses (primary →
Akash direct → backup), with direct RPC as the final fallback. This
sidesteps RPC per-method rate limits on bulk table reads and matches
how blockchan's frontend resolves chain reads.

| `GATEWAY_URL` value | behavior |
|---|---|
| (unset, default)    | 3-gateway chain → RPC fallback (recommended)  |
| `https://my.example`| single override → RPC fallback                |
| `url1,url2,url3`    | comma-separated list, tried in order → RPC   |
| `off`               | disable all gateway, raw RPC only             |

Anyone can run their own gateway. See
[iq-gateway](https://github.com/IQCoreTeam/iq-gateway).

## Commands

| Command | Description |
|---|---|
| `iqgit init` | Create local `.iqgit/` directory. No chain interaction. |
| `iqgit create <name> [--public\|--private]` | Register repo on chain. |
| `iqgit add <pathspec...>` | Stage paths for the next commit. |
| `iqgit reset [pathspec...]` | Unstage paths (no args clears the index). |
| `iqgit commit -m "<msg>"` | Build a snapshot of staged paths under `.iqgit/pending/`. No chain interaction. |
| `iqgit push` | Upload all pending commits to chain. Resume-safe. |
| `iqgit clone <owner>/<repo> [dir]` | Pull a repo's latest snapshot to disk. |
| `iqgit restore [commitId]` | Restore working tree to a commit (default: latest). |
| `iqgit log [--limit N] [--owner ... --repo ...]` | Print commit history. |
| `iqgit status` | 4-tier diff: HEAD, pending commits, staged index, working tree. |
| `iqgit registry [--limit N]` | Browse the public on-chain repo gallery. |
| `iqgit config [key] [value]` | Get or set global config. |
| `iqgit wallet new\|show\|balance\|repos` | Manage keypair. |

## How it works

Each `push` writes three kinds of records on chain:

1. **Blobs**: file contents, one inscription per unique hash
2. **Tree**: JSON map of `{ path: { txId, hash } }`, one per commit
3. **Commit row**: `{ id, message, treeTxId, parentCommitId, timestamp, author }`

`commit` builds these locally; `push` uploads them. Splitting the two means
multiple `commit`s can be batched into a single `push`, amortizing Solana
transaction fees.

### Resume after failure

`push` is checkpointed:

- Each blob's `{ hash: txId }` is appended to `.iqgit/upload-cache.json`
  on success, with synchronous flush.
- The tree's txId and the commit row's signature are persisted into the
  pending commit's `meta.json` between steps.

If a push fails partway through (network drop, kill signal, RPC error),
the next `iqgit push` resumes exactly where the last one stopped. Already
uploaded blobs are reused from cache instead of being re-inscribed.

### Ignore rules

`scan` reads both `.gitignore` and `.iqgitignore` (if present) and merges
them. `.git/` and `.iqgit/` are always excluded. Use `.iqgitignore` for
files you want in git but not on chain (e.g. large binaries).

### Large file warning

Files larger than 1MB trigger a confirmation prompt during `commit` since
on-chain inscription cost scales with size. Skip with `--no-warn-large`.

### `.iqgit/` layout

Per-repo state lives in `.iqgit/` next to your code. Safe to peek at
when debugging:

```
.iqgit/
├── config.json          # { owner, repo, isPublic }
├── HEAD                 # last successfully-pushed commitId
├── index.json           # paths staged for the next commit (string[])
├── pending/
│   └── NNN-<commitId>/
│       ├── meta.json    # { id, message, parentCommitId, treeTxId, committedSig, ... }
│       ├── tree.json    # full snapshot of this commit's file set
│       └── blobs/<hash> # raw base64 content, one per unique hash
└── upload-cache.json    # { hash: { txId, uploadedAt } } resume cache
```

Global config lives in `~/.iq-git/`:

```
~/.iq-git/
├── config.json          # walletPath + rpcUrl
├── .env                 # SOLANA_RPC_ENDPOINT, optionally GATEWAY_URL
└── wallets/default.json # generated keypair (only if you opted in)
```

## Project layout

```
src/
├── cli.ts              # commander entry, registers each command
├── setup.ts            # wallet / RPC gate; constructs GitClient
├── ui.ts               # chalk + ora + inquirer wrappers
├── core/
│   ├── scan.ts         # fs walk + ignore + base64 + hash
│   ├── repo.ts         # all .iqgit/ disk I/O
│   ├── tree.ts         # base-tree resolution shared by commit / status
│   └── gateway.ts      # gateway-first reads with RPC fallback
└── commands/           # one file per CLI command
                        # (init, create, add, reset, commit, push, clone,
                        #  restore, log, status, registry, config, wallet)
```

## License

Apache-2.0. See [LICENSE](LICENSE).

