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

## Evidence update (2026-07-14, fail-closed M5 bundle contract)

- [x] RED: a new strict-bundle test initially failed because the verifier did
  not exist; the three-case test matrix covers missing case, relaxed-threshold
  rejection and complete strict bundle acceptance.
- [x] Added `scripts/verify_fem_static_pbc_m5_evidence.py`, requiring current
  mesh generation/topology/marker/material identities, five named M5 cases,
  CPU/GPU engine ownership, SHA-256 artifact fingerprints and the published
  `2e-2` strict relative-error ceiling. Missing or non-pass cases fail closed.
- [x] `python3 -m pytest scripts/test_verify_fem_static_pbc_m5_evidence.py -q`
  — 3 passed; this is an evidence-contract gate, not solver execution proof.
- [x] The verifier now requires observable-level residuals for `H_demag`, `phi`,
  demag energy and central-cell comparison in every case, each within the same
  strict `2e-2` ceiling; a single aggregate metric cannot mask a failed field.
- [ ] Current managed CPU/GPU runtimes, primitive-vs-supercell artifacts and
  root-cause numerical repair remain open. The matching `just` recipe currently
  stops before runtime because Docker Buildx cannot write its activity state.
