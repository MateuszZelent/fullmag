# FEM mixed prism/pyramid shared-domain mesh

- Status: canonical target contract; feasibility fixture only
- Owners: Fullmag core
- Last updated: 2026-07-27
- Related ADRs: `docs/adr/0021-native-mixed-p1-fem-topology.md`
- Related specs:
  - `docs/specs/capability-matrix-v0.md`
  - `docs/architecture/backend-golden-masterplan.md`
- Related physics:
  - `docs/physics/0101-swept-mesh-through-thickness.md`
  - `docs/physics/0104-thin-film-shared-domain-meshing.md`
  - `docs/physics/0105-fem-meshing-production-acceptance.md`
  - `docs/physics/fem_demag_poisson.md`
  - `docs/physics/0900-native-fem-operator-contracts-and-validation.md`

## 1. Problem statement

Thin magnetic films need an exact number of three-dimensional elements through
their thickness without forcing the complete Poisson airbox to the same thin
scale. The target solver mesh is one conforming shared domain with:

- `prism6` cells in the magnetic Box;
- `pyramid5` cells only in the air transition adjoining magnetic `quad4`
  facets;
- `tet4` cells in the remaining air;
- `tri3 | quad4` boundary and interface facets.

This note makes that topology implementation-ready. It does not make mixed
elements executable in Fullmag. The current Python extraction, `MeshIR`, native
ABI, MFEM spaces/operators, FMMT v1 transport, and control-room decoder remain
tetrahedral contracts until later slices replace or version them.

The first qualification target is deliberately narrow: one axis-aligned
`Box`, P1, one conforming shared-domain airbox, uniform `Ms` and `Aex`, exchange,
uniform Zeeman, Poisson Robin or Dirichlet demag, FEM CPU/GPU double precision,
and PG-BB, NCG, or overdamped LLG relaxation. No status in this slice advances
from `unsupported` or `semantic_only` to `production_executable` or `validated`.

## 2. Physical model

### 2.1 No-new-physics statement

Mixed topology changes the spatial approximation only. It introduces no new
energy, field, torque, material law, demagnetization model, or boundary
condition. The same reduced magnetization is used in the magnetic domain:

```text
|m(x)| = 1
M(x) = Ms m(x)
```

Exchange and uniform Zeeman retain their existing contracts, for example:

```text
E_ex = integral_Omega_m Aex |grad(m)|^2 dV
E_Z  = -mu0 integral_Omega_m M . H_ext dV
```

### 2.2 Scalar Poisson demagnetization and signs

For the shared domain `D = Omega_m union Omega_air`, Fullmag uses magnetic
scalar potential `phi` with:

```text
laplace(phi) = div(M) in D, with M = 0 in Omega_air
H_demag = -grad(phi)
```

The corresponding volume weak-form source convention is:

```text
integral_D grad(phi) . grad(v) dV
  = integral_Omega_m M . grad(v) dV
```

with the existing Dirichlet or Robin outer-airbox boundary terms applied by the
selected Poisson boundary policy. Demagnetization energy keeps the existing
sign:

```text
E_demag = -0.5 mu0 integral_Omega_m M . H_demag dV
          + boundary_term
```

where `boundary_term` exists only for the boundary model that requires it.
Prism, pyramid, and tetrahedron assembly must reproduce these signs exactly.

### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | reduced magnetization | `1` |
| `M` | magnetization | `A/m` |
| `Ms` | saturation magnetization | `A/m` |
| `Aex` | exchange stiffness | `J/m` |
| `H_ext`, `H_demag` | magnetic field | `A/m` |
| `phi` | magnetic scalar potential | `A` |
| `mu0` | vacuum permeability | `N/A^2` |
| `t` | magnetic film thickness | `m` |
| `layers` | magnetic elements through thickness | `1` |
| `tau_plane` | node-plane comparison tolerance | `m` |
| `J_K` | element-map Jacobian determinant | `m^3` |

All public geometry and mesh sizes remain SI metres. The checked-in Gmsh
fixture uses normalized geometry because it certifies topology, not physical
scale; production certificates apply the SI tolerances below after realization.

### 2.4 Assumptions and validity limits

- The first geometry is one axis-aligned magnetic Box strictly inside one
  axis-aligned shared-domain airbox.
- `layers=1` means exactly two magnetic node planes and one prism cell layer.
- One prism layer is still a three-dimensional P1 discretization. It is not a
  thickness-averaged, 2.5D, shell, or macrospin model.
- `Ms` and `Aex` are uniform in the first qualification workload.
- The magnetic domain contains only `prism6`; `pyramid5` and `tet4` are air
  cells and must never carry a magnetic material marker.
- The first supported facets are `tri3 | quad4` and the polynomial/order
  contract is P1 only.
- Strict mode never splits prisms into tetrahedra and never silently replaces
  mixed topology with a free-tetrahedral mesh.
- Unsupported topology, physics, device, precision, or workflow combinations
  reject before native backend startup.

## 3. Numerical interpretation

### 3.1 FDM

Not applicable. FDM retains its Cartesian-cell discretization. Mixed-P1 mesh
capabilities must not be advertised on FDM lanes or inferred as a hybrid path.

### 3.2 FEM shape spaces and traces

The target is a conforming first-order nodal H1 space across the mixed mesh.
`P1` here means the canonical first-order element for each topology, not one
tetrahedron-only polynomial implementation applied by truncating connectivity:

| Cell/facet | First-order interpretation | Conforming trace |
|---|---|---|
| `tet4` | affine barycentric Lagrange basis | `tri3` |
| `prism6` | triangle-P1 times interval-P1 wedge basis | `tri3` ends, `quad4` sides |
| `pyramid5` | first-order nodal pyramid basis with compatible rational reference mapping | `quad4` base, `tri3` sides |
| `tri3` | affine triangular trace | three shared vertex DOFs |
| `quad4` | bilinear quadrilateral trace | four shared vertex DOFs |

Every geometric interface vertex has one shared global node ID. Operators must
use topology-aware maps, basis values, reference gradients, quadrature, and
Jacobian transforms. Treating the first four nodes of a prism or pyramid as a
tetrahedron is invalid.

The magnetic vector field and material coefficients are defined only on
magnetic prisms. Scalar Poisson potential spans magnetic prisms plus air
pyramids/tetrahedra. Magnetic masking, integration, field recovery, and
visualization must follow region ownership rather than node membership alone,
because interface nodes are shared.

### 3.3 FEM CPU and GPU

CPU/MFEM/hypre and GPU/MFEM/libCEED/CUDA are separate realizations of this one
contract. They may use different kernels or assembly strategies, but must agree
on connectivity order, basis traces, signs, material masks, energy ownership,
quadrature sufficiency, requested/resolved provenance, and rejection reasons.

The target is double precision only. No CPU or GPU runtime claim exists until
the lane has topology-aware import, assembly, operator, relaxation, artifact,
and managed-runtime validation. Forced GPU cannot fall back to CPU, and neither
lane may call the legacy prism-to-tet compatibility splitter in strict mode.

### 3.4 Exact-layer and shared-domain certificate

An accepted realized mesh must emit a certificate bound to the mesh topology
hash and region/material realization. For the first workload it proves:

1. `layers=1` resolves to exactly two magnetic normal-coordinate node planes;
2. magnetic cells are all canonical `prism6`;
3. no `pyramid5` or `tet4` carries a magnetic marker;
4. the film-air interface uses conforming shared node IDs and one face record;
5. each interior face has exactly two owners, each exterior face one owner, and
   no duplicate, orphan, or non-manifold face exists;
6. top/bottom magnetic facets are `tri3`, lateral magnetic facets are `quad4`;
7. the mapped Jacobian is positive at quadrature order at least 2 for every
   cell;
8. the normal-plane tolerance is
   `tau_plane = max(1e-15 m, 1e-8 * film_thickness)`;
9. relative CAD-versus-shared-domain volume error is at most `1e-8`;
10. p05 SICN is at least `0.1`, or the report uses an honestly named
    scaled-Jacobian metric and does not label it SICN;
11. strict execution reports `fallbacks_triggered=[]`.

The certificate fails closed. A warning, inferred layer count, clipped cell,
tet conversion, or unversioned connectivity does not satisfy it.

### 3.5 Hybrid

Unsupported. A future hybrid workflow requires explicit projection and
state-transfer semantics and cannot inherit this capability by sharing a mesh
file.

## 4. API, IR, planner, runtime, and product impact

### 4.1 Python API surface

The existing physics-first swept controls remain the intended authoring entry:
an axis-aligned Box requests a swept prism strategy and exact layer count. A
later implementation slice must define the canonical enum values and export
them without exposing Gmsh element IDs or algorithm names. Python-to-IR-to-UI-
to-Python round-trip must preserve requested topology and exact layer count.

This note adds no executable Python API. Existing tetrahedral lowering remains
the only public executable path and must reject, not pretend to realize, the
new strict mixed-P1 request until implementation lands.

### 4.2 ProblemIR representation and normalization

The target `ProblemIR` needs backend-neutral enums for:

```text
cell topology: prism6 | pyramid5 | tet4
facet topology: tri3 | quad4
mesh topology family: mixed_p1
exact layer count: positive integer
```

Gmsh numeric element IDs are import details and must not enter the public IR.
Validation must keep requested topology, sweep direction, and exact layer count
separate from the realized certificate. No migration may reinterpret an old
tetrahedral mesh as mixed-P1.

### 4.3 Planner and capability matrix

The target vocabulary is:

```text
mesh.topology.mixed_p1
mesh.swept.prism
mesh.transition.pyramid_tet
mesh.exact_layer_count
fem.cpu.exchange_demag.mixed_p1
fem.gpu.exchange_demag.mixed_p1
```

All six capabilities are `semantic_only` or `unsupported` in this slice. The
first legal target is strict/extended FEM, CPU or GPU, double precision, the
narrow workload in Section 1, and no fallback. `auto` may select a lane only
after that lane advertises the exact complete capability set; it must preserve
requested and resolved choices.

Until separately qualified, planning rejects FEM/BEM demag, PBC/Floquet,
DMI/STT/thermal/magnetoelastic terms, regional projections, eigen/frequency-
domain studies, DG0/material interfaces, order greater than one, arbitrary OCC
shapes, multiple bodies, and multilayers.

### 4.4 Runtime, ABI, and native ownership

Production topology import, basis/quadrature, exchange, Poisson RHS/solve/
recovery, relaxation, and certificate generation belong under `backends/fem`.
Rust runner code owns orchestration, typed ABI lowering, requested/resolved
provenance, artifacts, and rejection before startup; it must not implement a
second FEM solver or hidden element conversion.

The native ABI must carry typed, variable-width cell/facet connectivity or an
equivalent versioned descriptor. Fixed `tet4`/`tri3` buffers cannot encode this
contract. CPU and GPU readiness probes must reject an ABI/topology version they
do not understand before allocating solver state.

### 4.5 API, binary transport, and control room

FMMT v1 fixes every volume element at four indices and every boundary face at
three. Mixed topology therefore requires an FMMT v2 design with explicit
canonical type enums, offsets plus connectivity, per-cell/per-facet markers,
and versioned byte-range metadata. The OpenAPI descriptions, server serializer,
header/range reader, generated TypeScript, decoder, domain adapter, viewport
triangulation, selection, histogram, and inspector surfaces must change in one
later resource-first slice. FMMT v1 remains readable for tetrahedral sessions;
it must never carry disguised or truncated mixed cells.

The UI must show requested topology, realized topology counts, certificate
status, quality metric identity, exact-layer result, and explicit rejection or
degradation. Any rendering-only triangulation of quads is derived display data
and cannot replace solver topology or alter physics.

In the unified workspace, a future Mesh-module command is capability-gated and
uses the central command registry; resource hooks fetch revisioned FMMT v2
topology; the FEM domain adapter preserves typed cells/facets; viewport layers
derive render triangles without mutating solver connectivity; and the existing
mesh Inspector/dock displays the certificate and rejection reason. This target
does not introduce another workspace shell, direct component fetch, or a new
docking model.

### 4.6 Artifacts and provenance

At minimum, artifacts must record:

- requested and resolved topology family, layer count, device, precision,
  demag boundary model, and relaxation algorithm;
- canonical cell/facet counts by topology and region;
- mesh and material-realization hashes;
- the complete exact-layer/shared-domain certificate;
- Gmsh version and deterministic meshing inputs;
- `fallbacks_triggered`, with strict acceptance requiring an empty list;
- implementation, execution, and validation states independently.

The checked-in Gmsh 4.15.2 fixture is reproducible feasibility evidence only.
It is not runtime, MFEM, CPU/GPU, physics, API, or viewport proof.

## 5. Validation strategy

### 5.1 Feasibility and topology checks

`packages/fullmag-py/tests/test_mixed_element_meshing.py` loads the frozen GEO
fixture with Gmsh 4.15.2 and checks prism-only film, pyramid/tet-only air, two
magnetic planes, tri/quad film facets, complete conforming film enclosure,
manifold face ownership, and absence of the production prism-to-tet splitter.
It freezes topology invariants, not incidental air-tet counts.

### 5.2 Operator checks

Before executable promotion, each lane needs:

- reference basis/gradient/Jacobian and quadrature tests for prism6, pyramid5,
  tet4, tri3, and quad4;
- constant-field and linear-manufactured-solution patch tests across mixed
  interfaces;
- exchange directional-derivative and convergence tests;
- manufactured Poisson solution and RHS/sign tests across all three cell types;
- Dirichlet/Robin airbox convergence and existing sphere/ellipsoid demag gates;
- PG-BB/NCG energy-descent and overdamped-LLG trajectory/stop-reason gates;
- same-mesh CPU/GPU double parity with strict no-fallback provenance.

### 5.3 Cross-layer and product checks

- Python/ProblemIR/UI script round-trip for topology and exact layer count;
- planner accept/reject matrix for every listed supported and unsupported lane;
- ABI malformed/mixed-version rejection;
- FMMT v2 encode/decode, range, marker, and stale-revision tests;
- control-room mesh inspection and WebGL browser smoke;
- artifact schema and certificate tamper/staleness tests;
- managed container runtime gates for FEM CPU and strict FEM GPU.

### 5.4 Promotion levels

- `implemented`: source and contract tests exist for the complete affected
  layer.
- `production_executable`: the public lane executes the stated workload through
  the managed runtime with no hidden conversion or fallback.
- `validated`: topology, operators, physics, lane parity, artifacts, and product
  gates pass for the documented workload.

No lower level implies a higher one.

## 6. Completeness checklist

- [x] Canonical physical/numerical target and units
- [x] First-slice legality and fail-closed unsupported matrix
- [x] Exact-layer/shared-domain certificate target
- [x] Frozen Gmsh 4.15.2 feasibility fixture
- [ ] Executable Python API and round-trip
- [ ] ProblemIR enums, validation, and migration
- [ ] Planner implementation and machine-readable capabilities
- [ ] Variable-width mesh container and native ABI
- [ ] FEM CPU mixed-element operators
- [ ] FEM GPU mixed-element operators
- [ ] FMMT v2, OpenAPI, generated client, and viewport
- [ ] Managed runtime and physics validation
- [ ] Production qualification report

## 7. Known limits and deferred work

- Arbitrary OCC shapes, cylinders, imported CAD/STL, multiple bodies, and
  multilayers are deferred.
- PBC/Floquet, FEM/BEM/FMM, frequency-domain/eigen, DMI, STT, thermal,
  magnetoelasticity, regional projections, DG0/material-interface publication,
  and order greater than one are deferred.
- Adaptive remeshing and state transfer across mixed topology are deferred.
- Single precision and every hybrid execution path are deferred.
- The feasibility fixture does not select or validate production Gmsh meshing
  algorithms, quality budgets, performance, or runtime memory residency.

## 8. References

- Gmsh 4.15.2 reference manual, structured grids and QuadTri transitions.
- MFEM first-order H1 finite elements for tetrahedra, wedges, and pyramids.
- `docs/physics/0105-fem-meshing-production-acceptance.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
