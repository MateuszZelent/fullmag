# MESH-FDM-002 — Arbitrary cylinder axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zachować dowolną oś `Cylinder` od Python DSL przez ProblemIR do bounds i maski FDM.

**Architecture:** Oś jest częścią kanonicznej geometrii, normalizowaną raz podczas validation. Voxelizer używa projekcji punktu na oś zamiast założenia Z.

**Tech Stack:** Python DSL, serde Rust, geometry planner, Cargo/Pytest

## Global Constraints

- Jednostki długości pozostają SI.
- Wektor zerowy i nie-skończony jest błędem authoringu.
- Round-trip Python -> ProblemIR -> Python zachowuje wartości osi.

---

**Finding:** MESH-FDM-002, P1.
**Files:** `packages/fullmag-py/src/fullmag/model/geometry.py`, `crates/fullmag-ir/src/model.rs`, `crates/fullmag-plan/src/geometry.rs`, `crates/fullmag-plan/src/boundary_geometry.rs`, `crates/fullmag-plan/src/tests.rs`.

### Task 1: RED — geometria X/Y/skośna

- [ ] Dodać testy dla osi `[1,0,0]`, `[0,1,0]`, `[1,1,1]` oraz odrzucenia `[0,0,0]`; asercje muszą sprawdzać bounds i wybrane punkty inside/outside.
- [ ] Uruchomić `cargo test -p fullmag-plan cylinder -- --nocapture` i test round-trip Python; nowe przypadki mają FAIL przed zmianą.

### Task 2: GREEN — kanoniczne pole osi

```rust
GeometryEntryIR::Cylinder { radius: f64, height: f64, axis: [f64; 3] }
```

- [ ] Dodać pole serde i walidację skończonej, niezerowej osi; Python exporter ma emitować dokładnie tę samą wartość.
- [ ] Zastąpić Z-only `contains` projekcją osiową i promieniową; bounds policzyć z oriented cylinder AABB.
- [ ] Uruchomić `cargo test -p fullmag-ir cylinder --no-fail-fast`, `cargo test -p fullmag-plan cylinder --no-fail-fast` i właściwy test Python; wynik PASS.

### Task 3: zgodność

- [ ] Dodać fixture starego JSON bez osi tylko wtedy, gdy istnieją utrwalone publiczne dokumenty; domyślna oś może być `[0,0,1]` wyłącznie w jawnej migracji.
- [ ] Commit: `git add packages/fullmag-py/src/fullmag/model/geometry.py crates/fullmag-ir/src/model.rs crates/fullmag-plan && git commit -m "fix(geometry): preserve cylinder axis in FDM lowering"`.

**Exit:** maska i bounds są poprawne dla co najmniej trzech niekolinearnych osi, a round-trip nie usuwa osi.

