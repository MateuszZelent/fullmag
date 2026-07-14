# MESH-PBC-FDM-005 — Periodic image budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ograniczyć `image_counts` checked budżetem czasu/pamięci i zapisać resolved FFT/kernel/padding choice.

**Architecture:** Planner oblicza liczbę obrazów, padded grid i estymowany koszt przed runtime. Engine konsumuje resolved plan bez samodzielnego rozszerzania zakresu.

**Tech Stack:** Rust IR/planner/FFT engine/artifacts

## Global Constraints

- Wszystkie mnożenia checked; brak overflow.
- Limit jest lane-aware i widoczny w diagnostyce.
- Zmiana obrazów nie może być cichym fallbackiem.

---

**Finding:** MESH-PBC-FDM-005, P1.
**Files:** `crates/fullmag-ir/src/execution.rs`, `crates/fullmag-ir/src/plan.rs`, `crates/fullmag-plan/src/fdm.rs`, `crates/fullmag-engine/src/fdm/cpu/fft.rs`, `crates/fullmag-runner/src/fdm/artifacts.rs`, `crates/fullmag-runner/src/fdm/gpu/cuda/artifacts.rs`.

### Task 1: RED budget boundaries

- [x] Dodać testy zero/negative-equivalent, max legal, first illegal, overflow padded counts i excessive bytes dla wspólnego IR budgetu; CPU/GPU lane-specific managed cases pozostają otwarte.
- [x] Uruchomić `cargo test -p fullmag-ir periodic_workspace --lib --no-fail-fast` (4/4) oraz `cargo test -p fullmag-plan --lib fdm --no-fail-fast` (42/42).

### Task 2: resolved cost

```rust
pub struct ResolvedPeriodicImages {
    pub image_counts: [u32; 3], pub padded_counts: [u64; 3],
    pub estimated_bytes: u64, pub kernel: String,
}
```

- [x] Materializować checked plan w `FdmPeriodicityIR::resolve_periodic_images`, z checked image terms, paddingiem `N`/`2N` i limitem 8 GiB; planner odrzuca przed runtime dla single-grid i multilayer.
- [x] Publikować requested/resolved counts, padded counts, bytes i kernel w `mesh_runtime_metadata`; focused artifact test 1/1.
- [x] Dodać wspólny `FftWorkspace::try_new_with_boundary` z tym samym checked image/padding/8 GiB budgetem; legacy constructor failuje jawnie przed alokacją zamiast cichego fallbacku. Engine guard tests: 2/2.
- [ ] Przekazać serializowany resolved workspace do lane-specific CPU/CUDA FFT allocatorów i dodać osobne allocation evidence dla obu lane'ów.

### Task 3: production gate

- [ ] Włączyć boundary cases do nowego `just verify-fdm-pbc-production` z MESH-GATE-002.
- [ ] Commit: `git add crates/fullmag-ir crates/fullmag-plan crates/fullmag-engine crates/fullmag-runner justfile && git commit -m "fix(fdm): bound periodic image workspaces"`.

**Exit:** runtime nie alokuje periodic workspace bez checked resolved cost; każdy fallback lub rejection jest jawny.

### Evidence (2026-07-14)

- `cargo test -p fullmag-ir periodic_workspace --lib --no-fail-fast`: 4/4.
- `cargo test -p fullmag-plan --lib fdm --no-fail-fast`: 42/42.
- `cargo test -p fullmag-runner fdm_mesh_metadata_preserves_requested_and_resolved_pbc_demag --no-fail-fast -- --nocapture`: 1/1.
- `cargo test -p fullmag-engine --test physics_guardrails guardrail_fdm_periodic_workspace --no-fail-fast`: 2/2.
- Remaining gap: the engine/CPU/CUDA workspace allocator still needs to consume the serialized resolved cost, plus managed `just` production proof.
