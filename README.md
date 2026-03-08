# @iqlabs-official/git

On-chain Git for Solana. Version control stored entirely on the blockchain via [IQLabs SDK](https://www.npmjs.com/package/@iqlabs-official/solana-sdk).

**This is the CLI/library.** For the browser-based viewer (like GitHub), see [gitfrontend](https://github.com/IQCoreTeam/gitfrontend) — deployed at [git.iqlabs.dev](https://git.iqlabs.dev).

## What is this?

Think of it as **git** (the CLI tool) vs **GitHub** (the web UI):

| | git | GitHub |
|---|---|---|
| **On-chain** | `@iqlabs-official/git` (this package) | [git.iqlabs.dev](https://git.iqlabs.dev) |
| **Role** | Create repos, commit files, manage branches | Browse repos, view commits, read files |
| **Runs on** | CLI / Node.js | Browser (Next.js) |

All data lives on Solana. No servers, no databases — the blockchain *is* the database.

## Features

- **Create repos** — on-chain, owned by your Solana wallet
- **Commit files** — incremental uploads, unchanged files reuse existing tx IDs
- **Clone / checkout** — download any commit to local disk
- **Branches** — create and list named refs
- **Collaborators** — add writers to your repos
- **Fork** — fork anyone's public repo into your own namespace
- **Owner-scoped isolation** — each wallet has its own table namespace (like `github.com/{user}/{repo}`)
- **Visibility** — public or private repos with permission checks

## Install

```bash
npm install @iqlabs-official/git
```

## Quick start

```bash
# Set up your wallet
export SOLANA_RPC_ENDPOINT="https://api.mainnet-beta.solana.com"
# Place your keypair at ./keypair.json or ~/.config/solana/id.json

# Use in your code
```

```typescript
import { GitService } from "@iqlabs-official/git";

const git = new GitService();

// Create a repo
await git.createRepo("my-project", "My on-chain project");

// Commit current directory
await git.commit("my-project", "initial commit");

// View commit history
const log = await git.getLog("my-project");

// Clone someone else's repo (by their wallet address)
await git.clone("their-repo", "./output", "TheirWalletAddress...");

// List your repos
const repos = await git.listRepos();

// List someone else's repos
const theirRepos = await git.listRepos("TheirWalletAddress...");
```

## Architecture

```
Solana Program (code_in IDL)
    ↓
IQLabs SDK (@iqlabs-official/solana-sdk)
    ↓
@iqlabs-official/git (this package)
    ↓
Your app / CLI / plugin
```

Each wallet gets its own isolated tables on-chain:
```
sha256("git_repos_v2_" + walletAddress)  →  PDA for that wallet's repos
sha256("git_commits_" + walletAddress)   →  PDA for that wallet's commits
```

This means two wallets can both have a repo named `my-project` without conflict — just like `alice/my-project` and `bob/my-project` on GitHub.

## URL format

On [git.iqlabs.dev](https://git.iqlabs.dev), repos are accessed as:

```
https://git.iqlabs.dev/{walletAddress}/{repoName}
```

## License

MIT
