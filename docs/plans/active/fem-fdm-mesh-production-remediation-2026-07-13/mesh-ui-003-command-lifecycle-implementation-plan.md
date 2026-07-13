# MESH-UI-003 — Mesh command terminal lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raportować `completed` dopiero po terminalnym command resource i materializacji nowej mesh revision.

**Architecture:** Submit zwraca `accepted` z command ID. Command controller obserwuje resource/event, a sukces wiąże z expected mesh generation; porażka i cancellation są terminalne.

**Tech Stack:** Rust API/orchestrator, TypeScript command registry/resources

## Global Constraints

- Notification nie może ogłaszać sukcesu po samym HTTP 202.
- HTTP snapshot jest źródłem finalnego statusu.
- Command ID i mesh revision są odrębnymi identities.

---

**Finding:** MESH-UI-003, P1.

### Task 1: RED lifecycle tests

- [ ] Dodać UI tests accepted->running->completed, accepted->failed i accepted->completed bez new mesh revision; ostatni nie może być sukcesem.
- [ ] Dodać API/orchestrator fixture terminal status z output resource revision.

### Task 2: await terminal resource

```ts
type MeshCommandResult = { status: "accepted" | "completed" | "failed"; commandId: string; meshRevision?: string };
```

- [ ] `geometryLifecycleCommandContributions.ts` zwraca accepted po submit i deleguje finalizację do central command diagnostics/resource observer.
- [ ] Backend publikuje output mesh revision dopiero po atomic commit; uruchomić API/UI tests, PASS.

### Task 3: gates

- [ ] Uruchomić Control Room typecheck/lint/test i resource-first strict gate.
- [ ] Commit: `git add crates/fullmag-api crates/fullmag-cli apps/control-room/src/kernel && git commit -m "fix(ui): await terminal mesh command resources"`.

**Exit:** brak ścieżki `accepted -> completed` bez terminalnego backend statusu i current mesh revision.

