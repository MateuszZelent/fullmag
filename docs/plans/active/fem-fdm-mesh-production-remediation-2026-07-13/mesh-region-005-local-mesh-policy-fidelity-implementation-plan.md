# MESH-REGION-005 — Local region mesh policy fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Każdy deklarowany parametr regionowej polityki FEM jest rzeczywiście lokalnie realizowany i raportowany albo odrzucany jako unsupported.

**Architecture:** Size-field compiler tworzy scoped fields na physical volumes regionu. Capability validation rozdziela obsługiwane `max/min/transition` od unsupported local order; build report porównuje requested i resolved wartości per region.

**Tech Stack:** Python Gmsh size fields, ProblemIR validation, build report

## Global Constraints

- Region `minimum_element_size` nie może zmieniać globalnego hmin poza swoim zasięgiem.
- `order` nie może być raportowane applied przy globalnym P1.
- FDM region mesh policy pozostaje jawnie unsupported.

---

**Finding:** MESH-REGION-005, P1.

### Task 1: RED — spatial fidelity

- [x] Dodać regression dla scoped minimum oraz local order; minimum regionu nie trafia już do globalnego `Mesh.CharacteristicLengthMin`, a `order != 1` kończy się stabilnym błędem `region_mesh_policy_order_unsupported`.
- [ ] Uruchomić `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_meshing.py -k 'region_mesh_policy' -q`; oczekiwany RED dla scoped minimum/order status.

### Task 2: field compiler i report

- [ ] Przypisać region physical-volume tags do Gmsh fields oraz złożyć `Min`/distance/threshold bez globalnego nadpisania `Mesh.MeshSizeMin`.
- [x] Dodać capability validation odrzucającą local `order != 1` ze stabilnym reason code; raport nie może już udawać zastosowania lokalnego rzędu P2.
- [ ] Zweryfikować, że region bez policy dziedziczy obiekt i nie tworzy redundantnego field.

### Task 3: evidence

- [ ] Uruchomić pełne Python meshing tests oraz managed FEM mesh build dla dwóch regionów; zapisać histogram i build report.
- [ ] Commit: `git add packages/fullmag-py crates/fullmag-authoring crates/fullmag-plan docs/physics/0100-mesh-and-region-discretization.md && git commit -m "fix(mesh): realize scoped region mesh policies"`.

**Exit:** build report nigdy nie twierdzi, że zastosował lokalny parametr, którego Gmsh nie zrealizował w zadanym regionie.

### Evidence (2026-07-14, fail-closed local order and scoped minimum)

- Region `minimum_element_size` is retained in scoped field metadata but is no
  longer folded into the global hmin option.
- Local mesh order other than P1 is rejected before field construction with
  `region_mesh_policy_order_unsupported`.
- `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_meshing.py -k 'region_mesh_policy' -q` — 4 passed, 0 failed.
- Physical measured size histograms, full operation certificate and managed FEM proof remain open.
