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

- [ ] Dodać przypadki CPU/GPU x single/double dla region mask, Ms field, Aex field, Alpha field i texture; obecnie żądania GPU z fields mają przechodzić planner i dać RED.
- [ ] Dodać API/UI snapshot reason `fdm_cuda_region_material_fields_unsupported`.

### Task 2: planner legality

- [ ] Rozszerzyć canonical capability vocabulary i planner predicates o osobne region field capabilities.
- [ ] W strict odrzucić plan przed runtime; w auto rozwiązać do CPU wyłącznie zgodnie z execution-selection doctrine i zapisać requested/resolved.
- [ ] Zachować runtime guard jako defense-in-depth z tym samym kodem błędu.

### Task 3: cross-layer gates

- [ ] Uruchomić capability matrix check, planner/API tests, OpenAPI generation/hygiene i Control Room focused inspector tests.
- [ ] Commit: `git add docs/specs crates/fullmag-plan crates/fullmag-runner crates/fullmag-api apps/control-room && git commit -m "fix(planner): resolve CUDA region field legality"`.

**Exit:** żadna konfiguracja znana jako unsupported nie dociera do startu CUDA context.
