# MESH-PBC-FEM-004 — Edge and corner equivalence closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Udowodnić pełne klasy równoważności węzłów na przecięciach dwóch i trzech okresowych ścian.

**Architecture:** Constraint builder wyprowadza canonical representative niezależny od kolejności par, a certificate publikuje cardinality i commutation residual dla edge/corner classes.

**Tech Stack:** C++ FEM mesh, Rust periodic engine, managed native tests

## Global Constraints

- Translacje wieloosiowe muszą komutować w tolerancji certyfikatu.
- Wynik nie zależy od kolejności wejściowych pair records.
- Każdy periodic corner ma oczekiwaną cardinality dla aktywnych osi.

---

**Finding:** MESH-PBC-FEM-004, P1.
**Files:** `backends/fem/core/fem_mesh.cpp`, `.hpp`, `backends/fem/tests/fem_mesh_contract.cpp`, `crates/fullmag-engine/src/periodic/constraints.rs`, `tests/periodic_constraints.rs`.

### Task 1: RED matrix

- [ ] Dodać 2-axis edge i 3-axis corner fixtures, permutacje input pairs, missing diagonal closure i sprzeczne translacje.
- [ ] Uruchomić Rust periodic tests i container-backed `fem_mesh_contract`; invalid fixtures mają pokazać brak obecnego gate.

### Task 2: canonical classes

```cpp
struct PeriodicEquivalenceAudit {
  std::size_t edge_classes;
  std::size_t corner_classes;
  double max_commutation_residual;
};
```

- [ ] Po union-find zbudować deterministyczne representatives, policzyć oczekiwane class cardinalities i commutation residual.
- [ ] Odrzucić incomplete/noncommuting classes przed assembly; opublikować audit do v6.
- [ ] Uruchomić oba test sets; PASS dla permutacji, FAIL-closed dla corrupt fixtures.

### Task 3: commit

- [ ] Commit: `git add backends/fem/core backends/fem/tests/fem_mesh_contract.cpp crates/fullmag-engine && git commit -m "fix(pbc): certify FEM edge and corner closure"`.

**Exit:** v6 zawiera pełne edge/corner class evidence, a constraint assembly jest order-independent.

## Evidence update (2026-07-14)

- [x] v6 edge/corner closure validator checks two-axis diagonal mappings and translation commutation through deterministic `BTreeMap` representatives.
- [x] RED/GREEN regression fixtures cover input-pair permutation invariance and a missing diagonal mapping; `cargo test -p fullmag-ir periodic_edge_corner_closure --lib --no-fail-fast -- --nocapture` — 2 passed.
- [x] Existing fullmag-ir periodic certificate suite remains green (16 periodic tests, including face bijection, topology and material seam rejection).
- [ ] Native MFEM constraint assembly and managed `fem_mesh_contract` evidence remain required before production closure.
