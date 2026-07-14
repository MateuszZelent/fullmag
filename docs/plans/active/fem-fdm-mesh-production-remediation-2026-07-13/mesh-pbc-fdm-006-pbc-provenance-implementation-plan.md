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

- [x] Dodać resolved PBC record do runner artifact writera; połączyć origin/counts/cell/period z grid contract i nie duplikować runtime geometry.
- [x] Dodać wersjonowany schema payload `fdm_pbc_provenance.v1` i exact round-trip test; focused runner test PASS.

### Task 3: commit

- [x] Commit: `575e0e98` poprzedniego transfer provenance oraz bieżący commit PBC provenance zostaną zapisane osobno.

**Exit:** sam artifact wystarcza do odtworzenia okresu i wybranego algorytmu; requested intent pozostaje widoczne obok resolved reality.

## Evidence update (2026-07-14)

- [x] `mesh/fdm_pbc_provenance.v1.json` zawiera requested periodicity oraz resolved origin, counts, cell size, period, axes, demag, periodic image counts, FFT kernel/backend, padding i fallback.
- [x] Focused tests: `fdm_mesh_metadata_preserves_requested_and_resolved_pbc_demag` oraz `fdm_pbc_provenance_artifact_round_trips_requested_and_resolved_contract` — oba PASS.
- [ ] Pełna macierz CPU/CUDA single/double oraz managed runtime proof pozostają otwarte.
