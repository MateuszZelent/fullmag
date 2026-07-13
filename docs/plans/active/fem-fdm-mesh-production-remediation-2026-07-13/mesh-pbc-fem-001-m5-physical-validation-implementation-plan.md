# MESH-PBC-FEM-001 — Strict M5 primitive/supercell closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zamknąć fizyczny gate M5 dla FEM PBC demag przez zgodność primitive cell i centralnej komórki supercell w opublikowanych tolerancjach.

**Architecture:** Ten plan nie luzuje tolerancji. Najpierw lokalizuje rozjazd na wspólnej frozen mesh/material fixture, naprawia operator lub preprocessing, następnie zapisuje promocyjny evidence bundle CPU/GPU.

**Tech Stack:** FEM/MFEM/hypre/CUDA, Python validators, managed `just`

## Global Constraints

- Aktualizacja `docs/physics/0800-fem-static-pbc-demag.md` poprzedza zmianę numerics.
- CPU double jest oracle; GPU double musi przejść parity.
- Capability pozostaje `experimental/unvalidated`, dopóki strict M5 nie jest zielone.

---

**Finding:** MESH-PBC-FEM-001, P0.
**Dependencies:** MESH-PBC-FEM-002..006 oraz strict MeshIR validation.

### Task 1: reprodukcja i diagnoza

- [ ] Zamrozić wspólne primitive/supercell mesh, materiały, magnetization, airbox i solver tolerances; uruchomić `just verify-fem-static-pbc-demag-supercell-runtime`.
- [ ] Zapisać per-observable errors dla `H_demag`, `phi`, energii i central-cell crop; run ma odtworzyć obecne przekroczenie, nie zmieniać progów.

### Task 2: root-cause repair

- [ ] Na podstawie phase-resolved diagnostics wskazać jeden owner: RHS, periodic constraints, nullspace/gauge, airbox boundary, energy normalization lub crop mapping.
- [ ] Dodać failing native contract w odpowiednim `backends/fem/tests/*_contract.cpp`, następnie minimalną naprawę w owning module; nie dodawać fizyki do `mfem_bridge.cpp`.
- [ ] Uruchomić matching container-backed contract i oba static PBC runtime gates; PASS.

### Task 3: promotion evidence

```bash
just verify-fem-periodic-antidot-relaxation-runtime
just verify-fem-periodic-antidot-relaxation-gpu-runtime
just verify-fem-static-pbc-demag-z-padding-runtime
just verify-fem-static-pbc-demag-supercell-runtime
just verify-fem-static-pbc-demag-equilibrium-runtime
```

- [ ] Zapisać komendy, revisions i artifacts; zaktualizować tabelę M5 w physics note wyłącznie rzeczywistymi wynikami.
- [ ] Commit: `git add docs/physics/0800-fem-static-pbc-demag.md backends/fem crates/fullmag-runner scripts justfile && git commit -m "fix(fem): close strict static PBC M5 validation"`.

**Exit:** wszystkie pięć managed gates PASS bez relaxed thresholds; primitive/supercell errors są poniżej opublikowanych limitów CPU i GPU.

