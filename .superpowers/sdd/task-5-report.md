# Task 5 report — backoffice skeleton

## Files
- 03_구현문서_코드/package.json (workspaces + dev script), package-lock.json
- 03_구현문서_코드/backoffice/{package.json,.gitignore,tsconfig.json,vite.config.ts,index.html}
- backoffice/src/{main.tsx,styles.css,format.ts,format.test.ts}
- backoffice/src/app/{App,Layout,Header,routes}.tsx, actor.ts, queryClient.ts
- backoffice/src/api/{client.ts,client.test.ts,types.ts,hooks.ts,invariants.ts,invariants.test.ts}
- backoffice/src/components/{DataTable,Pager,Form,ErrorPanel,StatusBadge,Money,Digest,Instant,Section}.tsx
- backoffice/src/pages/dashboard/Dashboard.tsx
- .claude/launch.json (git root)

## Versions installed
- react 19.3.0
- react-dom 19.3.0
- react-router 7.18.4
- @tanstack/react-query 5.104.0
- vite 7.3.6
- vitest 3.2.7
- typescript 5.9.3
- @playwright/test 1.63.0
- @vitejs/plugin-react 5.2.0

## Commands
- TDD red: npm test -w backoffice before implementation -> 3 files failed (no modules)
- npm test -w backoffice -> 3 files, 11 tests passed
- npm run typecheck -w backoffice -> clean
- npm run build -w backoffice -> built (tsc + vite build)
- npm test -w rights-core -> 292 pass, 0 fail
- Dev servers started, proxy checked, then both stopped (ports 8080/5173 verified free).

## curl
- localhost:5173/api/dev/clock -> {"now":"2026-01-01T00:21:10.051Z","realNow":"2026-10-01T04:03:28.888Z","headroomMs":23600538837}
- localhost:5173/api/users (usr_editor) -> 10 items (3 sys_* + 7 dev users), next null
- /api/settlement/invariants (usr_settle) -> all-OK report matching the InvariantReport type used in src/api/invariants.ts

## Deviations / notes
- api() takes a 4th arg opts {actorOverride, fetchImpl}; devApi takes {fetchImpl} (fetch injection for tests).
- invariants: unpostedConfirmedRuns is not counted as a violation (code comment says it is reported separately, post-batch wait).
- tsconfig sets allowImportingTsExtensions (imports use .ts/.tsx like rights-core style).
- vite.config.ts imports defineConfig from vitest/config to hold the test block; test environment node.
- Header clock/badge not browser-verified by me (controller does that); only proxy and unit level.
- Playwright installed as devDependency only; browsers not installed. tsconfig include lists e2e dir (does not exist yet).
- npm warned about install-scripts (informational).

## Fix round 1
- actor.ts: in-memory current value + listener set + subscribe + useActor (useSyncExternalStore); setActor updates memory, tries localStorage, notifies, invalidates. api() still calls currentActor() (same memory value). Header/useList/useGet/useAction use useActor() in keys. Added actor.test.ts (default, notify, throwing localStorage).
- Header: removed run(never) casts; separate doAdvance/doSet handlers; clock buttons disabled while pending; violation popover closes on outside mousedown.
- format.ts: added non-throwing safeKrw (raw string on non-integer input incl. "" and "1.5"); Money uses it; test added. formatKrw stays strict.
- Result: 4 files, 15 tests pass; typecheck clean; build ok.
