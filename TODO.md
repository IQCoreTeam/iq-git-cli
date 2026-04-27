# iq-git-cli — TODO

글로벌 투두: [./IQGIT-V2-TODO.md](./IQGIT-V2-TODO.md)

---

## 현재 상태

v1 원본 유지 중 (`src/git-service.ts`, `src/iqpages-service.ts`, `src/chunk.ts`, `src/wallet_manager.ts`). v2 전환은 `@iqlabs/git` SDK publish 이후 진행.

## Phase 2 — 얇은 래퍼로 교체

선행: `@iqlabs/git` 0.1.0-rc.1 publish 또는 `npm link` 상태여야 함.

- [ ] 기존 `src/` 를 `legacy-backup` 브랜치에 보존
- [ ] `package.json`
  - [ ] `dependencies` 에 `@iqlabs/git` 추가
  - [ ] 직접 의존성 제거: `iqlabs-sdk`, `@solana/web3.js` (SDK 의 peer 로 흡수)
  - [ ] `commander`, `kleur`, `prompts` 등 UI 의존성 유지/추가
  - [ ] `bin: { "iq-git": "./dist/bin.js" }`
- [ ] `src/bin.ts` — commander 엔트리
- [ ] `src/config.ts` — `~/.iq-git/config`, keypair 경로 로딩
- [ ] `src/commands/` 로 커맨드 분리:
  - [ ] `init.ts` — `GitClient.createRepo(name, { isPublic })`
  - [ ] `commit.ts`
  - [ ] `log.ts`
  - [ ] `clone.ts`
  - [ ] `checkout.ts`
  - [ ] `status.ts`
  - [ ] `public-repos.ts` — `git_repos:all` 페이지네이션
  - [ ] `deploy.ts` — iqpages 배포 (v2 경로)
- [ ] 기존 v1 로직 파일 전부 삭제
  - [ ] `src/git-service.ts`
  - [ ] `src/iqpages-service.ts`
  - [ ] `src/chunk.ts`
  - [ ] `src/wallet_manager.ts`
  - [ ] `src/types.ts` (SDK 에서 import 로 대체)
- [ ] 각 커맨드는 **SDK 메서드 호출 + UX 만** 담당. 체인 액세스 직접 작성 금지 (`CODE-RULES.md` 위반)
- [ ] README 갱신 (의존·사용법)
- [ ] CLI 버전 bump + (선택) publish

## Phase 0 산출물 정리

- [ ] 현재 로컬에 남아있는 Phase 0 관련 수정사항 정리 (본 repo 에는 해당 없음. 정리 대상은 `on-chaingit-frontend` / `iqprofilenet` 쪽)

## 참고

- `IQGIT-V2-PLAN.md`, `IQGIT-V2-TODO.md`, `CODE-RULES.md` 는 이 repo 를 공용 문서 저장소로 겸함. 위치 이동 시 다른 repo 의 링크도 업데이트 필요.
