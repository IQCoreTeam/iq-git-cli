# IQ Pages — Minimal Implementation Plan

IQ GitHub repo 를 "공식 배포된 앱" 으로 선언하는 최소 기능.

**프론트엔드 변경**: [../on-chaingit-frontend/IQPAGES-PLAN.md](../on-chaingit-frontend/IQPAGES-PLAN.md)

---

## 레포 성격

**`iq-git-cli` 는 이름과 달리 라이브러리** — `@iqlabs-official/git` 으로 퍼블리시. CLI 바이너리 없음.

IQ Pages 는 이 라이브러리에 **`IqpagesService` 클래스** 로 추가. 사용 주체:
- 프론트 (on-chaingit-frontend) — 배포 UI + 갤러리
- 향후 Node 스크립트 — 자동화/배치 배포 (필요하면)

---

## 원칙

- 새 파일 **1 개** (`iqpages-service.ts`) + `types.ts`/`index.ts` 에 몇 줄 추가
- **Node fs 사용 안 함**. 서비스는 순수 온체인만 다룸
- 설정 파일 (`iqpages.json`, `iqprofile.json`) 은 **온체인 repo 에서 읽음** — 로컬 파일 시스템 개념 없음

## 정적 전용인 이유 (중요)

IQ Pages 는 MVP 에서 **정적 파일 서빙만 지원**. install/build/start 같은 실행 개념 **없음**.

이유:
- **Gateway 서버 보안이 아직 샌드박싱/빌드러너 운영 수준으로 설계되지 않음**. 현 단계에서 `npm install` 이나 임의 빌드 커맨드를 Gateway 프로세스에서 돌리면 공급망 공격·임의 코드 실행에 노출됨
- Gateway 가 빌드러너를 하게 되면 그 자체가 별도 운영 프로젝트 (IQ Build 수준) 로 커짐 — IQ Pages MVP 범위 밖
- 정적 전용이면 Gateway 는 bytes 를 HTTP 로 전달만 하므로 공격 표면이 최소. 악성 스크립트를 repo 에 넣어도 Gateway 는 실행하지 않음 (방문자 쪽 피해는 DYOR 로 대응)

**즉, "정적 전용" 은 단순함 때문이 아니라 Gateway 보안 강화 전까지의 의식적 제한.** 빌드러너는 향후 별도 이슈로.

iqbrowser 와의 필드 공유:
- `name`, `version`, `description` — iqbrowser.json 컨벤션 따름
- `runtime`, `install`, `start` — 실행 개념이라 IQ Pages 에는 생략
- `entry` — 정적 사이트 엔트리 파일 (IQ Pages 고유)

---

## 동작 방식

```
사용자 로컬
  └─ iqpages.json 작성 → git commit (IQ GitHub 프론트의 업로드 UI 로)
                           ↓
                      온체인 repo 에 파일 존재

프론트 배포 버튼
  └─ IqpagesService.readConfig(repoTxId) 로 온체인 조회
      └─ 없음 → 프론트가 에디터 페이지로 유도 (모달 + 버튼)
      └─ 있음 → 검증 통과 시 deploy() 호출
          ↓
      트랜잭션: 0.2 SOL 결제 + createTable(iqpages-root, repoTxId, writers 락)
```

**중복 방지**: tableSeed = repoTxId → PDA 충돌로 두 번째 시도 자동 실패.

**Discovery**: `getTablelistFromRoot('iqpages-root')` 로 전체 목록.

**메타**: 전부 repo 의 `iqpages.json` / `iqprofile.json` 에서 fetch. 레지스트리엔 정보 없음.

---

## 파일 변경 (옵션 C)

```
src/
├── types.ts              # + IqpagesConfig, IqprofileConfig, IQPAGES_CONSTANTS, 템플릿 상수
├── iqpages-service.ts    # 신규 — IqpagesService + 검증 함수
├── index.ts              # export 추가
│
├── git-service.ts        # 건드리지 않음
├── wallet_manager.ts
└── chunk.ts
```

---

## types.ts 에 추가

```typescript
// 기존 타입들 아래에 덧붙임

export interface IqpagesConfig {
  name: string;
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
  ROOT_ID: 'iqpages-root',
  FEE_LAMPORTS: 200_000_000, // 0.2 SOL
  FEE_RECIPIENT: 'EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1',
} as const;

// 프론트 에디터 prefill 용 템플릿
export const IQPAGES_TEMPLATE = `{
  "name": "my-app",
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
```

---

## iqpages-service.ts 설계

### 생성자

기존 `GitChainService` 와 동일한 wallet-adapter 패턴:

```typescript
interface WalletLike {
  publicKey: PublicKey | null;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
}

export class IqpagesService {
  readonly connection: Connection;
  readonly wallet: WalletLike;
  readonly programId: PublicKey;

  constructor(connection: Connection, wallet: WalletLike) {
    this.connection = connection;
    this.wallet = wallet;
    this.programId = new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID);
  }
}
```

브라우저 (wallet-adapter) / Node (Keypair 래핑) 모두 동일 인터페이스로 동작.

### 메서드

**읽기 (signer 불필요 — publicKey null 이어도 OK):**

- `readConfig(repoTxId: string): Promise<IqpagesConfig | null>` — 온체인 repo 에서 `iqpages.json` 조회. 없거나 파싱 실패 시 null.
- `readProfile(repoTxId: string): Promise<IqprofileConfig | null>` — `iqprofile.json` 조회.
- `isDeployed(repoTxId: string): Promise<boolean>` — 테이블 PDA 존재 여부.
- `listAll(): Promise<string[]>` — 배포된 repoTxId 배열 (레지스트리 엔트리에는 오직 repoTxId 만 있음).

**없음 — 설계 의도적으로 제거:**
- `listMine()` — 레지스트리에 owner 저장 안 함. 프론트에서 `listRepos(myWallet)` 루프 + `isDeployed` 로 해결.

**쓰기 (signer 필요):**

- `deploy({ repoTxId }): Promise<string>` — 내부에서 `readConfig` 재사용하여 검증 후 트랜잭션 실행. 반환: 트랜잭션 서명.

### deploy 내부 플로우

순차 실행 (SDK `createTable` 이 내부에서 sendTx 를 마감하므로 원자 트랜잭션 불가).

```typescript
async deploy(opts: { repoTxId: string }): Promise<string> {
  // 1. 온체인 config 읽기 + 검증
  const config = await this.readConfig(opts.repoTxId);
  if (!config) throw new Error('iqpages.json missing in repo');
  validateIqpagesConfig(config);

  const profile = await this.readProfile(opts.repoTxId);
  if (profile) validateIqprofileConfig(profile);

  // 2. 중복 체크 (수수료 내기 전에)
  if (await this.isDeployed(opts.repoTxId)) {
    throw new Error(`already deployed: ${opts.repoTxId}`);
  }

  // 3. 수수료 transfer
  await sendAndConfirmTransaction(
    this.connection,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: this.signer.publicKey,
      toPubkey: new PublicKey(IQPAGES_CONSTANTS.FEE_RECIPIENT),
      lamports: IQPAGES_CONSTANTS.FEE_LAMPORTS,
    })),
    [this.signer],
  );

  // 4. 테이블 생성 (writers 락 → 아무도 row 못 씀, 마커 역할)
  const sig = await iqlabs.writer.createTable(
    this.connection,
    this.signer,
    IQPAGES_CONSTANTS.ROOT_ID,
    opts.repoTxId,        // tableSeed
    'iqpages',            // tableName
    [],                   // columns (빈 테이블)
    '',                   // idCol
    [],                   // extKeys
    undefined,            // gate
    [SystemProgram.programId],  // writers — 아무도 못 씀
  );
  return sig;
}
```

**트레이드오프**: 3단계 (수수료) 성공 후 4단계 (테이블) 실패 시 0.2 SOL 손실. 그러나:
- 주된 실패 원인 = 중복 배포 → 2단계에서 이미 걸러냄
- 그 외 네트워크/RPC 일시 오류는 드물고, 재시도로 복구 가능

### 검증 함수 (같은 파일에 두되 export)

프론트 에디터에서도 실시간 검증에 쓸 수 있게 export:

```typescript
export function validateIqpagesConfig(obj: unknown): asserts obj is IqpagesConfig {
  if (!obj || typeof obj !== 'object') throw new Error('invalid iqpages.json');
  const { name, entry } = obj as any;
  if (typeof name !== 'string' || !name) throw new Error('iqpages.json: name required');
  if (typeof entry !== 'string' || !entry) throw new Error('iqpages.json: entry required');
}

export function validateIqprofileConfig(obj: unknown): asserts obj is IqprofileConfig {
  if (!obj || typeof obj !== 'object') throw new Error('invalid iqprofile.json');
  const { displayName, description } = obj as any;
  if (typeof displayName !== 'string') throw new Error('iqprofile.json: displayName required');
  if (typeof description !== 'string') throw new Error('iqprofile.json: description required');
}
```

---

## index.ts 변경

```typescript
// 기존 export 유지 + 아래 추가
export { IqpagesService, validateIqpagesConfig, validateIqprofileConfig } from './iqpages-service.js';
export {
  type IqpagesConfig,
  type IqprofileConfig,
  IQPAGES_CONSTANTS,
  IQPAGES_TEMPLATE,
  IQPROFILE_TEMPLATE,
} from './types.js';
```

---

## 설정 파일 (사용자가 repo 에 커밋)

### `iqpages.json` (필수)

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "description": "Short description",
  "entry": "index.html"
}
```

### `iqprofile.json` (선택)

```json
{
  "displayName": "My App",
  "description": "Short description",
  "icon": "./icon.png"
}
```

---

## 사용 예시 (프론트)

```typescript
import {
  IqpagesService,
  validateIqpagesConfig,
  IQPAGES_TEMPLATE,
} from '@iqlabs-official/git';

const svc = new IqpagesService(connection, wallet);

// repo 선택 시점에 미리 체크
const config = await svc.readConfig(repoTxId);
if (!config) {
  // 모달 → 에디터 유도
}

// 배포 시점
const sig = await svc.deploy({ repoTxId });
```

---

## 나중 추가 (지금 안 함)

- `unpublish()` — tombstone 테이블
- Gateway 호스팅 타입
- 빌드 커맨드
- 별도 CLI 바이너리

---

## MVP 체크리스트

- [ ] `src/types.ts` — 타입·상수·템플릿 추가
- [ ] `src/iqpages-service.ts` — IqpagesService + 검증 함수
- [ ] `src/index.ts` — export 추가
- [ ] README 에 IQ Pages 섹션

---

## 미결정

1. **`iqpages-root` 최초 생성** — IQLabs 가 한 번 `createDbRoot('iqpages-root')` 운영 작업
2. **`readConfig` 구현** — 온체인 repo 에서 파일 읽는 방식 확정 (`GitService.checkout` 패턴 재사용 또는 직접 readCodeIn)
3. **타임스탬프/정렬** — `getTablelistFromRoot` 은 timestamp 를 안 돌려줌. 갤러리 카드에서는 일단 "repo 의 최신 커밋 시간" 으로 대체. 실제 배포 시점이 필요해지면 추후 `getSignaturesForAddress(tablePda)` 로 RPC 조회 추가
