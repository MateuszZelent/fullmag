# MESH-FDM-001 — Checked grid budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Odrzucać każdą siatkę FDM, której liczba komórek lub estymowany koszt pamięci przepełnia typ albo przekracza jawny budżet execution lane.

**Architecture:** Planner jest jedynym właścicielem checked arithmetic i estymacji kosztu; runtime wyłącznie weryfikuje zapisany wynik przed alokacją. CPU i CUDA konsumują ten sam resolved grid budget.

**Tech Stack:** Rust, ProblemIR/planner, FDM CPU/CUDA runtime, Cargo tests

## Global Constraints

- Physics-first; bez cichego clampowania rozmiaru.
- Requested counts i resolved budget pozostają w provenance.
- Limity zależne od urządzenia są rozwiązywane przez capability/planner, nie kernel.

---

**Finding:** [MESH-FDM-001](../../../reports/2026-07-13/fem-fdm-mesh-production-audit/README.md#macierz-problemów-i-planów-naprawczych)
**Priorytet:** P0
**Stan:** `nx*ny*nz` jest liczone w `u32` bez jednego checked cell/memory gate.

### Task 1: RED — overflow i przekroczenie budżetu

**Files:** Test `crates/fullmag-plan/src/tests.rs`; modify `crates/fullmag-plan/src/geometry.rs`, `crates/fullmag-plan/src/fdm.rs`.

- [ ] Dodać testy `fdm_grid_count_overflow_is_rejected` i `fdm_grid_memory_budget_is_rejected`, obejmujące overflow pośredniego iloczynu i stabilny kod błędu z requested counts.
- [ ] Uruchomić `cargo test -p fullmag-plan fdm_grid_ -- --nocapture`; oba nowe testy mają najpierw zakończyć się FAIL.

### Task 2: GREEN — jeden checked calculator

**Interfaces:**

```rust
pub struct FdmGridCost { pub cells: u64, pub estimated_bytes: u64 }
pub fn checked_fdm_grid_cost(counts: [u32; 3], bytes_per_cell: u64) -> Result<FdmGridCost, PlanError>;
```

- [ ] Zaimplementować mnożenia przez `checked_mul`, limit lane i diagnostykę przed budową maski; usunąć niesprawdzone iloczyny z planowanych ścieżek.
- [ ] W `crates/fullmag-runner/src/fdm/cpu/reference.rs` i `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs` porównać alokację z resolved cost i fail-closed przy rozjeździe.
- [ ] Uruchomić `cargo test -p fullmag-plan fdm --no-fail-fast` oraz `cargo test -p fullmag-runner fdm --no-fail-fast`; wynik PASS.

### Task 3: kontrakt i evidence

- [ ] Jeśli limit jest publiczną capability, zaktualizować `docs/specs/capability-matrix-v0.md` i `.json`, a następnie uruchomić `./scripts/ci/contract_guard.sh --strict`.
- [ ] Zapisać test maksymalnego legalnego gridu i pierwszego nielegalnego gridu w artefakcie planera.
- [ ] Commit: `git add crates/fullmag-plan crates/fullmag-runner docs/specs/capability-matrix-v0.* && git commit -m "fix(fdm): reject grids outside checked budgets"`.

**Exit:** żaden iloczyn grid size nie przepełnia typu; planner odrzuca przed alokacją z deterministycznym reason; CPU/CUDA egzekwują ten sam resolved budget.
