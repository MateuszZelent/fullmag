# MESH-GATE-002 — Cross-backend PBC production matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać jeden promocyjny matrix gate obejmujący corrupt FEM topology i wszystkie wspierane FDM PBC lanes.

**Architecture:** `just verify-fdm-pbc-production` i FEM certificate contracts zapisują machine-readable case matrix. Gate wymaga jawnego PASS albo expected unsupported dla każdego capability row.

**Tech Stack:** Cargo, Pytest, CUDA/native managed tests, just

## Global Constraints

- Matrix obejmuje CPU/CUDA, double/single, standard/T0/T1, single-grid/multilayer.
- FEM obejmuje faces, normals, domains, edges/corners i remesh recertification.
- M5 jest oddzielnym strict physical gate, ale top-level matrix wymaga jego statusu.

---

**Finding:** MESH-GATE-002, P1.

### Task 1: case manifest

- [ ] Dodać versioned manifest z cases: corrupt face topology, corner closure, FP32 seam, T0/T1 seam, multilayer, image budgets, remesh, M5 reference.
- [ ] Verifier ma FAIL, jeśli capability row nie ma case result albo artifact fingerprint.

### Task 2: repo recipes

- [ ] Dodać `just verify-fdm-pbc-production` kompozytujący engine guardrails, planner PBC, runner native periodic i managed CUDA contracts.
- [ ] Rozszerzyć FEM meshing/PBC recipes o corrupt certificate i remesh fixtures; nie używać ręcznego Docker command.

### Task 3: execute and record

```bash
cargo test -p fullmag-engine physics_guardrails --no-fail-fast
cargo test -p fullmag-plan fdm_pbc --no-fail-fast
cargo test -p fullmag-runner native_fdm_periodic --no-fail-fast
just verify-fdm-pbc-production
just verify-fem-meshing-production
```

- [ ] Wszystkie supported rows PASS; unsupported rows zgadzają się z capability matrix i mają reason.
- [ ] Commit: `git add justfile scripts backends/fdm/tests backends/fem/tests crates/fullmag-engine crates/fullmag-plan crates/fullmag-runner && git commit -m "test(pbc): add cross-backend production matrix"`.

## Evidence — 2026-07-14 (bounded matrix contract)

- [x] Added versioned `scripts/pbc_production_matrix.v1.json` with FEM corrupt-face, edge/corner, remesh, and strict-M5 rows plus FDM CPU/CUDA precision, T0/T1, multilayer, and image-budget rows.
- [x] Added `scripts/verify_pbc_production_matrix.py`; terminal rows require `pass` or capability-consistent `expected_unsupported`, a SHA-256 artifact fingerprint, and a reason for unsupported cases. Pending/failed rows emit stable case identifiers and fail the gate.
- [x] Added `just verify-fdm-pbc-production`, composing focused engine, planner, and runner periodic tests with the matrix verifier. It does not start a managed runtime.
- [x] RED/GREEN test: `python3 -m pytest scripts/test_verify_pbc_production_matrix.py -q` → `3 passed`.
- [ ] Production promotion remains open: the checked-in manifest intentionally contains `not_run` rows, so `just verify-fdm-pbc-production` must remain red until native/managed case artifacts are populated. No managed runtime was run in this bounded slice.

**Exit:** żadna promowana PBC capability nie istnieje bez named case i evidence artifact.
