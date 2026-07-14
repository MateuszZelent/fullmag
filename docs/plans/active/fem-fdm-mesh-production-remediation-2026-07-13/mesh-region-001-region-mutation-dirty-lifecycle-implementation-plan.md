# MESH-REGION-001 — Region mutation dirty lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Każda mutacja regionu ma deterministycznie oznaczać właściwe realizacje jako stale, a zmiana wpływająca na topologię FEM musi blokować run do udanego remeshu.

**Architecture:** Jeden backendowy classifier porównuje region przed i po mutacji i zwraca `metadata`, `coefficients`, `membership`, `initial_state` oraz `topology`. CRUD regionów i scene commit używają tego samego wyniku; UI wyłącznie odczytuje authoritative revisions.

**Tech Stack:** Rust API/session, ProblemIR, OpenAPI v2, TypeScript resource hooks

## Global Constraints

- FDM region edit nie przebudowuje gridu, jeśli nie zmieniła się geometria ownera/cell/universe.
- FEM conformal shape/frame/enable/mesh-policy edit wymaga nowej mesh generation.
- HTTP snapshot jest źródłem prawdy; websocket tylko invaliduje.

---

**Finding:** MESH-REGION-001, P0.
**Files:** `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`, `crates/fullmag-api/src/main.rs`, `crates/fullmag-session`, `crates/fullmag-api/src/router_v2/tests.rs`, `docs/adr/0009-geometry-invalidates-mesh.md`.

### Task 1: RED — pełna macierz mutacji

- [ ] Rozszerzyć test transakcji regionowych o rename, material override, shape, frame, enabled, realization, mesh policy, priority, delete i duplicate; asercje obejmują osobno topology, membership, coefficient i initial-state revisions.
- [ ] Uruchomić `env CARGO_TARGET_DIR=/tmp/fullmag-region-lifecycle cargo test -p fullmag-api authoring_transactions_mutate_object_regions_and_couplings -- --nocapture`; oczekiwany RED: topology-changing cases nie ustawiają stale/dirty.

### Task 2: classifier i atomic commit

```rust
enum RegionMutationImpact { Metadata, InitialState, Coefficients, Membership, Topology }
fn classify_region_mutation(before: Option<&SceneObjectRegion>, after: Option<&SceneObjectRegion>, discretization: Discretization) -> BTreeSet<RegionMutationImpact>;
```

- [ ] Zaimplementować classifier przy modelu authoring i użyć go we wszystkich pięciu operacjach CRUD/reorder; usunąć zależność od ręcznych, rozproszonych tagów.
- [x] Włączyć region topology inputs do `scene_mesh_signature` i publikować dirty/stale po region CRUD/duplicate/reorder; failure mutacji pozostawia rewizje bez zmian w istniejących transakcjach.
- [ ] Zastąpić obecne szerokie invalidation jednym classifierem impactów oraz dopiąć osobne membership/coefficient/initial-state revisions.
- [ ] Uruchomić focused API/session tests; oczekiwany PASS całej macierzy.

### Task 3: kontrakt i evidence

- [ ] Uaktualnić ADR 0009 o tabelę klasyfikacji FDM/FEM oraz invariant „stary mesh może być visible, ale nie current”.
- [ ] Uruchomić API hygiene i test scenariusza build-after-region-edit; zapisać before/after scene revision, mesh generation i stale reasons.
- [ ] Commit: `git add docs/adr/0009-geometry-invalidates-mesh.md crates/fullmag-api crates/fullmag-session && git commit -m "fix(mesh): classify region mutation invalidation"`.

### Evidence (2026-07-14, partial)

- Commit `bfe4b73f` marks object-region create/patch/delete/duplicate/reorder as `mesh:dirty` and includes the full region payload in `scene_mesh_signature`.
- `env CARGO_TARGET_DIR=/tmp/fullmag-region-lifecycle cargo test -p fullmag-api authoring_ -- --nocapture` — 44 passed.
- The dedicated impact classifier and separate revision semantics remain open; current invalidation intentionally over-invalidates metadata-only mutations until REGION-011/013 land.

**Exit:** żadna zmiana regionu wpływająca na mesh lub materialization nie pozostawia zależnego zasobu jako current.
