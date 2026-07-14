# MESH-UI-004 — Capability-driven mesh editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zastąpić statyczne menu kompletnym edytorem FDM grid, FEM mesh i PBC sterowanym canonical capability reasons.

**Architecture:** Inspector authoruje SceneDocument/ProblemIR draft; Ribbon renderuje commands z registry. Capability resource określa enabled/disabled i reason dla backend/device/precision/multilayer/PBC.

**Tech Stack:** React, Zustand draft hygiene, command registry, OpenAPI capabilities

## Global Constraints

- Jeden unified workspace i viewport; bez osobnych aplikacji FDM/FEM.
- Shared shadcn primitives, klasy `fm-*`, tokeny `--fm-*`.
- Pierwszy client render zgodny z SSR; draft nie nadpisuje snapshotu po ACK.

---

**Finding:** MESH-UI-004, P1.
**Dependency:** MESH-UI-001 i canonical capability schema.

### Task 1: model tests

- [ ] Dodać matrix editor model dla FDM/FEM, CPU/GPU, single/double, multilayer i PBC; asercje enabled reason i exported patch.
- [ ] Dodać hydration test oraz round-trip do SceneDocument; current static menu ma nie spełniać fixtures.

### Task 2: editor surfaces

- [ ] Dodać focused Inspector sections w `apps/control-room/src/modules/inspector/panels/` oraz command contributions zamiast lokalnych endpointów.
- [ ] Ribbon ma otwierać/focusować editor; disabled controls pokazują server reason; build command blokowany dla invalid draft.
- [ ] Uruchomić focused model/render tests; PASS.

### Task 3: full UI gates

- [ ] Uruchomić typecheck, lint zero warnings, pełny test, API hygiene i architecture hygiene.
- [ ] Commit: `git add apps/control-room/src/modules/ribbon apps/control-room/src/modules/inspector apps/control-room/src/kernel && git commit -m "feat(ui): add capability-driven mesh authoring"`.

**Exit:** każda publiczna legalna opcja ma authoring control; każda nielegalna ma server-derived reason i nie może zostać wysłana.

## Evidence — 2026-07-14 (bounded capability model/editor slice)

- [x] Added typed pure `meshEditorCapabilityModel` for FDM/FEM, CPU/CUDA, single/double, multilayer, and PBC options. It fails closed when the meshing capability resource is absent, preserves server status/reason, and validates a canonical editor patch before export.
- [x] Added focused model tests for status/reason normalization, unavailable resources, unsupported draft rejection, and canonical patch export.
- [x] Inspector consumes `useMeshCapabilitiesResource` through `useMeshDetailsModel` and renders a capability matrix with status/reason rows.
- [x] Ribbon consumes the same resource through `RibbonModule` and disables FEM mesh build actions with the server-derived reason; command registry build commands apply the same capability gate when resource data is present.
- [x] Legacy resources that do not yet publish lane keys remain non-blocking (`unavailable` is informational); only explicit unsupported/development/source-visible statuses block authoring.
- [ ] Focused Vitest/typecheck/browser gates remain open in this worktree: `vitest`/TypeScript binaries are unavailable (`sh: 1: vitest: not found`), and no browser smoke was run. Draft persistence, SceneDocument/ProblemIR round-trip, and full editor controls remain future slices.
