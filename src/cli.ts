#!/usr/bin/env node
// iq-git CLI — thin wrapper over `@iqlabs-official/git-sdk` (Node entry). Usage:
//
//   iq-git init <name> [--public] [--description "..."]
//   iq-git commit <name> -m "<msg>"
//   iq-git status <name> [--owner <base58>]
//   iq-git log <name> [--owner <base58>] [--limit N]
//   iq-git checkout <name> <commitId|latest> [--out ./dir] [--owner <base58>]
//   iq-git clone <owner> <name> [--out ./dir]
//   iq-git bootstrap-registry        (one-time, admin only)
//
// Workdir for init/commit/status/checkout defaults to the current directory.
// For commit/status we walk the cwd and base64 every file (see scan.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { GitClient, bootstrapRegistry } from "@iqlabs-official/git-sdk/node";
import { scanDirectory } from "./scan.js";
import { loadWalletCtx } from "./wallet.js";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a === "-m" || a === "-o") {
      flags[a === "-m" ? "message" : "out"] = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.error(
    [
      "iq-git <command> [...]",
      "",
      "commands:",
      "  init <name> [--public] [--description <text>]",
      '  commit <name> -m "<message>"',
      "  status <name> [--owner <base58>]",
      "  log <name> [--owner <base58>] [--limit N]",
      "  checkout <name> <commitId|latest> [--out ./dir] [--owner <base58>]",
      "  clone <owner> <name> [--out ./dir]",
      "  bootstrap-registry",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const { positional, flags } = parseArgs(rest);

  const { connection, signer } = loadWalletCtx();
  const client = new GitClient({ connection, signer });
  const owner = signer.publicKey.toBase58();

  switch (cmd) {
    case "init": {
      const name = positional[0];
      if (!name) usage();
      await client.createRepo({
        name,
        description: (flags.description as string) ?? "",
        isPublic: Boolean(flags.public),
        timestamp: Date.now(),
      });
      console.log(`created ${owner}/${name}`);
      break;
    }

    case "commit": {
      const name = positional[0];
      const message = flags.message as string | undefined;
      if (!name || !message) usage();
      const scan = scanDirectory(process.cwd());
      const fileCount = Object.keys(scan).length;
      console.log(`scanning ${fileCount} files...`);
      const commit = await client.commit(name, message, scan);
      console.log(`commit ${commit.id}`);
      console.log(`tree   ${commit.treeTxId}`);
      break;
    }

    case "status": {
      const name = positional[0];
      if (!name) usage();
      const who = (flags.owner as string) ?? owner;
      const scan = scanDirectory(process.cwd());
      const s = await client.status(who, name, scan);
      console.log(`added     ${s.added.length}`);
      s.added.forEach((p) => console.log(`  + ${p}`));
      console.log(`modified  ${s.modified.length}`);
      s.modified.forEach((p) => console.log(`  M ${p}`));
      console.log(`unchanged ${s.unchanged.length}`);
      break;
    }

    case "log": {
      const name = positional[0];
      if (!name) usage();
      const who = (flags.owner as string) ?? owner;
      const limit = flags.limit ? Number(flags.limit) : undefined;
      const commits = await client.log(who, name, { limit });
      for (const c of commits) {
        console.log(`${c.id.slice(0, 8)}  ${new Date(c.timestamp).toISOString()}  ${c.message}`);
      }
      break;
    }

    case "checkout": {
      const name = positional[0];
      const commitId = positional[1];
      if (!name || !commitId) usage();
      const out = path.resolve((flags.out as string) ?? "./checkout_output");
      fs.mkdirSync(out, { recursive: true });
      const who = (flags.owner as string) ?? owner;
      const target =
        who !== owner
          ? await client.clone(name, who, writeSink(out))
          : await client.checkout(name, commitId as "latest" | string, writeSink(out));
      console.log(`checked out ${target.id} into ${out}`);
      if (who !== owner && commitId !== "latest") {
        console.warn(
          "note: different-owner checkout only supports 'latest' — ignored specific commit id",
        );
      }
      break;
    }

    case "clone": {
      const cloneOwner = positional[0];
      const name = positional[1];
      if (!cloneOwner || !name) usage();
      const out = path.resolve((flags.out as string) ?? `./${name}`);
      fs.mkdirSync(out, { recursive: true });
      const target = await client.clone(name, cloneOwner, writeSink(out));
      console.log(`cloned ${target.id} into ${out}`);
      break;
    }

    case "bootstrap-registry": {
      const sig = await bootstrapRegistry(connection, signer);
      console.log(sig ? `bootstrapped: ${sig}` : "already bootstrapped");
      break;
    }

    default:
      usage();
  }
}

function writeSink(root: string): (p: string, base64: string) => Promise<void> {
  return async (relative, base64) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(base64, "base64"));
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
