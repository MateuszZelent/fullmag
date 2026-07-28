# ADR 0021 - Native mixed-P1 FEM topology

**Status:** accepted
**Date:** 2026-07-27
**Decision makers:** Fullmag core

## Context

Exact through-thickness FEM layers for thin magnetic Boxes cannot remain a
mesher-only hint if the realized shared-domain solver mesh converts every prism
to tetrahedra. That conversion loses the requested topology, weakens the exact-
layer contract, and makes planner, runtime, artifacts, API, and UI report a
different numerical model from the one authored.

The first target is narrow: one axis-aligned P1 magnetic Box inside one
conforming airbox, uniform `Ms` and `Aex`, exchange, uniform Zeeman,
Dirichlet/Robin Poisson demag, double-precision FEM CPU/GPU, and PG-BB, NCG, or
overdamped LLG. This ADR defines the target architecture; current runtime
support is not promoted.

## Decision

Adopt typed native mixed-P1 topology as the canonical target:

```text
magnetic cells: prism6
air transition cells: pyramid5
far-air cells: tet4
facets: tri3 | quad4
```

The public and intermediate contracts use canonical Fullmag enums, never Gmsh
numeric element IDs. The target vocabulary includes
`mesh.topology.mixed_p1`, `mesh.swept.prism`,
`mesh.transition.pyramid_tet`, `mesh.exact_layer_count`,
`fem.cpu.exchange_demag.mixed_p1`, and
`fem.gpu.exchange_demag.mixed_p1`.

`layers=1` means exactly two magnetic node planes and one three-dimensional
prism layer. It is not a shell, 2.5D, or thickness-averaged model.

Requested topology, exact layer count, device, precision, demag model, and
workflow remain distinct from the realized mesh certificate and resolved
execution lane. Strict mode accepts only an exact realization with
`fallbacks_triggered=[]`. It never calls a prism-to-tet splitter, silently
chooses a free-tetrahedral mesh, or falls back from GPU to CPU.

We reject these alternatives:

- **Tet conversion:** changes the authored topology and hides exact-layer
  failure.
- **Nonconforming magnetic and air domains:** requires an explicit mortar/Nitsche
  contract that the first slice does not define and breaks shared-node Poisson
  semantics.
- **2.5D or thickness averaging:** changes the physical approximation instead
  of implementing the requested 3D P1 mesh.
- **A second FEM stack in Rust:** conflicts with `backends/fem` ownership and
  MFEM/hypre/libCEED CPU/GPU architecture.

## Consequences

Positive:

- authored topology and realized solver topology can agree exactly;
- magnetic prism resolution is decoupled from far-air tetrahedral size;
- conforming shared-node exchange/Poisson assembly remains possible;
- CPU/GPU can implement one topology, sign, unit, and certificate contract.

Remaining costs and risks:

- MFEM/libCEED operators, quadrature, and quality validation must become
  mixed-topology aware; typed mesh containers, native ABI, artifacts,
  transport, and viewport code already preserve variable-width topology;
- `pyramid5` needs an explicit first-order reference basis and quadrature/Jacobian
  validation, not tetrahedral truncation;
- FMMT v1 cannot represent mixed cells safely; v2 is the typed transport path
  while v1 remains a tetrahedral compatibility reader.

## Implementation obligations

1. Canonical cell/facet enums and variable-width connectivity are implemented
   in Python, `ProblemIR`, mesh artifacts, and the native ABI.
2. Validate topology/physics legality before backend startup. Until separately
   qualified, reject FEM/BEM, PBC/Floquet, DMI/STT/thermal/magnetoelastic,
   regional projections, eigen/frequency-domain, DG0/material interfaces,
   order greater than one, arbitrary OCC shapes, multiple bodies, and
   multilayers.
3. Keep production element import, H1 spaces, basis/quadrature, exchange,
   Poisson, relaxation, and certificate generation under `backends/fem`.
4. Implement CPU/MFEM/hypre and GPU/MFEM/libCEED/CUDA as separate realizations
   of the same contract. Forced unsupported lanes fail closed.
5. Bind the exact-layer/shared-domain certificate to mesh and material hashes,
   including plane count/tolerance, cell/facet ownership, shared node IDs,
   manifoldness, positive order-2-or-higher Jacobians, relative volume error,
   honest quality metric, and fallback list.
6. FMMT v2 implements canonical type enums, offsets plus connectivity,
   per-cell/per-facet markers, and range-readable versioned metadata. OpenAPI,
   serializer, range/header logic, generated frontend types, decoder, adapters,
   viewport, selection, and mesh inspectors consume that representation.
7. Preserve FMMT v1 and the tetrahedral reader only for version-1 tetrahedral
   sessions. Remove the temporary legacy reader after all supported writers emit
   v2, API and control-room consumers decode v2, persisted v1 compatibility has
   a tested migration/read path, and two consecutive releases record no active
   production dependence on the v1-only runtime path.
8. Publish implementation, executable, and validated states independently.
   The checked-in Gmsh fixture is feasibility evidence only.

## Migration and rollback

Migration is additive and fail-closed. Completed transport slices and remaining
operator slices are deliberately separate:

1. freeze the physics contract and Gmsh 4.15.2 feasibility fixture;
2. add typed enums, versioned containers, planner rejection, and exact
   certificate without changing the default tetrahedral execution path;
3. add FMMT v2/OpenAPI/control-room support;
4. add CPU mixed-P1 operators and managed validation;
5. add GPU double operators and same-mesh parity;
6. enable the narrow qualified workload only after all layer gates pass;
7. retire the v1-only reader under the criterion above.

Rollback before promotion disables the mixed-P1 capability and continues to
read existing tetrahedral FMMT v1 sessions. Rollback must not reinterpret a
mixed request as tetrahedral, delete requested intent, or downgrade validation
requirements.

## Validation

- Gmsh 4.15.2 Box-in-Box feasibility: prism-only film, pyramid/tet-only air,
  two magnetic node planes, tri/quad film facets, conforming enclosure, and
  manifold face ownership without the production splitter.
- Element basis, trace, quadrature, Jacobian, material-mask, and manufactured
  solution tests for every topology.
- Exchange directional derivative and Poisson sign/convergence gates.
- PG-BB, NCG, and overdamped-LLG gates on the exact same certified mesh.
- Planner rejection matrix for every deferred feature and forced lane.
- FMMT v2 encode/decode/range/malformed/stale tests and browser mesh smoke.
- Container-backed managed FEM CPU and strict GPU double runtime evidence.

## References

- `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- `docs/architecture/backend-golden-masterplan.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- `docs/adr/0011-resource-first-api.md`
