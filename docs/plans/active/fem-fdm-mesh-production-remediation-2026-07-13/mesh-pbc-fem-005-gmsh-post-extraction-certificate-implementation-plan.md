# MESH-PBC-FEM-005 — Gmsh post-extraction PBC certification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Niezależnie zweryfikować wynik `gmsh.model.mesh.setPeriodic` po ekstrakcji węzłów i elementów.

**Architecture:** Bbox/surface selection i Gmsh periodic relation są inputem, nie dowodem. Po ekstrakcji własny verifier buduje v6 z rzeczywistej topologii.

**Tech Stack:** Python Gmsh, NumPy, periodic certificate tests

## Global Constraints

- Certyfikować extracted mesh, nie CAD intention.
- Face matching korzysta z translated vertex sets i marker/domain roles.
- Tolerance i Gmsh version trafiają do provenance.

---

**Finding:** MESH-PBC-FEM-005, P1.
**Files:** `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`, `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`, `packages/fullmag-py/src/fullmag/meshing/periodic.py`, `packages/fullmag-py/tests/test_periodic_meshing.py`.

### Task 1: RED Gmsh fixtures

- [ ] Dodać valid mirrored box oraz corrupt meshes: removed face element, changed diagonal, duplicate pair i mixed domain.
- [ ] Uruchomić `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_periodic_meshing.py -vv`; corrupt cases mają ujawnić brak verifiera.

### Task 2: verifier

```python
def certify_periodic_mesh(mesh: MeshIR, axes: tuple[str, ...], tolerance_m: float) -> PeriodicMeshCertificateV6:
    ...
```

- [ ] Zbudować node bijection, face bijection, normals/area/domain checks i edge/corner closure z extracted arrays.
- [ ] Pipeline zwraca mesh + v6 albo typed error; sam sukces `setPeriodic` nie wystarcza.
- [ ] Uruchomić periodic tests i `just verify-fem-meshing-production`; PASS.

### Task 3: commit

- [ ] Commit: `git add packages/fullmag-py/src/fullmag/meshing packages/fullmag-py/tests/test_periodic_meshing.py && git commit -m "fix(mesh): certify extracted Gmsh periodic topology"`.

**Exit:** każde periodic Gmsh build ma post-extraction v6; celowo uszkodzona topologia nigdy nie przechodzi.
