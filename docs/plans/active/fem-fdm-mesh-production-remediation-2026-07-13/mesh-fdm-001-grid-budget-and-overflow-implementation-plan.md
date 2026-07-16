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

- [x] Dodać testy `fdm_grid_count_overflow_is_rejected` i `fdm_grid_memory_budget_is_rejected`, obejmujące overflow pośredniego iloczynu i stabilny kod błędu z requested counts.
- [x] Uruchomić `cargo test -p fullmag-plan fdm_grid_ -- --nocapture`; oba testy przechodzą po wdrożeniu.

### Task 2: GREEN — jeden checked calculator

**Interfaces:**

```rust
pub struct FdmGridCost { pub cells: u64, pub estimated_bytes: u64 }
pub fn checked_fdm_grid_cost(counts: [u32; 3], bytes_per_cell: u64) -> Result<FdmGridCost, PlanError>;
```

- [x] Zaimplementować mnożenia przez `checked_mul`, limit lane i diagnostykę przed budową maski; usunąć niesprawdzone iloczyny z planowanych ścieżek.
- [x] CPU reference i CUDA native construction porównują alokację z resolved cost i fail-closed przy rozjeździe.
- [x] `cargo test -p fullmag-plan fdm --no-fail-fast` — 36 passed; `cargo test -p fullmag-runner fdm --no-fail-fast` — 80 passed.

### Task 3: kontrakt i evidence

- [ ] Jeśli limit jest publiczną capability, zaktualizować `docs/specs/capability-matrix-v0.md` i `.json`, a następnie uruchomić `./scripts/ci/contract_guard.sh --strict`.
- [ ] Zapisać test maksymalnego legalnego gridu i pierwszego nielegalnego gridu w artefakcie planera.
- [x] Implementacja i testy budżetu są obecne w historii branch; osobny historyczny commit obejmujący kod nie został odtworzony w tym remediacyjnym branchu.

**Exit:** żaden iloczyn grid size nie przepełnia typu; planner odrzuca przed alokacją z deterministycznym reason; CPU/CUDA egzekwują ten sam resolved budget.

## Evidence update (2026-07-14)

- [x] Planner owns `checked_fdm_grid_cost`, with checked cell/memory arithmetic, explicit cell/memory limits and stable requested-count diagnostics.
- [x] Runtime validates the same cost and grid certificate before CPU/CUDA allocation; forged payload, non-finite origin, stale mask and missing production certificate are fail-closed tests.
- [x] Focused and adjacent FDM suites are green as recorded above.
- [ ] Maximum legal/first illegal grid artifact and managed CPU/CUDA proof remain open before final closure.
