# MESH-REGION-002 — Conformal marker remesh preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Każdy FEM remesh odtwarza regiony conformal i publikuje nową, kompletną mapę markerów zamiast dziedziczyć mapę poprzedniej topologii.

**Architecture:** Typowany request remeshu przenosi canonical `object_regions`; Python wykonuje OCC fragmentation identycznie jak initial build. Candidate transaction zawiera mesh, build report i `object_region_markers`, a planner akceptuje markery tylko z tej samej generation/topology hash.

**Tech Stack:** Rust CLI bridge/orchestrator/IR/planner, Python Gmsh OCC

## Global Constraints

- Stara mapa markerów nigdy nie jest kopiowana do nowej topologii.
- Brak pełnej mapy conformal kończy remesh fail-closed przed publikacją.
- Native FEM proof używa container-backed recipe `just`.

---

**Finding:** MESH-REGION-002, P0.
**Dependencies:** MESH-FEM-007, MESH-REGION-006.

### Task 1: RED — marker reuse i coverage

- [ ] Dodać fixture dwóch obiektów z regionem conformal, wymusić zmianę numeracji physical groups po remeshu i sprawdzić owner, element coverage oraz material assignment.
- [x] Dodać RED/GREEN coverage dla odpowiedzi CLI: świeże `object_region_markers` są emitowane przez Python i parsowane przez Rust; focused Python test przechodzi (`1 passed`). Rust test compilation pozostaje zablokowane przez istniejące brakujące pola w `live_workspace.rs`/`step_utils.rs`.

### Task 2: rozszerzyć typed bridge

```rust
struct SharedRemeshResponse {
    mesh: MeshIR,
    report: FemSharedDomainBuildReportIR,
    object_region_markers: BTreeMap<String, u32>,
    topology_hash: String,
}
```

- [x] Dodać `object_regions` do requestu w `crates/fullmag-cli/src/python_bridge.rs` i przekazać je przez `remesh_cli.py` do shared-domain OCC pipeline.
- [x] Zbudować mapę markerów wyłącznie z nowego wyniku; zweryfikować unikalność, owner coverage i obecność każdego enabled conformal region przed commit.
- [x] Usunąć preservation starej mapy w orchestratorze; failure pozostawia całą poprzednią generation current.

### Task 3: planner i managed evidence

- [ ] Powiązać lookup markera z topology hash oraz odrzucić marker z innej generation przed DG0 realization.
- [ ] Uruchomić Python meshing/remesh tests, Rust planner/orchestrator tests i właściwy container-backed `just` gate FEM; zapisać before/after marker map i material element counts. Python focused test i `cargo check -p fullmag-cli --bin fullmag` przechodzą; test compilation i managed gate są nadal otwarte.
- [ ] Commit: `git add packages/fullmag-py crates/fullmag-cli crates/fullmag-ir crates/fullmag-plan && git commit -m "fix(fem): rebuild conformal region markers on remesh"`.

**Exit:** remesh nie może opublikować topologii bez kompletnej, świeżej i owner-aware mapy conformal markers.
