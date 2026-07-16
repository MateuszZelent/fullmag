# MESH-FDM-003 — Transform-aware 3D Difference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Obliczać `Difference` jako pełne 3D CSG z zachowaniem transformacji każdego zagnieżdżonego operandu.

**Architecture:** Jeden rekurencyjny evaluator `contains(point)` obsługuje prymitywy, transformacje i CSG; nie ma osobnej XY-only ścieżki dla odejmowania.

**Tech Stack:** Rust geometry planner, SDF/containment tests

## Global Constraints

- Wynik voxelizacji musi odpowiadać authored geometry w 3D.
- Transformacja należy do węzła drzewa, nie jest kasowana podczas loweringu.
- Nie dodawać nowej biblioteki geometrycznej.

---

**Finding:** MESH-FDM-003, P0.
**Files:** `crates/fullmag-plan/src/geometry.rs`, `crates/fullmag-plan/src/boundary_geometry.rs`, `crates/fullmag-ir/src/model.rs`, `crates/fullmag-plan/src/tests.rs`.

### Task 1: RED — translated finite-height cutters

- [x] Dodać testy różnicy box-minus-translated-cylinder i box-minus-translated-box z punktami powyżej/poniżej wysokości narzędzia.
- [x] Uruchomić `cargo test -p fullmag-plan difference -- --nocapture`; 2 testy przechodzą po wdrożeniu.

### Task 2: GREEN — wspólny evaluator

```rust
impl GeometryShape {
    fn contains(&self, point_m: [f64; 3]) -> bool;
}
```

- [x] Reprezentować `Translate` jako węzeł zawierający child i inverse-transformować punkt przed delegacją.
- [x] Implementować `Difference(a,b)` wyłącznie jako `a.contains(p) && !b.contains(p)`; usunąć wyjątki XY i zachować finite Z.
- [x] `cargo test -p fullmag-plan difference --lib --no-fail-fast` — 2 passed.

### Task 3: cross-surface regression

- [x] Python/ProblemIR fixture tej samej różnicy zachowuje translated operand; API lowering test — 1 passed; Rust fixture zapisuje expected removed-cell fingerprint.
- [x] Implementacja i regression tests są obecne w historii branch; kod findingu pochodzi z wcześniejszego slice'u, a dowody zapisano teraz indywidualnie.

**Exit:** translacja i wysokość każdego operandu wpływają na membership; brak XY-only path.

## Evidence update (2026-07-14)

- [x] Recursive `GeometryShape::contains` is the sole CSG evaluator for primitives, inverse transforms and finite 3D Difference.
- [x] Rust active-mask fingerprint and translated finite-height regression pass; Python ProblemIR shape lowering passes.
- [ ] No managed FDM runtime artifact currently records this specific CSG fixture; retain as an open evidence improvement if the final gate requires a persisted production artifact.
