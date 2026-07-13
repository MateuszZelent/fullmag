# MESH-FEM-002 — Mandatory strict MeshIR validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przepuszczać każdy inline/file/generated/remeshed MeshIR przez `validate_strict()` przed plannerem i native ABI.

**Architecture:** Jeden production entry point opakowuje podstawową i strict validation; wszystkie loader paths go używają. Solver nigdy nie jest pierwszym miejscem wykrywania NaN, duplikatu lub odwróconego tetra.

**Tech Stack:** Rust IR/planner/CLI, Cargo, managed FEM

## Global Constraints

- Fail-closed dla NaN/Inf, duplicate nodes, degenerate i inverted tetra.
- Stabilne kody błędów oraz element/node IDs.
- Nie omijać validation dla trusted/generated assets.

---

**Finding:** MESH-FEM-002, P0.
**Files:** `crates/fullmag-ir/src/mesh_hints.rs`, `crates/fullmag-ir/src/mesh_assets.rs`, `crates/fullmag-plan/src/mesh.rs`, `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-cli/src/main.rs`, `crates/fullmag-cli/src/step_utils.rs`.

### Task 1: RED — każda ścieżka wejścia

- [ ] Dodać tabelaryczne testy inline JSON, file asset i remesh dla NaN, duplicate, zero-volume i negative-orientation tetra.
- [ ] Uruchomić `cargo test -p fullmag-ir validate_strict -- --nocapture` i `cargo test -p fullmag-plan mesh_strict -- --nocapture`; przypadki omijające strict mają FAIL.

### Task 2: GREEN — production validator

```rust
pub fn validate_mesh_for_execution(mesh: &MeshIR) -> Result<(), MeshValidationError> {
    mesh.validate()?;
    mesh.validate_strict()
}
```

- [ ] Wywołać tę funkcję po deserializacji, po generacji/remeshu i bezpośrednio przed pakowaniem native mesh.
- [ ] Usunąć produkcyjne wywołania samego `validate()`; pozostawić je tylko w testach warstwy podstawowej.
- [ ] Uruchomić `cargo test -p fullmag-ir mesh --no-fail-fast` i `cargo test -p fullmag-plan mesh --no-fail-fast`; PASS.

### Task 3: managed proof

- [ ] Uruchomić `just verify-fem-meshing-production`; gate musi zawierać corrupt fixtures i zakończyć się PASS.
- [ ] Commit: `git add crates/fullmag-ir crates/fullmag-plan crates/fullmag-cli && git commit -m "fix(fem): require strict mesh validation before execution"`.

**Exit:** żadna produkcyjna ścieżka nie dociera do ABI po samym `validate()`; corrupt fixtures fail przed solverem.
