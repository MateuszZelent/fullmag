# MESH-FEM-001 — Fail-closed Gmsh element import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nigdy nie zamieniać prism/hex/pyramid/tet10/quad na fałszywy tet4/tri3 przez obcięcie connectivity.

**Architecture:** Pierwszy bezpieczny rollout jest fail-closed: extraction akceptuje wyłącznie jawnie wspierane typy i arity. Mixed elements lub konformalna tetrahedralizacja wymagają osobnej decyzji ADR i pełnego native support.

**Tech Stack:** Python Gmsh API, NumPy, Pytest, FEM managed gates

## Global Constraints

- Brak heurystycznego `nodes[:4]` lub `nodes[:3]`.
- Error zawiera Gmsh element type, dimension, order i arity.
- Native FEM build jest weryfikowany przez container-backed `just`.

---

**Finding:** MESH-FEM-001, P0.
**Files:** `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`, `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`, `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`, `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`, `packages/fullmag-py/tests/test_meshing.py`.

### Task 1: RED — nieobsługiwane elementy

- [ ] Dodać fixtures prism6, hex8, pyramid5, tet10 i quad4 boundary; każdy import ma zwracać stabilny `UnsupportedGmshElementError`, nie MeshIR.
- [ ] Uruchomić `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_meshing.py -k 'element_type or connectivity' -vv`; nowe testy mają FAIL.

### Task 2: GREEN — typed dispatch

```python
SUPPORTED_VOLUME_ELEMENTS = {4: ("tet4", 4)}
SUPPORTED_BOUNDARY_ELEMENTS = {2: ("tri3", 3)}
```

- [ ] Dispatchować po Gmsh type i dokładnej liczbie primary nodes; odrzucać każdy brak wpisu lub rozjazd arity przed budową arrays.
- [ ] Usunąć obcinanie connectivity i dodać report field `rejected_element_types` do nieudanej diagnostyki buildu.
- [ ] Uruchomić pełny `pytest packages/fullmag-py/tests/test_meshing.py -vv`; wynik PASS.

### Task 3: managed proof

- [ ] Uruchomić `just verify-fem-meshing-production` i `just verify-fem-time-domain-native-contract`; oba PASS.
- [ ] Commit: `git add packages/fullmag-py/src/fullmag/meshing packages/fullmag-py/tests/test_meshing.py && git commit -m "fix(fem): reject unsupported Gmsh element types"`.

**Exit:** żaden nieobsługiwany element nie tworzy pozornie legalnego MeshIR; tet4/tri3 fixtures pozostają zielone.
