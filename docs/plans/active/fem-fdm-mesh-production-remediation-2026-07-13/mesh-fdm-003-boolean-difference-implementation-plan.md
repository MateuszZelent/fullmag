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

- [ ] Dodać testy różnicy box-minus-translated-cylinder i box-minus-translated-box z punktami powyżej/poniżej wysokości narzędzia.
- [ ] Uruchomić `cargo test -p fullmag-plan difference -- --nocapture`; testy mają wykazać obecne błędne odejmowanie.

### Task 2: GREEN — wspólny evaluator

```rust
impl GeometryShape {
    fn contains(&self, point_m: [f64; 3]) -> bool;
}
```

- [ ] Reprezentować `Translate` jako węzeł zawierający child i inverse-transformować punkt przed delegacją.
- [ ] Implementować `Difference(a,b)` wyłącznie jako `a.contains(p) && !b.contains(p)`; usunąć wyjątki XY i zachować finite Z.
- [ ] Uruchomić `cargo test -p fullmag-plan geometry --no-fail-fast`; wynik PASS.

### Task 3: cross-surface regression

- [ ] Dodać Python/ProblemIR fixture tej samej bryły i porównać active-cell fingerprint z oczekiwanym snapshotem.
- [ ] Commit: `git add crates/fullmag-plan crates/fullmag-ir/src/model.rs packages/fullmag-py/tests && git commit -m "fix(fdm): preserve transforms in 3D CSG difference"`.

**Exit:** translacja i wysokość każdego operandu wpływają na membership; brak XY-only path.

