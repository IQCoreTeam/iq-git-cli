# IQ Labs — Code Rules (공용)

IQ Labs 모든 레포 (SDK, CLI, 프론트, 마이그레이터 등) 에 공통 적용되는 규칙.

---

## 1. 의미 없는 래퍼 금지

입력/출력이 원본 함수와 동일한 래퍼 함수를 만들지 마세요. 그냥 원본을 부르면 됩니다.

```ts
// ❌ 의미 없음
async function getAccount(pubkey: PublicKey) {
  return await connection.getAccountInfo(pubkey);
}

// ✅ 원본을 바로 씀
const info = await connection.getAccountInfo(pubkey);
```

래퍼를 만들 수 있는 경우는 **실제로 동작이 추가되거나, 타입 축소, 에러 변환, 캐싱, 표준화된 기본값** 같이 **가치 있는 한 겹** 이 붙을 때만.

## 2. 같은 목적 함수 중복 금지 (전역 스캔 후 작성)

기능을 추가하기 전에 **코드베이스 전체를 훑어 기존 함수를 재사용할 수 있는지 확인** 하세요. 코드베이스 어디에도 같은 목적의 함수가 두 개 이상 존재해선 안 됩니다.

- 새 기능이 필요하면: 먼저 `grep` / IDE 검색으로 "이미 같은 일을 하는 함수가 있는가" 확인
- 비슷한데 미묘하게 다르면: **기존 함수를 일반화** 해서 합치세요. 옆에 새로 만들지 마세요
- 중복 발견 시 한 쪽 삭제. 이름이 다르거나 도메인이 조금 다르다는 이유로 두 개 유지하지 마세요

## 3. 1회용 타입 변수 금지 (가능하면 inline)

**재사용되지 않을 타입 별칭 / 인터페이스** 는 만들지 말고 사용처에 inline 하세요.

```ts
// ❌ 한 번만 쓰이는 타입 별칭
type CommitRow = { id: string; treeTxId: string; timestamp: number };
function writeCommit(row: CommitRow) { ... }

// ✅ inline
function writeCommit(row: { id: string; treeTxId: string; timestamp: number }) { ... }
```

재사용이 **2곳 이상** 생기는 순간 그때 추출.

## 4. 불필요한 파라미터 금지

정말 필요한 파라미터만 정의하세요.

- "나중에 쓸 수도 있다" 는 이유로 파라미터를 만들지 마세요
- 기본값을 줘서 대부분 생략되는 파라미터는 **시그니처에서 제거** 하는 것이 맞을 수도
- 함수 내부에서 실제로 쓰이지 않는 파라미터 → 즉시 삭제

## 5. 책임 분리 명확히. 아니면 말해주세요

각 모듈·함수의 책임을 명확하게 유지하세요. 한 함수가 여러 층의 일을 섞어서 하고 있다면 쪼개세요.

- 설계나 접근 방식이 이상하게 느껴지면 **침묵하지 말고 즉시 문제제기**
- 우회해서 땜빵하지 말고, 원인을 근본에서 짚으세요
- 레이어가 섞였거나 (예: UI 코드 안에서 체인 호출) 흐름이 꼬였다면 리팩토링 제안

## 6. try-catch 로 에러 메시지 숨기지 마세요

에러를 조용히 삼키려는 용도로 `try/catch` 를 남발하지 마세요.

```ts
// ❌ 에러가 어디서 났는지 영영 모름
try {
  await doSomething();
} catch {
  return null;
}

// ✅ 특정 에러만 의미 있게 복구하고 나머지는 throw
try {
  return await readCodeIn(sig);
} catch (err) {
  if (err instanceof Error && err.message.includes("instruction not found")) {
    return null;  // 이 케이스는 "없음" 으로 취급해도 되는 명시적 처리
  }
  throw err;       // 나머지는 그대로 던져야 디버깅 가능
}
```

catch 를 쓸 거면:
- **어떤 에러 타입·메시지** 에 대해 어떤 복구를 하는지 명시적으로 분기
- 나머지는 **재throw** 해서 상위에서 처리할 수 있게
- 개발 중 `console.warn` / `console.error` 라도 남겨서 원인 추적 가능하게 (프로덕션 전에 적절히 정리)
- catch 블록 안을 **`{}` 빈 블록 or `return null`** 로 두는 건 거의 항상 버그의 원천

---

## 참고

- 리뷰 중 이 규칙과 충돌하는 코드를 발견하면 PR 에서 지적 / 수정
- 규칙에 예외가 필요하다면 **해당 지점에 짧은 주석** 으로 이유 명기 (예: `// 경계: SDK 내부 에러는 의미 있는 메시지 없어 조용히 스킵`)
- 규칙 자체를 바꾸고 싶으면 이 문서를 수정하는 PR 로
