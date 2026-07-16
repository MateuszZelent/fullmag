# MESH-UI-002 — Generated Inspector status contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć rozjazd backend `valid` kontra Inspector `ready` i wszystkie ręczne status stringi.

**Architecture:** Inspectory konsumują generated `PeriodicValidationStatus` z resource hook. Presentation mapping jest wspólny dla authoring i results panels.

**Tech Stack:** TypeScript/React, generated OpenAPI types, Vitest

## Global Constraints

- Nie naprawiać przez lokalną zamianę jednego stringa.
- `valid`, `invalid`, `stale`, `unavailable` mają jawne copy i actions.
- Każdy semantic Explorer node ma własny Inspector detail view.

---

**Finding:** MESH-UI-002, P0.
**Dependency:** MESH-API-001 i 003.

### Task 1: RED real-backend fixtures

- [ ] Zmienić `FrequencyDomainInspectorPanel.test.tsx` fixture z wymyślonego `ready` na generated backend payload `valid`; oba Inspectory mają dziś FAIL.
- [ ] Dodać invalid/stale/unavailable cases oraz accessible status assertions.

### Task 2: shared model

```ts
export function periodicStatusView(status: PeriodicValidationStatus): { tone: "success" | "danger" | "warning" | "neutral"; label: string };
```

- [ ] Dodać wspólny pure model i użyć go w `FrequencyDomainInspectorPanel.tsx` oraz `FrequencyDomainResultInspectors.tsx`.
- [ ] Usunąć ręczne unions/string comparisons; uruchomić focused tests, PASS.

### Task 3: gates

- [ ] Uruchomić `pnpm --dir apps/control-room typecheck`, `lint`, `test`, `check:api-hygiene`.
- [ ] Commit: `git add apps/control-room/src/modules/inspector apps/control-room/src/kernel/api && git commit -m "fix(ui): consume generated periodic validation status"`.

**Exit:** realny backend `valid` renderuje poprawny stan; invalid/stale/unavailable nie są mylone i mają testy.

### Evidence update (2026-07-14, generated aggregate status mapping)

- [x] Added the shared `periodicStatusView` model backed by generated `PeriodicValidationStatus`; `valid`, `invalid`, `stale` and `unavailable` map to distinct presentation tones and labels.
- [x] Both the authoring/frequency inspector and the dedicated periodic-pairs resource inspector now render the aggregate backend status instead of inventing `ready` from resource presence.
- [x] Added model coverage for all four backend statuses plus the missing-status fallback and updated the real-backend Inspector fixture to use `status: "valid"`.
- [ ] Frontend dependencies are absent in this isolated worktree: `pnpm --dir apps/control-room typecheck` fails before compilation with `spawnSync next ENOENT`; Vitest/browser gates remain pending.
