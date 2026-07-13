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

- [ ] Dodać testy zero/negative-equivalent, max legal, first illegal, overflow padded counts i excessive bytes dla CPU/GPU lanes.
- [ ] Uruchomić planner `fdm_pbc_images` tests; excessive cases mają obecnie nie failować we właściwym miejscu.

### Task 2: resolved cost

```rust
pub struct ResolvedPeriodicImages {
    pub image_counts: [u32; 3], pub padded_counts: [u64; 3],
    pub estimated_bytes: u64, pub kernel: String,
}
```

- [ ] Materializować checked plan, egzekwować lane budget i przekazywać go do FFT workspace.
- [ ] Publikować requested/resolved counts oraz rejection reason; uruchomić planner/engine tests, PASS.

### Task 3: production gate

- [ ] Włączyć boundary cases do nowego `just verify-fdm-pbc-production` z MESH-GATE-002.
- [ ] Commit: `git add crates/fullmag-ir crates/fullmag-plan crates/fullmag-engine crates/fullmag-runner justfile && git commit -m "fix(fdm): bound periodic image workspaces"`.

**Exit:** runtime nie alokuje periodic workspace bez checked resolved cost; każdy fallback lub rejection jest jawny.
