# MESH-PBC-FDM-006 — Complete FDM PBC provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Umożliwić jednoznaczne odtworzenie FDM PBC z planu i artifact: origin, `N`, `d`, `L`, axes, demag, images, FFT/kernel/padding i fallback.

**Architecture:** `FdmGridCertificateIR` jest identity siatki, a osobny resolved PBC record opisuje wykonanie. Artefakt przechowuje requested i resolved bez ich nadpisywania.

**Tech Stack:** Rust IR/planner/runner artifacts, JSON schema

## Global Constraints

- `L=N*d` jest walidowane dla każdej osi okresowej.
- Provenance jest identyczne semantycznie dla CPU/CUDA i single/multilayer.
- Brak pola nie może być zastępowany inferred default w czytniku.

---

**Finding:** MESH-PBC-FDM-006, P1.
**Dependencies:** MESH-FDM-005, 007 i MESH-PBC-FDM-001, 005.

### Task 1: RED artifact round-trip

- [ ] Dodać artifact fixtures dla CPU open, CPU periodic images, CUDA double, CUDA single i multilayer; deserializacja ma odtwarzać dokładny resolved contract.
- [ ] Potwierdzić obecne braki origin/kernel/padding przez failing snapshot assertions.

### Task 2: schema i writer

```rust
pub struct ResolvedFdmPbcProvenance {
    pub axes: [bool; 3], pub period_m: [f64; 3], pub demag: ResolvedFdmDemagBoundary,
    pub fft_kernel: String, pub padded_counts: [u64; 3], pub fallback: Option<String>,
}
```

- [ ] Dodać record do planu/artifacts CPU i CUDA; połączyć z grid fingerprint, nie duplikować geometry truth.
- [ ] Dodać schema validation i exact round-trip tests; uruchomić IR/plan/runner tests, PASS.

### Task 3: commit

- [ ] Commit: `git add crates/fullmag-ir/src/plan.rs crates/fullmag-plan/src/fdm.rs crates/fullmag-runner/src/fdm && git commit -m "feat(fdm): record complete resolved PBC provenance"`.

**Exit:** sam artifact wystarcza do odtworzenia okresu i wybranego algorytmu; requested intent pozostaje widoczne obok resolved reality.

