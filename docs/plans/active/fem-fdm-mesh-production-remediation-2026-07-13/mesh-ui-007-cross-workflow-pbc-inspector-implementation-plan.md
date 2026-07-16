# MESH-UI-007 — Cross-workflow PBC Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Udostępnić równoważny PBC authoring/validation Inspector dla static, time-domain, eigenmodes i frequency response.

**Architecture:** Jeden semantic PBC resource/view model zasila dedykowane node details; stage panels dodają tylko stage-specific observables, nie duplikują statusu mesh.

**Tech Stack:** React Inspector registry, resource hooks, command registry

## Global Constraints

- Każdy semantic Explorer node ma własny detail view.
- Static/time-domain nie są kierowane do frequency-only Inspector.
- Unsupported stage/backend pokazuje capability reason.

---

**Finding:** MESH-UI-007, P1.
**Dependencies:** MESH-UI-001, 002 i 004.

### Task 1: registry/model RED

- [x] Dodać pure-model fixtures dla authored PBC, mesh certificate, static stage, time stage, eigen stage i response stage; każdy otrzymuje własny detail ID i wspólnego ownera statusu.
- [ ] Uruchomić inspector registry tests; obecne checkout nie ma zainstalowanego `vitest`/`node_modules`, więc wykonanie testu jest blockerem środowiskowym.

### Task 2: semantic inspectors

```ts
type PbcInspectorContext = "authoring" | "mesh-certificate" | "static" | "time-domain" | "eigenmodes" | "frequency-response";
```

- [ ] Dodać registry entries i focused panels używające wspólnego PBC resource hook; stage-specific sections tylko rozszerzają view.
- [x] Zarejestrować typed context resolver/IDs w `inspectorRegistry`; model nie duplikuje statusu i wskazuje `meshing.mesh.periodic_pairs` jako jedynego ownera.
- [ ] Explorer tree buduje nodes z resources/capabilities, nie hardcoded frequency assumptions.
- [ ] Uruchomić registry/panel tests, typecheck i lint; PASS.

### Task 3: browser workflow

- [ ] Browser smoke przełącza wszystkie contexts, zachowuje selection i pokazuje current status/reasons.
- [ ] Commit: `git add apps/control-room/src/modules/explorer apps/control-room/src/modules/inspector && git commit -m "feat(ui): inspect PBC across all study workflows"`.

**Exit:** każde wspierane workflow ma resource-backed PBC Inspector; brak statycznych placeholderów i frequency-only drift.

### Bounded slice evidence (2026-07-14)

- Dodano `pbcInspectorModel.ts` oraz `pbcInspectorModel.test.ts` z sześcioma
  kontekstami: `authoring`, `mesh-certificate`, `static`, `time-domain`,
  `eigenmodes`, `frequency-response`.
- Registry eksportuje stabilne context IDs i resolver; wszystkie konteksty
  wskazują wspólny owner `meshing.mesh.periodic_pairs`, a stage-specific view
  jest oznaczony osobnym polem.
- Próba `pnpm --dir apps/control-room exec vitest run
  src/modules/inspector/panels/pbcInspectorModel.test.ts` zakończyła się
  `vitest not found`; brak zależności lokalnych. Browser smoke, realny
  resource-hook panel i nowe Explorer nodes pozostają otwartymi gate'ami.
