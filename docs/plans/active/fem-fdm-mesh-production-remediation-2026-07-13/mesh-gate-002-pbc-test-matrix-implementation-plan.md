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

**Exit:** żadna promowana PBC capability nie istnieje bez named case i evidence artifact.

