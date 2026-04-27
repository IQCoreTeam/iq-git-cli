# IQ Git v2 — Per-Repo Commit Tables + Open Registry

**현 구조의 read 비용을 근본적으로 낮추기 위한 스키마 전환.**

두 축으로 이루어진다:

1. **레포 당 commit 테이블 분리** — 오너 당 하나였던 `git_commits_<owner>` 를 레포마다 독립 테이블로 쪼갠다. 쓰기 권한은 오너 지갑 화이트리스트로 고정. 리더는 그 테이블의 **가장 최근 성공 tx = 최신 commit** 이라고 믿고 바로 읽는다.
2. **공용 레지스트리 테이블** — `git_repos:all` 이라는 **오픈 writers 테이블** 을 Bootstrap 시 한 번 `createTable` 로 초기화해 두고, 공개 레포를 만들 때 개인 목록 writeRow 와 함께 (별도 tx 로) 이 레지스트리에도 row 를 추가한다. 갤러리 리더는 `readTableRows(git_repos:all, { limit, before })` 로 파싱된 row 를 바로 페이지네이션한다.

---

## 현 구조 (v1)

```
iq-git-v1 (DbRoot)
│
├─ Table "git_repos_v2_<owner>"
│   └─ row per repo: { name, description, isPublic, timestamp }
│
└─ Table "git_commits_<owner>"        ← 오너의 ALL commits (모든 repo 섞임)
    └─ row per commit: { id, repoName, message, treeTxId, parentCommitId, timestamp, author }
```

### v1 의 문제

리더가 특정 repo 의 **최신 treeTxId 하나** 를 얻으려면:

1. `readTableRows(git_commits_<owner>)` → **오너의 모든 repo 의 모든 commit row 를 전부 다운로드**
2. JS 에서 `row.repoName === "<repo>"` 필터
3. `timestamp` 로 정렬 → `[0].treeTxId`

즉 **"최신 1개" 가 필요한데 전체 스캔 후 버리는 구조**. 결과:

- SDK `readTableRows` 내부에서 signature 마다 `readCodeIn` → 각 tx 의 chunk linked-list traversal 까지 타고 들어감
- 오너가 여러 repo 에 활발히 commit 했으면 수백 RPC 버스트
- `{ limit: N }` 옵션은 "최근 N 개 시그니처" 만 잘라내는데, 그 안에 내가 원하는 repo 의 최신 commit 이 있으리란 보장 없음 — 옆 repo 커밋만 10개 들어오면 내 repo 는 못 찾음
- 광고성 tx 를 아무나 테이블에 쏠 수 있어 리더가 "진짜 commit" 인지 별도로 검증해야 함

이 비용은 **iqprofilenet 의 Unofficial Apps 드롭다운** 에서 가장 크게 터진다:

```
for each deployment in iqpages-root:
  getLog(owner, repo)  ← v1 에선 위 전체 스캔
  getLog(owner, repo)  ← readConfig 에서 또 호출
  getLog(owner, repo)  ← latestTree 쿼리에서 또 호출
```

결과: 드롭다운 열 때 수천 RPC 요청 → Helius rate limit 초과.

그리고 **공용 레포 갤러리가 없다**. 다른 사람의 레포를 보려면 오너 지갑 주소를 알고 있어야 하고, 그 오너의 `git_repos_v2_<owner>` 를 직접 조회해야 한다. "지금 체인에 올라온 공개 레포 목록" 을 체인만 보고 만드는 API 가 없다.

---

## 제안 구조 (v2)

```
iq-git-v1 (DbRoot)                                    ← DbRoot 는 그대로 유지
│
├─ Table  hint = "git_repos_v2_<owner>"               ← 기존 그대로 (내 레포 목록)
│   │   • writers = [owner.publicKey]
│   └─ row per repo: { name, description, isPublic, timestamp }
│
├─ Table  hint = "git_repos:all"                      ★ NEW 오픈 레지스트리 (갤러리 원천)
│   │   • writers = [] (누구나 writeRow 가능)
│   │   • schema: [owner, repo, description, timestamp]
│   │   • Bootstrap 시 1회 createTable 로 초기화
│   └─ row per 공개 repo — `isPublic = true` 일 때만 기록
│
├─ Table  hint = "git_commits:<owner>:<repo>"         ★ NEW repo 당 commit 테이블
│   │   • writers = [owner.publicKey]                   (오너만 write — 광고/스팸 차단)
│   │   • schema: [id, message, treeTxId, parentCommitId, timestamp, author]
│   └─ row per commit — 가장 최근 성공 tx = 최신 commit
│
└─ Table  hint = "git_commits:<owner>:<otherRepo>"
```

### 용어: `table_hint` 와 네비게이션

iqlabs contract 의 `create_table` (see `programs/iqlabs/src/iqdb/instructions.rs:27`) 은 두 식별자를 구분한다:

- **`table_seed`**: PDA 파생에만 쓰는 해시된 바이트. 밖에서는 안 보인다.
- **`table_hint`**: "사람이 읽을 수 있는" 문자열. `db_root.table_seeds` / `global_table_seeds` 에 그대로 저장된다.

힌트는 해싱되기 전의 문자열이라 **repo 이름의 특수문자·공백 제약 없음** (실제 PDA seed 는 SDK 가 keccak 해싱한다). 이름 규칙을 일관되게 쓰면 `getTablePda(dbRoot, toSeedBytes(hint))` 로 **오너 주소·레포 이름만 알면 바로 PDA 를 재파생** 할 수 있다. 이게 "특정 대상을 직접 찾아가는 경로" 의 기본 메커니즘이다.

#### 쿼리 별 경로

| 질문 | 경로 | 비용 |
|---|---|---|
| 특정 오너의 레포 목록 (오너 주소를 아는 경우) | hint `git_repos_v2_<owner>` 로 PDA 파생 → `readTableRows` | 1 RPC |
| 특정 repo 의 최신 commit | hint `git_commits:<owner>:<repo>` 로 PDA 파생 → `readTableRows({ limit: 1 })` | 1 RPC |
| 특정 repo 의 전체 커밋 히스토리 | 같은 PDA → `readTableRows` | 1 RPC 수준 (테이블이 repo 별로 격리되어 있어 필터 불필요) |
| **공개 레포 전체 목록 (갤러리 / 탐색)** | **`git_repos:all` 레지스트리 → `readTableRows({ limit, before })`** | 페이지 당 1 RPC |

#### DbRoot hint 스캔은 "앱 경로" 가 아니다

> DbRoot 의 `table_seeds` 배열을 읽어서 등록된 모든 테이블 힌트를 나열하는 방법도 존재한다 (`iqlabs.reader.getTablelistFromRoot`). 하지만 이 배열은 **엔트리 수에 비례해 account 크기가 선형으로 성장**한다. 오너가 1만 명 넘어가면 DbRoot 가 수백 KB~MB 단위가 되고, 리더가 매번 전체를 받아 `startsWith("git_repos_v2_")` 로 필터하는 비용이 무시할 수 없게 된다. 같은 DbRoot 에 솔챗·iqpages·git 테이블까지 섞이면 더 심해진다.
>
> 따라서 `getTablelistFromRoot` 은 **디버깅 / 관리자 뷰 / 일회성 마이그레이션 스크립트** 용도로만 쓴다. 앱의 리더 경로 (갤러리, 탐색, 목록 렌더) 는 절대 여기에 의존하면 안 된다. 갤러리 / 탐색은 전용 레지스트리 테이블이 담당한다.

### writers 화이트리스트

`createTable` 호출 시 `writers_opt` 로 어떤 지갑이 writeRow 할 수 있는지 제한한다. contract 로직(`instructions.rs:52`) 은 리스트가 비면 누구나, 값이 있으면 그 안의 지갑만 허용한다.

- **`git_commits:<owner>:<repo>`** → `writers = [owner.publicKey]`. 오너만 commit. 남이 광고 tx 를 쏴도 validateRowJson 에서 reject → 리더는 "이 테이블의 tx = 진짜 commit" 으로 간주할 수 있다.
- **`git_repos_v2_<owner>`** → 지금처럼 `writers = [owner.publicKey]` 유지.
- **`git_repos:all`** → `writers = []` (오픈). 누구나 자기 공개 레포를 등록할 수 있어야 하므로 열어 둔다. 대신 row 는 `{ owner, repo, description, timestamp }` 를 담고, 리더는 렌더 시 `row.owner` 가 해당 tx 의 signer 와 일치하는지 확인하는 최소 가드를 건다. 스팸이 실제 문제가 되면 게이트웨이 화이트리스트·rate limit 또는 향후 contract 제약으로 강화.
- 향후 collaborator 를 허용하려면 `manage_table_creators` instruction 으로 writers 를 확장. 진짜 git 의 collaborator 권한에 대응.

### 최신 commit 조회

```ts
const pda = getTablePda(dbRoot, toSeedBytes(`git_commits:${owner}:${repo}`));
const rows = await iqlabs.reader.readTableRows(pda, { limit: 1 });
const latest = rows[0];          // { id, treeTxId, message, ... }
```

**1 RPC 범위**. writers 제약 덕분에 "성공한 최근 1개" = "진짜 최신 commit".

게이트웨이의 `/table/<pda>/rows` 를 우선 호출해 파싱된 row 를 한 번에 받고, 빈 응답이면 SDK 로 fallback. 게이트웨이가 부정한 tx 를 긁어왔더라도 writers 제약 덕분에 테이블 자체에 들어있는 것만 진짜이므로, **리더는 "최근 것부터 훑어 내가 원하는 instruction 이 포함된 유효한 성공 tx 를 찾을 때까지"** 로 처리한다.

### 전체 히스토리 조회

```ts
const rows = await iqlabs.reader.readTableRows(pda);   // 이 repo 만. 필터 불필요
rows.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
```

JS 필터 제거, pagination 도 정직해진다.

---

## 공용 레지스트리: `git_repos:all`

공개 레포를 체인 전체 범위에서 보여주는 갤러리의 원천.

### 설계

- 단일 오픈 테이블. `writers = []` 라 누구나 writeRow 가능
- Bootstrap 시 **한 번만** `createTable` 로 초기화 (rent 비용 1 회). 별도 bootstrap 스크립트가 수행하며 본 리포에 관리자가 들고 있음
- row schema: `{ owner, repo, description, timestamp }`
- 페이지네이션은 signature 기준 `{ limit, before }` (SDK `readTableRows` 옵션)
- 레포가 공개로 전환되거나 새로 만들어질 때마다 오너가 writeRow
- 비공개 레포는 **기록하지 않음**

### 왜 "테이블 초기화" 를 선택했는가

처음 후보였던 "marker PDA touch (초기화 안 된 PDA 를 `remainingAccounts` 로 첨부해서 tx 히스토리에만 기록)" 는:

- **장점**: rent 없음, tx 1 개
- **단점**:
  - 누군가 트롤링으로 아무 tx 나 같은 PDA 에 touch 하면 리더가 매번 디코드 후 필터해야 함
  - row 가 파싱된 형태로 반환되지 않음 — `getSignaturesForAddress` + `getTransaction` + `readCodeIn` 조합으로 매번 복원
  - 테이블 접근 API (`/table/<pda>/rows` 게이트웨이) 를 못 씀

테이블로 두면:
- **row 는 파싱된 상태로 반환** → 게이트웨이의 `/table/<pda>/rows` 한 방
- 초기 rent 한 번만 부담
- 필요 시 나중에 writers 추가 제약 쉽게 얹음

트롤링 가능성을 생각하면 **"초기화된 오픈 테이블" 이 조금 더 방어적**. tx 수가 2 개로 늘지만 비용 차이는 미미.

### 공개 레포 등록 시 (writer path)

```ts
// tx 1: 개인 목록에 row 추가
await iqlabs.writer.writeRow(
  connection, signer,
  IQGIT_ROOT_ID,
  `git_repos_v2_${owner}`,
  JSON.stringify({ name, description, isPublic: true, timestamp }),
);

// tx 2: 공개 레포면 레지스트리에도 row 추가
if (isPublic) {
  await iqlabs.writer.writeRow(
    connection, signer,
    IQGIT_ROOT_ID,
    "git_repos:all",
    JSON.stringify({ owner, repo: name, description, timestamp }),
  );
}
```

비공개 레포는 두 번째 tx 생략. 갤러리에 노출되지 않는다.

### 갤러리 조회 (reader path)

```ts
// 최근 100개
const recent = await iqlabs.reader.readTableRows(
  getTablePda(dbRoot, toSeedBytes("git_repos:all"), programId),
  { limit: 100 },
);

// 다음 페이지
const next = await iqlabs.reader.readTableRows(pda, {
  limit: 100,
  before: recent[recent.length - 1].signature,
});
```

row 는 이미 `{ owner, repo, description, timestamp }` 로 파싱돼 나온다. 렌더 시 `row.owner === tx.signer` 같은 최소 가드로 스팸/위조 row 를 거른다.

---

## "등록" 개념 (레포 생성 시)

레포를 새로 만들면 다음이 일어난다:

1. **`git_repos_v2_<owner>`** 에 row 추가 — 오너 개인 목록 (항상)
2. **`isPublic === true`** 면 `git_repos:all` 에도 row 추가 (별도 tx)
3. **`git_commits:<owner>:<repo>`** 테이블을 여기서 `createTable` 해두는 편이 첫 commit 때 비용을 분산하기 좋다 (선택)

`isPublic = false` 로 만든 레포는 (2) 를 건너뛴다. 갤러리에서 보이지 않게 하고, 클로닝/읽기도 오너 개인 목록을 직접 보는 사람만 접근.

> **프라이빗 레포 암호화 (TODO)**
> 지금은 `isPublic = false` 가 "공용 디렉토리 미노출" 만 보장하고 commit 내용 자체는 여전히 체인에 평문으로 올라간다.
> 향후 `git_commits:<owner>:<repo>` 의 row 에 `iq-locker` 방식의 DH 기반 다자 암호화를 적용해 collaborator 화이트리스트에게만 복호화 가능하게 만들 수 있다.
> 이 경우 `writers` 확장(`manage_table_creators`) + 각 writer 의 encryption pubkey 조회(`UserInventory.metadata`) 가 결합된다. MVP 범위 밖, 별도 이슈로.

### 트랜잭션 구조 (요약)

```ts
// 레포 생성 시 (createRepo)

// 1. commits 테이블 선(先)생성 (writers = [owner]). 레포 생성 시 한 번만.
if (!(await isTableExists(commitsPda))) {
  await iqlabs.writer.createTable(
    connection, signer,
    IQGIT_ROOT_ID,
    `git_commits:${owner}:${repo}`,        // seed 힌트 — SDK 가 해싱
    "git_commits",                         // table_name (human readable)
    ["id", "message", "treeTxId", "parentCommitId", "timestamp", "author"],
    "id",
    [],
    undefined,                             // gate 없음
    [signer.publicKey],                    // writers
    `git_commits:${owner}:${repo}`,        // tableHint (DbRoot 에 저장됨)
  );
}

// 2. 개인 목록에 writeRow
await iqlabs.writer.writeRow(
  connection, signer,
  IQGIT_ROOT_ID,
  `git_repos_v2_${owner}`,
  JSON.stringify({ name, description, isPublic, timestamp }),
);

// 3. public 이면 레지스트리에도 writeRow
if (isPublic) {
  await iqlabs.writer.writeRow(
    connection, signer,
    IQGIT_ROOT_ID,
    "git_repos:all",
    JSON.stringify({ owner, repo: name, description, timestamp }),
  );
}
```

비용:
- **Bootstrap**: `git_repos:all` createTable 1 회 (전체 네트워크에 1 번만, 관리자가)
- **레포 생성 시**: `createTable × 1` (commits, 레포당 1 번) + `writeRow × 1~2` (공개면 2)

---

## iq-git-cli 변경 (쓰기 경로)

### commit 시

```ts
// 1. per-repo commits 테이블 없으면 먼저 생성
if (!(await this.isTableExists(owner, repo, "commits"))) {
  await iqlabs.writer.createTable(..., writers=[signer.publicKey]);
}

// 2. commit row 저장
await iqlabs.writer.writeRow(..., JSON.stringify(commit));
```

첫 commit 에서만 `createTable` 비용 (rent ~0.002 SOL). 이후는 writeRow 만.

### fetch / log / clone

`readTableRows(git_commits:<owner>:<repo>)` 로 변경. JS 필터 제거.

### createRepo

위의 "등록" 규약을 그대로 따름. `isPublic` 플래그는 기본 `true`. 프라이빗으로 만들고 싶으면 `createRepo(name, { isPublic: false })`.

### (선택) 갤러리용 CLI 명령

`iq-git public-repos [--limit N] [--before SIG]` 같은 서브커맨드를 추가해 `git_repos:all` 을 읽어 목록 출력.

---

## on-chaingit-frontend 변경 (읽기 + 쓰기)

### commit UI

CLI 와 동일 path.

### repo 페이지 / 커밋 목록

테이블이 이제 repo 격리라 JS 필터 없이 그대로 렌더. pagination 이 자연스러워진다.

### deploy()

기존엔 `readConfig` → `readFileFromLatest` → `getLog(owner)` 로 오너 전체 스캔. v2 에선 `readTableRows(git_commits:<owner>:<repo>, { limit: 1 })` 한 방.

iqpages 테이블의 marker row 에 snapshot JSON 을 박는 Phase 0 로직은 **"배포된 버전을 고정" 의미로 유지** — 이후 commit 이 올라가도 deploy 된 건 그 시점의 treeTxId 로 남는다. "자동 최신 반영" 원하면 iqpages row 무시하고 `git_commits:<owner>:<repo>` 직결. 두 기본값 중 pinned 쪽이 안전해 iqprofilenet 기본은 pinned 유지 권장.

### 공개 갤러리

신규 페이지: `git_repos:all` 레지스트리를 `readTableRows({ limit, before })` 로 페이지네이션. row 의 `owner`/`repo` 로 상세 페이지 링크 구성.

---

## iqprofilenet 변경 (읽기만)

### Unofficial Apps 드롭다운

```ts
for each deployment (owner, repoName) in iqpages-root:
  // 옵션 1 (기본): 배포 시점 스냅샷. iqpages marker row 1 RPC.
  snapshot = await svc.readDeploymentRow(owner, repoName)

  // 옵션 2 (원한다면): live latest. per-repo commit 테이블 1 RPC.
  latest = await git.getLatestCommit(owner, repoName)  // readTableRows limit:1
```

둘 다 **1 RPC 범위**. v1 의 오너 전체 스캔과 비교하면 수백 배 감소.

`useDeploymentDetails` 의 `useQueries` 도 오너별 getLog 중복 호출 제거. deployment 당 최대 2-3 RPC (`readDeploymentRow` + 필요 시 `getFile(configTxId)` + `getFile(profileTxId)`).

---

## 마이그레이션

### 현황 추적

마이그레이션이 필요한 **기존 repo 는 iqpages-root 에 등록된 deployment 목록으로부터 추출**. 현재 확인된 대상:

| Owner | Repos | 비고 |
|---|---|---|
| `FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c` | `iq-snake`, `poiqemon` | `~/Desktop/deploy/deploy.json` 키페어로 배포. https://git.iqlabs.dev/pages/FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c/{repo} |

추가 유저가 배포했으면 `getTablelistFromRoot(iqpages-root)` 로 좌표만 수집하면 됨 (마이그레이션 스크립트 한정, 앱 런타임 아님). 오너별 `git_commits_<owner>` 를 순회해 v2 테이블로 옮긴다.

### 하위호환 정책: v1 fallback 없음

v1 유저 수가 사실상 0 이므로 **SDK 에는 v1 읽기 경로를 넣지 않는다**. SDK v2 는 오직 v2 테이블만 바라본다. 그 결과:

- 기존에 v1 로 commit 한 repo 는 **마이그레이션이 끝나야 v2 리더에 보인다** (iqprofilenet / on-chaingit-frontend 포함)
- 마이그레이션 안 된 repo 는 v2 앱에서 "커밋 없음" 처럼 나타남 → 그 repo 를 신경쓰는 사람만 스크립트로 옮기면 됨
- SDK 에 폴백 코드가 남지 않아 유지보수 단순. 폭격의 원천이었던 v1 `git_commits_<owner>` 전체 스캔 로직 자체가 코드베이스에서 사라짐

**단, 기존에 올린 파일 (blob) / tree tx 는 체인 영구 저장이라 그대로 재사용**. 마이그레이션은 commit row 만 재작성할 뿐 파일·tree 업로드는 건너뛴다.

### 마이그레이션 스크립트 — 독립 repo `iqgit-v1-migrator`

위치: `~/WebstormProjects/iqgit-v1-migrator/`. SDK 레포에 일회성 스크립트를 섞지 않는다. 이 작업은 **한 번 쓰고 버리는 도구** 라서 SDK 의 publish 산출물에 낄 필요가 없고, CLI 스타일의 독립 앱으로 두는 편이 의존성·빌드·실행을 깔끔하게 분리한다.

구조:

```
~/WebstormProjects/iqgit-v1-migrator/
├─ package.json                   ← dependencies: "@iqlabs/git", "iqlabs-sdk", "commander"
├─ tsconfig.json
├─ README.md                      ← 목적·사용법·비용 추산
└─ src/
    ├─ bin.ts                     ← commander 엔트리 (migrate / verify / dry-run)
    ├─ v1-reader.ts               ← 기존 git_commits_<owner> 테이블 직접 조회
    ├─ migrate.ts                 ← 메인 흐름 (ensureCommitTable → writeRow × N)
    └─ util/
        ├─ keypair.ts             ← 로컬 keypair json 로딩
        └─ log.ts                 ← 진행 로그 포맷
```

이 repo 는 **`@iqlabs/git/node` 의 첫 실사용 소비자** 로서 SDK 의 공개 인터페이스 검증도 겸한다. 스크립트를 짜다가 SDK 내부를 자꾸 벗기면 공개 API 가 부실하다는 신호다.

**입력**:
- owner keypair (json 파일 경로)
- RPC URL (env)

**흐름**:

```ts
import { Keypair, Connection } from "@solana/web3.js";
import { GitClient } from "@iqlabs/git/node";
import iqlabs from "iqlabs-sdk";

const keypair   = loadKeypair(process.argv[2]);
const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const client    = GitClient.forNode({ connection, keypair });
const owner     = keypair.publicKey.toBase58();

// 1. v1 테이블에서 owner 의 모든 commit row 를 한 번에 수집
//    (v2 SDK 에는 이 경로가 없으므로, 스크립트 내부에서 iqlabs-sdk 직접 호출)
const v1Pda   = iqlabs.contract.getTablePda(
  iqGitDbRoot,
  iqlabs.utils.toSeedBytes(`git_commits_${owner}`),
  PROGRAM_ID,
);
const v1Rows  = await iqlabs.reader.readTableRows(v1Pda);
const byRepo  = groupBy(v1Rows, r => r.repoName);

for (const [repoName, commits] of Object.entries(byRepo)) {
  commits.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));  // oldest first

  // 2. v2 per-repo commit 테이블 없으면 생성 (writers = [owner])
  await client.ensureCommitTable(repoName);

  // 3. 시간순으로 v2 row writeRow — treeTxId / author / timestamp 그대로.
  //    parentCommitId 는 직전 row 의 id 로 채워 DAG 링크 복원
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

  // 4. 해당 repo 가 현재 public 이면 레지스트리 (git_repos:all) 에도 등록
  const repoMeta = await client.getRepoMeta(owner, repoName);
  if (repoMeta?.isPublic) {
    await client.registerPublicRepo({
      owner, repo: repoName,
      description: repoMeta.description,
      timestamp: Date.now(),
    });
  }

  // 5. 검증
  const latest = await client.getLatestCommit(owner, repoName);
  if (latest.treeTxId !== commits[commits.length - 1].treeTxId) {
    throw new Error(`migration verify failed for ${repoName}`);
  }
  console.log(`✓ ${repoName}: ${commits.length} commits migrated`);
}
```

**핵심 동작**:
- file blob / tree tx 는 건드리지 않는다. 재업로드 0. 비용은 `createTable × repo 수` + `writeRow × commit 수`
- owner keypair 로 서명해야 `writers=[owner]` 통과 → **자기 repo 만 마이그레이션 가능**
- 스크립트는 idempotent — 이미 v2 테이블이 있으면 `ensureCommitTable` 이 skip. 부분 실패 후 재실행 OK
- `parentCommitId` 는 정렬 순서대로 재구성. v1 에 저장이 안 되어 있던 링크를 이 시점에 복원

### 실행 예시

```bash
# 1. SDK 가 먼저 publish 혹은 npm link 되어 있어야 함
cd ~/WebstormProjects/iqlabs-git-sdk
npm run build && npm link

# 2. migrator repo 준비
cd ~/WebstormProjects/iqgit-v1-migrator
npm install
npm link @iqlabs/git        # 로컬 개발 중이면
npm run build

# 3. 오너 본인이 자기 keypair 로 실행
SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..." \
  npx iqgit-v1-migrator migrate ~/Desktop/deploy/deploy.json
```

출력:
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

사전 확인용 `dry-run` 서브커맨드를 두고, 변환 결과를 체인에 쓰기 전에 시뮬레이션 로그만 찍도록 해두면 안전. `verify` 서브커맨드는 마이그레이션 완료 후 v1 / v2 최신 commit 의 treeTxId 가 일치하는지 재확인.

### 비용 추산

현재 확인된 대상 (`FPSYQmFh...rf1c` 의 `iq-snake`, `poiqemon`):
- `createTable × 2` ≈ 0.004 SOL (commits 테이블)
- `writeRow × (commits count)` ≈ 0.00001 SOL × 수십 = 무시할 수준
- 공개 → `git_repos:all` writeRow × 2 ≈ 0.00002 SOL

**총 예상: 0.005 SOL 미만**. 여유있게 0.01 SOL 이상 owner 계정에 있으면 안전.

### 오래된 iqpages deploy 2 repo 의 예외

`iq-snake` / `poiqemon` 은 v1 때 배포하면서 iqpages 테이블의 `writers` 가 `[SystemProgram.programId]` 로 잘못 박혀 있어 **그 테이블의 marker row 는 업데이트 불가**. 따라서:

- v2 commit 테이블 이관 자체는 문제 없이 가능 (별도 PDA)
- 하지만 iqpages 쪽에서 "이 repo 는 어떤 tree 로 배포됐나" 를 담은 snapshot row 는 새로 쓸 수 없음
- → iqpages 에서 이 두 repo 를 노출하지 않게 **레거시 필터** 로 숨긴다 (아래)

### 레거시 iqpages 필터

```ts
// 모든 v2 소비자 앱 공통
const LEGACY_IQPAGES = new Set([
  "FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c:iq-snake",
  "FPSYQmFh1WhbrgNKoQCDBcrf3YLc9eoNCpTyAjHXrf1c:poiqemon",
]);
```

iqprofilenet / on-chaingit-frontend 의 iqpages 갤러리 렌더링 전에 이 셋으로 필터. 해당 2 repo 의 commit 이력은 v2 에서 정상 조회 가능하지만 **"배포된 iq-pages"** 로는 안 보임. 이 두 repo 를 v2 배포로 되살리려면 다른 이름으로 다시 배포하거나 iq-pages 계정 갱신 가능해질 때까지 대기.

---

## 단계 (플랜)

### Phase 0 — 현재 (스킵됨, 커밋/푸시 안 함)
- on-chaingit-frontend 에 marker snapshot 로직 추가 (deploy 가 row 에 JSON 박음)
- iqprofilenet 에 `readDeploymentRow` + fallback 로직
- **커밋/푸시 하지 않음**. v2 전환에서 이 변경의 일부는 유지되고 일부는 대체되므로, v2 작업 완료 후 일괄 커밋

### Phase 1 — iq-git v2 스키마 도입
1. **Bootstrap**: `git_repos:all` 레지스트리 테이블을 `createTable(writers=[])` 로 **한 번만** 생성. 관리자 키로 수행하고 PDA 주소를 상수화 (`GIT_REPOS_ALL_PDA`)
2. iq-git-cli: `commit`, `fetch`, `log`, `clone` 을 per-repo 테이블 기준으로 수정. 첫 commit 에서 `createTable(writers=[owner])`
3. iq-git-cli: `createRepo` 에서 `git_repos_v2_<owner>` 에 writeRow + `isPublic` 이면 `git_repos:all` 에도 writeRow
4. iq-git-cli: (선택) `public-repos` 서브커맨드로 `git_repos:all` 페이지네이션 조회
5. on-chaingit-frontend: 동일한 쓰기 경로 + repo 페이지 / 커밋 목록 읽기 경로 + 공개 갤러리 페이지
6. SDK 변경 없음 확인 (이미 writers + `{ limit: N }` + tableHint + `before` 지원)

### Phase 2 — 마이그레이션
1. iqpages-root 좌표 수집 스크립트
2. 각 (owner, repo) 에 대해 v2 테이블 생성 + row 이관 + 검증
3. 공개인 것은 `git_repos:all` 에도 등록
4. **마이그레이션 불가한 레거시 deploy (writers 고정된 것)** 는 LEGACY 리스트에 기록
5. iqpages marker row 업데이트 (v2 로 옮긴 것만)

### Phase 3 — 읽기 경로 전환
1. on-chaingit-frontend: deploy / repo / 커밋 목록이 v2 테이블만 바라보게. v1 fallback 경로 제거
2. iqprofilenet: `useDeploymentDetails` 를 `readDeploymentRow` 1-RPC 경로로 정리. getLog 호출 완전 제거
3. 두 앱에 LEGACY 필터 적용해서 drop-down / 갤러리에서 숨김

### Phase 4 — 정리
1. v1 코드 경로 삭제 (`readFileFromLatest` 의 commit-log 스캔, iqpages-service 의 fallback 등)
2. 문서 갱신 (README, IQPAGES-PLAN)
3. 새 deploy 가 v2 경로만 쓰는지 E2E 확인

---

## 비용 / 리스크

- **사용자 적은 현재** 가 깨끗한 전환 타이밍. 유저가 쌓이기 전에 해야 마이그레이션 스크립트가 가볍다
- SDK / contract 변경 **없음** → 기존 iq-locker, iqprofilenet, solchat 등은 영향 없음 (commit 읽기 쓰는 곳만 해당)
- 리스크 있는 구간: 마이그레이션 중 새 commit 이 v1 에 쓰이는 것. **전환 기간엔 CLI / frontend 가 v2 로 이미 쓰고 있어야** 하므로 순서: (Phase 1 배포) → (새 commit 은 v2 로 흐름) → (Phase 2 마이그레이션 으로 과거분 이관). 혹은 점검 모드로 전환 window 를 명시
- **`git_repos:all` 스팸**: writers 가 열려 있어 누군가 가짜 row 를 쏠 수 있다. 리더 쪽에서 `row.owner === tx.signer` 검증을 기본 가드로, 실제 피해가 보이면 그 시점에 게이트웨이가 화이트리스트 / rate limit 을 얹거나 contract 제약을 추가한다. MVP 단계에서는 감당 가능
- 프라이빗 레포 내용 암호화는 MVP 범위 밖. `isPublic` 은 "공용 디렉토리 노출 여부" 만 보장한다는 점을 UI 에 명시

---

## Git 내부 모델 — 지금 구현이 차용한 것, 차용 안 한 것

v2 설계는 여기서 더 파생될 여지가 있어서 **진짜 git 이 내부적으로 어떤 개념을 쓰는지** 와 우리가 그걸 어디까지 재현하고 있는지 같이 정리해둔다. 이후 모듈화·SDK 화 때 결정해야 할 것들이 여기서 나온다.

### Git 의 핵심 세 객체

Git 은 디스크를 "blob / tree / commit" 세 오브젝트로 추상화한다. 모두 **내용을 SHA-1(v2 기본) / SHA-256(v3) 로 해시한 주소로 식별** — 같은 내용이면 같은 해시, 같은 해시면 같은 오브젝트. 이게 "이미 올라간 것은 다시 안 올린다" 의 뿌리다.

- **blob**: 파일 한 장의 바이트. 파일명이나 권한은 포함하지 않고 **내용만**. 같은 내용을 다른 이름으로 두 번 커밋해도 blob 은 하나.
- **tree**: 디렉토리 스냅샷. 엔트리마다 `{mode, name, 대상_blob_또는_tree_해시}`. 이 자체도 해시되어 주소가 된다. 하위 트리 해시가 그대로 엔트리에 들어가므로 **하위가 안 바뀌면 상위 tree 도 안 바뀐다**.
- **commit**: `{tree 해시, parent 해시, author, committer, message, timestamp}`. 이것도 해싱. parent 를 체인으로 따라가면 전체 히스토리.

즉 "commit 은 tree 를 가리키는 포인터, tree 는 blob/subtree 를 가리키는 포인터, 모든 포인터는 해시" 구조. **Merkle DAG**.

#### 중복 회피 (dedup)

- `git add` 단계에서 파일 내용을 해싱 → `.git/objects/<hash 앞 2>/<뒷 38>` 에 이미 존재하면 write 생략
- `git commit` 시 tree 를 만들 때 각 엔트리 해시로 비교 → 내용 같은 파일은 기존 blob 해시 재사용
- 원격 `git push` 시 send-pack 프로토콜이 "상대가 이미 아는 해시는 빼고" 보내므로 네트워크 상에서도 중복 안 실림

### 현재 iq-git 이 차용한 것

`src/git-service.ts:284-409` (commit 함수) 가 git 의 incremental commit 을 어떻게 모방하는지:

- **파일 해시로 dedup**
  ```ts
  const currentHash = sha256(content).toString("hex");
  if (oldTree[relativePath] && oldTree[relativePath].hash === currentHash) {
      fileTree[relativePath] = oldTree[relativePath];    // 기존 txId 재사용
      reusedCount++;
      continue;                                           // codeIn 업로드 생략
  }
  ```
  이게 "이미 올라간 건 다시 안 올림" 의 구현. 파일 내용 해시가 같으면 **이전 commit 에서 쓰던 txId 를 그대로** 새 tree 에 달고 간다. blob 재사용과 동일한 효과.

- **tree 개념 = `tree.json` 매니페스트**
  ```ts
  const fileTree: FileTree = {};    // { [path]: { txId, hash } }
  // ...
  const treeTxId = await iqlabs.writer.codeIn(..., ["tree.json"], ...);
  ```
  디렉토리 스냅샷을 JSON 한 장으로 만들어 codeIn 으로 올리고 그 tx signature 를 `treeTxId` 라 부른다. 진짜 git 의 tree 객체에 해당.

- **commit 이 tree 를 가리킴**
  ```ts
  const commit: Commit = {
      id: randomUUID(), repoName, message, author,
      timestamp, treeTxId,
  };
  await iqlabs.writer.writeRow(..., commit);
  ```
  commit row 의 `treeTxId` 가 "이 commit 의 스냅샷 주소" 역할.

- **chunking**
  ```ts
  const chunks = chunkString(content, DEFAULT_CHUNK_SIZE);   // 850 bytes/chunk
  ```
  큰 파일은 Solana tx payload 제한을 넘으므로 여러 chunk 로 쪼개 codeIn 의 linked-list 로 저장. git 의 packfile / delta 와 비슷한 역할이지만 구현은 단순 바이트 분할.

### 현재 차용 안 한 것 (의도적 or 구현 미흡)

- **blob 수준 dedup 이 아니라 "path+hash" 단위 dedup**
  진짜 git 은 `같은 내용` = 같은 blob 이라 경로가 달라도 재사용. iq-git 은 `oldTree[relativePath].hash === currentHash` 로 **경로까지 같아야** 재사용한다. 파일 rename 시 전체 재업로드. tree 맵을 경로 → txId 대신 hash → txId 의 추가 인덱스로 두면 쉽게 고칠 수 있음. v2 리팩토링 때 하자.
- **tree 자체의 구조적 재사용 (subtree reuse)**
  진짜 git 은 하위 디렉토리가 안 바뀌면 그 subtree 객체를 그대로 참조. iq-git 은 tree 가 "path → {txId, hash}" 의 평면 map 이라 subtree 개념이 없음. 전체 tree JSON 을 매 commit 마다 새로 올린다. 파일 수 많으면 tree manifest 크기가 커짐.
- **parent-commit 링크 (history traversal)**
  `Commit.parentCommitId` 는 타입에는 있는데 commit 시 세팅 안 한다 (`src/git-service.ts:402-409`). `git log --graph` 같이 parent 를 따라가는 기능이 없고, 모든 log 는 per-repo 테이블의 timestamp 정렬로 단순화. 브랜치/머지 하려면 필요.
- **branch / ref / HEAD**
  `types.ts` 에 `Ref` 타입은 있지만 실제로는 "최신 commit = 그 테이블의 가장 최근 row" 로 대체. `refs/heads/main`, `refs/tags/*` 개념이 없고, 당연히 병합·체크아웃 시 이를 해석하는 로직도 없음.
- **packfile / delta 압축**
  git 은 유사 blob 사이 델타로 용량을 줄이지만 iq-git 은 항상 base64 + chunking 의 raw 저장. 대용량 저장소라면 비용 영향 큼. 초기 MVP 는 생략 OK.

### v2 에서 고쳐둘 만한 것

| 항목 | 비용 | 효과 |
|---|---|---|
| hash → txId 인덱스 추가 (rename dedup) | 작음 | 파일 이동·리네임 시 재업로드 방지 |
| subtree 도입 (`tree.json` 을 재귀 구조로) | 중간 | tree 매니페스트 크기·rent 절감. 큰 레포에 필수 |
| `parentCommitId` 실제로 기록 | 거의 0 | history / revert / blame 기능의 기반 |
| `branch`, `ref` 모델링 | 중간 | 실제 협업 기능, PR · merge 전제 |

MVP 는 **hash dedup 인덱스** + **parentCommitId 기록** 만 추가하고 나머지는 별도 이슈로. 모듈화할 때 이 개념들이 각각의 작은 모듈로 떨어질 수 있게 설계 여지를 남겨 둔다.

---

## 새 패키지 구조 — `@iqlabs/git` SDK 와 얇은 소비자들

거의 처음부터 다시 짠다는 전제. 지금 `iq-git-cli/src/` 6 개 파일에 혼재된 CLI / 프로토콜 / 체인 액세스를 **독립 npm 패키지 `@iqlabs/git`** 로 완전히 분리한다. CLI, 프론트엔드, 기타 앱들은 모두 이 SDK 를 dependency 로 소비하는 얇은 래퍼로 만든다.

### 레포 배치 (monorepo 아님 — 각 독립 repo)

모든 레포는 `~/WebstormProjects/` 아래에 동거한다. `npm link` / `pnpm link` 로 로컬 개발 시 상호 참조가 쉽도록 한 디렉터리 안에 모아 두되, 각 repo 는 **독립 git 레포 + 독립 npm 패키지**.

```
~/WebstormProjects/
│
├─ iqlabs-git-sdk/                       ← NEW repo, npm 패키지 "@iqlabs/git"
│   ├─ package.json                      ← exports map: ".", "./browser", "./node"
│   ├─ tsconfig.json
│   ├─ rollup.config.mjs                 ← 3 타겟 빌드 (shared / browser / node)
│   │
│   ├─ src/                              ← 모든 실제 로직. CLI 없음
│   │    ├─ index.ts                     ← "@iqlabs/git" (shared)
│   │    ├─ browser.ts                   ← "@iqlabs/git/browser"
│   │    ├─ node.ts                      ← "@iqlabs/git/node"
│   │    ├─ core/                        ← L0  types, seed, hash, chunk, codec
│   │    ├─ wallet/                      ← L0  Signer 추상
│   │    ├─ chain/                       ← L1  iqlabs-sdk 래퍼 + gateway fallback
│   │    ├─ storage/                     ← L2  BlobStore, TreeStore
│   │    ├─ model/                       ← L3  RepoService, CommitService, RegistryService
│   │    ├─ client/                      ← L4  GitClient (facade)
│   │    └─ platform/                    ← fs-node / fs-browser 분리
│   │
│   ├─ test/
│   └─ scripts/
│        └─ bootstrap-registry.ts        ← git_repos:all 최초 createTable (관리자 키)
│                                          (SDK 에 남기는 이유: 팀 내 재사용 가능한 부트스트랩.
│                                           일회성 마이그레이션과는 다른 목적)
│
├─ iqgit-v1-migrator/                    ← NEW repo, 일회성 v1→v2 이관 도구
│   ├─ package.json                      ← dependencies: "@iqlabs/git", "iqlabs-sdk", "commander"
│   └─ src/
│        ├─ bin.ts                       ← commander (migrate / verify / dry-run)
│        ├─ v1-reader.ts                 ← 기존 git_commits_<owner> 스캔
│        ├─ migrate.ts                   ← 메인 흐름
│        └─ util/
│
├─ iq-git-cli/                           ← 기존 repo, 얇은 CLI 래퍼로 전환
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
│        │   ├─ public-repos.ts          ← git_repos:all 페이지네이션 조회
│        │   └─ deploy.ts                ← iqpages 배포
│        └─ config.ts                    ← ~/.iq-git/config, keypair 경로 로딩
│
├─ on-chaingit-frontend/                 ← 기존 repo
│   └─ package.json
│       └─ dependencies:
│           "@iqlabs/git": "^0.1.0"
│   → import { GitClient } from "@iqlabs/git/browser"
│     (자체 GitChainService / IqpagesService 제거)
│
└─ iqprofilenet/                         ← 기존 repo
    └─ package.json
        └─ dependencies:
            "@iqlabs/git": "^0.1.0"
    → import { readDeploymentRow, lookupLatestCommit } from "@iqlabs/git/browser"
      (src/lib/iqgit/ 전부 제거)
```

SDK 는 로직의 "근원", CLI / 프론트는 그걸 쓰는 UX 계층. 둘의 **릴리스 주기가 독립**.

### 왜 monorepo 가 아니라 독립 repo 인가

| 독립 repo | monorepo |
|---|---|
| SDK 버전이 명시적으로 고정됨 (`"@iqlabs/git": "^0.1.2"`) | workspace link 로 모호해질 수 있음 |
| 외부 유저가 `npm i @iqlabs/git` 만 하면 끝 | workspace 라는 오해 가능 |
| 이슈 / PR / 히스토리 각 레포에 격리 | 섞임 |
| CI / release automation 단순 | workspace 빌드 순서 챙겨야 함 |
| 로컬 개발 시 `npm link` 한 번 필요 | workspace auto-link |

로컬 개발 편의는 `npm link` (또는 `pnpm link`) 로 해결됨. 구조적 명확성 쪽이 더 중요.

### 서브엔트리 (exports map)

`@iqlabs/git` 의 `package.json`:

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

- `@iqlabs/git` — runtime 중립 (타입, seed, chunk, 해시 인터페이스, row 스키마). DOM / node fs 의존 없음
- `@iqlabs/git/browser` — 위 + `WalletAdapter`, Web Crypto 해시, fetch 기반 gateway
- `@iqlabs/git/node` — 위 + `node:fs`, `node:crypto`, Keypair 로더

CLI 와 Node 마이그레이션 스크립트는 `@iqlabs/git/node` 를, 웹 앱들은 `@iqlabs/git/browser` 를 import. 공통 타입이 필요한 정적 헬퍼나 설정 코드는 `@iqlabs/git` 루트에서.

### 의존성 규칙

- 루트 (`shared`) 는 `@solana/web3.js`, `iqlabs-sdk`, `buffer` 만 peer dep. DOM / node fs **금지**
- `browser` 는 추가로 `@solana/wallet-adapter-base` (타입만)
- `node` 는 추가로 `fs/promises`, `path`, `node:crypto` 빌트인
- CLI (`iq-git-cli`) 는 `@iqlabs/git` + `commander` / `kleur` / `prompts` 같은 UI 의존성만. **체인 액세스 코드 직접 작성 금지** — 무조건 SDK 경유

이 규칙을 eslint `no-restricted-imports` 로 강제하면 웹 번들에 node API 가 새어 들어오는 사고를 빌드 시점에 차단.

### 로컬 개발 워크플로우

모든 repo 가 `~/WebstormProjects/` 에 있으므로 `npm link` (또는 `pnpm link`) 로 상호 참조가 단순하다.

```bash
# SDK 빌드를 watch 모드로 띄우기
cd ~/WebstormProjects/iqlabs-git-sdk
npm install
npm run build -- --watch    # rollup/tsup watch
npm link                    # 글로벌 심볼릭 링크 등록

# CLI 에서 로컬 SDK 링크
cd ~/WebstormProjects/iq-git-cli
npm link @iqlabs/git
npm run dev

# 프론트엔드에서 로컬 SDK 링크
cd ~/WebstormProjects/on-chaingit-frontend
npm link @iqlabs/git
npm run dev

cd ~/WebstormProjects/iqprofilenet
npm link @iqlabs/git
npm run dev

# 릴리스 전에 unlink
cd ~/WebstormProjects/iq-git-cli
npm unlink --no-save @iqlabs/git
npm install                 # 정식 버전으로 재설치
```

SDK 하나 수정 → watch 빌드가 3 곳 (CLI + 프론트 2) 에 실시간 반영. 사고 없이 개발 루프를 짧게 돌릴 수 있는 핵심 이유.

### 확장 패턴 (같은 원칙을 다른 도메인에도)

IQ Labs 전체 코드베이스를 정리하는 원칙으로 확장. 모든 repo 는 `~/WebstormProjects/` 아래 동거.

| SDK (독립 repo, npm 퍼블리시) | 경로 | 얇은 소비자 |
|---|---|---|
| `@iqlabs/git` | `~/WebstormProjects/iqlabs-git-sdk/` | `iq-git-cli`, `on-chaingit-frontend`, `iqprofilenet`, `iqgit-v1-migrator` |
| `@iqlabs/iqpages` | `~/WebstormProjects/iqlabs-iqpages-sdk/` | `on-chaingit-frontend` (배포 UI), `iqprofilenet` (읽기) |
| `@iqlabs/chat` (solchat core) | `~/WebstormProjects/iqlabs-chat-sdk/` | `solchat-web`, `simplechatcli` |
| `@iqlabs/iqchan` | `~/WebstormProjects/iqlabs-iqchan-sdk/` | iqchan 관련 앱 |

일회성 도구 (마이그레이션, 부트스트랩 등) 는 SDK 에 섞지 않고 **별도 저장소** 로 둔다. 예: `iqgit-v1-migrator` 는 v1→v2 이관 전용 CLI 앱.

**공통 로직 = SDK, UX = 얇은 소비자**. 같은 SDK 를 여러 앱이 import 하므로 버그 한 번 고치면 모든 앱이 같이 이득. 버전 고정 덕분에 파괴적 변경은 명시적 업그레이드로만 전파.

이 규칙을 eslint `no-restricted-imports` 로 강제하면 웹 유저가 실수로 `node` 코드를 가져올 때 빌드에서 즉시 잡힌다.

---

## 모듈화 계획 — 내부 레이어 분해

현재 `git-service.ts` 831 줄이 "repo 생성 · 커밋 · fetch · collaborator · iqpages 연계" 를 다 섞어 들고 있다. 재작성 시 다음 레이어로 쪼갠다. 각 레이어는 위 레이어만 import.

```
┌─────────────────────────────────────────────┐
│  L5  Apps                                   │
│  @iqlabs/git/cli, on-chaingit-frontend,     │
│  iq-git-cli 의 얇은 커맨드, iqprofilenet    │
└─────────────────────────────────────────────┘
                  ↓ uses
┌─────────────────────────────────────────────┐
│  L4  GitClient (facade)                     │
│    • commit, clone, log, checkout, status   │
│    • createRepo, setVisibility, fork        │
│    • 고수준 워크플로우만. 아래 모듈 조합    │
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
│  tree.json 만    │  │  codeIn 파일 업로드, │
│  업로드/조회,    │  │  hash → txId 인덱스, │
│  (나중에) subtree│  │  dedup, retry         │
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
│    core/hash.ts      — SHA-256 (web/node 분리)│
│    core/chunk.ts     — byte-safe chunking    │
│    core/seed.ts      — table_hint 규약       │
│    core/fs.ts (node) — 디렉토리 스캔         │
│    core/wallet.ts    — Signer 추상화         │
└─────────────────────────────────────────────┘
```

### 각 모듈의 책임

- **L0 `core/`** — 런타임 의존성 (hash, fs 스캔, wallet signing) 을 한 곳에 가둠. 브라우저용 `core/hash.ts` 는 `SubtleCrypto`, Node 용은 `node:crypto`. 상위 레이어는 이 인터페이스만 보면 된다.
- **L1 `chain/`** — SDK 호출 래퍼. 여기서만 `iqlabs-sdk` import. 게이트웨이 `/table/<pda>/rows` 우선, 실패 시 `readTableRows` fallback. rate limiter 여기에 붙여 일관된 재시도. L2+ 는 이 어댑터만 쓰도록 타입 인터페이스로 닫아둔다 (테스트 시 mock 쉬움).
- **L2 `storage/`**
  - `BlobStore`: 파일 내용 → codeIn 업로드. **hash → txId 캐시** 여기에 둬서 rename 시에도 재사용. chunking 도 여기서.
  - `TreeStore`: path-map 트리 (`tree.json`) 직렬화 / 파싱 / 업로드. 나중에 subtree 재귀화 시 내부만 바꾸면 됨.
- **L3 `model/`**
  - `RepoService`: 오너의 repo 목록, 가시성, 공용 레지스트리 등록. 위에서 정의한 schema 와 네비게이션 규칙 구현.
  - `CommitService`: per-repo commit 테이블 생성 / writeRow / `readTableRows({limit:1})` / `parentCommitId` 채우기.
- **L4 `client/GitClient`** — 유저 관점의 워크플로우 (commit, clone, status, checkout 등) 를 위 모듈을 조합해서 구현. 상태머신이 복잡한 commit 로직도 여기서 오케스트레이션.
- **L5 Apps** — CLI / 프론트 / iqprofilenet 이 `GitClient` 를 사용. 각 앱에는 UI 전용 코드만.

### 모듈 간 테스트 전략

- L0 / L1 은 **단위 테스트**. chain 어댑터는 `SystemProgram` 호출 mock 으로.
- L2 / L3 은 **fake chain adapter** 로 in-memory 시뮬레이션 → 빠르게 dedup 로직, 해시 재사용 등 검증.
- L4 `GitClient` 는 **로컬 Solana test validator** 에 통합 테스트. 실제 codeIn 왕복 포함.

### 기존 코드 매핑 (어디 어디서 복사해올지)

| v2 모듈 | 기존 출처 |
|---|---|
| `core/chunk.ts` | `iq-git-cli/src/chunk.ts` 그대로 |
| `core/hash.ts` | `git-service.ts` 의 `sha256` 사용 부분. node / web 분리해서 재작성 |
| `core/wallet.ts` | `iq-git-cli/src/wallet_manager.ts` + `iqlabs-sdk` 의 `SignerInput` 참고 |
| `core/fs.ts` (node) | `git-service.ts` 의 `scanDirectory`, `fs.readFileSync` 루프 |
| `chain/` | `iqlabs-sdk` 호출부 + 솔챗 쪽에서 쓴 `gateway/reader.ts` 의 `readTableRows` fallback 패턴 |
| `storage/BlobStore` | `git-service.ts:314-366` (파일 업로드 루프 + hash skip + retry) |
| `storage/TreeStore` | `git-service.ts:381-391` (tree.json codeIn) + `checkout` 의 `readCodeIn` 복원 로직 |
| `model/RepoService` | `git-service.ts` 의 `createRepo`, `listRepos`, `setVisibility`, fork |
| `model/CommitService` | `git-service.ts` 의 `commit`, `getLog`, `checkout` 의 commit 부분 |
| `client/GitClient` | `git-service.ts` 전체 조합 로직 (commit → blob 업로드 → tree 업로드 → commit row write) |
| `cli/` | `iq-git-cli/package.json` bin + `index.ts` 기반으로 새로 작성 |

---

## 단계 (플랜 — 리패키지 포함)

각 Phase 는 **독립 repo** 전제. SDK 가 퍼블리시 된 다음 CLI / 프론트가 소비한다.

### Phase 0 (스킵됨, 커밋/푸시 안 함)
> 위 섹션 유지. on-chaingit-frontend + iqprofilenet 의 Phase 0 수정은 v2 로 대체될 예정이므로 커밋 보류.

### Phase 1 — `@iqlabs/git` SDK 구현 (신규 repo: `~/WebstormProjects/iqlabs-git-sdk/`)

새 repo 를 `~/WebstormProjects/iqlabs-git-sdk/` 경로에 만들고 여기에서 SDK 를 전부 짠다. 이 시점에는 기존 `iq-git-cli` / 프론트 코드는 **건드리지 않는다**.

1. `~/WebstormProjects/iqlabs-git-sdk/` 디렉터리 생성 + `git init` + `npm init`. `package.json` (name = `@iqlabs/git`, exports map 구성), `tsconfig.json`, rollup/tsup 빌드, eslint 규칙 (레이어 간 import 제약)
2. L0 `core/` 작성 (chunk, hash, seed, wallet, codec, errors)
3. L1 `chain/` 작성 (chain-adapter 인터페이스 + iqlabs-sdk 구현 + gateway fallback + rate-limit)
4. L2 `storage/` 작성 (BlobStore + hash → txId 인덱스, TreeStore, tree-walker)
5. L3 `model/` 작성 (RepoService, CommitService, RegistryService — per-repo 테이블 규약 반영)
6. L4 `client/GitClient` 에서 commit / clone / log / checkout / status 구현
7. `scripts/bootstrap-registry.ts` — `git_repos:all` 테이블 createTable 1 회 (관리자 키). `@iqlabs/git/node` 의 첫 소비자
8. vitest 단위 테스트 (core / storage / model) + fake chain adapter
9. `npm publish` (`0.1.0-rc.1` 정도로) — 배포 후 다음 Phase 가 소비 가능

### Phase 2 — `iq-git-cli` 를 얇은 래퍼로 교체

기존 repo 를 유지하되 **내부를 비우고 SDK 소비자로 전환**.

1. `iq-git-cli/package.json` 에 `"@iqlabs/git": "^0.1.0"` 추가. 기존 `iqlabs-sdk`, `@solana/web3.js` 등 직접 의존성은 제거 (peer 로 빠짐)
2. `src/bin.ts` + `src/commands/*` 구조로 재작성. 각 커맨드는 `GitClient` 메서드 호출만 하고 UX (prompt / 에러 메시지 / 진행바) 에 집중
3. 기존 `git-service.ts`, `iqpages-service.ts`, `chunk.ts`, `wallet_manager.ts` **제거**
4. 로컬 개발 동안은 `npm link @iqlabs/git` 으로 SDK 변경을 즉시 반영
5. CLI 버전 bump + npm publish (선택)

### Phase 3 — 마이그레이션 (독립 repo `iqgit-v1-migrator`)

새 repo `~/WebstormProjects/iqgit-v1-migrator/` 에서 v1 → v2 데이터 이관 도구를 짠다. SDK 레포에 일회성 스크립트를 섞지 않고 별도 프로젝트로 분리. 이 도구는 **"@iqlabs/git/node 의 두 번째 소비자"** 로 SDK 공개 인터페이스만 쓴다 (CLI 가 쓰는 것과 같은 API).

1. `iqgit-v1-migrator` repo 초기화 — `git init` + `npm init` + `@iqlabs/git` 의존성 추가
2. iqpages-root 좌표 수집 로직 (`getTablelistFromRoot(iqpages-root)` → `(owner, repo)` 목록)
3. 각 (owner, repo) 에 대해 v2 per-repo 테이블 생성 + row 이관 + 검증
4. 공개 repo 는 `git_repos:all` 에도 등록
5. 마이그레이션 불가한 레거시 deploy 는 `LEGACY_IQPAGES` 상수에 기록 (이 상수는 SDK 레포 or 각 앱 레포에 둠)
6. `migrate`, `verify`, `dry-run` 서브커맨드 제공

### Phase 4 — 프론트 재배선

1. **on-chaingit-frontend**: `package.json` 에 `@iqlabs/git` 추가. `services/git/`, `services/iqpages/` 의 자체 구현 제거 → `import { GitClient } from "@iqlabs/git/browser"` 로 대체. 배포 / 갤러리 / repo 페이지 / 커밋 목록 전부 재배선
2. **iqprofilenet**: 동일. `src/lib/iqgit/`, `src/lib/iqpages/` 제거 → `@iqlabs/git/browser` import. `useDeploymentDetails` 를 1-RPC 경로로 정리
3. 두 앱에 `LEGACY_IQPAGES` 필터 적용해 drop-down / 갤러리에서 숨김
4. 각 repo 별 PR → 배포

### Phase 5 — 정리

1. 기존 v1 코드 경로 삭제 (`readFileFromLatest` 의 commit-log 스캔, iqpages-service 의 fallback 등)
2. `@iqlabs/git` 을 `0.1.0` 정식 릴리스로 태그
3. README / IQPAGES-PLAN / 본 문서 갱신, 각 repo 의 README 에서 의존 관계 명시
4. 새 deploy 가 v2 경로만 쓰는지 E2E 확인
5. `@iqlabs/iqpages`, `@iqlabs/chat` 등으로 동일 패턴 확장 (로드맵)

---

## 재작성 범위 / 리스크

- **코드 라인 기준으로 70~80% 가 새 작성**. 기존 소스는 로직 발췌 용도. 처음부터 모듈 경계를 제대로 긋는 게 유지보수 핵심
- 마이그레이션 스크립트가 `@iqlabs/git/node` 의 두 번째 소비자라 **SDK 경계 검증** 에도 쓰인다. 스크립트 짜다가 자꾸 core / chain 내부를 벗기면 공개 인터페이스가 부실하다는 신호
- **Phase 1 완료 + publish 전까지는 프론트에 영향 가지 않게** — `iqlabs-git-sdk` repo 에서만 병행 개발. `iq-git-cli/src/` 는 그대로 두고 있다가 Phase 2 에서 한 번에 교체
- 웹 쪽 번들 사이즈: `@iqlabs/git/browser` 가 iqlabs-sdk + web3.js 를 포함하므로 최소 수백 KB. tree-shaking 보장되게 ESM 전용 + sideEffects: false. CommonJS 는 `node/` 서브엔트리에만 제공
- **독립 repo 3 개 (iqlabs-git-sdk + iq-git-cli + 각 소비자)** 를 조율해야 해 릴리스 순서가 중요. `sdk publish → cli bump → frontend deploy` 순서를 릴리스 노트로 문서화
