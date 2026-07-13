# MESH-FDM-005 — FDM origin propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zachować fizyczny origin siatki FDM w planie, runtime, API i artefaktach.

**Architecture:** Planner wylicza origin raz i zapisuje go w `FdmPlanIR`; CPU/CUDA oraz data plane konsumują to pole. Artefakt rozdziela requested geometry bounds od resolved grid origin.

**Tech Stack:** Rust serde, runner CPU/CUDA, artifacts/OpenAPI

## Global Constraints

- Origin jest w metrach i jest wymagany dla nowo tworzonych planów.
- Nie rekonstruować origin z samych extentów w downstream.
- Zmiana schema wymaga testu kompatybilności i regenerated API, jeśli pole jest publiczne.

---

**Finding:** MESH-FDM-005, P1.
**Files:** `crates/fullmag-ir/src/plan.rs`, `crates/fullmag-plan/src/fdm.rs`, `crates/fullmag-runner/src/fdm/cpu/reference.rs`, `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs`, `crates/fullmag-runner/src/fdm/artifacts.rs`, `crates/fullmag-runner/src/fdm/gpu/cuda/artifacts.rs`.

### Task 1: RED — translated grid round-trip

- [ ] Dodać test planu geometrii przesuniętej od zera i asercję serialized `origin_m`.
- [ ] Dodać testy CPU/CUDA construction oraz artifact snapshot; uruchomić focused tests i potwierdzić FAIL.

### Task 2: GREEN — pole planu

```rust
pub struct FdmPlanIR {
    pub origin_m: [f64; 3],
    /* istniejące pola */
}
```

- [ ] Przepisać `native_origin` do planu i usunąć downstream reconstruction.
- [ ] Przekazać pole przez CPU, CUDA oraz artefakty; dodać grid identity obejmującą origin.
- [ ] Uruchomić `cargo test -p fullmag-ir plan --no-fail-fast`, `cargo test -p fullmag-plan fdm --no-fail-fast`, `cargo test -p fullmag-runner fdm --no-fail-fast`; wynik PASS.

### Task 3: public data contract

- [ ] Jeśli viewport/mesh resource publikuje origin, zaktualizować OpenAPI, wygenerować klienta i uruchomić `pnpm --dir apps/control-room check:api-hygiene`.
- [ ] Commit: `git add crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner apps/control-room/src/kernel/api/generated && git commit -m "fix(fdm): preserve resolved grid origin"`.

**Exit:** ten sam origin występuje w planie, konstrukcji CPU/CUDA, artifact i publicznym resource; translated fixture daje identyczne world coordinates.

