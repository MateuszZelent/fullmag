# MESH-REGION-016 — FDM cache partition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Metadata, texture i material-only region edits nie powodują ponownej voxelizacji identycznego grid assetu FDM.

**Architecture:** Cache identity zostaje rozdzielone na geometry/grid key, membership key, coefficient key i initial-state key zgodnie z MESH-REGION-011. Każdy builder konsumuje tylko semantyczne wejścia wpływające na jego wynik.

**Tech Stack:** Python Problem asset cache, Rust realization revisions

## Global Constraints

- Optymalizacja nie może zachować starej maski lub coefficient array.
- Cache hit jest dozwolony tylko przy zgodnym canonical digest wejść danej warstwy.
- Zmiana owner geometry/cell/universe zawsze unieważnia grid i potomne keys.

---

**Finding:** MESH-REGION-016, P2.
**Dependencies:** MESH-REGION-011.

### Task 1: RED cache-key matrix

- [ ] Dodać instrumentowany test liczący voxelizer invocations dla rename, texture, material, transition, shape, owner geometry i cell change.
- [ ] Oczekiwać braku nowej voxelizacji dla pierwszych czterech i dokładnie jednego rebuild dla geometry/cell; obecny pełny key ma dać RED.

### Task 2: layered keys

- [ ] Wyodrębnić deterministic `grid_asset_key`, `region_membership_key`, `coefficient_realization_key` i `initial_state_key` z dokładnymi wejściami.
- [ ] Przepiąć builder tak, aby reuse grid nadal wymuszało świeżą maskę/fields/texture zgodnie z ich keys.
- [ ] Zapisać cache hit/miss reasons i digests w debug provenance bez dużych payloadów.

### Task 3: regression/benchmark

- [ ] Uruchomić Python model/meshing tests i benchmark repeated material edits; potwierdzić identyczny grid checksum i nowe coefficient checksum.
- [ ] Commit: `git add packages/fullmag-py crates/fullmag-session && git commit -m "perf(fdm): partition region realization cache keys"`.

**Exit:** cache eliminuje wyłącznie pracę, której wynik semantycznie się nie zmienił.

## Evidence update (2026-07-14)

- [x] FDM-only geometry asset cache identity now excludes `object_regions` and FEM-only `mesh_workflow`; geometry, cell size and study-universe inputs remain part of the key.
- [x] RED/GREEN regression: the focused instrumented test exercises two region-only calls and one changed-cell call; it passes with exactly two voxelizer invocations (`1` cache hit for region-only edit, `1` rebuild for cell change).
- [ ] Coefficient/membership artifact checksums, cache hit/miss provenance and repeated production benchmark remain open.
