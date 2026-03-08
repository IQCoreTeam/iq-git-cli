import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  Connection,
  PublicKey,
  Signer,
  Transaction,
  TransactionInstruction,
  SendTransactionError,
  SystemProgram,
} from "@solana/web3.js";
import { getWalletCtx } from "./wallet_manager.js";
import iqlabs from "iqlabs-sdk/src";
import { Idl } from "@coral-xyz/anchor";
import { createRequire } from "module";
import { chunkString, DEFAULT_CHUNK_SIZE } from "./chunk.js";
import { sendAndConfirmTransaction } from "@solana/web3.js";

import { GIT_CONSTANTS, OWNER_SCOPED_TABLES, Repository, Commit, FileTree } from "./types.js";

const require = createRequire(import.meta.url);
const IDL = require("iqlabs-sdk/idl/code_in.json") as Idl;

const DEFAULT_ROOT_ID = "iq-git-v1";

const sha256 = (input: string): Buffer => {
  return createHash("sha256").update(input).digest();
};

const sendInstruction = async (
  connection: Connection,
  signer: Signer,
  instruction: TransactionInstruction
) => {
  const tx = new Transaction().add(instruction);
  try {
    return await sendAndConfirmTransaction(connection, tx, [signer]);
  } catch (err) {
    if (err instanceof SendTransactionError) {
      console.error("TxLogs:", await err.getLogs(connection));
    }
    throw err;
  }
};

export class GitService {
  readonly connection: Connection;
  readonly signer: Signer;
  readonly dbRootId: Uint8Array;
  readonly programId: PublicKey;
  readonly builder: ReturnType<typeof iqlabs.contract.createInstructionBuilder>;

  constructor(rootId = DEFAULT_ROOT_ID) {
    const { connection, signer } = getWalletCtx();
    this.connection = connection;
    this.signer = signer;
    this.dbRootId = sha256(rootId);
    this.programId = iqlabs.contract.getProgramId();
    this.builder = iqlabs.contract.createInstructionBuilder(
      IDL,
      this.programId
    );
  }

  /** Compute table seed — owner-scoped tables append the wallet address */
  private tableSeed(tableName: string, ownerAddress?: string): Buffer {
    if (OWNER_SCOPED_TABLES.has(tableName)) {
      const owner = ownerAddress || this.signer.publicKey.toBase58();
      return sha256(tableName + "_" + owner);
    }
    return sha256(tableName);
  }

  async ensureInfrastructure() {
    const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
    const rootInfo = await this.connection.getAccountInfo(dbRoot);
    if (!rootInfo) {
      console.log("Initializing Git DB Root...");
      const ix = iqlabs.contract.initializeDbRootInstruction(
        this.builder,
        {
          db_root: dbRoot,
          signer: this.signer.publicKey,
          system_program: SystemProgram.programId,
        },
        { db_root_id: this.dbRootId }
      );
      await sendInstruction(this.connection, this.signer, ix);
    }

    const myAddr = this.signer.publicKey.toBase58();

    await this.ensureTable(GIT_CONSTANTS.REPOS_TABLE, [
      "name",
      "description",
      "owner",
      "timestamp",
      "isPublic",
    ], myAddr);

    await this.ensureTable(GIT_CONSTANTS.COMMITS_TABLE, [
      "id",
      "repoName",
      "message",
      "author",
      "timestamp",
      "treeTxId",
      "parentCommitId",
    ], myAddr);

    await this.ensureTable(GIT_CONSTANTS.REFS_TABLE, [
      "repoName",
      "refName",
      "commitId",
    ], myAddr);

    await this.ensureTable(GIT_CONSTANTS.COLLABORATORS_TABLE, [
      "repoName",
      "userAddress",
      "role",
    ], myAddr);

    await this.ensureTable(GIT_CONSTANTS.FORKS_TABLE, [
      "originalRepoName",
      "forkRepoName",
      "owner",
    ], myAddr);
  }

  async createBranch(repoName: string, branchName: string, commitId: string) {
    await this.ensureInfrastructure();
    console.log(
      `Creating branch '${branchName}' at ${commitId.slice(0, 8)}...`
    );

    const tableSeed = this.tableSeed(GIT_CONSTANTS.REFS_TABLE);

    await iqlabs.writer.writeRow(
      this.connection,
      this.signer,
      this.dbRootId,
      tableSeed,
      JSON.stringify({ repoName, refName: branchName, commitId })
    );
    console.log(`Branch '${branchName}' created.`);
  }

  async listBranches(
    repoName: string,
    ownerAddress?: string
  ): Promise<{ refName: string; commitId: string }[]> {
    const tableSeed = this.tableSeed(GIT_CONSTANTS.REFS_TABLE, ownerAddress);
    const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
    const table = iqlabs.contract.getTablePda(
      dbRoot,
      tableSeed,
      this.programId
    );

    try {
      const rows = await iqlabs.reader.readTableRows(table);

      const allRefs = rows as unknown as {
        repoName: string;
        refName: string;
        commitId: string;
      }[];
      const refs = allRefs.filter((r) => r.repoName === repoName);

      const map = new Map<string, string>();
      refs.forEach((r) => map.set(r.refName, r.commitId));

      return Array.from(map.entries()).map(([refName, commitId]) => ({
        refName,
        commitId,
      }));
    } catch {
      return [];
    }
  }

  private async ensureTable(tableName: string, columns: string[], ownerAddress?: string) {
    const tableSeed = this.tableSeed(tableName, ownerAddress);
    const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
    const tablePda = iqlabs.contract.getTablePda(
      dbRoot,
      tableSeed,
      this.programId
    );

    const info = await this.connection.getAccountInfo(tablePda);
    if (!info) {
      console.log(`Creating table '${tableName}'...`);

      const idCol =
        columns.find((c) => c === "id" || c === "name") || columns[0];

      const ix = iqlabs.contract.createTableInstruction(
        this.builder,
        {
          db_root: dbRoot,
          table: tablePda,
          signer: this.signer.publicKey,
          system_program: SystemProgram.programId,
          receiver: this.signer.publicKey,
          instruction_table: iqlabs.contract.getInstructionTablePda(
            dbRoot,
            tableSeed,
            this.programId
          ),
        },
        {
          db_root_id: this.dbRootId,
          table_seed: tableSeed,
          table_name: Buffer.from(tableName),
          column_names: columns.map((c) => Buffer.from(c)),
          id_col: Buffer.from(idCol),
          ext_keys: [],
          gate_mint_opt: null,
          writers_opt: null,
        }
      );
      await sendInstruction(this.connection, this.signer, ix);
    }
  }

  async createRepo(
    name: string,
    description: string,
    isPublic: boolean = true
  ) {
    await this.ensureInfrastructure();

    const row: Repository = {
      name,
      description,
      owner: this.signer.publicKey.toBase58(),
      timestamp: Date.now(),
      isPublic,
    };

    const tableSeed = this.tableSeed(GIT_CONSTANTS.REPOS_TABLE);

    console.log(
      `Creating ${isPublic ? "public" : "private"} repo '${name}'...`
    );
    await iqlabs.writer.writeRow(
      this.connection,
      this.signer,
      this.dbRootId,
      tableSeed,
      JSON.stringify(row)
    );
    const wallet = this.signer.publicKey.toBase58();
    console.log("Repo created!");
    console.log(`View at: https://git.iqlabs.dev/${wallet}/${name}`);
  }

  async setVisibility(repoName: string, isPublic: boolean) {
    const repos = await this.listRepos();
    const repo = repos.find((r) => r.name === repoName);

    if (!repo) {
      throw new Error(`Repository '${repoName}' not found.`);
    }

    if (repo.owner !== this.signer.publicKey.toBase58()) {
      throw new Error("Only the repo owner can change visibility.");
    }

    const updatedRow: Repository = {
      ...repo,
      isPublic,
    };

    const tableSeed = this.tableSeed(GIT_CONSTANTS.REPOS_TABLE);

    console.log(
      `Setting '${repoName}' to ${isPublic ? "public" : "private"}...`
    );
    await iqlabs.writer.writeRow(
      this.connection,
      this.signer,
      this.dbRootId,
      tableSeed,
      JSON.stringify(updatedRow)
    );
    console.log(`Visibility updated to ${isPublic ? "public" : "private"}.`);
  }

  async listRepos(ownerAddress?: string): Promise<Repository[]> {
    const tableSeed = this.tableSeed(GIT_CONSTANTS.REPOS_TABLE, ownerAddress);
    const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
    const table = iqlabs.contract.getTablePda(
      dbRoot,
      tableSeed,
      this.programId
    );

    try {
      const rows = await iqlabs.reader.readTableRows(table);
      return rows as unknown as Repository[];
    } catch {
      return [];
    }
  }

  async commit(repoName: string, message: string) {
    await this.ensureInfrastructure();
    console.log(`Snapshotting current directory for repo '${repoName}'...`);

    let oldTree: FileTree = {};
    const logs = await this.getLog(repoName);
    if (logs.length > 0) {
      console.log("Fetching previous state for incremental commit...");
      try {
        const latest = logs[0];
        const treeRes = await iqlabs.reader.readCodeIn(latest.treeTxId);
        if (treeRes.data) {
          oldTree = JSON.parse(treeRes.data);
        }
      } catch (e) {
        console.warn("Could not load previous tree, performing full upload.");
      }
    }

    const fileTree: FileTree = {};

    const filesToUpload = this.scanDirectory(process.cwd());
    console.log(`Found ${filesToUpload.length} files to track.`);

    let uploadedCount = 0;
    let reusedCount = 0;

    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    for (const f of filesToUpload) {
      const relativePath = path.relative(process.cwd(), f);

      const stats = fs.statSync(f);
      if (stats.size > 10 * 1024 * 1024) continue;

      const content = fs.readFileSync(f).toString("base64");
      const currentHash = sha256(content).toString("hex");

      if (oldTree[relativePath] && oldTree[relativePath].hash === currentHash) {
        fileTree[relativePath] = oldTree[relativePath];
        reusedCount++;
        process.stdout.write(`\rUnchanged: ${relativePath}          `);
        continue;
      }

      process.stdout.write(`\nUploading ${relativePath}... `);
      const chunks = chunkString(content, DEFAULT_CHUNK_SIZE);
      if (chunks.length === 0) chunks.push("");

      let success = false;
      let retries = 3;

      while (retries > 0 && !success) {
        try {
          const txId = await iqlabs.writer.codeIn(
            { connection: this.connection, signer: this.signer },
            chunks,
            undefined,
            path.basename(f),
            0,
            "application/octet-stream",
            (p) => {}
          );

          fileTree[relativePath] = {
            txId,
            hash: currentHash,
          };
          console.log("Done.");
          success = true;
        } catch (e: any) {
          console.log(`Retry (${retries}): ${e.message}`);
          retries--;
          if (retries === 0) console.error("Skipping file.");
          await delay(2000);
        }
      }

      await delay(500);
      uploadedCount++;
    }

    console.log(
      `\n\nIncrementally committed: ${uploadedCount} new/modified, ${reusedCount} unchanged.`
    );

    if (uploadedCount === 0 && reusedCount > 0 && logs.length > 0) {
      console.log("No file changes detected.");
    }

    console.log("Uploading File Tree Manifest...");
    const treeJson = JSON.stringify(fileTree);
    const treeChunks = chunkString(treeJson, DEFAULT_CHUNK_SIZE);
    const treeTxId = await iqlabs.writer.codeIn(
      { connection: this.connection, signer: this.signer },
      treeChunks,
      undefined,
      "tree.json",
      0,
      "application/json"
    );

    console.log("Recording commit...");

    const canWrite = await this.canWriteToRepo(repoName);
    if (!canWrite) {
      throw new Error(
        `Permission Denied: You are not the owner or a collaborator of '${repoName}'.`
      );
    }

    const commit: Commit = {
      id: randomUUID(),
      repoName,
      message,
      author: this.signer.publicKey.toBase58(),
      timestamp: Date.now(),
      treeTxId,
    };

    const tableSeed = this.tableSeed(GIT_CONSTANTS.COMMITS_TABLE);

    await iqlabs.writer.writeRow(
      this.connection,
      this.signer,
      this.dbRootId,
      tableSeed,
      JSON.stringify(commit)
    );
    const wallet = this.signer.publicKey.toBase58();
    console.log(`Commit successful! ID: ${commit.id}`);
    console.log(`View at: https://git.iqlabs.dev/${wallet}/${repoName}`);
  }

  async canReadRepo(repoName: string, ownerAddress?: string): Promise<boolean> {
    const repos = await this.listRepos(ownerAddress);
    const repo = repos.find((r) => r.name === repoName);
    if (!repo) return false;

    if (repo.isPublic === undefined || repo.isPublic === true) return true;

    const myAddr = this.signer.publicKey.toBase58();
    if (repo.owner === myAddr) return true;

    const collabs = await this.getCollaborators(repoName, ownerAddress);
    return collabs.some((c) => c.userAddress === myAddr);
  }

  async canWriteToRepo(repoName: string, ownerAddress?: string): Promise<boolean> {
    const repos = await this.listRepos(ownerAddress);
    const repo = repos.find((r) => r.name === repoName);

    if (!repo) return false;

    const myAddr = this.signer.publicKey.toBase58();
    if (repo.owner === myAddr) return true;

    const collabs = await this.getCollaborators(repoName, ownerAddress);
    return collabs.some((c) => c.userAddress === myAddr);
  }

  async addCollaborator(repoName: string, userAddress: string) {
    const repos = await this.listRepos();
    const repo = repos.find((r) => r.name === repoName);
    if (repo?.owner !== this.signer.publicKey.toBase58()) {
      throw new Error("Only the repo owner can add collaborators.");
    }

    await this.ensureInfrastructure();

    console.log(`Adding ${userAddress} as collaborator to '${repoName}'...`);
    const tableSeed = this.tableSeed(GIT_CONSTANTS.COLLABORATORS_TABLE);

    await iqlabs.writer.writeRow(
      this.connection,
      this.signer,
      this.dbRootId,
      tableSeed,
      JSON.stringify({ repoName, userAddress, role: "writer" })
    );
    console.log("Collaborator added.");
  }

  async getCollaborators(repoName: string, ownerAddress?: string): Promise<any[]> {
    const tableSeed = this.tableSeed(GIT_CONSTANTS.COLLABORATORS_TABLE, ownerAddress);
    const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
    const table = iqlabs.contract.getTablePda(
      dbRoot,
      tableSeed,
      this.programId
    );

    try {
      const rows = await iqlabs.reader.readTableRows(table);
      const all = rows as unknown as any[];
      return all.filter((c) => c.repoName === repoName);
    } catch {
      return [];
    }
  }

  async forkRepo(originalRepoName: string, newRepoName: string, originalOwner: string) {
    console.log(`Forking '${originalRepoName}' to '${newRepoName}'...`);

    await this.createRepo(newRepoName, `Fork of ${originalRepoName}`);

    const logs = await this.getLog(originalRepoName, originalOwner);
    if (logs.length > 0) {
      const latest = logs[0];

      const commit: Commit = {
        id: randomUUID(),
        repoName: newRepoName,
        message: `Fork from ${originalRepoName} at ${latest.id.slice(0, 8)}`,
        author: this.signer.publicKey.toBase58(),
        timestamp: Date.now(),
        treeTxId: latest.treeTxId,
      };

      const tableSeed = this.tableSeed(GIT_CONSTANTS.COMMITS_TABLE);
      await iqlabs.writer.writeRow(
        this.connection,
        this.signer,
        this.dbRootId,
        tableSeed,
        JSON.stringify(commit)
      );
    }

    // Record fork relationship
    const forkSeed = this.tableSeed(GIT_CONSTANTS.FORKS_TABLE);
    await iqlabs.writer.writeRow(
      this.connection,
      this.signer,
      this.dbRootId,
      forkSeed,
      JSON.stringify({
        originalRepoName,
        forkRepoName: newRepoName,
        owner: this.signer.publicKey.toBase58(),
      })
    );

    const wallet = this.signer.publicKey.toBase58();
    console.log("Fork complete!");
    console.log(`View at: https://git.iqlabs.dev/${wallet}/${newRepoName}`);
  }

  private scanDirectory(
    dir: string,
    fileList: string[] = [],
    rootDir: string = dir,
    ig?: any
  ): string[] {
    if (!ig) {
      const ignore = createRequire(import.meta.url)("ignore");
      ig = ignore();
      const gitignorePath = path.join(rootDir, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, "utf-8");
        ig.add(content);
      }

      ig.add([
        ".git",
        "node_modules",
        "dist",
        ".DS_Store",
        "downloads",
        "package-lock.json",
      ]);
    }

    const files = fs.readdirSync(dir);
    for (const file of files) {
      const p = path.join(dir, file);
      const relativePath = path.relative(rootDir, p);

      if (ig.ignores(relativePath)) continue;

      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        this.scanDirectory(p, fileList, rootDir, ig);
      } else {
        fileList.push(p);
      }
    }
    return fileList;
  }

  async getLog(repoName: string, ownerAddress?: string): Promise<Commit[]> {
    const canRead = await this.canReadRepo(repoName, ownerAddress);
    if (!canRead) {
      throw new Error(
        `Permission Denied: You don't have access to read '${repoName}'.`
      );
    }

    const tableSeed = this.tableSeed(GIT_CONSTANTS.COMMITS_TABLE, ownerAddress);
    const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
    const table = iqlabs.contract.getTablePda(
      dbRoot,
      tableSeed,
      this.programId
    );

    const rows = await iqlabs.reader.readTableRows(table);
    return (rows as unknown as Commit[])
      .filter((c) => c.repoName === repoName)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async checkout(commitId: string, outputDir: string = "./checkout_output", ownerAddress?: string) {
    console.log(`Checking out commit ${commitId}...`);

    const tableSeed = this.tableSeed(GIT_CONSTANTS.COMMITS_TABLE, ownerAddress);
    const dbRoot = iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
    const table = iqlabs.contract.getTablePda(
      dbRoot,
      tableSeed,
      this.programId
    );

    const rows = await iqlabs.reader.readTableRows(table);
    const commits = rows as unknown as Commit[];
    const commit = commits.find((c) => c.id === commitId);

    if (!commit) throw new Error(`Commit ${commitId} not found.`);

    console.log(`Found commit: ${commit.message} (Author: ${commit.author})`);

    console.log(`Fetching file tree from Tx: ${commit.treeTxId}...`);
    const treeResult = await iqlabs.reader.readCodeIn(commit.treeTxId);

    if (!treeResult.data) throw new Error("Failed to load file tree manifest");

    const fileTree: FileTree = JSON.parse(treeResult.data);
    const files = Object.keys(fileTree);

    console.log(`Restoring ${files.length} files to ${outputDir}...`);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    let restored = 0;
    for (const filePath of files) {
      const entry = fileTree[filePath];
      const fullDestPath = path.join(outputDir, filePath);

      process.stdout.write(`Restoring ${filePath}... `);

      try {
        const parentDir = path.dirname(fullDestPath);
        if (!fs.existsSync(parentDir))
          fs.mkdirSync(parentDir, { recursive: true });

        const fileResult = await iqlabs.reader.readCodeIn(entry.txId);

        if (fileResult.data) {
          const buffer = Buffer.from(fileResult.data, "base64");
          fs.writeFileSync(fullDestPath, buffer);
          console.log("Done.");
        } else {
          console.log("Empty or Failed.");
        }
      } catch (e) {
        console.log("Error:", e);
      }
      restored++;
    }
    console.log("Checkout complete!");
  }
  async clone(repoName: string, outputDir: string, ownerAddress?: string) {
    await this.ensureInfrastructure();

    const canRead = await this.canReadRepo(repoName, ownerAddress);
    if (!canRead) {
      throw new Error(
        `Permission Denied: You don't have access to clone '${repoName}'.`
      );
    }

    console.log(`Cloning '${repoName}' to '${outputDir}'...`);

    const commits = await this.getLog(repoName, ownerAddress);
    if (commits.length === 0) {
      throw new Error(`Repository '${repoName}' has no commits to clone.`);
    }

    const latest = commits[0];
    await this.checkout(latest.id, outputDir, ownerAddress);
  }

  async status(
    repoName: string
  ): Promise<{
    added: string[];
    modified: string[];
    deleted: string[];
    unchanged: string[];
  }> {
    const canRead = await this.canReadRepo(repoName);
    if (!canRead) {
      throw new Error(
        `Permission Denied: You don't have access to check status of '${repoName}'.`
      );
    }

    // status always checks own repos
    const commits = await this.getLog(repoName);
    if (commits.length === 0) {
      throw new Error("No commits found to compare against.");
    }

    const latest = commits[0];
    console.log(
      `Comparing against latest commit: [${latest.id.slice(0, 8)}] ${
        latest.message
      }`
    );

    const treeResult = await iqlabs.reader.readCodeIn(latest.treeTxId);
    if (!treeResult.data) throw new Error("Failed to load remote file tree.");
    const remoteTree: FileTree = JSON.parse(treeResult.data);

    const localFiles = this.scanDirectory(process.cwd());
    const localMap = new Map<string, string>();

    for (const f of localFiles) {
      const relativePath = path.relative(process.cwd(), f);
      const content = fs.readFileSync(f).toString("base64");
      const hash = sha256(content).toString("hex");
      localMap.set(relativePath, hash);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const unchanged: string[] = [];

    for (const [path, hash] of localMap.entries()) {
      if (!remoteTree[path]) {
        added.push(path);
      } else if (remoteTree[path].hash !== hash) {
        modified.push(path);
      } else {
        unchanged.push(path);
      }
    }

    for (const path of Object.keys(remoteTree)) {
      if (!localMap.has(path)) {
        deleted.push(path);
      }
    }

    return { added, modified, deleted, unchanged };
  }

  async run(repoName: string, ownerAddress?: string) {
    await this.ensureInfrastructure();

    const canRead = await this.canReadRepo(repoName, ownerAddress);
    if (!canRead) {
      throw new Error(
        `Permission Denied: You don't have access to run '${repoName}'.`
      );
    }

    console.log(`\n--- Running '${repoName}' from Chain ---`);

    const commits = await this.getLog(repoName, ownerAddress);
    if (commits.length === 0) {
      throw new Error(`Repository '${repoName}' not found or empty.`);
    }
    const latest = commits[0];
    console.log(`Downloading ${latest.id.slice(0, 8)} (${latest.message})...`);

    const tmpDir = path.join(
      os.tmpdir(),
      `iq-git-run-${repoName}-${Date.now()}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });

    await this.checkout(latest.id, tmpDir, ownerAddress);

    console.log("Preparing execution environment...");

    const packageJsonPath = path.join(tmpDir, "package.json");
    let startCommand = "";

    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
        if (pkg.scripts && pkg.scripts.start) {
          console.log(`Found start script: ${pkg.scripts.start}`);
          startCommand = "npm install && npm start";
        } else if (pkg.main) {
          startCommand = `npm install && node ${pkg.main}`;
        }
      } catch (e) {
        console.warn("Invalid package.json, falling back to heuristics.");
      }
    }

    if (!startCommand) {
      if (fs.existsSync(path.join(tmpDir, "index.ts"))) {
        startCommand = "npm install && npx tsx index.ts";
      } else if (fs.existsSync(path.join(tmpDir, "index.js"))) {
        startCommand = "npm install && node index.js";
      } else {
        throw new Error(
          "Could not detect entry point (package.json start script, index.ts, or index.js)."
        );
      }
    }

    console.log(`\n> Executing: ${startCommand}`);
    console.log("------------------------------------------");

    const { spawn } = require("child_process");

    return new Promise<void>((resolve, reject) => {
      const child = spawn(startCommand, {
        cwd: tmpDir,
        shell: true,
        stdio: "inherit",
      });

      child.on("error", (err: any) => {
        console.error("Execution error:", err);
        reject(err);
      });

      child.on("close", (code: number) => {
        console.log("------------------------------------------");
        console.log(`App exited with code ${code}`);

        resolve();
      });
    });
  }
}
