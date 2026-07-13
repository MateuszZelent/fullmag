# MESH-GATE-001 — Managed native and browser meshing gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uczynić `just verify-fem-meshing-production` fail-closed gate obejmującym Python/Rust, managed native FEM execution i realny browser/WebGL mesh smoke.

**Architecture:** Jeden top-level recipe orkiestruje istniejące mniejsze gates i zapisuje evidence manifest. Native build/run pozostaje własnością container-backed `justfile`.

**Tech Stack:** just, shell verifier, C++ FEM contract, Playwright/R3F

## Global Constraints

- Rozpoczęty kontener lub częściowy PASS nie jest sukcesem.
- Gate używa tego samego mesh artifact/fingerprint w native i browser stage.
- UI smoke sprawdza visible canvas, `isContextLost()==false` i drawing buffer > 0.

---

**Finding:** MESH-GATE-001, P0.

### Task 1: RED gate audit

- [ ] W `scripts/verify_fem_meshing_production.py` dodać manifest requirements dla native contract result, managed runtime artifact i browser screenshot/metrics; istniejący gate ma FAIL z brakującymi stages.

### Task 2: orchestrated stages

- [ ] W `justfile` zbudować/uruchomić `fem_mesh_contract` w managed FEM container, potem named managed mesh fixture, następnie Control Room smoke na powstałym resource.
- [ ] `scripts/verify_fem_meshing_production.sh` ma `set -euo pipefail`, zachować exit codes i zapisać revision/toolchain/fingerprint/results do evidence JSON.

### Task 3: proof

```bash
just verify-fem-meshing-production
just ensure-managed-fem-runtime
pnpm --dir apps/control-room smoke:viewport-3d
just run-viewport-3d-mixed-target-smoke
```

- [ ] Wszystkie komendy PASS; sprawdzić evidence paths i że celowo zepsuty native/browser stage czyni top-level gate czerwonym.
- [ ] Commit: `git add justfile scripts/verify_fem_meshing_production.* backends/fem apps/control-room/scripts && git commit -m "test(mesh): require managed native and browser proof"`.

**Exit:** jeden top-level gate dowodzi source, native runtime i viewport na tej samej mesh generation; failure dowolnego etapu propaguje nonzero exit.

