# Slice 5 requirements: conforming shared-domain airbox

Authoritative sources:

- `/home/kkingstoun/git/fullmag/fullmag/docs/plans/active/2026-07-27-fem-single-layer-prism-pyramid-shared-domain.md`, Task 2.2 and section 5.5.
- `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`.
- Current typed `MeshData`, Prism6 body-only generator, Gmsh mixed fixture, and ABI v2 on this branch.

## Scope

Implement Task 2.2 only: the first production conforming shared-domain Gmsh path for one axis-aligned magnetic `Box` with a volumetric airbox. Do not start DSL/planner/native-physics/API/UI work from later slices.

## Required realization

1. Build a triangular source face for the magnetic Box and extrude it into native `prism6` with exactly the requested structured layer count.
2. Use the same interface topology/entities as the inner boundary of one surrounding air volume; no coincident duplicate nodes or faces.
3. Mesh the surrounding air so `pyramid5` occurs only in air at the quad transition and `tet4` occupies the remaining air. Do not split prism/pyramid/quad into tetra/tri compatibility elements.
4. Preserve magnetic, transition-air, far-air, interface, and true outer-boundary markers/roles. The magnet-air interface is not an exterior boundary.
5. First path is only axis-aligned Box, P1, fixed layers, no PBC or unsupported physics semantics. Unsupported cases fail closed before Gmsh; strict has no fallback.
6. Prefer a shared GEO topology. Do not perform a post-extrusion OCC fragment that destroys the structured extrusion or duplicates surfaces. If Gmsh requires a `.geo` syntax/API mechanism such as QuadTri, version-gate it and test the exact generated contract.
7. Validate after extraction: all magnetic volume cells Prism6; Pyramid5 only air and incident to quad transition; far air Tet4; exact requested magnetic node-plane count; positive family-specific Jacobians; marker coverage; conforming face adjacency; no orphan/non-manifold/coincident interface faces; volume balance against CAD tolerance.
8. Produce `mixed_layer_topology_certificate.v1` with the fields required by plan section 5.5. It must be accepted only after the validations above, carry topology fingerprint v2, Gmsh version/strategy, `fallbacks_triggered=[]`, family counts per marker/part, facet counts per role/marker, quality/Jacobian minima, plane coordinates/tolerance, volume balance and conformity counts. This certificate is distinct from the body-only `MeshRealizationReport`.
9. Preserve typed topology and certificate through `MeshData` transforms, persistence, IR/artifact lowering paths that are already owned by the meshing layer. Do not falsely advertise native solver qualification; this slice proves meshing only.

## TDD and proof

Write real Gmsh 4.15.2 RED tests first and capture expected failures in the report. Cover at least layers=1 with exactly two magnetic planes, layers=2, x/y/z axis where the production contract permits, exact family/marker partition, quad interface adjacency, no duplicate interface nodes, outer boundary role, rejected unsupported requests, deterministic topology fingerprint, and tampered/stale certificate rejection.

Run focused tests during iteration, then:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_mixed_element_meshing.py \
  packages/fullmag-py/tests/test_meshing_fallbacks.py -vv
just verify-fem-meshing-production
```

The `just` recipe is authoritative if it covers this Python/Gmsh production gate. Do not invent host native FEM builds and do not claim CPU/GPU physics support from this slice.

## Report contract

Write `.superpowers/sdd/mixed-task-5-report.md` with: root-cause/design evidence, RED command/output, files changed, exact topology/marker/certificate semantics, all GREEN commands/results, limitations, and status `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. Do not stage or commit.
