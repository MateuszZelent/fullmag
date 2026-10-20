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

The next scoped workload is the tracked CoFeB-ring example. It contains a
swept `prism6` magnetic layer and a spatially disconnected `tet4` magnetic
ring in the same airbox. The gap is part of the model: demagnetization couples
the bodies through air, while exchange remains body-local. The lower ring in
that source is commented out and is not part of the acceptance fixture.

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
`fem.gpu.exchange_demag.mixed_p1`. The implemented source-contract extension
also defines `mesh.topology.mixed_p1.v2.disconnected_bodies`,
`fem.cpu.exchange_demag.mixed_p1.disconnected_bodies`, and
`fem.gpu.exchange_demag.mixed_p1.disconnected_bodies` without changing the
meaning of the v1 IDs. These v2 IDs are not public executable or validated
capabilities until managed runtime, operator, parity, and physics evidence is
available.

The bounded relaxation implementation accepts exact `layers` in `{1, 2, 3}`.
For any accepted count `L`, requested and realized counts are both `L` and the
magnetic mesh has exactly `L+1` node planes. In particular, `layers=1` means
exactly two magnetic node planes and one three-dimensional prism layer. None of
these meshes is a shell, 2.5D, or thickness-averaged model.

(mixed-p1-v2-disconnected-bodies)=
<!-- DOC-ANCHOR:mixed-p1-v2-disconnected-bodies -->
The existing `mixed_layer_topology_certificate.v1` keeps its single magnetic
prism meaning. The implemented source-contract `v2` certificate describes
multiple magnetic body regions and mixed magnetic cell families (`prism6` for
the swept body and `tet4` for a disconnected body). It binds body/material
markers, applies exact-layer evidence only to the swept region, and carries a
measured positive gap/contact result. v1 readers reject v2; v2 must never be
encoded as a v1 single-marker certificate. Managed runtime, operator execution,
CPU/GPU parity, and physics qualification remain **NOT VERIFIED**.

For a positive-gap pair, body-owned nodal-P1 `Ms`, `Aex`, `alpha`, anisotropy
coefficients and axes are sufficient. Their interpolation is evaluated only
inside the owning magnetic body. No coefficient is smoothed through the air
or averaged across body ownership. A touching or overlapping pair is outside
this decision until a dedicated conforming interface or DG0 exchange/energy
operator is defined; it must fail closed rather than silently choosing a
nodal value.

The initial native geometry proof is limited to strictly separated body
AABBs, with the positive AABB distance used as a conservative lower bound.
Overlapping boxes return an unavailable proof even when the underlying bodies
could be disjoint. Air cells incident to two body boundaries remain legal:
only magnetic cells/shared magnetic node ownership create an exchange bridge.
This bound does not add a narrow-phase contact solver or a new interaction.

For the HXT request, the implemented source realization records the requested
algorithm separately from algorithm 1 for quad/pyramid transition volumes and
algorithm 10 for the remaining tetrahedral volumes. Note 0106 owns this bounded
hybrid meshing policy and the independent faceted-boundary volume-integrity
proof; neither changes the requested exact prism layers or claims CAD
convergence. Managed runtime and physics qualification remain **NOT VERIFIED**.

The v2 wire shape is owned by canonical note 0106. Its required top-level
fields are `schema_version`, `certificate_status`, `magnetic_regions[]`,
`body_separation_pairs[]`, `body_material_fields[]`, and
`fallbacks_triggered`. The note defines the typed nested records, SI units,
ordering and SHA-256 material-field binding; this ADR only fixes their
versioning, fail-closed compatibility and CPU/GPU ownership.

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
- **One unowned global scalar field:** a single coefficient field without an
  explicit body marker and ownership relation can create exchange or
  coefficient interpolation across an air gap. A global nodal array is legal
  only when every value is explicitly bound to one body, its node order and
  material marker under the v2 body-field digest contract.
- **Reusing certificate v1 for multi-body meshes:** hides mixed magnetic cell
  families and makes old readers accept an unverified topology.
- **Implicit contact averaging:** has no defined exchange trace or energy law
  at a sharp interface.
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
2. Validate topology/physics legality before backend startup. Certificate v1
   rejects FEM/BEM, PBC/Floquet, DMI/STT/thermal/magnetoelastic, regional
   projections, eigen/frequency-domain, DG0/material interfaces, order greater
   than one, arbitrary OCC shapes, multiple bodies, and multilayers. The
   implemented certificate-v2 source path admits only positive-gap disconnected
   bodies under the dedicated body-marker and material-field contract; all
   contact, overlap and explicit interlayer-exchange cases remain rejected.
   Managed runtime, operator execution, CPU/GPU parity, and physics
   qualification for this v2 path remain **NOT VERIFIED**.
3. Keep production element import, H1 spaces, basis/quadrature, exchange,
   Poisson, relaxation, and final execution preflight under `backends/fem`.
   Keep language-neutral certificate evidence computation and validation in
   `fullmag-ir`, with the implemented source owners
   `crates/fullmag-ir/src/mixed_certificate.rs` and
   `crates/fullmag-ir/src/mixed_certificate_v2.rs`; they consume typed realized
   topology and do not own meshing, MFEM assembly, or solver execution. The v1
   owner and its typed PyO3 bridge retain their existing host-unit/extension
   qualification; that evidence does not qualify the v2 source implementation. Artifact v2
   persistence calls that validator with explicit native-required save
   semantics and binds its result in a deterministic receipt; public full audit
   records a Python fallback as non-production, and private fast trust requires
   native structural preflight. Managed FEM runtime use remains not verified.
   This persistence boundary does not move element import,
   basis/quadrature, operators, or execution acceptance out of `backends/fem`.
   The final backend preflight remains mandatory before MFEM state or operators
   are allocated.
4. Implement CPU/MFEM/hypre and GPU/MFEM/libCEED/CUDA as separate realizations
   of the same contract. Forced unsupported lanes fail closed.
5. Bind the exact-layer/shared-domain certificate to mesh and material hashes,
   including plane count/tolerance, cell/facet ownership, shared node IDs,
   manifoldness, positive order-2-or-higher Jacobians, relative volume error,
   honest quality metric, and fallback list.
6. FMMT v2 implements canonical type enums, offsets plus connectivity,
   per-cell/per-facet markers, and range-readable versioned metadata. The
   reserved 64-byte header stores optional cell/facet global-ordinal counts at
   byte offsets 40/44. A count is zero for legacy v2 or exactly matches its
   entity count; nonzero counts select aligned trailing `u64` cell/facet
   ordinal sections after the marker sections. The serializer, range/header
   logic, decoder, topology-index builder, viewport triangulation, and surface
   selection consume that representation. Histogram and Inspector integration
   are outside this bounded transport change.
7. Preserve FMMT v1 and the tetrahedral reader only for version-1 tetrahedral
   sessions. Remove the temporary legacy reader after all supported writers emit
   v2, API and control-room consumers decode v2, persisted v1 compatibility has
   a tested migration/read path, and two consecutive releases record no active
   production dependence on the v1-only runtime path.
8. Publish implementation, executable, and validated states independently.
   The checked-in Gmsh fixture is feasibility evidence only.
9. Restrict receipt-based fast loading to internal content-addressed v2 cache
   entries with exact expected bindings and native structural preflight. Public,
   imported, forced-audit, and legacy-v1 loads perform a full audit. Missing
   native preflight bypasses fast trust; managed and release audits fail closed
   without the native certifier. Generic/non-mixed persistence or incomplete
   producer provenance remains v1 rather than inventing receipt fields.
10. Add certificate v2 as an additive schema. It must record per-body magnetic
    cell-family membership, markers, exact-sweep evidence, positive-gap/contact
    evidence, and body-local material realization while retaining every v1
    topology, quality, manifold, facet-marker and fingerprint proof. Unknown
    versions fail closed.
11. Extend MFEM CPU and libCEED/CUDA GPU operators to assemble the body sum of
    exchange, material-weighted mass/damping, and magnetic-cell Poisson source;
    the two lanes must preserve identical marker, quadrature, sign, and unit
    semantics. A forced GPU request has no CPU fallback.
12. Keep contact interfaces and explicit interlayer exchange outside this
    extension until their interface operator, units, provenance, and validation
    are separately specified.

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
7. complete the additive v2 certificate and disconnected-body planner/native
   source contracts without changing v1 readers; this implementation status is
   source/contract only and is not runtime qualification;
8. qualify the exact CoFeB-ring CPU/GPU workload only after gap, marker,
   operator, and physics gates pass;
9. retire the v1-only reader under the criterion above.

Rollback before promotion disables the mixed-P1 capability and continues to
read existing tetrahedral FMMT v1 sessions. Rollback must not reinterpret a
mixed request as tetrahedral, delete requested intent, or downgrade validation
requirements.

## Validation

- Gmsh 4.15.2 Box-in-Box feasibility and regression fixtures: prism-only film,
  pyramid/tet-only air, exact `L+1` magnetic node planes for
  `L in {1, 2, 3}`, tri/quad film facets, conforming enclosure, and manifold
  face ownership without the production splitter.
- Element basis, trace, quadrature, Jacobian, material-mask, and manufactured
  solution tests for every topology.
- Exchange directional derivative and Poisson sign/convergence gates.
- PG-BB, NCG, and overdamped-LLG gates on the exact same certified mesh.
- Planner rejection matrix for every deferred feature and forced lane.
- Certificate-v2 fixtures with one swept prism body and one disconnected tet4
  body, including positive-gap, no-bridging, marker ownership, and v1-reader
  rejection cases.
- Body-local material tests for `Ms`, `Aex`, `alpha`, uniaxial coefficients and
  axes; exchange must have no cross-gap contribution, while Poisson demag must
  couple both bodies.
- Contact/overlap negative tests proving that missing interface operators,
  nodal averaging and hidden coefficient smoothing fail closed.
- Exact CoFeB-ring one-step CPU/GPU operator parity and later relaxation
  evidence, with explicit device identity and no fallback.
- FMMT v2 encode/decode/range/malformed/stale tests and browser mesh smoke.
- Container-backed managed FEM CPU and strict GPU double runtime evidence.

## References

- `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md` defines the
  common size-policy algebra, exact-layer/in-plane distinction, metric evidence,
  and FMMQ compatibility envelope without widening this ADR's bounded topology
  decision.
- `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- `docs/architecture/backend-golden-masterplan.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- `docs/adr/0011-resource-first-api.md`
