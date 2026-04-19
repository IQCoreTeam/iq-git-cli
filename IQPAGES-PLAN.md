# IQ Pages — Minimal Implementation Plan

IQ GitHub repo 를 "공식 배포된 앱" 으로 선언하는 최소 기능.

**프론트엔드 변경**: [../on-chaingit-frontend/IQPAGES-PLAN.md](../on-chaingit-frontend/IQPAGES-PLAN.md)

---

## 원칙: 정말 최소만

- 폴더 구조 과하게 만들지 않음
- 추상화 없이 직접 구현
- 커맨드 2 개면 충분
- zod 같은 라이브러리 없이 간단한 런타임 체크

---

## 동작 방식 (전체)

```
iqgit pages deploy
  ↓
1. 현재 repo 의 repoTxId 탐지
2. iqpages.json 있는지 확인 (없으면 에러)
3. 원자 트랜잭션:
   - 0.2 SOL → EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1
   - createTable(iqpages-root, repoTxId, writers: [SystemProgram.programId])
4. 끝
```

**중복 방지**: tableSeed = repoTxId → PDA 충돌로 두 번째 시도 자동 실패.

**Discovery**: `getTablelistFromRoot('iqpages-root')` 로 전체 목록.

**메타**: 전부 repo 의 `iqpages.json` / `iqprofile.json` 에서 fetch. 레지스트리에는 아무 정보 없음.

---

## 파일 구조 (최소)

`iq-git-cli/src/iqpages/` 아래 3 파일:

```
src/iqpages/
├── deploy.ts       # 배포 트랜잭션 조립 + CLI 커맨드
├── list.ts         # 배포 목록 조회
└── schemas.ts      # iqpages.json / iqprofile.json 예시 + 체크
```

그 외 필요하면 추가, 안 필요하면 넣지 않음.

---

## 상수 (deploy.ts 상단)

```typescript
import { PublicKey, SystemProgram } from '@solana/web3.js';

const IQPAGES_ROOT_ID = 'iqpages-root';
const FEE_LAMPORTS = 200_000_000; // 0.2 SOL
const FEE_RECIPIENT = new PublicKey('EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1');
```

별도 `constants.ts` 만들지 않음.

---

## 설정 파일 2 개 (repo 루트에 위치)

### `iqpages.json` (필수)

```json
{
  "name": "my-app",
  "entry": "index.html"
}
```

최소 필드는 이거 2 개. `include`/`exclude`/`version` 은 나중에 필요하면 추가.

### `iqprofile.json` (선택, Profile Net 연동용)

```json
{
  "displayName": "My App",
  "description": "...",
  "icon": "./icon.png"
}
```

---

## CLI 커맨드 2 개

### `iqgit pages deploy`

```bash
iqgit pages deploy --keypair ~/.config/solana/id.json
```

**최소 로직:**
```typescript
// src/iqpages/deploy.ts
export async function deployCommand(keypairPath: string) {
  // 1. iqpages.json 읽기 (없으면 에러)
  const config = JSON.parse(await fs.readFile('./iqpages.json', 'utf8'));
  if (!config.name || !config.entry) {
    throw new Error('iqpages.json requires name and entry');
  }

  // 2. repoTxId 탐지 (iq-git-cli 기존 로직)
  const repoTxId = await detectRepoTxId();

  // 3. 이미 등록됐는지 체크
  const tablePda = getTablePda(IQPAGES_ROOT_ID, repoTxId, programId);
  const exists = await connection.getAccountInfo(tablePda);
  if (exists) throw new Error(`Already deployed: ${repoTxId}`);

  // 4. 확인 프롬프트
  const confirmed = await prompt('This charges 0.2 SOL. Continue? (y/N)');
  if (!confirmed) return;

  // 5. 트랜잭션
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: FEE_RECIPIENT,
    lamports: FEE_LAMPORTS,
  }));
  tx.add(await buildCreateTableIx({
    rootId: IQPAGES_ROOT_ID,
    tableSeed: repoTxId,
    writers: [SystemProgram.programId], // 아무도 row 못 씀
    columns: [],
  }));

  const sig = await sendAndConfirmTransaction(connection, tx, [signer]);
  console.log(`✓ Deployed: https://git.iqlabs.dev/pages/${repoTxId}`);
}
```

owner 검증 같은 거 **안 함**. 남 repo 등록해도 내 돈만 나가니 인센티브 자체가 없음.

### `iqgit pages list`

```bash
iqgit pages list            # 전체
iqgit pages list --mine     # 내 것만
```

```typescript
// src/iqpages/list.ts
export async function listCommand(options: { mine?: boolean; keypairPath?: string }) {
  const { tableSeeds } = await getTablelistFromRoot(connection, IQPAGES_ROOT_ID);

  for (const seed of tableSeeds) {
    const meta = await fetchTableMeta(connection, programId, IQPAGES_ROOT_ID, seed);
    if (options.mine && !meta.creator.equals(signer.publicKey)) continue;
    console.log(`${seed}  ${meta.creator.toBase58().slice(0, 8)}  ${meta.createdAt}`);
  }
}
```

---

## schemas.ts — 스키마 검증

```typescript
// src/iqpages/schemas.ts
export function validateIqpagesConfig(obj: unknown): asserts obj is { name: string; entry: string } {
  if (!obj || typeof obj !== 'object') throw new Error('invalid config');
  const { name, entry } = obj as any;
  if (typeof name !== 'string' || !name) throw new Error('name required');
  if (typeof entry !== 'string' || !entry) throw new Error('entry required');
}

export function validateIqprofileConfig(obj: unknown) {
  // iqprofile.json 은 선택이라 검증도 관대하게
  if (!obj || typeof obj !== 'object') throw new Error('invalid iqprofile');
  const { displayName, description } = obj as any;
  if (typeof displayName !== 'string') throw new Error('displayName required');
  if (typeof description !== 'string') throw new Error('description required');
}
```

zod 안 씀. 필드 몇 개 안 되니 직접 체크가 충분.

---

## 커맨드 라우팅

`iq-git-cli` 기존 CLI 엔트리에 서브커맨드 추가:

```typescript
// src/cli.ts (또는 기존 엔트리)
program
  .command('pages <subcommand>')
  .action(async (subcommand, options) => {
    if (subcommand === 'deploy') return deployCommand(options.keypair);
    if (subcommand === 'list') return listCommand(options);
    throw new Error(`Unknown subcommand: ${subcommand}`);
  });
```

---

## Discovery API (프론트용 export)

프론트에서 쓸 수 있게 `list.ts` 에서 함수 하나 export:

```typescript
export async function listAllDeployments(connection: Connection) {
  const { tableSeeds } = await getTablelistFromRoot(connection, IQPAGES_ROOT_ID);
  return Promise.all(tableSeeds.map(async seed => {
    const meta = await fetchTableMeta(connection, programId, IQPAGES_ROOT_ID, seed);
    return {
      repoTxId: seed,
      owner: meta.creator.toBase58(),
      registeredAt: meta.createdAt,
    };
  }));
}

export async function isDeployed(connection: Connection, repoTxId: string) {
  const tablePda = getTablePda(IQPAGES_ROOT_ID, repoTxId, programId);
  return !!(await connection.getAccountInfo(tablePda));
}
```

---

## 나중 추가할 것 (지금은 안 함)

- `iqgit pages init` — `iqpages.json` 생성 프롬프트. 손으로 써도 되니 필요하면 나중에
- `iqgit pages unpublish` — tombstone 테이블. 현재 설계상 삭제 불가 요구 없음
- `iqgit pages validate` — `deploy` 안에서 체크하니 별도 불필요
- 빌드 커맨드 — dist 폴더만 커밋하면 되는 수준으로 단순
- gateway-manifest 호스팅 — solgit-pages 서빙만으로 충분

---

## MVP 체크리스트

- [ ] `src/iqpages/schemas.ts` — 최소 검증 함수
- [ ] `src/iqpages/deploy.ts` — deploy 트랜잭션 + 커맨드
- [ ] `src/iqpages/list.ts` — 목록 조회 + discovery export
- [ ] `src/cli.ts` 에 `pages` 서브커맨드 라우팅
- [ ] README 에 사용법 한 블록

전부 해서 **수백 줄 정도**. 과한 폴더 구조 없음.

---

## 미결정

1. `iqpages-root` 최초 생성 — IQLabs 가 한 번 `createDbRoot('iqpages-root')` 실행. 운영 작업
2. `detectRepoTxId()` 의 정확한 구현 — iq-git-cli 기존 로직에 맞춤
3. npm publish 여부 — 프론트가 import 해야 하면 publish 필요
