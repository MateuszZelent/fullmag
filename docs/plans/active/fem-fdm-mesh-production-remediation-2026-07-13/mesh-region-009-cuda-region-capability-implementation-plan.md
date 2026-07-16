# MESH-REGION-009 — CUDA region capability resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unsupported regionowe pola FDM CUDA są odrzucane w plannerze/capability resolution, a nie dopiero podczas startu native runtime.

**Architecture:** Capability matrix rozróżnia region mask, inter-region exchange, per-cell Ms/Aex/Alpha i texture per device/precision. Planner zachowuje requested intent i stable rejection reason; UI wyświetla ten sam reason.

**Tech Stack:** Capability matrix, Rust planner/runner, OpenAPI/UI

## Global Constraints

- Brak automatycznego fallbacku CUDA -> CPU w strict mode.
- `auto` może wybrać CPU, ale provenance zachowuje requested GPU i reason resolution.
- Usunięcie guardu runtime następuje dopiero po implementacji i kwalifikacji CUDA arrays.

---

**Finding:** MESH-REGION-009, P1.

### Task 1: RED capability matrix

- [x] Dodano RED/GREEN planner regression dla CUDA + region `Ms` override; przed zmianą żądanie docierało do native guardu, po zmianie kończy się przed startem CUDA.
- [ ] Dodać pełną macierz CPU/GPU x single/double dla Ms/Aex/Alpha/texture i region mask.
- [ ] Dodać API/UI snapshot reason `fdm_cuda_region_material_fields_unsupported`.

### Task 2: planner legality

- [x] Planner odrzuca FDM CUDA cellwise `Ms/Aex/Alpha` z reason `fdm_cuda_region_material_fields_unsupported`; runtime guard pozostaje defense-in-depth.
- [ ] Rozszerzyć capability vocabulary, auto-resolution/provenance oraz osobne predicates dla mask/fields/texture.

### Task 3: cross-layer gates

- [ ] Uruchomić capability matrix check, planner/API tests, OpenAPI generation/hygiene i Control Room focused inspector tests.
- [ ] Commit: `git add docs/specs crates/fullmag-plan crates/fullmag-runner crates/fullmag-api apps/control-room && git commit -m "fix(planner): resolve CUDA region field legality"`.

**Exit:** żadna konfiguracja znana jako unsupported nie dociera do startu CUDA context.

### Evidence (2026-07-14, partial)

- `cargo test -p fullmag-plan fdm_cuda_region_material_fields_fail_in_planner_before_native_start --lib` — PASS.
- `cargo test -p fullmag-plan --lib --no-fail-fast` — 206 passed, 0 failed.
- Otwarte: capability matrix/OpenAPI/UI reason, auto GPU→CPU policy, complete precision matrix and managed CUDA gate.
