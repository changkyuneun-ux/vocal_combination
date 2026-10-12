# 작업 스크립트 (2026-10-12 구조 개편·명칭 변경)

재사용 시 참고용으로 보관한다. 모두 일회성 작업에 쓴 스크립트이며, 실행 전 경로·커밋 해시를 현재 상황에 맞게 고쳐야 한다.

| 파일 | 용도 | 사용 커밋 |
| --- | --- | --- |
| `fixrefs.py` | 폴더 재배치 후 현행 문서 속 이전 경로 참조를 git rename 기록 기준으로 일괄 치환, `dobedopop` 표기 치환 | `15e8323` |
| `regen.ts` | digest 접두어·문서 키 변경 후 MDRL 엔진으로 적합성 digest(facts 문서·투영, 할당·역분개 결과)를 재계산하고 옛 hex→새 hex를 코드 트리에 반영 | `615c2e9` |
| `docs.py` | 현행 문서의 VCRL→MDRL, dobedupop/dobedopop→dobedubpop 치환과 예시 digest 갱신 | `01bef8e` |

실행 예: `node regen.ts "<저장소>/04_구현_소스코드"`, `python3 -I fixrefs.py "<저장소>" --apply`
