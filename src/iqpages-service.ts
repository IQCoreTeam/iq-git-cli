import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { getWalletCtx } from "./wallet_manager.js";
import { GitService } from "./git-service.js";
import {
  IQPAGES_CONSTANTS,
  IqpagesConfig,
  IqprofileConfig,
  FileTree,
} from "./types.js";

export function validateIqpagesConfig(obj: unknown): asserts obj is IqpagesConfig {
  if (!obj || typeof obj !== "object") throw new Error("invalid iqpages.json");
  const { name, version, description, entry } = obj as any;
  if (typeof name !== "string" || !name) throw new Error("iqpages.json: name required");
  if (typeof version !== "string" || !version) throw new Error("iqpages.json: version required");
  if (typeof description !== "string") throw new Error("iqpages.json: description required");
  if (typeof entry !== "string" || !entry) throw new Error("iqpages.json: entry required");
}

export function validateIqprofileConfig(obj: unknown): asserts obj is IqprofileConfig {
  if (!obj || typeof obj !== "object") throw new Error("invalid iqprofile.json");
  const { displayName, description } = obj as any;
  if (typeof displayName !== "string") throw new Error("iqprofile.json: displayName required");
  if (typeof description !== "string") throw new Error("iqprofile.json: description required");
}

function buildSeed(owner: string, repoName: string): string {
  return `${owner}:${repoName}`;
}

function parseSeedFromHex(hex: string): { owner: string; repoName: string } | null {
  try {
    const plain = Buffer.from(hex, "hex").toString("utf8");
    const idx = plain.indexOf(":");
    if (idx <= 0) return null;
    return { owner: plain.slice(0, idx), repoName: plain.slice(idx + 1) };
  } catch {
    return null;
  }
}

export class IqpagesService {
  readonly connection: Connection;
  readonly signer: Keypair;
  readonly programId: PublicKey;
  private readonly git: GitService;

  constructor() {
    const { connection, signer } = getWalletCtx();
    this.connection = connection;
    this.signer = signer as Keypair;
    this.programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
    this.git = new GitService();
  }

  private tablePda(owner: string, repoName: string): PublicKey {
    const rootSeed = iqlabs.utils.toSeedBytes(IQPAGES_CONSTANTS.ROOT_ID);
    const tableSeed = iqlabs.utils.toSeedBytes(buildSeed(owner, repoName));
    const dbRoot = iqlabs.contract.getDbRootPda(rootSeed, this.programId);
    return iqlabs.contract.getTablePda(dbRoot, tableSeed, this.programId);
  }

  async isDeployed(owner: string, repoName: string): Promise<boolean> {
    const info = await this.connection.getAccountInfo(this.tablePda(owner, repoName));
    return info !== null;
  }

  async listAll(): Promise<{ owner: string; repoName: string }[]> {
    const { tableSeeds } = await iqlabs.reader.getTablelistFromRoot(
      this.connection,
      IQPAGES_CONSTANTS.ROOT_ID,
    );
    return tableSeeds
      .map((hex: string) => parseSeedFromHex(hex))
      .filter((v: { owner: string; repoName: string } | null): v is { owner: string; repoName: string } => v !== null);
  }

  /** Read a single file from the latest commit of the given repo. Returns null if missing. */
  private async readFileFromLatest(owner: string, repoName: string, filePath: string): Promise<string | null> {
    let commits;
    try {
      commits = await this.git.getLog(repoName, owner);
    } catch {
      return null;
    }
    if (commits.length === 0) return null;

    const latest = commits[0];
    const treeRes = await iqlabs.reader.readCodeIn(latest.treeTxId);
    if (!treeRes.data) return null;

    const tree: FileTree = JSON.parse(treeRes.data);
    const entry = tree[filePath];
    if (!entry) return null;

    const fileRes = await iqlabs.reader.readCodeIn(entry.txId);
    if (!fileRes.data) return null;

    return Buffer.from(fileRes.data, "base64").toString("utf8");
  }

  async readConfig(owner: string, repoName: string): Promise<IqpagesConfig | null> {
    const content = await this.readFileFromLatest(owner, repoName, IQPAGES_CONSTANTS.CONFIG_FILENAME);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async readProfile(owner: string, repoName: string): Promise<IqprofileConfig | null> {
    const content = await this.readFileFromLatest(owner, repoName, IQPAGES_CONSTANTS.PROFILE_FILENAME);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async deploy(repoName: string): Promise<string> {
    const owner = this.signer.publicKey.toBase58();

    // Only public repos can be deployed as IQ Pages — the gateway serves
    // files by treeTxId with no access control, so private repos would be
    // exposed anyway. We enforce it at the IQ Pages layer to keep the
    // registry aligned with the declared visibility.
    const repos = await this.git.listRepos(owner);
    const repo = repos.find((r) => r.name === repoName);
    if (!repo) throw new Error(`repo not found: ${owner}/${repoName}`);
    if (!repo.isPublic) {
      throw new Error(
        `repo '${repoName}' is private. Only public repos can be deployed as IQ Pages.`,
      );
    }

    const config = await this.readConfig(owner, repoName);
    if (!config) {
      throw new Error(`${IQPAGES_CONSTANTS.CONFIG_FILENAME} missing in repo '${repoName}'. Commit it first.`);
    }
    validateIqpagesConfig(config);

    const profile = await this.readProfile(owner, repoName);
    if (profile) validateIqprofileConfig(profile);

    if (await this.isDeployed(owner, repoName)) {
      throw new Error(`already deployed: ${owner}/${repoName}`);
    }

    // Pre-check balance before any tx. Rough upper bound:
    // 0.2 SOL fee + ~0.05 SOL for createTable rent/compute + tx fee buffer.
    const balance = await this.connection.getBalance(this.signer.publicKey);
    const needed = IQPAGES_CONSTANTS.FEE_LAMPORTS + 50_000_000;
    if (balance < needed) {
      throw new Error(
        `insufficient balance: have ${balance / 1e9} SOL, need at least ${needed / 1e9} SOL`,
      );
    }

    // 1. Create marker table FIRST. If this fails (contract validation, etc.)
    // no fee has been spent yet.
    // Anchor contract rejects empty columns (EmptyColumns), so we supply one
    // dummy column. Writers are locked to SystemProgram, so rows can never be
    // written — the table's existence is the only signal.
    const seed = buildSeed(owner, repoName);
    const sig = await iqlabs.writer.createTable(
      this.connection,
      this.signer,
      IQPAGES_CONSTANTS.ROOT_ID,
      seed,
      "iqpages",
      ["marker"],
      "marker",
      [],
      undefined,
      [SystemProgram.programId],
      seed,
    );

    // 2. Fee transfer AFTER table creation succeeded.
    await sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.signer.publicKey,
          toPubkey: new PublicKey(IQPAGES_CONSTANTS.FEE_RECIPIENT),
          lamports: IQPAGES_CONSTANTS.FEE_LAMPORTS,
        }),
      ),
      [this.signer],
    );

    return sig;
  }
}
