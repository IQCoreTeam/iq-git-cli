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

// ----- IQ Pages -----

export interface IqpagesConfig {
  name: string;
  version: string;
  description: string;
  entry: string;
}

export interface IqprofileConfig {
  displayName: string;
  description: string;
  icon?: string;
  routes?: {
    profile?: string;
    myPage?: string;
  };
}

export const IQPAGES_CONSTANTS = {
  ROOT_ID: "iqpages-root",
  FEE_LAMPORTS: 200_000_000,
  FEE_RECIPIENT: "EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1",
  CONFIG_FILENAME: "iqpages.json",
  PROFILE_FILENAME: "iqprofile.json",
} as const;

export const IQPAGES_TEMPLATE = `{
  "name": "my-app",
  "version": "1.0.0",
  "description": "Short description",
  "entry": "index.html"
}
`;

export const IQPROFILE_TEMPLATE = `{
  "displayName": "My App",
  "description": "Short description",
  "icon": "./icon.png",
  "routes": {
    "profile": "/profile/{walletAddress}"
  }
}
`;
