# MESH-FDM-006 — Single-grid top-level translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zachować top-level `Translate` w single-grid FDM tak samo jak w multilayer.

**Architecture:** Wspólne geometry lowering zwraca transform-aware shape; różnice między single-grid i multilayer dotyczą układu domen, nie semantyki transformacji.

**Tech Stack:** Rust geometry/planner tests

## Global Constraints

- Nie kopiować drugiego algorytmu translacji.
- Translation wpływa na bounds, origin, maskę i provenance.
- Wynik bez translacji musi pozostać bitowo zgodny.

---

**Finding:** MESH-FDM-006, P1.
**Files:** `crates/fullmag-plan/src/geometry.rs`, `crates/fullmag-plan/src/fdm.rs`, `crates/fullmag-plan/src/tests.rs`.

### Task 1: RED

- [ ] Dodać single-grid fixture `Translate(Box)` z niezerowymi przesunięciami XYZ i porównać bounds, origin oraz active-cell coordinates z multilayer geometry lowering.
- [ ] Uruchomić `cargo test -p fullmag-plan translated_single_grid -- --nocapture`; wynik przed zmianą FAIL.

### Task 2: GREEN

```rust
GeometryShape::Translate { offset_m: [f64; 3], child: Box<GeometryShape> }
```

- [ ] Usunąć gałąź `Translate` zwracającą sam child; zastosować inverse translation w `contains` i forward translation w bounds.
- [ ] Użyć tej samej reprezentacji w obu planner lanes.
- [ ] Uruchomić `cargo test -p fullmag-plan geometry --no-fail-fast` i `cargo test -p fullmag-plan fdm --no-fail-fast`; wynik PASS.

### Task 3: commit

- [ ] Commit: `git add crates/fullmag-plan/src/geometry.rs crates/fullmag-plan/src/fdm.rs crates/fullmag-plan/src/tests.rs && git commit -m "fix(fdm): preserve top-level translations"`.

**Exit:** przesunięta geometria ma przesuniętą maskę i origin w single-grid; single/multilayer używają wspólnej semantyki.

