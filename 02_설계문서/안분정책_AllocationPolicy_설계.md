# 권리자 풀 내부 안분 (AllocationPolicy) 설계

상태: 설계 확정 (구현 전)
상위: `라이선스_정산_모니터링_백오피스_개념설계.md`

권리자 풀(예: 순매출의 70%)을 레이블·멤버·신탁 등 청구자에게 나누는 규칙.
스템 배정 시간, 빌더 멤버 %, 사전 계약 지분을 **단독 선택하거나 믹스**한다.

## 1. 확정 기본값

신규 IP·1차 소장에 적용하는 템플릿 ID: `VC-ALLOC-DEFAULT-V1`.

| 항목 | 값 | 이유 |
| --- | --- | --- |
| 모드 | `MIX` / `LAYERED` | 계약(누구 몫)과 사용(어떻게 나눔)을 한 공식에 섞지 않는다 |
| 1층 | `CONTRACT` 버킷 | 레이블·실연자 풀·신탁을 먼저 확정 |
| 2층 (실연자 풀) | `MEMBER_PCT` | 상품 정의·발행 검증(90%/10%)·팬 고지가 같은 숫자 |
| 스템 시간 메트릭 | `ASSIGNED_DURATION` | 발행된 타임라인 구간 초. 구매 후 청취 길이는 쓰지 않음 |
| 잠금 스템 | 권리 대상이면 시간 합에 포함 | 강제 배정 구간에도 실연이 있으면 몫이 있다 |
| 청구자 커버 | `requireAllClaimantsCovered = true` | 사용량 단독으로 레이블·신탁이 0이 되면 활성화 거부 |
| 반올림 | KRW 정수, 잔여는 최대 지분 파티, 동률은 `partyId` 오름차순 | 라인 합 = 권리자 풀 |
| 2차 재판매 | 1차 정책 복사 후 별도 버전 | 안분 레시피와 플랫폼 수수료(`SettlementRule`)를 분리 |

2층을 스템 시간으로 바꾸거나, 실연자 풀 안에서 시간+멤버% 가중 믹스를 쓰는 것은 **허용된 오버라이드**다. 기본값만 멤버 %다.

## 2. 베이스

세 베이스는 모두 **청구자 집합 위의 비중 벡터**를 만든다. 합은 1이다. 해당 베이스가 모르는 파티는 0이다.

### 2.1 `STEM_TIME`

```
partyShare[p] = sum(durationSec of stems mapped to p, rights-bearing, include locked if flag)
                / sum(all included stems)
```

- `durationSec`: 조합 타임라인에서 그 스템이 **배정된 구간 길이**. 청취 플레이헤드가 아니다.
- 스템→파티 맵이 없거나 풀 밖 파티면 해당 스템은 분모에서 빼고 로그를 남긴다.
- 분모 0이면 평가 실패 → 해당 이벤트 홀드.

### 2.2 `MEMBER_PCT`

```
partyShare[p] = builderPercent[p] / 100
```

- 값은 발행 검증을 통과한 빌더 스냅샷과 **동일**해야 한다. 합 100%가 아니면 발행 자체가 거부되므로 정산 단계에 103%는 들어오지 않는다.
- 실연자가 아닌 청구자(레이블, 신탁)는 0.

### 2.3 `CONTRACT`

```
entry = { target: Party | ShareBucket, pct }
sum(pct) = 100
```

- `Party` 엔트리는 그 파티에 바로 귀속.
- `ShareBucket` (`kind=POOL`)은 2층에서 다시 나눈다.
- 버킷 멤버 목록은 정책에 명시한다. 빌더에 나타난 멤버가 풀 밖이면 기본은 발행 거부(커버리지).

## 3. 믹스

### 3.1 `LAYERED` (기본)

1. 1층 `CONTRACT`로 각 Party 금액과 각 POOL 금액을 확정한다.
2. POOL마다 `layers[1].base`로 풀 멤버에게만 재안분한다.
   - 기본 베이스: `MEMBER_PCT`
   - 오버라이드: `STEM_TIME` 또는 `WEIGHTED` `{ memberPct, stemTime }` (둘 합 100, 계약 가중치 없음)
3. POOL에 속하지 않은 파티는 1층 금액이 최종이다.

### 3.2 `WEIGHTED`

```
final[p] = wT * STEM_TIME[p] + wM * MEMBER_PCT[p] + wC * CONTRACT[p]
wT + wM + wC = 1, 각 wi >= 0
```

CONTRACT가 버킷을 포함하면, 가중 믹스 전에 버킷을 멤버에게 **균등 또는 명시된 내부 지분**으로 펼친 벡터를 쓴다. 기본 템플릿은 가중 믹스를 쓰지 않는다. 펼침 기본은 버킷 내부 `MEMBER_PCT` 재정규화.

### 3.3 `SINGLE`

`singleBase` 하나만 사용. `requireAllClaimantsCovered`가 true인데 0인 청구자가 있으면 활성화·평가 모두 거부.

## 4. 데이터 모델

### Party

- `partyId`, `type`: `LABEL | MEMBER | ARTIST | PUBLISHER | CMO | PLATFORM`
- 지급 계좌는 정산 지급 모듈. 안분 엔진은 `partyId`만 본다.
- `PLATFORM`과 팬 인센티브는 이 엔진 밖(3풀 단계)이다.

### Claimant

- `grantId`, `partyId`, `role`: `LABEL_SHARE | PERFORMER | WORK_RIGHT`
- 커버리지 검사 대상.

### ShareBucket

- `bucketId`, `kind`: `PARTY` (사실상 단건) | `POOL`
- `memberPartyIds[]` (POOL일 때)
- `pct` (1층 계약 비중)

### AllocationPolicy

- `policyId`, `version`, `ipId`, `eventType`: `PRIMARY | RESALE`
- `status`: `DRAFT | ACTIVE | SUPERSEDED`
- `mode`: `SINGLE | MIX`
- `singleBase?`: `STEM_TIME | MEMBER_PCT | CONTRACT`
- `mix?`: `{ kind: LAYERED | WEIGHTED, weights?, layers? }`
- `stemTime`: `{ metric: ASSIGNED_DURATION, includeLockedIfRightsBearing: true }`
- `guards`: `{ requireAllClaimantsCovered: true, renormalizePool: false }`
- `rounding`: `{ unit: KRW, remainder: LARGEST_SHARE }`
- `effectiveFrom`
- ACTIVE는 `(ipId, eventType)`당 하나. 새 활성화는 이전 버전을 SUPERSEDED.

### BasisSnapshot (발행 시 VC에 부착, 불변)

- `policyId`, `policyVersion`
- `recipeJson` (당시 정책 본문 전체)
- `memberPercents[{ partyId, pct }]`
- `stemAssignments[{ stemId, partyId, durationSec, locked, rightsBearing }]`
- `contractShares` / `buckets` 복사본
- `claimantPartyIds[]`

정산은 **현재 ACTIVE 정책이 아니라 이 스냅샷**만 읽는다. 정책 변경은 이후 발행분에만 적용. 과거 거래를 고치려면 보정 이벤트를 원장에 추가한다.

### AllocationLine (원장)

- `eventId`, `vcId`, `partyId`, `amountKrw`, `share`, `baseBreakdown` (각 베이스 기여, 감사)
- 환불은 동일 키 음수 라인.

## 5. 평가 알고리즘

입력: 순매출 중 권리자 풀 금액 `R`, `BasisSnapshot`.

1. 스냅샷이 없거나 `recipeJson`이 깨지면 이벤트를 배치에서 제외하고 알림.
2. 세 베이스 벡터를 청구자 집합 위에 계산. 멤버% 합이 1이 아니면 데이터 오류(발행 버그) → 홀드.
3. 모드에 따라 최종 비중 `s[p]` 산출 (3절).
4. `guards.requireAllClaimantsCovered`이고 `s[p]=0`인 청구자가 있으면 홀드.
5. `POOL` 합이 0이 되어 1층 금액을 놓을 곳이 없으면 그 버킷만 홀드.
6. `amount[p] = floor(R * s[p])` 후 `R - sum(amount)`를 최대 `s[p]` 파티에 +1원씩.
7. `sum(amount) == R` 검증. 실패 시 배치 중단.
8. `AllocationLine` append. `baseBreakdown`에 세 베이스와 가중/계층 경로를 남긴다.

포인트·크레딧 보상은 이 알고리즘에 넣지 않는다.

## 6. 운영 화면 (SPACE)

직무 분리: 정책 편집자 ≠ 배치 확정자. 활성화는 편집자와 다른 계정.

1. **청구자·버킷** — 그랜트 청구자를 PARTY 지분 또는 POOL에 배치. 합 100% 전에는 다음 단계 잠금.
2. **레시피** — 단독 / 계층 / 가중. 계층 2층 기본 `MEMBER_PCT`. 스템 시간 또는 시간+멤버 가중은 명시적 오버라이드.
3. **시뮬** — 최근 발행 N건의 스냅샷에 초안 레시피를 적용해 금액 미리보기. 활성화 전 필수.
4. **활성화** — 기존 ACTIVE는 SUPERSEDED. 이미 발행된 VC는 영향 없음.
5. **버전 비교** — 레시피 diff + 샘플 VC 금액 diff.

레이블 포털은 자기 IP 정책 **조회·변경 요청**만. 활성화는 SPACE.

아티스트 포털은 본인 `AllocationLine`과 스냅샷 멤버%·배정 초만.

## 7. 예외

| 상황 | 처리 |
| --- | --- |
| 빌더 멤버가 실연자 풀 밖 | 기본 발행 거부. 예외 플래그가 있는 캠페인만 그 멤버 사용량 0으로 허용 |
| 실연자 풀 전원 0% | 버킷 홀드 |
| 스템 파티가 풀 밖 | 그 스템을 시간 분모에서 제외, 감사 로그 |
| 가중치/계약 합 ≠ 100 | 초안 저장 가능, 활성화 거부 |
| 월중 정책 교체 | 이전 발행분 스냅샷 유지 |
| 환불 | 원 라인 역분개 |
| 정책 미설정 IP | 이벤트 적재, 배치 제외 (기존 D12와 동일) |

## 8. 기본 템플릿 예시

1차 소장, 권리자 풀 `R = ₩3,430`.

계약 버킷: 레이블 40 / 실연자 풀 50 / 신탁 10.  
실연자 풀 멤버 %: 뷔 30, 정국 30, 제이홉 25, 슈가 15.

비중 `s`: 레이블 0.40, 신탁 0.10, 뷔 0.15, 정국 0.15, 제이홉 0.125, 슈가 0.075.

| 파티 | `floor(R * s)` | 잔여 배분 | 확정 |
| --- | --- | --- | --- |
| 레이블 | 1,372 | +1 (최대 지분) | ₩1,373 |
| 신탁 | 343 | | ₩343 |
| 뷔 | 514 | +1 (다음 동률, partyId 우선 가정) | ₩515 |
| 정국 | 514 | | ₩514 |
| 제이홉 | 428 | | ₩428 |
| 슈가 | 257 | | ₩257 |
| 합 | 3,428 | +2 | ₩3,430 |

잔여 2원은 지분 내림차순으로 1원씩. 동률은 `partyId` 오름차순. 위 표의 뷔/정국 순서는 예시 ID 순서다.

## 9. 구현 범위 밖

- 세금·원천징수
- 신탁 파일 포맷 매핑 (라인만 제공)
- 청취 기반 스트리밍 로열티 (`ASSIGNED_DURATION`만)
- 팬 인센티브 풀 내부 안분
