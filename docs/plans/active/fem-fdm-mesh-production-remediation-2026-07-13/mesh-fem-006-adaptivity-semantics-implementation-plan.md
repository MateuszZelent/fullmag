# MESH-FEM-006 — Honest adaptive meshing semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Oddzielić faktycznie wspieraną relaxation adaptivity od niewspieranych kryteriów, w szczególności nie zastępować `eigenfrequency_delta` energy proxy.

**Architecture:** Każde criterion ma named estimator, observable, unit, stop rule i validation tier. Brak estimatora oznacza unsupported, nie heurystyczną substytucję.

**Tech Stack:** Physics docs, Python/Rust orchestration, artifacts

## Global Constraints

- Kryteria i observables mają SI units lub jawny dimensionless definition.
- Zmiana topology wymusza state transfer audit i certificate invalidation.
- Nie promować kryterium bez convergence evidence.

---

**Finding:** MESH-FEM-006, P1.
**Files:** `docs/physics/0100-mesh-and-region-discretization.md`, `docs/physics/0105-fem-meshing-production-acceptance.md`, `crates/fullmag-cli/src/orchestrator.rs`, `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`, `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`.

### Task 1: publication i RED

- [ ] Opisać wspierane estimators i wycofać twierdzenie, że energy proxy realizuje eigenfrequency delta.
- [ ] Dodać test, że `eigenfrequency_delta` bez eigensolver estimatora kończy się `unsupported_mesh_adaptivity_criterion`; obecnie ma FAIL.

### Task 2: criterion registry

```rust
enum AdaptiveCriterion { RelaxationEnergyDelta, EigenfrequencyDelta }
fn resolve_estimator(c: AdaptiveCriterion, stage: StageKind) -> Result<EstimatorId, CapabilityError>;
```

- [ ] Zaimplementować resolver bez substytucji; publikować resolved estimator i wartości iteracji.
- [ ] Ograniczyć relaxation estimator do legalnych stage kinds; eigenfrequency odblokować dopiero z rzeczywistym eigen observable.
- [ ] Uruchomić orchestrator/CLI tests; PASS.

### Task 3: managed validation

- [ ] Uruchomić właściwy managed relaxation/remesh gate, zapisać convergence report i transfer audit.
- [ ] Commit: `git add docs/physics packages/fullmag-py crates/fullmag-cli && git commit -m "fix(fem): make adaptive criteria semantically honest"`.

**Exit:** każdy accepted criterion używa nazwanego estimatora zgodnego z authored observable; żadna ścieżka nie zamienia eigenfrequency na energy.
