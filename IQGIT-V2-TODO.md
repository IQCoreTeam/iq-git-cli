# IQ Git v2 — Global TODO

전체 v2 전환 진행 상황. 각 repo 의 세부 TODO 는 해당 repo 의 `TODO.md` 참조.

참고 문서:
- 설계: [IQGIT-V2-PLAN.md](./IQGIT-V2-PLAN.md)
- 코드 법칙: [CODE-RULES.md](./CODE-RULES.md)

---

## 관련 repo

| repo | 경로 | 역할 | 상태 |
|---|---|---|---|
| iqlabs-git-sdk | `~/WebstormProjects/iqlabs-git-sdk/` | `@iqlabs/git` npm 패키지 본체 | 스캐폴딩 전 |
| iq-git-cli | `~/WebstormProjects/iq-git-cli/` | 얇은 CLI 래퍼 (본 문서 위치) | v1 원본 보존 |
| iqgit-v1-migrator | `~/WebstormProjects/iqgit-v1-migrator/` | v1→v2 일회성 마이그레이션 도구 | 스캐폴딩 전 |
| on-chaingit-frontend | `~/WebstormProjects/on-chaingit-frontend/` | 웹 프론트 (쓰기 + 갤러리) | v1 동작 중 |
| iqprofilenet | `~/WebstormProjects/iqprofilenet/` | 웹 프론트 (읽기) | v1 동작 중 |

---

## Phase 0 (스킵됨, 커밋/푸시 안 함)

- [x] on-chaingit-frontend 에 iqpages marker snapshot 로직 추가 (로컬 수정만)
- [x] iqprofilenet 에 `readDeploymentRow` + fallback 로직 (로컬 수정만)
- [ ] **커밋/푸시 금지 유지** — v2 완료 시 일괄 정리

---

## Phase 1 — `@iqlabs/git` SDK 구현

repo: `iqlabs-git-sdk`

- [ ] 저장소 초기화 (`git init`, `npm init`, `package.json` 의 `exports` map, tsconfig, rollup/tsup, eslint — 레이어 간 `no-restricted-imports` 규칙 포함)
- [ ] L0 `core/` (types, seed, chunk, codec, errors)
- [ ] L0 `wallet/` (Signer 추상 + keypair-signer + adapter-signer)
- [ ] L1 `chain/` (chain-adapter 인터페이스, iqlabs-sdk 구현, gateway fallback, rate-limit)
- [ ] L2 `storage/BlobStore` (codeIn 업로드 + hash→txId 인덱스 + chunking + retry)
- [ ] L2 `storage/TreeStore` (tree.json 직렬화/파싱/업로드, tree-walker)
- [ ] L3 `model/RepoService` (git_repos_v2_<owner> + git_repos:all)
- [ ] L3 `model/CommitService` (git_commits:<owner>:<repo>, ensureCommitTable, writeRow, getLatest, getHistory)
- [ ] L3 `model/RegistryService` (공개 레포 갤러리 read)
- [ ] L4 `client/GitClient` (commit / clone / log / checkout / status / createRepo / setVisibility)
- [ ] `scripts/bootstrap-registry.ts` — `git_repos:all` createTable 1회 (admin key)
- [ ] vitest 단위 테스트 (core / storage / model) + fake chain adapter
- [ ] README + 세부 `TODO.md`
- [ ] `npm publish` 0.1.0-rc.1

---

## Phase 2 — `iq-git-cli` 를 얇은 래퍼로 교체

repo: `iq-git-cli`

- [ ] 기존 `src/*.ts` 백업 브랜치로 분리
- [ ] `package.json` 에 `@iqlabs/git` 추가, 직접 의존성 (`iqlabs-sdk`, `@solana/web3.js`) 제거
- [ ] `src/bin.ts` + `src/commands/*` 구조 재작성
  - [ ] `init` / `createRepo`
  - [ ] `commit`
  - [ ] `log`
  - [ ] `clone`
  - [ ] `checkout`
  - [ ] `status`
  - [ ] `public-repos` (갤러리 페이지네이션)
  - [ ] `deploy` (iqpages)
- [ ] 기존 `git-service.ts`, `iqpages-service.ts`, `chunk.ts`, `wallet_manager.ts` 삭제
- [ ] `npm link @iqlabs/git` 로 로컬 개발
- [ ] CLI 버전 bump + (선택) publish

---

## Phase 3 — 마이그레이션 (독립 repo)

repo: `iqgit-v1-migrator`

- [ ] 저장소 초기화 + `@iqlabs/git` dependency
- [ ] `src/bin.ts` commander 엔트리 (`migrate` / `verify` / `dry-run`)
- [ ] `src/v1-reader.ts` — 기존 `git_commits_<owner>` 조회
- [ ] `src/migrate.ts` — ensureCommitTable → writeRow × N, parentCommitId 복원, public repo 레지스트리 등록
- [ ] idempotent 재실행 검증
- [ ] `iq-snake` / `poiqemon` 대상 실제 실행 (owner keypair: `~/Desktop/deploy/deploy.json`)
- [ ] `LEGACY_IQPAGES` 상수 확정 (iqpages marker 업데이트 불가한 repo)

---

## Phase 4 — 프론트 재배선

### on-chaingit-frontend

- [ ] `package.json` 에 `@iqlabs/git` 추가
- [ ] `services/git/`, `services/iqpages/` 자체 구현 제거
- [ ] 배포 / 갤러리 / repo 페이지 / 커밋 목록 → `GitClient` 로 재배선
- [ ] `LEGACY_IQPAGES` 필터 적용
- [ ] PR → 배포

### iqprofilenet

- [ ] `package.json` 에 `@iqlabs/git` 추가
- [ ] `src/lib/iqgit/`, `src/lib/iqpages/` 제거
- [ ] `useDeploymentDetails` 를 1-RPC 경로 (`readDeploymentRow`) 로 정리
- [ ] `LEGACY_IQPAGES` 필터 적용
- [ ] Phase 0 의 로컬 수정 (`lib/iqpages/iqpages-service.ts`, `lib/iqpages/use-iqpages-data.ts`) 정리
- [ ] PR → 배포

---

## Phase 5 — 정리

- [ ] v1 코드 경로 완전 삭제 (SDK / 프론트 둘 다)
- [ ] `@iqlabs/git` 0.1.0 정식 릴리스 태그
- [ ] README / IQPAGES-PLAN / 본 문서 갱신
- [ ] 각 repo README 에서 의존 관계 / 릴리스 순서 명시
- [ ] 새 deploy 가 v2 경로만 쓰는지 E2E 확인
- [ ] 같은 패턴으로 `@iqlabs/iqpages`, `@iqlabs/chat` 등 분리 계획 검토 (별도 문서)

---

## 릴리스 순서 (반드시 이 순서)

1. `iqlabs-git-sdk` publish (0.1.0-rc.1 → 0.1.0)
2. `iq-git-cli` bump (새 SDK 버전 참조)
3. `iqgit-v1-migrator` 실행 (데이터 이관)
4. 프론트 2 곳 PR / 배포
5. 정리 & cleanup
