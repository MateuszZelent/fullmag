# FEM mixed prism/pyramid shared-domain mesh

- Status: bounded FEM CPU/GPU double mixed-P1 relaxation lanes implemented in source/contracts; managed public-runtime proof pending; wider scopes fail closed
- Owners: Fullmag core
- Last updated: 2026-07-30
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

(problem-statement)=
## 1. Problem statement

Thin magnetic films need an exact number of three-dimensional elements through
their thickness without forcing the complete Poisson airbox to the same thin
scale. The target solver mesh is one conforming shared domain with:

- `prism6` cells in the magnetic Box;
- `pyramid5` cells only in the air transition adjoining magnetic `quad4`
  facets;
- `tet4` cells in the remaining air;
- `tri3 | quad4` boundary and interface facets.

This note makes that topology implementation-ready. Python authoring and Gmsh
extraction, `MeshIR`, the runner/native ABI, the mixed-layer certificate, FMMT
v2 transport, OpenAPI resources, and the control-room decoder/viewport already
preserve typed variable-width topology. The certified topology is implemented
through only the bounded CPU and GPU lanes below. Every wider physics, geometry,
precision, device, or workflow tuple remains fail-closed before native operator
startup.

The first qualification target is deliberately narrow: one axis-aligned
`Box`, P1, one conforming shared-domain airbox, exact layer count in
`{1, 2, 3}`, uniform `Ms` and `Aex`, exchange,
uniform Zeeman, Poisson Robin or Dirichlet demag, explicit FEM CPU or GPU double
precision, strict execution, and PG-BB, NCG, or overdamped LLG relaxation.
Those exact certificate-bound device tuples are currently `implemented`, not
`production_executable` or `validated`, because no immutable managed public
CPU/GPU SP4 runtime report exists yet. Device `auto`, single/extended/hybrid
execution, and wider tuples remain `unsupported`; no fallback is permitted.

(governing-equations)=
## 2. Physical model and governing equations

### 2.1 No-new-physics statement

Mixed topology changes the spatial approximation only. It introduces no new
energy, field, torque, material law, demagnetization model, or boundary
condition. The same reduced magnetization is used in the magnetic domain.

```{math}
:label: eq-mixed-p1-magnetization

\lVert \mathbf m(\mathbf x) \rVert = 1,
\qquad
\mathbf M(\mathbf x) = M_s \mathbf m(\mathbf x).
```

Exchange and uniform Zeeman retain their existing contracts.

```{math}
:label: eq-mixed-p1-exchange-zeeman

E_{\mathrm{ex}}
= \int_{\Omega_m} A_{\mathrm{ex}}\lVert\nabla\mathbf m\rVert^2\,\mathrm dV,
\qquad
E_{\mathrm Z}
= -\mu_0\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm{ext}}\,\mathrm dV.
```

### 2.2 Scalar Poisson demagnetization and signs

For the shared domain $D=\Omega_m\cup\Omega_{\mathrm{air}}$, Fullmag uses
magnetic scalar potential $\phi$ with

```{math}
:label: eq-mixed-p1-demag-strong

\nabla^2\phi=\nabla\cdot\mathbf M\quad\text{in }D,
\qquad
\mathbf M=\mathbf 0\quad\text{in }\Omega_{\mathrm{air}},
\qquad
\mathbf H_{\mathrm{demag}}=-\nabla\phi.
```

The corresponding volume weak-form source convention is

```{math}
:label: eq-mixed-p1-demag-weak

\int_D \nabla\phi\cdot\nabla v\,\mathrm dV
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV.
```

with the existing Dirichlet or Robin outer-airbox boundary terms applied by the
selected Poisson boundary policy. Demagnetization energy keeps the existing
sign:

```{math}
:label: eq-mixed-p1-demag-energy

E_{\mathrm{demag}}
=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm{demag}}\,\mathrm dV
+E_{\partial D}.
```

where `boundary_term` exists only for the boundary model that requires it.
Prism, pyramid, and tetrahedron assembly must reproduce these signs exactly.

(symbols-and-si-units)=
### 2.3 Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ext}}$ | external magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{demag}}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\phi$ | magnetic scalar potential | $\mathrm{A}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $\Omega_{\mathrm{air}}$ | air domain | $\mathrm{m^3}$ |
| $D$ | conforming shared domain | $\mathrm{m^3}$ |
| $v$ | scalar H1 test function | $1$ |
| $E_{\mathrm{ex}}$ | exchange energy | $\mathrm{J}$ |
| $E_{\mathrm Z}$ | Zeeman energy | $\mathrm{J}$ |
| $E_{\mathrm{demag}}$ | demagnetization energy | $\mathrm{J}$ |
| $E_{\partial D}$ | demagnetization boundary contribution | $\mathrm{J}$ |
| $t$ | magnetic film thickness | $\mathrm{m}$ |
| $L$ | requested and realized prism-cell layers | $1$ |
| $\tau_{\mathrm{plane}}$ | node-plane comparison tolerance | $\mathrm{m}$ |
| $J_K$ | element-map Jacobian determinant | $\mathrm{m^3}$ |
| $N_i$ | scalar P1 nodal basis function | $1$ |
| $M_{ij}$ | scalar mass-matrix entry | $\mathrm{m^3}$ |
| $w_i$ | magnetic nodal volume weight | $\mathrm{m^3}$ |

All public geometry and mesh sizes remain SI metres. The checked-in Gmsh
fixture uses normalized geometry because it certifies topology, not physical
scale; production certificates apply the SI tolerances below after realization.

(assumptions-and-validity)=
### 2.4 Assumptions and validity limits

- The first geometry is one axis-aligned magnetic Box strictly inside one
  axis-aligned shared-domain airbox.
- The implemented exact-layer set is $L\in\{1,2,3\}$; a request is accepted
  only when requested and realized counts both equal $L$ and the magnetic mesh
  has exactly $L+1$ normal-coordinate node planes.
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

(discrete-realization)=
## 3. Discrete realization and backend interpretation

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

#### 3.2.1 Nodal volume weights and material averaging

For the qualified P1 mixed path, nodal volume weights are the row sums of the
MFEM scalar mass matrix assembled only over magnetic volume attributes:

```{math}
:label: eq-mixed-p1-mass-weights

M_{ij}=\int_{\Omega_m}N_iN_j\,\mathrm dV,
\qquad
w_i=\sum_jM_{ij}=\int_{\Omega_m}N_i\,\mathrm dV.
```

The runtime must assemble this operator with the geometry-specific MFEM basis,
quadrature, and Jacobian for each cell family. It must not substitute
`cell_volume / local_node_count`, `volume / 4`, or a tetrahedral formula for a
wedge or pyramid. Partition of unity gives the required conservation check:

```{math}
:label: eq-mixed-p1-volume-conservation

\sum_i w_i=\operatorname{vol}(\Omega_m).
```

The canonical runtime weight vector is the MFEM mass-row-sum result. Any
compatibility view of nodal volumes must be synchronized from that vector after
assembly and cannot remain an independent integration rule.

For uniform or nodal-P1 saturation magnetization, reported average reduced
magnetization keeps the existing lumped material/volume policy:

```{math}
:label: eq-mixed-p1-average-magnetization

\langle\mathbf m\rangle
=\frac{\sum_i M_{s,i}w_i\mathbf m_i}{\sum_i M_{s,i}w_i}.
```

The first mixed qualification uses uniform `Ms`, for which this reduction is
exact for P1 `m`. Sharp element-DG0 material coefficients retain their existing
exact tetrahedral element integration and remain rejected for any mesh
containing `prism6`, `pyramid5`, or `hex8`; they must never be projected onto
shared nodes as an implicit fallback.

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

The target is double precision only. The bounded explicit CPU and GPU lanes are
`implemented` in source, operator, planner, and startup contracts. Neither lane
is yet `production_executable` or `validated`; forced GPU cannot fall back to
CPU. Neither lane may call the legacy prism-to-tet compatibility splitter in
strict mode.

#### 3.3.1 Mixed-P1 GPU operator and residency contract

The first GPU implementation slice reuses topology-aware MFEM assembly during
runtime setup and executes the resulting sparse operators on the device. It
does not add prism- or pyramid-specific time-step kernels when the assembled
CSR operator already represents the same weak form. For one immutable topology
generation, setup must:

1. assemble the exchange stiffness and magnetic mass projection from magnetic
   `prism6` cells;
2. assemble Poisson stiffness and the selected Robin boundary mass over the
   complete conforming `prism6 | pyramid5 | tet4` domain;
3. assemble `B_x/B_y/B_z: m -> rhs` using only magnetic-cell quadrature and
   the existing positive weak-form source convention;
4. assemble `R_x/R_y/R_z: phi -> H_demag` using only magnetic-cell recovery
   weights, so shared interface nodes are not normalized by air-cell mass;
5. bind every operator to the accepted typed-topology fingerprint and the
   quadrature/material policy; and
6. upload each CSR structure and value buffer exactly once for that topology
   generation.

The accepted-step and rejected-trial hot loop keeps magnetization, Poisson RHS,
potential, recovered demag field, exchange field, effective field, and energy
reductions device-resident. Strict GPU execution rejects rather than selecting
`hybrid_cpu_poisson` or performing an implicit GPU-to-CPU fallback. Normal
controller decisions may publish bounded scalar diagnostics, but the qualifying
compute counters must report zero H2D bytes, zero D2H bytes, and zero host
synchronizations for field/operator evaluation after setup. Qualification must
inspect those raw counters, not infer clean residency from a derived status
boolean.

The same assembled operators serve PG-BB, nonlinear CG, and overdamped LLG;
the relaxators must not inspect fixed-width tetrahedral connectivity. Before
the GPU capability can move beyond `implemented`, a managed identical-topology
CPU/GPU run must prove matching topology fingerprints, correct CUDA/Hypre device
identity, `device_hypre_poisson`, empty fallback trails, same-state
field/energy/torque operator parity, and the residency counters above. The
bounded one-step gate evaluates this operator contract before either direct
minimizer takes its first step. Run schema
`fem_mixed_prism_airbox_runtime_run.v4` binds the exact initial magnetization
and topology to immutable step-0 `H_ex`, `H_demag`, and `H_eff` Zarr chunks and
the step-0 exchange, demagnetization, total-energy, and maximum-torque scalar
row. Comparison schema `fem_mixed_prism_airbox_cpu_gpu.v3` compares those
quantities only on magnetic nodes and preserves each lane's independent
accepted-step and residency proof. A passing step-0 comparison remains a
bounded operator proof, not a capability promotion or a converged-state proof.
Source tests, CUDA allocation tests, successful setup/rollback, or a comparison
of different first iterates do not promote executable or validated status.

### 3.4 Exact-layer and shared-domain certificate

An accepted realized mesh must emit a certificate bound to the mesh topology
hash and region/material realization. For the first workload it proves:

1. requested and realized layer counts are the same
   $L\in\{1,2,3\}$ and resolve to exactly $L+1$ magnetic
   normal-coordinate node planes;
2. magnetic cells are all canonical `prism6`;
3. no `pyramid5` or `tet4` carries a magnetic marker;
4. the film-air interface uses conforming shared node IDs and one face record;
5. each interior face has exactly two owners, each exterior face one owner, and
   no duplicate, orphan, or non-manifold face exists;
6. top/bottom magnetic facets are `tri3`, lateral magnetic facets are `quad4`;
7. the mapped Jacobian is positive at quadrature order at least 2 for every
   cell;
8. the normal-plane tolerance is given by the equation below;
9. relative CAD-versus-shared-domain volume error is at most `1e-8`;
10. p05 SICN is at least `0.1`, or the report uses an honestly named
    scaled-Jacobian metric and does not label it SICN;
11. strict execution reports `fallbacks_triggered=[]` in both the certificate
    and enclosing build report, and the build report has `degraded=false`.

```{math}
:label: eq-mixed-p1-plane-tolerance

\tau_{\mathrm{plane}}
=\max\!\left(10^{-15}\,\mathrm m,10^{-8}t\right).
```

The certificate fails closed. A warning, inferred layer count, clipped cell,
tet conversion, or unversioned connectivity does not satisfy it.

For $L=2$ or $L=3$, the mesher bounds the magnetic source-face target size by
$2t/L$ before extrusion. This local, deterministic refinement keeps the lateral
`quad4` prism faces and their incident transition pyramids within the unchanged
p05 scaled-Jacobian floor without globally refining the far-air tetrahedra. The
authored `hmax` remains an upper bound; the realized topology and derived local
refinement remain fingerprint-bound certificate evidence.

Cross-language certificate recomputation admits the bounded binary64
comparison

```text
abs(claimed - recomputed)
  <= max(1e-12 * max(abs(claimed), abs(recomputed)),
         16 * f64::EPSILON)
```

only for dimensionless `scaled_jacobian_minima_by_family`,
`scaled_jacobian_p05_by_family`, `magnetic_relative_volume_error`, and
`shared_domain_relative_volume_error`. This accounts for NumPy/LAPACK versus
direct-Rust determinant and reduction ordering. No other certificate field
inherits the `16 * f64::EPSILON` absolute allowance: dimensional Jacobians,
volumes, and related scalar evidence retain `1e-12` relative plus `1e-30`
absolute comparison, while bounds, plane coordinates, counts, markers, and
identities retain their field-specific fail-closed checks.

This certificate rule is distinct from the final-artifact magnetization
norm-defect rule in Section 4.6. The norm-defect check uses only an absolute
`16 * epsilon64` recomputation allowance over selected magnetic nodes and has
no `1e-12` relative term; sharing the same binary64 absolute constant does not
make the two validation contracts interchangeable.

#### 3.4.1 Language-neutral topology fingerprint v3

Accepted mixed-layer certificates emitted after this migration bind to topology
fingerprint `v3`. Version 3 hashes one language-neutral typed binary stream;
it never hashes Python, Rust, JSON, MessagePack, or FMMT serialization bytes.
The SHA-256 domain bytes are exactly
`fullmag:fem-mesh-topology-fingerprint:v3`, with no implicit NUL, newline, or
length prefix. The following payload follows those domain bytes in fixed order:

1. nodes;
2. cell types, offsets, connectivity, global ordinals, and mesh parts;
3. element markers;
4. facet types, roles, offsets, connectivity, and global ordinals;
5. boundary markers;
6. periodic boundary pairs in authored list order;
7. periodic node pairs in authored list order.

Every sequence begins with an unsigned 64-bit element count in little-endian
order. Connectivity indices, offsets, and markers are unsigned 32-bit
little-endian integers; global ordinals are unsigned 64-bit little-endian
integers. Each node and each present periodic translation is a fixed tuple of
exactly three binary64 values and therefore has no nested sequence count.
UTF-8 strings begin with their unsigned 64-bit byte length, so empty,
non-ASCII, and prefix-related values remain distinct. Optional fields begin
with exactly one byte (`0` absent, `1` present); any other tag is invalid.
Present empty strings remain distinct from absent strings.

Node coordinates, periodic translations, and periodic tolerances are encoded
as the exact IEEE-754 binary64 bit pattern written as an unsigned 64-bit
little-endian integer. Non-finite values reject before hashing. Signed zero is
preserved: `+0.0` and `-0.0` have different fingerprints because v3 binds to
the exact transported topology data rather than numerically normalizing it.

Stable enum tags are exactly one unsigned byte each:

| Field | Value | Tag |
|---|---|---:|
| cell type | `tet4`, `prism6`, `pyramid5`, `hex8` | `1`, `2`, `3`, `4` |
| cell mesh part | `magnetic`, `transition_air`, `far_air` | `1`, `2`, `3` |
| facet type | `tri3`, `quad4` | `1`, `2` |
| facet role | `exterior`, `material_interface`, `periodic_seam` | `1`, `2`, `3` |

Each periodic boundary pair encodes, in order: `pair_id`, optional
`source_marker`, optional `destination_marker`, `marker_a`, `marker_b`, optional
three-component `translation`, optional canonical `tolerance` (Python accepts
the legacy input alias `tolerance_m` but hashes the normalized field), optional
`axis_hint`, optional `orientation`, and optional `pairing_policy`. Each periodic
node pair encodes `pair_id`, `node_a`, and `node_b`. Pair and node-pair list
order is significant, exactly as in fingerprint v2.

`mesh_name`, quality reports, per-domain quality, realization reports, material
fields, and the certificate itself remain excluded, matching v2 topology
scope. Changing any included value, sequence order, option presence, enum tag,
or signed-zero bit changes v3. Changing an excluded diagnostic does not.

Rust consumers dispatch by `topology_fingerprint_version`: legacy accepted v2
certificates remain validated with the frozen JSON-v2 algorithm, v3 uses the
binary contract above, and unknown versions (including v4) reject. Ingestion
and validation must never repair, upgrade, overwrite, or rebind a stale
transported certificate fingerprint to the received mesh. A trusted
topology-producing transformation, such as planner packing that changes ordered
topology, may mint a replacement fingerprint in the source certificate's
version only after the source certificate validates and the output evidence and
provenance are recomputed and revalidated. Python emits v3 for newly
realized/rebuilt mixed-layer certificates. The JSON/OpenAPI field shape stays a
string version plus a `sha256:` value; only the version value and digest change.

### 3.5 Hybrid

Unsupported. A future hybrid workflow requires explicit projection and
state-transfer semantics and cannot inherit this capability by sharing a mesh
file.

(python-api)=
## 4. API, IR, planner, runtime, and product impact

### 4.1 Python API surface

The existing physics-first swept controls are the authoring entry: an
axis-aligned Box requests a swept prism strategy and exact layer count without
exposing Gmsh element IDs or algorithm names. Python-to-IR-to-UI-to-Python
round-trip preserves requested topology and exact layer count.

The public `GeometryMeshHandle.thin_film` parameters exercised by the canonical
example below are:

| Python parameter | Type | Default | SI unit | Validation domain | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `GeometryMeshHandle.thin_film.maximum_element_size` | `float \| "auto" \| None` | `None` | $\mathrm m$ | finite positive length, `"auto"`, or `None`; the bounded example supplies `3e-9` | authored upper target for the magnetic source-face mesh; the certified mesher may deterministically refine below it to preserve quality | FEM CPU/GPU only | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].maximum_element_size`; compatibility alias `GeometryMeshHandle.thin_film.hmax` lowers to `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].hmax` |
| `GeometryMeshHandle.thin_film.layers` | `int` | `1` | $1$ | exact mixed-P1 execution accepts only `1`, `2`, or `3`; other positive values remain authorable only outside this lane and are rejected by its capability gate | prism-cell layers through the same physical film | FEM CPU/GPU only | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].through_thickness_elements` |
| `GeometryMeshHandle.thin_film.topology` | `"tetrahedral" \| "prismatic" \| None` | `None` | $1$ | mixed-P1 requires `"prismatic"` | requested cell topology family | FEM CPU/GPU only | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].topology` |
| `GeometryMeshHandle.thin_film.exact_layers` | `bool \| None` | `None` | $1$ | strict prismatic execution resolves `None` to `True` and rejects `False` | require requested and realized layer equality | FEM CPU/GPU only | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].exact_layer_count` |
| `GeometryMeshHandle.thin_film.transition` | `"pyramid_to_tetrahedra" \| "reject" \| None` | `None` | $1$ | mixed shared-domain execution requires `"pyramid_to_tetrahedra"` | conforming air transition policy | FEM CPU/GPU only | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].transition_policy` |
| `GeometryMeshHandle.thin_film.order` | `int \| None` | `None` | $1$ | prismatic execution accepts only `None` or `1` and resolves to P1 | finite-element order | FEM CPU/GPU only | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].order` |

```python
# %% Author one strict mixed-P1 film.
import fullmag as fm

fm.reset()
study = fm.study("mixed-p1-layers")
study.engine("fem")
study.mode("strict")
study.universe(mode="manual", size=(100e-9, 80e-9, 65e-9))
film = study.geometry(
    fm.Box(size=(24e-9, 12e-9, 1e-9), name="magnet"),
    name="magnet",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1, 0, 0)
film.mesh.thin_film(
    maximum_element_size=3e-9,
    layers=3,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
study.relax(algorithm="projected_gradient_bb", max_steps=1)
```

The public Python API and its lowering preserve the requested prismatic
topology, transition policy, and exact layer count. The bounded mixed-P1 CPU and
GPU implementations exist, but public production status remains unclaimed until
the exact managed CPU/GPU SP4 runs store immutable execution evidence.

The bounded managed qualification command is
`just verify-fem-mixed-prism-airbox-runtime`. It reads the exact canonical SP4
projected-gradient scenario, requires and replaces exactly one authored
`max_steps=50_000` with `max_steps=1` in a generated temporary copy, and runs
that copy through the existing managed FEM CPU and strict GPU headless routes.
Its validator requires authored `auto`, separate managed `cpu` and `gpu`
overrides, effective strict FEM double execution, `fem_cpu_native` and
`fem_native_gpu`, no fallback, exact mixed certificate and topology identity,
one executed step, initial/final magnetization artifacts bound to the source
and resolved engine, exact CPU/GPU initial-magnetization identity, and the
frozen magnetization-norm bound on each lane. The CPU policy must be explicitly
`exchange_plus_mass_tangent_gradient`; the GPU policy must be explicitly
`device_tangent_gradient`. Because these are different search directions, the
gate does not compare the two first accepted iterates, their final energies, or
their final torques. Each accepted solver-step row must instead independently
prove a native direct-increment Armijo decision
`delta_upper_j <= armijo_rhs_j < 0`, and therefore energy nonincrease. GPU
evidence must additionally prove the managed CUDA/Hypre device identity and
bounded control-scalar-only readbacks. Its accepted solver-step row must prove
at least one demagnetization solve and bind the iteration count and final
residual to the GPU demag runtime diagnostics. The solver-step residual uses
the writer's `{:.17e}` binary64 round-trip representation and therefore matches
the JSON diagnostic exactly after parsing; this identity check has no
solver-tolerance allowance.

The report requires same-state step-0 `H_ex`, `H_demag`, `H_eff`, exchange,
demagnetization, total energy, and maximum-torque parity. Each lane must publish
scalar steps exactly `[0, 1]`; the step-0 row is the already computed native
snapshot and does not execute a solver step. Each field series contains the
step-0 sample and the forced final sample, while its authored cadence remains
`every_steps=50_000` so the canonical 50,000-step scenario does not write a
full field at every accepted step. The comparison requires the same initial
magnetization hash and topology fingerprint before reading those values.
Converged-state parity remains a separate SP4 convergence-matrix gate with
unchanged frozen tolerances. A passing bounded operator comparison is not
physics qualification: this note and the capability matrix remain
`implemented` until the wider matrix is produced and reviewed.

The ordinary Python API suite uses `--skip-geometry-assets` to keep authored
`auto`, managed CPU override, and base-plus-relaxation-stage propagation under
fast always-on coverage. The standalone full real-asset helper export is an
explicit slow opt-in selected with `FULLMAG_RUN_SLOW_REAL_ASSET_TESTS=1`; it is
diagnostic, not the sole qualification proof. Authoritative exact-source,
real-asset, bounded runtime coverage moved to the non-skipping managed `just`
gate above.

(problem-ir)=
### 4.2 ProblemIR representation and normalization

`ProblemIR` uses backend-neutral enums for:

```text
cell topology: prism6 | pyramid5 | tet4
facet topology: tri3 | quad4
mesh topology family: mixed_p1
exact layer count: positive integer
```

For the example above, current Python lowering emits the following complete
canonical `problem_meta.runtime_metadata.mesh_workflow.per_geometry[0]` entry.
It is one named subobject of `ProblemIR`, not a complete `ProblemIR` document:

```json
{
  "geometry": "magnet",
  "mode": "custom",
  "hmax": 3e-9,
  "maximum_element_size": 3e-9,
  "order": 1,
  "mesh_strategy": "swept_prism",
  "through_thickness_elements": 3,
  "through_thickness_distribution": "fixed",
  "sweep_face_meshing": "triangular",
  "topology": "prismatic",
  "sweep_direction": "auto",
  "element_family": "prism",
  "transition_policy": "pyramid_to_tetrahedra",
  "exact_layer_count": true
}
```

`packages/fullmag-py/tests/test_api.py` symbol
`test_mixed_p1_publication_example_lowers_complete_mesh_entry_to_problem_ir`
executes this authoring path without geometry realization and compares the full
entry above against current `Problem.to_ir(include_geometry_assets=False)`
output. This prevents the publication fragment from drifting into a
hand-shaped lookalike.

Gmsh numeric element IDs are import details and must not enter the public IR.
Validation keeps requested topology, sweep direction, and exact layer count
separate from the realized certificate. Legacy tetrahedral input normalizes to
the typed representation; no migration may reinterpret it as mixed-P1.

The realized mixed-layer certificate in `ProblemIR` and build-report provenance
emits `topology_fingerprint_version="v3"`. This is a provenance migration, not
a physics or authoring change. Loaders preserve and validate legacy v2, emit v3
for newly realized or rebuilt certificates, reject unknown versions, and do not
rewrite a stale digest. The global periodic-certificate v6 topology identity is
not migrated: mixed-certificate validation, planning, packing, runtime, and
provenance use explicit v2/v3 dispatch without changing unrelated periodic,
artifact, or API fingerprints. Python and UI round-trip fields are otherwise
unchanged.

`problem_meta.runtime_metadata.runtime_selection.device` remains the authored
script request. A managed launcher records its explicit overlay separately as
`runtime_device_override={"device":"cpu|gpu","source":"managed_launcher"}`.
Planning resolves the effective device from authored intent plus that immutable
launcher overlay and binds it into mixed-topology provenance. Planned startup
and engine resolution consume the bound decision rather than re-reading mutable
environment state, while session provenance continues to report the authored
request and resolved engine separately. No layer may rewrite the model-builder
runtime map to make the overlay look authored.

(round-trip-and-failure-semantics)=
### 4.3 Round-trip and failure semantics

Requested intent remains the authored topology, exact layer count, device,
precision, demag policy, and relaxation algorithm. Resolved execution records
the certificate-bound topology, the same realized layer count, the explicit
CPU or GPU lane, and the retained `implemented` capability status. Python and
UI export must preserve the same requested fields; neither may infer execution
support from a displayed certificate alone.

Validation errors are fail-closed. The bounded relaxation lane accepts only
$L\in\{1,2,3\}$ with requested count equal to realized count and exactly
$L+1$ magnetic planes. Counts `0` and `4`, a non-exact request, a stale or
mismatched fingerprint, any fallback, or `degraded=true` reject before native
startup. Unsupported combinations—including `time_evolution`, FEM/BEM,
PBC/Floquet, DMI, STT, thermal, magnetoelastic, regional projection,
frequency-domain/eigen studies, DG0 interfaces, high order, multiple bodies,
and physical multilayers—retain their existing rejection. A free-tetrahedral
mesh is an explicit alternative configuration, never an automatic fallback.

### 4.4 Planner and capability matrix

The target vocabulary is:

```text
mesh.topology.mixed_p1
mesh.swept.prism
mesh.transition.pyramid_tet
mesh.exact_layer_count
fem.cpu.exchange_demag.mixed_p1
fem.gpu.exchange_demag.mixed_p1
```

The four mesh capabilities and both bounded CPU/GPU operator capabilities are
`implemented`. Neither operator lane is `production_executable` or `validated`
until the next managed proof. The legal implementation target is strict FEM,
explicit CPU or GPU, double precision, the narrow workload in Section 1, and
no fallback. `auto` remains rejecting. Authored device intent, a managed-launcher
override, the plan-bound effective device, and resolved execution must remain
distinct provenance.

Until separately qualified, planning rejects FEM/BEM demag, PBC/Floquet,
DMI/STT/thermal/magnetoelastic terms, regional projections, eigen/frequency-
domain studies, DG0/material interfaces, order greater than one, arbitrary OCC
shapes, multiple bodies, and multilayers.

(implementation-mapping)=
### 4.5 Runtime, ABI, and native implementation mapping

Production topology import, basis/quadrature, exchange, Poisson RHS/solve/
recovery, relaxation, and certificate generation belong under `backends/fem`.
Rust runner code owns orchestration, typed ABI lowering, requested/resolved
provenance, artifacts, and rejection before startup; it must not implement a
second FEM solver or hidden element conversion.

The native ABI carries typed, variable-width cell/facet connectivity. CPU and
GPU readiness probes reject an ABI/topology version they do not understand
before allocating solver state. The bounded CPU and GPU mixed-P1 gates admit
only the certificate-bound tuples in Section 1; every wider physics tuple still
rejects before unsupported operator allocation.

### 4.6 API, binary transport, and control room

FMMT v2 carries explicit canonical type enums, offsets plus connectivity,
per-cell/per-facet markers, exact optional `u64` global ordinals, and versioned
byte-range metadata. Its 64-byte header uses reserved byte offsets 40 and 44
for cell- and facet-global-ordinal counts. Each count is zero for a legacy v2
payload or equals its entity count; nonzero counts append 8-byte-aligned cell
and facet ordinal sections after the marker sections. OpenAPI,
serializer, header/range reader, generated TypeScript, decoder, domain adapter,
topology-index construction, viewport triangulation, and surface selection
consume that typed representation. Histogram and Inspector integration are not
claimed by this bounded transport change. FMMT v1 remains readable only for tetrahedral
sessions; it must never carry disguised or truncated mixed cells.

The UI must show requested topology, realized topology counts, certificate
status, quality metric identity, exact-layer result, and explicit rejection or
degradation. Any rendering-only triangulation of quads is derived display data
and cannot replace solver topology or alter physics.

In the unified workspace, a future Mesh-module command is capability-gated and
uses the central command registry; resource hooks fetch revisioned FMMT v2
topology; the FEM domain adapter preserves typed cells/facets; viewport layers
derive render triangles without mutating solver connectivity; and the existing
mesh resources retain their existing certificate data. A later Inspector
integration may present that certificate and rejection reason. This target
does not introduce another workspace shell, direct component fetch, or a new
docking model.

### 4.7 Artifacts and provenance

At minimum, artifacts must record:

- requested and resolved topology family, layer count, device, precision,
  demag boundary model, and relaxation algorithm;
- canonical cell/facet counts by topology and region;
- mesh and material-realization hashes;
- the complete exact-layer/shared-domain certificate;
- Gmsh version and deterministic meshing inputs;
- `fallbacks_triggered`, with strict acceptance requiring an empty list;
- implementation, execution, and validation states independently.

The bounded managed gate treats final artifacts as identity-bearing evidence,
not merely parseable arrays. `m_final.json` must report observable `m`, unit
`dimensionless`, the accepted final step, the bounded source hash, the resolved
engine and double precision, and exactly one three-component vector per
`metadata.mesh.node_count`. Its final step must match `scalars.csv` and the
relaxation qualification; final exchange, demagnetization, total energy, and
torque scalars must match the qualification metadata within relative tolerance
`1e-15` and no dimensional absolute tolerance. That bound reflects the
`{:.15e}` scalar CSV writer's 16-significant-decimal-digit serialization; it is
not a physics-parity tolerance. The dimensionless magnetization norm defect is
independently recomputed from `m_final.json` and the execution plan's
`magnetic_object` node selection; shared-domain air nodes are excluded exactly
as they are in qualification generation. The recomputed value may differ from
the recorded qualification value by at most
`16 * epsilon64`, where IEEE-754 binary64 `epsilon64 = 2^-52`. This absolute
dimensionless allowance covers only cross-language floating-point
recomputation; it is not an energy, torque, state-parity, or solver tolerance.

The same gate treats the initial operator artifacts as identity-bearing
evidence. The canonical stage requests exactly `H_ex`, `H_demag`, and `H_eff`
through `FieldAutosave(..., every_steps=50_000)`. For each observable,
`fields/<observable>.zarr` must be an uncompressed Zarr v2 array with axes
`[sample, component, cell]`, component order `[x, y, z]`, binary64 values,
shape `[2, 3, mesh.node_count]`, chunks `[1, 3, mesh.node_count]`, and samples
at steps `[0, 1]`. The step-0 sample has time and solver timestep equal to zero.
Its `.zattrs`, `.zarray`, `samples.csv`, and `0.0.0` payload are hashed into the
run summary and bound to the bounded source hash, resolved engine, double
precision, initial-state hash, and topology fingerprint. The comparison reads
the immutable payloads but evaluates components only at
`execution_plan.backend_plan.mesh_parts[role=magnetic_object]` node indices;
pure-air nodes are outside the magnetic operator comparison.

The step-0 `scalars.csv` row supplies `E_ex`, `E_demag`, `E_total`,
`max_torque_Apm`, and `max_torque_T`. The maximum torque is the native scalar
reduction; the gate does not claim that a host-derived full torque vector is a
GPU-resident operator artifact. The existing native CPU/GPU parity contract
sets the frozen component tolerances to `rtol=5e-8` and `atol=1e-6 A/m` for
each of `H_ex`, `H_demag`, and `H_eff`. Energy uses `rtol=1e-6` and
`atol=1e-30 J`; both torque units use `rtol=1e-6`, with
`atol=1e-9 A/m` and `atol=1e-15 T`, respectively. Every component uses
`abs(cpu-gpu) <= atol + rtol * max(abs(cpu), abs(gpu))`. These are existing
Fullmag CPU/GPU contracts and must not be tuned from this workload.
Comparison reparses and rehashes the raw scalar row and both field chunks, then
requires exact agreement with their persisted run-summary bindings. The
versioned `comparison.v3.csv` publishes maximum and RMS field deltas, all three
energy comparisons, both maximum-torque comparisons, and their units and
statuses alongside the initial-state and per-lane Armijo evidence.

The checked-in Gmsh 4.15.2 fixture is reproducible feasibility evidence only.
It is not runtime, MFEM, CPU/GPU, physics, API, or viewport proof.

(validation)=
## 5. Validation strategy

### 5.1 Feasibility and topology checks

`packages/fullmag-py/tests/test_mixed_element_meshing.py` loads the frozen GEO
fixture with Gmsh 4.15.2 and checks prism-only film, pyramid/tet-only air, two
magnetic planes, tri/quad film facets, complete conforming film enclosure,
manifold face ownership, and absence of the production prism-to-tet splitter.
It freezes topology invariants, not incidental air-tet counts.

### 5.2 Operator checks

The CPU and GPU implemented slices are backed by the following operator
contracts; any `production_executable` or `validated` promotion requires its
own fresh managed evidence:

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
- frozen Python/Rust fingerprint-v3 vectors spanning SI scales (`1e-7`,
  `1e-5`, `3e-9`, `1e20`), arbitrary finite round-trip floats, signed zero,
  all enum tags, non-ASCII/empty/prefix strings, absent versus present-empty
  options, every periodic field, list reordering, excluded-field stability,
  tamper rejection, legacy-v2 acceptance, plan packing, runner validation, and
  unknown-version rejection;
- managed container runtime gates for FEM CPU and strict FEM GPU.
- bounded same-state step-0 field, energy, and maximum-torque parity with
  immutable Zarr/CSV identity and magnetic-node scoping.

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
- [x] Language-neutral topology fingerprint v3 contract and v2 migration rule
- [x] Frozen Gmsh 4.15.2 feasibility fixture
- [x] Python API and round-trip preserve requested mixed topology
- [x] ProblemIR enums, validation, and legacy-tetra migration
- [x] Fail-closed planner and machine-readable capabilities
- [x] Variable-width mesh container and native ABI
- [x] FEM CPU mixed-element operators
- [x] FEM GPU mixed-element operators
- [x] FMMT v2, OpenAPI, generated client, and typed viewport transport
- [ ] Managed runtime and physics validation
- [ ] Production qualification report

(limitations)=
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

(scientific-bibliography)=
## 8. Scientific bibliography

- Gmsh 4.15.2 reference manual, structured grids and QuadTri transitions:
  <https://gmsh.info/doc/texinfo/gmsh.html>.
- MFEM 4.8 mesh and first-order H1 finite-element documentation:
  <https://docs.mfem.org/4.8/classmfem_1_1Mesh.html>.
- `docs/physics/0105-fem-meshing-production-acceptance.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`

(source-code-index)=
## 9. Source-code index

| Claim | Path | Stable symbol | Responsibility | Lane | Tests/evidence status |
|---|---|---|---|---|---|
| Public exact-layer authoring | `packages/fullmag-py/src/fullmag/world.py` | `thin_film` | validates and lowers prismatic thin-film intent | FEM CPU/GPU | Python round-trip and real-mesh tests |
| Published Python-to-IR example | `packages/fullmag-py/tests/test_api.py` | `test_mixed_p1_publication_example_lowers_complete_mesh_entry_to_problem_ir` | executes the documented authoring path and compares the complete per-geometry mesh entry | FEM CPU/GPU shared contract | focused executable lowering test |
| Shared-domain prism realization | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_box_mesh` | generates exact stacked prisms and conforming air | FEM CPU/GPU | Gmsh 4.15.2 topology/certificate tests |
| Certificate generation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py` | `_attach_mixed_layer_topology_certificate` | recomputes and binds realized topology evidence | FEM CPU/GPU | Python/Rust cross-language validation |
| Planner legality | `crates/fullmag-plan/src/mesh.rs` | `validate_mixed_p1_execution_scope` | enforces exact bounded relaxation tuples | FEM CPU/GPU | planner accept/reject matrix |
| Capability publication | `crates/fullmag-runner/src/capabilities.rs` | `mixed_p1_feature_capabilities` | publishes bounded status and scope wording | FEM CPU/GPU | capability serialization tests |
| FMMT v2 topology serialization | `crates/fullmag-api/src/field_store.rs` | `serialize_fem_mesh_topology_binary_v2` | emits typed CSR topology and exact optional `u64` cell/facet identities without changing the v2 version | FEM CPU/GPU shared transport | serializer layout, legacy-v2, malformed-count, and overflow tests |
| FMMT v2 topology decoding | `apps/control-room/src/kernel/api/codecs/topologyCodec.ts` | `decodeTopology` | decodes full or range-fetched topology while preserving global ordinals as `BigUint64Array` | unified control room | codec malformed/range and chunked facade tests |
| FMMT v2 byte layout | `apps/control-room/src/kernel/api/codecs/topologyCodec.ts` | `topologyByteLayout` | computes aligned optional cell/facet ordinal ranges for legacy, cell-only, facet-only, and combined v2 payloads | unified control room | direct four-variant layout tests |
| FMMT v2 range loading | `apps/control-room/src/kernel/api/ControlRoomApi.ts` | `loadTopologySectionsByRange` | range-fetches every declared topology section into its exact typed-array representation | unified control room | chunked facade tests with exact `u64` identities |
| Mixed topology render index | `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexModel.ts` | `buildViewport3DTopologyIndexBundle` | derives render topology while retaining local owner indices and exact global cell ordinals | unified control room | mixed-cell, semantic-face-deduplication, and byte-accounting tests |
| Mixed topology surface selection | `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx` | `resolveMeshPartSurfacePickIdentity` | returns exact decimal global cell identity only for complete aligned maps and preserves boundary-only legacy picks only when every identity map is absent | unified control room | exact-identity, partial-map, misalignment, and legacy tests |
| Step-0 field authoring | `packages/fullmag-py/src/fullmag/model/study.py` | `class StageAutosave` | carries the three scheduled field autosaves without changing the physical model | FEM CPU/GPU shared contract | canonical SP4 scenario source contract |
| Native step-0 dispatch | `crates/fullmag-runner/src/dispatch.rs` | `record_native_fem_initial_field_snapshots` | records requested native field snapshots before direct minimization and advances their schedules | FEM CPU/GPU | runner source and artifact-schedule contracts |
| Native current-state statistics | `backends/fem/cpu/mfem/runtime/snapshot.cpp` | `context_snapshot_stats_mfem` | evaluates current-state fields, energies, and maximum torque without a solver step | FEM CPU/GPU | native runtime contracts; managed proof pending |
| Native Zarr serialization | `crates/fullmag-runner/src/artifact_pipeline.rs` | `append_fem_snapshot` | writes immutable component-major field chunks and sample metadata | FEM CPU/GPU | artifact pipeline and gate tamper tests |
| Step-0 artifact validation | `scripts/verify_fem_mixed_prism_airbox_runtime.py` | `validate_runtime_artifacts` | binds scalar and field artifacts to source, topology, state, engine, and precision | FEM CPU/GPU | focused verifier tests |
| Same-state operator comparison | `scripts/verify_fem_mixed_prism_airbox_runtime.py` | `compare_runtime_summaries` | compares magnetic-node fields and step-0 energy/torque under frozen tolerances without capability promotion | FEM CPU/GPU | focused verifier tests; managed proof pending |
| Exchange weak form | `backends/fem/cpu/mfem/interactions/exchange_operator.cpp` | `initialize_exchange_operator_mfem` | assembles topology-aware exchange operator | FEM CPU | native operator contracts; managed proof pending |
| Uniform Zeeman energy | `backends/fem/cpu/mfem/interactions/zeeman_energy.cpp` | `zeeman_energy_from_field` | evaluates the existing Zeeman energy contract | FEM CPU | native energy contracts |
| Poisson weak-form source | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | assembles magnetic-cell Poisson RHS | FEM CPU | manufactured/operator contracts; managed proof pending |
| Demag field recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | recovers $\mathbf H_{\mathrm{demag}}$ on magnetic cells | FEM CPU | manufactured/operator contracts; managed proof pending |
| Demag energy | `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | evaluates the existing demag-energy sign contract | FEM CPU | energy contracts; managed proof pending |
| Magnetic nodal weights | `backends/fem/core/fem_mesh.cpp` | `compute_node_volumes` | synchronizes mixed P1 mass-row-sum volume weights | FEM CPU/GPU shared contract | native material/metric contracts |
