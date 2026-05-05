// `iqgit create <name> [--public|--private]` — registers the repo
// on-chain. First chain-touching command in a repo's life.
//
//   in:  <name>, --public (default) | --private, --description
//   sdk: GitClient.createRepo({ name, description, isPublic, timestamp })
//        ↑ also pre-creates the per-repo commit table (SDK does this
//          inside createRepo so the first commit() is cheaper)
//   out: writes .iqgit/config.json with { owner, repo, isPublic }

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import * as repo from "../core/repo";
import { setup } from "../setup";
import * as ui from "../ui";

export function register(program: Command): void {
  program
    .command("create <name>")
    .option("--public", "default visibility")
    .option("--private")
    .option("--description <text>", "", "")
    .action(async (
      name: string,
      opts: { public?: boolean; private?: boolean; description: string },
    ) => {
      const cwd = process.cwd();
      if (!existsSync(join(cwd, ".iqgit"))) repo.initRepo(cwd);

      const { client, signer } = await setup();
      const isPublic = !opts.private;

      const sp = ui.spinner(`Creating on-chain repo ${name}...`).start();
      try {
        await client.createRepo({
          name,
          description: opts.description,
          isPublic,
          timestamp: Date.now(),
        });
        sp.succeed(`Created ${signer.publicKey.toBase58()}/${name}`);
      } catch (e) {
        sp.fail((e as Error).message);
        process.exit(1);
      }

      repo.writeConfig(cwd, {
        owner: signer.publicKey.toBase58(),
        repo: name,
        isPublic,
      });

      ui.log.dim(`Next: edit files, then iqgit commit -m "..." && iqgit push`);
    });
}
