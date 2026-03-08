export interface Repository {
  name: string;
  description: string;
  owner: string;
  timestamp: number;
  isPublic: boolean;
}

export interface Commit {
  id: string;
  repoName: string;
  message: string;
  author: string;
  timestamp: number;
  treeTxId: string;
  parentCommitId?: string;
}

export interface FileTree {
  [filePath: string]: {
    txId: string;
    hash: string;
  };
}

export interface Ref {
  repoName: string;
  refName: string;
  commitId: string;
}

export interface Collaborator {
  repoName: string;
  userAddress: string;
  role: "admin" | "writer";
}

export interface Fork {
  originalRepoName: string;
  forkRepoName: string;
  owner: string;
}

export const GIT_CONSTANTS = {
  REPOS_TABLE: "git_repos_v2",
  COMMITS_TABLE: "git_commits",
  REFS_TABLE: "git_refs",
  COLLABORATORS_TABLE: "git_collabs",
  FORKS_TABLE: "git_forks",
};

/** Tables scoped per-owner (wallet address appended to table name for PDA derivation) */
export const OWNER_SCOPED_TABLES = new Set([
  GIT_CONSTANTS.REPOS_TABLE,
  GIT_CONSTANTS.COMMITS_TABLE,
  GIT_CONSTANTS.REFS_TABLE,
  GIT_CONSTANTS.COLLABORATORS_TABLE,
  GIT_CONSTANTS.FORKS_TABLE,
]);
