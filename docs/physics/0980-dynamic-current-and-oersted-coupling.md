# Dynamic current and Oersted coupling

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-07-16
- Related ADRs: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Related specs: `docs/specs/spin-transport-runtime-contract-v1.md`
- Formula version: `current_transport.fullmag.v1`
- Operator versions: `fdm_face_to_cell_current.v1`,
  `fdm_oersted_cell_integrated_open.v1`,
  `fem_conservative_current_rt0_view.v1`,
  `fem_closed_current_extension.v1`,
  `fem_oersted_direct_tetra_quadrature.v1`,
  `fem_oersted_hcurl_h1_gauge.v1`,
  `fem_oersted_hcurl_h1_zero_mean_natural.v1`
- Realization versions: `oersted_fdm_fft_open.v1`,
  `oersted_direct_biot_savart.v1`,
  `oersted_analytic_return_additive.v1`,
  `oersted_fem_vector_potential.v1`

Executable engines such as `fdm_oersted_fft_open_v1` are distinct from those
formula/operator/realization identifiers. Section 8.1 of the runtime contract
is the normative registry.

## 1. Problem statement

All current-induced physics must consume one signed, conservative current field
at the same stage time. Computing torque from one current approximation and
Oersted field from another creates an internally inconsistent multiphysics
problem. This note defines charge-source timing, global circuit closure,
Oersted field/energy semantics, FDM cell-integrated convolution, FEM
`H(curl)` vector potential, caching, rollback, observables, and qualification.

It specifies a target contract and does not claim existing lanes satisfy it.

## 2. Physical model

### 2.1 Conservative dynamic current

On conducting domain `Omega_c`, the M1 electroquasistatic problem is

```text
E=-grad V,
J_c=sigma E,
div J_c=0.
```

M2 may make `J_c=J_c(V,mu_s,m)` through AMR/PHE/AHE and reciprocal spin
feedback, but it retains charge continuity. `J_c` is conventional and signed.
A prescribed `CurrentDensityField` must pass discrete divergence, electrode
flux, and insulating-boundary balance before STT, SHE, or Oersted uses it.
Automatic solenoidal projection is a different explicit model and changes
provenance.

Every drive owns exactly one `TimeEnvelope`:

```text
constant(value)
sinusoidal(amplitude,frequency_hz,phase_rad,offset)
pulse(amplitude,t_on,t_off)                 # [t_on,t_off)
piecewise_linear([(t0,y0),...])
sinc(amplitude,center,bandwidth_hz,offset)
tabulated(artifact,interpolation,extrapolation)
```

The envelope is a dimensionless scalar multiplier `a(t)` of the SI-valued base
drive. Its arguments have one frozen interpretation:

| Argument | Meaning | Unit / constraint |
|---|---|---|
| `value` | constant multiplier | 1, finite |
| `amplitude` | signed multiplier amplitude for sinusoid, pulse, or sinc | 1, finite |
| `offset` | additive multiplier offset | 1, finite |
| `frequency_hz` | sinusoidal cycles per second | Hz, finite and `>=0` |
| `phase_rad` | phase added to `2 pi frequency_hz t` | rad (dimensionless), finite |
| `t_on`, `t_off` | pulse half-open interval bounds | s, finite and `t_on<t_off` |
| `(t_i,y_i)` | PWL knot time and dimensionless multiplier | s and 1; finite, strictly increasing `t_i` |
| `center` | time origin of the sinc argument | s, finite |
| `bandwidth_hz` | sinc bandwidth and declared significant source bandwidth | Hz, finite and `>0` |
| `artifact` | table identity whose abscissa is time and ordinate is multiplier | metadata requires s and 1 |
| `interpolation`, `extrapolation` | versioned enum policies, not numerical values | 1 |

For the canonical sinc convention, `sinc(x)=sin(pi x)/(pi x)` and
`a(t)=offset+amplitude*sinc(bandwidth_hz*(t-center))`; changing normalized
sinc convention requires a formula version. A source API that authors absolute
SI amplitudes must normalize them into the base drive and this dimensionless
envelope exactly once, preserving both values in provenance.

The remaining canonical evaluations are

```text
constant:   a(t)=value,
sinusoidal: a(t)=offset+amplitude
                  sin(2 pi frequency_hz t+phase_rad),
pulse:      a(t)=amplitude for t_on<=t<t_off, otherwise 0,
PWL:        linear interpolation between adjacent (t_i,y_i) knots.
```

PWL values outside the authored knot interval and tabulated interpolation/
extrapolation are controlled by explicit versioned policies; no backend may
silently clamp, wrap, or extrapolate them differently. If a PWL source omits
such a policy, canonical validation rejects evaluation outside its knot range.

Torque and Oersted bind to that source; they do not carry independent copies.
For a separable linear solve,

```text
J_c(x,t)=a(t)J_c0(x),
H_oe(x,t)=a(t)H_oe0(x),
```

so the base maps may be cached. Magnetization-dependent conductivity, iSHE, or
nonseparable electrodes require refresh under the selected coupling policy.

### 2.2 Global circuit closure

Local continuity in a truncated bar with inlet and outlet is insufficient for
Biot–Savart: the magnetic field depends on the return circuit. A general
`OerstedField` requires exactly one closure:

- `closed_geometry`: a volumetrically meshed conductor/return loop whose
  conservative current is part of the same RT0 view and has zero net outer
  source flux. A nonzero loop current additionally requires a versioned
  impressed source representation (`source_cut` or periodic potential drop),
  or an already certified imported closed RT0 field. A single-valued
  electrostatic `H1` potential on a closed loop is not such a source;
- `external_lead_extension`: a versioned, volumetrically tetrahedralized lead
  extension whose current is joined to the conductor by
  `fem_closed_current_extension.v1`, with oriented interface-flux equality and
  its own mesh/revision/digest certificate. V1 solves the device and extension
  as one coupled minimum-dissipation problem, so lead impedance feeds back on
  the device current; a sequential field extrapolation is not this closure;
- `analytic_return_path`: an OE-F1-only additive analytic field realization,
  `oersted_analytic_return_additive.v1`. It is not an RT0 field, is never
  inserted into `ConservativeCurrentView`, and is unsupported for OE-F2.

An open two-electrode bar without specified leads/return path is rejected for
general Oersted evaluation. Closure identity and geometry revision are
provenance and cache inputs.

Canonical FEM v1 therefore permits OE-F2 only with `closed_geometry` or a
volumetrically meshed `external_lead_extension`. A line/wire formula, endpoint
correction, or analytic return may augment OE-F1 only and must publish its
field and error contribution separately. It cannot be relabelled as a closed
RT0 source or used to satisfy the mixed-solver range condition.

### 2.3 Magnetoquasistatic Oersted field

For the instantaneous conservative current,

```text
H_oe(x,t) = 1/(4 pi) integral_Omega_c
  J_c(x',t) x (x-x')/|x-x'|^3 dV',          [A/m]
curl H_oe=J_c,
div(mu0 H_oe)=0.
```

There is no `mu0` in Biot–Savart for `H`. In vacuum `B_oe=mu0 H_oe`.
Magnetization belongs to the demagnetizing operator and may not be counted as
material permeability in the Oersted solve.

### 2.4 Energy and work semantics

For current independent of `m`, the instantaneous external Zeeman interaction
is

```text
E_oe(t)=-mu0 integral_Omega_m M_s m dot H_oe(t)dV. [J]
```

There is no factor `1/2`. It is published as `oersted_zeeman_energy` with
`energy_semantics=external_zeeman` and may participate in the normal external
field energy accounting.

In M2, `J_c(m)` makes the snapshot above nonvariational: its variation does not
generate the full coupled response. It is published as
`oersted_zeeman_work_snapshot` with
`energy_semantics=coupled_diagnostic_nonvariational`, excluded from canonical
`E_total` and conservative minimizers. It must still match the exact stage
field used in the LLG RHS.

### 2.5 Quasistatic validity

For highest significant angular frequency `omega`, conductor transverse size
`d`, characteristic length `L`, permittivity `epsilon`, conductivity `sigma`,
and magnetic permeability used only in the regime estimate,

```text
r_disp=omega epsilon/sigma,
delta=sqrt(2/(mu sigma omega)),
kL=omega L sqrt(mu0 epsilon).
```

Electro/magnetoquasistatics require all three to be small. Product defaults
warn at `r_disp>1e-2` or `d/delta>0.1`; strict execution rejects values above
`0.1` without an explicit expert override. `kL` also needs a versioned threshold.
Pulse/PWL/tabulated inputs require finite rise time or declared
`bandwidth_hz`; an ideal infinite-bandwidth step is outside strict validity.

### 2.6 Stage time, accepted state, and rollback

For every explicit RK RHS evaluation:

```text
t_stage=t_n+c_i dt,
m_stage=m_i,
J_stage=J_c(m_i,t_stage),
H_oe,stage=H[J_stage].
```

FSAL reuse is valid only when cache identity includes accepted time/state,
transport revision, envelope revision, closure, and method. A rejected step
does not publish a field, change committed revisions, or leave tentative
transport/Oersted state as accepted. After acceptance, observables are refreshed
at the accepted state; published `J_charge`, `H_oe`, and work/energy correspond
to the RHS state they describe.

### 2.7 Symbols and SI units

| Symbol | Meaning | SI unit / condition |
|---|---|---|
| `V` | electric potential | V |
| `E` | electric field | V/m |
| `sigma` | conductivity | S/m, positive definite |
| `J_c` | conventional current density | A/m^2 |
| `H_oe` | Oersted field | A/m |
| `B_oe` | magnetic flux density | T |
| `A` | magnetic vector potential | T m |
| `p_gauge` | gauge multiplier in the chosen weak form | A/m |
| `M_s` | saturation magnetization | A/m |
| `E_oe` | external Zeeman energy/snapshot | J |
| `epsilon` | permittivity | F/m |
| `mu` | permeability used in skin-depth estimate | H/m |
| `omega` | highest significant angular frequency | s^-1 |
| `delta`, `d`, `L` | lengths | m |
| `t`, `dt` | time | s |
| `a(t)`, envelope `value/amplitude/offset/y_i` | source multiplier and ordinates | 1 |
| `frequency_hz`, `bandwidth_hz` | cyclic frequency and bandwidth | Hz |
| `phase_rad` | sinusoidal phase | rad (dimensionless) |
| `center`, `t_on`, `t_off`, `t_i` | envelope times | s |

### 2.8 Assumptions and validity limits

The model excludes displacement current, propagation delay, full-wave
electromagnetics, unresolved skin/eddy-current redistribution, and magnetic
material response inside the Oersted operator. Unsupported PBC, missing closure,
nonconservative prescribed current, undefined source time, or strict operation
outside the regime fail closed rather than selecting a plausible fallback.

## 3. Numerical interpretation

### 3.1 FDM current reconstruction and Oersted convolution

Finite-volume charge produces globally oriented face flux. The only current
map consumed by Oersted and published as `J_charge` is

```text
J_K,x=0.5(J_x,K-1/2+J_x,K+1/2),
```

and analogously for `y,z`, under `fdm_face_to_cell_current.v1`. A future
non-Cartesian source requires a conservative least-squares reconstruction with
a new version. Oersted must not recompute `sigma E`.

Production open-boundary FDM uses a cell-integrated antisymmetric kernel:

```text
K(r) = [ 0    k_z -k_y
        -k_z  0    k_x
         k_y -k_x  0 ],
k_a=1/(4 pi) integral_source_cell r_a/|r|^3 dV',
K(0)=0.
```

Near field uses the cell integral; far field may use a controlled approximation.
The source mask is the conductor, independent of the magnetic mask. FFT uses
zero padding to at least `2N` in every nonperiodic axis, versioned crop,
normalization, R2C layout, near/far cutoff, and kernel precision. PBC is rejected
without a dedicated periodic/Ewald kernel. `nz=1` and other singleton axes have
independent oracles. Plans/buffers are persistent, never rebuilt per RHS.

Cache identity includes cell size, shape, origin, conductor/magnet union grid,
mask and source revisions, closure, cutoff, layout, method, and precision.
The resolved operator is `fdm_oersted_cell_integrated_open.v1` and the
realization is `oersted_fdm_fft_open.v1`. CPU double engine
`fdm_oersted_fft_open_v1` is the reference/production baseline; CUDA engine
`fdm_oersted_cufft_open_v1` must preserve kernel/layout/crop semantics with no
strict hot-loop vector transfers.

`analytic_cylinder` resolves to `oersted_analytic_cylinder.v1`; it is a special
geometry oracle and must support an arbitrary declared axis by a covariant
rotation or reject it. `direct_biot_savart` is the small independent O(N^2)
oracle with controlled near-field quadrature and realization
`oersted_direct_biot_savart.v1`.

### 3.2 FEM prerequisite: conservative `RT0/H(div)` current view (OE-T0)

Both FEM Oersted realizations consume one immutable
`ConservativeCurrentView`; neither may reconstruct `J_c` from nodal potential,
conductivity, or a visualization field. The minimum v1 view is an oriented
lowest-order Raviart--Thomas (`RT0`) field on the tetrahedral conductor/lead
support:

```text
ConservativeCurrentView = {
  operator_version: "fem_conservative_current_rt0_view.v1",
  unit: "A/m^2",
  component_convention: "signed_conventional_xyz",
  fe_space: "RT0_Hdiv_3d",
  mesh_revision, topology_revision, geometry_digest,
  source_module_id, source_state_revision, source_field_digest,
  closure_revision, closure_digest,
  canonical_face_record_count, canonical_face_digest,
  balance_certificate, evaluation_time_s, stage_identity
}
```

The RT degrees of freedom are signed normal-flux moments with one global face
orientation; the reconstructed physical field has unit `A/m^2`, while
integrated face flux has unit `A`. Piola transformation, basis normalization
and shared-face orientation are part of the operator version. `H(div)`
conformity makes the normal trace single-valued;
the elementwise divergence of the `RT0` field must satisfy the integrated
charge-balance gate. Extending the field by zero from conductor to air is legal
only where its normal trace is zero. Electrode fluxes must instead be joined by
the declared physical return/lead closure before the view is complete. The
view rejects a current with an unpaired terminal flux, a non-finite degree of
freedom, a stale mesh/source revision, or a digest mismatch.

The current transport workflow owns construction and publication of this
view. For an `H1` potential solve, simply projecting `-sigma grad V` into a
nodal vector space is not conservative and is visualization-only. OE-T0 must
produce `RT0` through a conservative mixed reconstruction or flux-equilibrated
projection whose element balance and electrode balance are independently
certified. The Oersted owner receives a read-only view pinned to the exact
accepted/stage source snapshot. Source revision, coefficient digest, closure
digest, mesh revision, time and stage identity are mandatory cache keys.

The digest is not computed from MFEM true-dof order. The canonical serialized
record is `(face_key, flux_A)`, sorted by a `face_key` made from the three
stable mesh-vertex identities. Its canonical normal follows the versioned
orientation of that ordered face key; local/MFEM signs are converted before
serialization. The digest hashes the operator/schema IDs, geometry digest and
little-endian records in sorted order. Stable vertex identities are independent
of element numbering and MPI ownership. Element reorder, local face reorder,
true-dof reorder and MPI repartition must therefore leave the digest unchanged.

#### 3.2.1 OE-T0 v1 construction contract

V1 is restricted to straight, affine, nondegenerate tetrahedra. Curved or
higher-order geometry is rejected until a separately versioned canonical
geometry and face-quadrature contract exists. Every mesh vertex carries an
explicit stable unsigned 64-bit identity. MFEM vertex, element, face and true
DOF numbers are never substituted for that identity.

For a potential-derived source, OE-T0 reconstructs the conservative field in
`RT0` with discontinuous elementwise constants as Lagrange multipliers. With
`j_0=-sigma grad V`, the discrete problem is the constrained weighted
projection

```text
min_j 1/2 integral (j-j_0) dot sigma^{-1}(j-j_0) dV,
subject to B j = q and C j = d,

[ M  B^T C^T ] [ j      ]   [ g ],
[ B   0   0  ] [ lambda ] = [ q ],
[ C   0   0  ] [ eta    ]   [ d ].
```

`M` is the `RT0` weighted vector mass matrix and `B` is the `RT0`--`L2`
divergence operator. `C` contains nonlocal terminal-current sums,
source-cut/periodic-pair flux equations and nonconforming closure-interface
pairing equations. Zero insulating normal-flux DOFs and any other pointwise
prescribed RT trace are eliminated as essential DOFs before forming the KKT
system. A deterministic rank-revealing analysis removes redundant rows from
`[B;C]`; in particular exactly one dependent divergence equation per closed
connected component is removed unless an equivalent explicit compatibility
constraint is used. Every omitted physical equation is still checked by the
independent certificate. Direct coefficient projection is not a conservation
proof.

A resolved v1 `source_cut` is an oriented pair of conforming triangulated cut
surfaces materialized only from the current module's authored
`periodic_potential_drop`. It carries stable face-key pairings, a canonical
minus-to-plus orientation and a potential jump in volts. Before RT
reconstruction, `fem_charge_h1_periodic_jump.v1` solves the periodic `H1`
quotient unknown plus an affine jump lift (equivalently duplicated paired
traces) satisfying `V_plus-V_minus=drop_V`, with one explicit gauge. The RT KKT
does not impose this voltage equation; it consumes the converged lifted
potential and requires equal/opposite paired cut flux through `Cj=d`. Every cut
face occurs exactly once on each side, geometry matches under the declared
transform, and `drop_V` is multiplied by the source time envelope. Missing,
multiply paired or orientation-inconsistent cut faces are rejected. A future
total-current cut is a separately versioned charge operator.

The construction request contains the potential and conductivity snapshots,
stable vertex identities, classified boundary faces, terminal/source-cut
constraints, closure support, all source/mesh/topology revisions and digests,
evaluation time and stage identity. `closed_geometry` accepts either a
periodic-drop reconstruction sourced by the same current module or a certified
imported closed RT0 field. The closure object itself never invents a drive;
absent either source, its only admissible potential-derived solution is zero
current. `external_lead_extension` participates in the same coupled
constrained solve. OE-T0 rejects analytic returns, incomplete interface pairing
and any attempt to manufacture closure by zeroing an open terminal flux.

The published view owns an immutable mesh snapshot, RT collection, finite
element space, grid function, canonical records and identity metadata. The
transport owner atomically replaces its `shared_ptr<const
ConservativeCurrentView>` only after the charge solve, constrained
reconstruction and all independent gates succeed. Failure leaves the previous
accepted view intact; tentative/rejected-stage state is never published.

The balance certificate is evaluated from the physical Piola-mapped field by
independent quadrature, not from the KKT residual. It records every element
residual, shared-face trace jump, terminal/source-cut flux, closure-interface
pair, net outer flux and normalized global balance using a `1e-30 A` floor.
The public summary may expose maxima, but the complete diagnostic artifact is
retained.

For canonical face records, the sorted stable vertex triple `(a<b<c)` defines
the face key and its ordered coordinates define the canonical normal. Repeated
identities, degenerate faces, non-finite fluxes, or identity/coordinate
disagreement across ranks are rejected. Records normalize negative zero,
encode unsigned identities and binary64 flux in little-endian form, and hash
the schema, operator/orientation version, geometry digest and sorted records.

The OE-T0 v1 reference executable guarantees byte-identical one-rank/two-rank
results by gathering the canonical affine mesh, coefficients and constraints,
performing the reconstruction in deterministic canonical order on rank zero,
and broadcasting canonical records and the accepted field. This is an
explicit correctness/reference realization, not the production-scalability
claim. A future distributed reconstruction may replace it only under a new
deterministic reduction/quantization contract and must retain the same
physical gates.

### 3.3 FEM direct tetrahedral Biot--Savart oracle (OE-F1)

The independent CPU-double reference evaluates the volume integral directly
from the conservative view:

```text
H_oe(x) = 1/(4 pi) sum_T integral_T
  J_RT0,T(x') x (x-x') / |x-x'|^3 dV'.
```

`J_RT0,T` is affine on each physical tetrahedron. The integration uses the
physical Jacobian and the signed Piola-mapped field; replacing it by a centroid
sample is not this operator. For well-separated source/target pairs, an
embedded pair of tetrahedral rules estimates error. Near pairs are recursively
subdivided. If `x` lies in or on a source tetrahedron, that tetrahedron is
split into positive-volume sub-tetrahedra having `x` as a vertex and a Duffy/
Gauss--Jacobi rule integrates the integrable `1/r^2` singularity. No arbitrary
self-distance cutoff or deleted self term is permitted. Degenerate
sub-tetrahedra fail validation. Deterministic element order and compensated
componentwise accumulation are required.

The resolved operator is `fem_oersted_direct_tetra_quadrature.v1`; it uses the
existing realization family `oersted_direct_biot_savart.v1` and CPU engine
`fem_oersted_direct_tetra_cpu_v1`. Its fixed FP64 profile records quadrature
orders, relative/absolute field tolerances, near-pair criterion, subdivision
limit and an unconverged-pair count. It evaluates the direct volume integral at
every integration point used to assemble the target-space load
`l_i=sum_K integral_K phi_i(x) H_direct(x)dV`. Near/singular source rules and
their error estimator are applied independently at those projection quadrature
points. A versioned projection-quadrature profile controls target integration
order and load error. The consistent vector `L2` mass solve then produces the
LLG nodal field. Interpolating values sampled only at target nodes into the
load is not this operator. The published `H_oe` is that exact projected field,
not unprojected samples. OE-F1 requires global circuit closure but no
volumetric airbox. It is the small-problem oracle and validation reference, not
the production asymptotic algorithm.

### 3.4 FEM mixed vector-potential contract (OE-F2)

The OE-F2 FEM target formulation solves on conductor plus airbox with vacuum
`mu0` everywhere:

```text
curl(mu0^-1 curl A)+grad p_gauge=J_c,
div A=0,
B_oe=curl A,
H_oe=mu0^-1 B_oe.
```

The baseline truncation uses the relative exact-sequence pair

```text
A in H_0(curl;Omega),        n x A = 0 on boundary Omega,
p_gauge in H^1_0(Omega),     p_gauge = 0 on boundary Omega.
```

Because `grad H^1_0` is a subspace of `H_0(curl)`, the weak form is: find
`(A,p)` in those spaces such that for every `(v,q)` in the same test spaces,

```text
(mu0^-1 curl A, curl v) + (grad p, v) = (J_c, v),
(A, grad q) = 0.
```

With `C_ij=(mu0^-1 curl w_j,curl w_i)` and
`B_ij=(grad phi_j,w_i)`, the block form is

```text
[ C  B ][A] = [f],
[B^T 0 ][p]   [0].
```

For this baseline, `p` is in `H^1_0`; it is **not** a zero-mean scalar space.
Dirichlet data removes the scalar constant already. Implementing the baseline
with an unconstrained `H1` space plus pinning/zero mean changes the discrete
exact sequence and is forbidden.

A separate, explicitly selected boundary variant may use `A in H(curl)` and
`p in H1/R` with `integral_Omega p dV=0`. Its second equation weakly imposes
the corresponding divergence/normal condition, while the curl integration
produces a natural outer boundary condition. It is
`fem_oersted_hcurl_h1_zero_mean_natural.v1`, has different truncation physics,
solver policy and validation, and may never be substituted for the baseline.

Both variants require a topology certificate. The planner either supplies a
versioned basis and constraints for the relevant harmonic fields or rejects a
domain whose discrete de Rham cohomology is nontrivial. A scalar gauge alone
does not remove harmonic null modes on a multiply connected airbox/conductor
complex.

The baseline outer condition `n x A=0` is only a finite-airbox truncation, not
an exact open boundary. Qualification requires at least three geometrically
similar growing airboxes, extrapolated error in the fixed magnetic observation
domain, and comparison with OE-F1. The airbox must contain the entire closed
current view and magnetic target; conductor/lead interfaces are internal, not
artificial outer boundaries.

The Ampere load is assembled directly from the pinned `RT0/H(div)` view. This is the
compatible pairing `(J_RT0,v_ND)`; importing the nodal `J_charge` visualization
buffer or independently evaluating `-sigma grad V` is forbidden.

The compatible magnetic flux is formed by the discrete de Rham curl into RT0:
`b=Curl_ND_to_RT a`, so `B_oe` is the RT0 field represented by `b` and its
incidence divergence vanishes before any nodal projection. `H_oe=B_oe/mu0` is
then projected by a consistent `L2` mass matrix to the same nodal field space
used by the LLG RHS, and the observable publishes that exact projection. The
weak Ampere/current residual and compatible RT0 divergence are measured before
projection; differentiating the nodal display/LLG field is not a Maxwell or
gauge residual.
Matrix caching is allowed only for unchanged geometry and `mu0`. The CPU target
uses MFEM plus block solver/AMS. A future device target would require
device-owned hypre/libCEED operators and state, but this publication makes no
GPU executable claim. Assembly, BC, solve, projection, and telemetry have
separate owners; `mfem_bridge.cpp` is an adapter. Any later strict GPU target
must have no CPU vector-potential solve or hidden transfer fallback.

Material `mu_r != 1` requires a separate coupled publication to prevent double
counting micromagnetic response.

This path resolves operator `fem_oersted_hcurl_h1_gauge.v1`, realization
`oersted_fem_vector_potential.v1`, and CPU/GPU engines
`fem_oersted_hcurl_h1_gauge_v1` /
`fem_oersted_hcurl_h1_gauge_device_v1` respectively.

### 3.5 SI, sign, energy and accepted work snapshot

The two FEM realizations consume the same signed conventional `J_c [A/m^2]`
and produce `H_oe [A/m]`; OE-F2 stores `A [T m]`, `curl A=B_oe [T]`, and
`p [A/m]`. Reversing every RT0 face flux must reverse `A`, `B_oe`, `H_oe` and
the Zeeman energy contribution exactly within the linear-solve/quadrature
tolerance. No `mu0` multiplies Biot--Savart `H`; OE-F2 divides `curl A` by
`mu0` once.

For one-way current independent of `m`, both paths publish
`-mu0 integral M_s m dot H_oe dV` as external Zeeman energy, without `1/2`.
For `J_c(m)` they publish only
`oersted_zeeman_work_snapshot`, excluded from conservative `E_total`. The
snapshot identity is the immutable tuple
`(accepted_or_stage_state, evaluation_time_s, source_state_revision,
source_field_digest, closure_digest, mesh_revision, oersted_operator_version,
projection_version)`. Field, energy/work, quantities and provenance must refer
to the same tuple; a rejected stage cannot advance or publish it.

### 3.6 Hybrid and coupling cadence

No hybrid Oersted lane is validated here. Any future cross-discretization
source projection must conserve total and local current, report projection
error, retain closure, and converge to the same direct Biot–Savart oracle.

`refresh=stage_consistent` is strict. `separable_scale` is exact only after the
planner proves separability. `accepted_step_approx` is explicitly degraded and
requires temporal-order evidence; it cannot claim strict high-order coupling.
M2 nonlinear failure rejects the LLG step. M3 uses common IMEX rollback for
`m,V,mu_s,J,H`, cache state, and telemetry.

## 4. API, IR, planner, runtime, and workspace impact

### 4.1 Python API surface

`CurrentTransport` owns model, domain, drive, one envelope, materials,
electrodes, and coupling. `OerstedField` binds `current_source`, one tagged
circuit closure, method, and refresh policy. Python validation rejects missing
gauge, invalid source/closure, unsupported PBC, unsigned vector reduction,
missing bandwidth, and ambiguous thickness/regions. Canonical script export
preserves all envelope data, including complete piecewise-linear points.
OE-T0 introduces no independently authored current object: the conservative
view is a resolved product of the named current source. `direct_biot_savart`
and `fem_vector_potential` remain explicit method choices. FEM vector-potential
policy exposes the boundary/gauge variant; omission resolves only to the
baseline `tangential_A_h1_0.v1`, never to the zero-mean variant. Direct tetra
quadrature exposes a tagged deterministic FP64 policy rather than reusing
Krylov fields. Python and UI script export must preserve every selected policy
field and reject unavailable lanes before execution.

### 4.2 ProblemIR representation

Typed `ResolvedCurrentTransportPlanIR` and `OerstedSourceIR`/
`ResolvedOerstedPlanIR` preserve source identity, signed convention, envelope,
electrodes/BC, closure, method/operator versions, validity assessment,
refresh/coupling, energy semantics, mesh/source revisions, and requested lane.
Authored `OerstedSourceIR` carries `current_source_id` plus geometry/meshing
intent only; it cannot carry a current-view reference, artifact revision,
face-record count or digest. The resolved plan obtains
`ConservativeCurrentViewRef` only from the executed named source revision and
its verified data-plane artifact.
Legacy flat fields are accepted only by a versioned migrator that cannot drop
parameters. Normalized four-path authoring round-trip is field-for-field equal.
`ResolvedOerstedPlanIR` additionally pins the conservative-current-view
operator, source/mesh/topology/closure revisions and digests, observation and
projection spaces, boundary/gauge variant, quadrature profile or block-solver
profile, and expected work-snapshot semantics. Canonical face-flux record
streams remain runtime data-plane payloads rather than JSON `ProblemIR` and
are independent of MFEM numbering/storage.

### 4.3 Planner and capability matrix

Capabilities distinguish `transport.charge.ohmic`,
`transport.charge.magnetoresistive`, `field.oersted.dynamic`,
`field.oersted.fdm_fft`, `field.oersted.fem_vector_potential`, and coupling
cadence. Planner verifies continuity, closure, regime, topology, PBC, method,
lane/device/precision, cache identity, solver availability, and strict
residency. Requested and resolved selections remain visible. Validation is
scoped to named workload, geometry/BC, lane, precision, and frequency envelope.
Until OE-T0, OE-F1 and OE-F2 gates are implemented, the canonical FEM direct
tetra and vector-potential capabilities remain `semantic_only`. Existing
cylinder or nodal midpoint execution cannot satisfy or promote them.

### 4.4 Runtime, quantities, provenance, API, and UI

Transport workflow owns current state; Oersted consumes `J_charge`; integrator
coordinates stage evaluation without owning either physics. Existing IDs
`V_electric`, `J_charge`, and `H_oe` are retained. Energy/work snapshots carry
explicit semantics. Telemetry records residual/balance, refresh/cache counts,
method/operator revision, airbox/kernel metadata, stage time, timings, and
strict-GPU transfer counts.

The current artifact gains a versioned RT0 data-plane member plus a compact
JSON manifest containing its immutable view descriptor and balance
certificate. Oersted artifacts record the consumed source digest (not merely
its display-field revision), quadrature/linear-solve convergence, topology and
airbox certificate, projection identity, and work-snapshot identity. A missing
or mismatched manifest fails closed. No generic dispatcher, `Context`, or
`mfem_bridge.cpp` owns these algorithms: they belong to current-transport and
Oersted subsystems under `backends/fem`.

Provenance records authored source and closure, formula/operator versions,
current convention, envelope/bandwidth, validity metrics/override, requested
and resolved execution, energy semantics, revisions, and external-oracle version.

Resource-first API projects revisioned Current Transport and Oersted Field
models while heavy fields remain in `/data/fields`. Dedicated Explorer and
Inspector nodes show source, signed current, closure, method, refresh, SI units,
regime, freshness, residual, and capability scope. UI Apply shares canonical
validation and export emits canonical Python.

## 5. Validation strategy

### 5.1 Analytical checks

| Workload | Required result |
|---|---|
| uniform/layered conductor | analytic potential, resistance, flux balance |
| infinite-wire limit | `H_phi=I/(2 pi r)` after controlled length study |
| uniform cylinder | analytic inside/outside and continuity at `R` |
| signed-current involution | exact chirality reversal |
| arbitrary-axis cylinder | rotational covariance for z, x, and `(1,1,1)` |
| separable envelope | exact amplitude/phase at every RK stage |
| energy consistency | snapshot from exactly the RHS field, no `1/2` |
| RT0 conservation | shared-face flux cancellation, element divergence and terminal/closure balance |
| direct tetra singularity | inside/on-face/on-edge targets converge without cutoff |
| exact-sequence gauge | manufactured `A`, gradient-nullspace and harmonic-topology reject/constraint |

### 5.2 Cross-method/backend checks

FDM cell-integrated FFT is compared componentwise with direct integration for
the same closed circuit, including random signed current, near cells, shifted
conductor, mask, `nz=1`, crop, and self-cell zero. FEM vector potential is
compared with direct quadrature and an airbox sequence. Independent FDM/FEM
families converge to the same continuum solution. CPU double is the oracle for
its GPU double lane; FP32 follows a separate error budget. NeuralMag supplies a
comparative regular-grid cell-integrated pattern, not an MFEM oracle.
MFEM Example 34 is a useful SubMesh/ND/RT transfer reference but explicitly
warns that its demonstration current need not be divergence-free; therefore it
cannot satisfy OE-T0 without the conservative reconstruction and range check.

### 5.3 Regression and quantitative gates

Tests cover OE-F2 preconditioner-scaled first-block and `B^T a` constraint
residuals, weak Ampere/current residual, compatible RT0 curl and incidence
divergence before nodal projection, FFT layout/normalization, singleton axes,
unsupported PBC rejection,
closure rejection, conductor/magnet masks, sine/pulse/PWL/sinc timing, FSAL,
rejected-step rollback, final refresh, M2 diagnostic exclusion from `E_total`,
strict-GPU zero hot-loop transfers, quantity/RHS identity, normalized authoring
round-trip, and browser author/run/inspect smoke. Continuum studies use at least
three spatial resolutions and three time steps; observed temporal order must be
at least nominal minus `0.25` in the asymptotic range.

## 6. Completeness checklist

- [ ] Python current/Oersted model and complete envelope export
- [ ] ProblemIR, planner, migration, and scoped capabilities
- [ ] Conservative FDM charge and face-to-cell publication
- [ ] FDM direct oracle and cell-integrated CPU/CUDA FFT
- [ ] FEM direct oracle and `H(curl)` CPU/GPU vector potential
- [ ] OE-T0 immutable conservative RT0 view with revision/digest certificate
- [ ] OE-F1 cutoff-free direct tetrahedral CPU-double oracle
- [ ] OE-F2 exact-sequence `H_0(curl) x H^1_0` baseline and topology gate
- [ ] Stage-consistent coupling, FSAL, rollback, final refresh
- [ ] Correct external/nonvariational energy semantics
- [ ] Quantities, provenance, typed API, and UI inspectors
- [ ] Cross-backend convergence and managed/browser proof

Unchecked items remain implementation work.

## 7. Known limits and deferred work

Full Maxwell waves, displacement current, skin/eddy redistribution, magnetic
`mu_r` in the Oersted solve, periodic Ewald kernels, higher-order Nedelec,
exact open-boundary FEM treatments, and hybrid source projection require
separate publications and gates. An expert regime override is provenance, not
evidence that the approximation is accurate.

## 8. References

1. T. Schrefl, `docs/papers/mic_intro.pdf` (local copy, 2016), especially the magnetostatic Ampere/divergence and external-Zeeman conventions.
2. *Manual for Micromagnetics Module*, `docs/comsol/Manual_for_Micromagnetics_Module.pdf` (local copy; current-density-to-magnetization workflow comparison only, not a numerical oracle).
3. NeuralMag `external_solvers/neuralmag/neuralmag/common/convolution_setup.py`, `convolution_runtime.py`, and `field_terms/oersted_field.py`; comparative open-boundary regular-grid tensor, SI and energy evidence only.
4. BORIS `external_solvers/BORIS/Boris/OerstedTFunc.cpp`, `OerstedKernel.cpp`, `Oersted.cpp`, and `Transport_Charge_Display.cpp`; comparative current/Oersted ownership and FFT lifecycle evidence only.
5. J. R. Dormand and P. J. Prince, J. Comput. Appl. Math. 6 (1980), DOI: 10.1016/0771-050X(80)90013-3.
6. MFEM, [Example 34 source](https://docs.mfem.org/html/ex34_8cpp_source.html), magnetostatic SubMesh transfer with its documented divergence-free-current limitation.
7. MFEM, [Maxwell discretization notes](https://mfem.org/maxwell-notes/), de Rham-compatible `H(curl)`/`H(div)` spaces and weak curl operators.
8. MFEM, [Tour of examples](https://mfem.org/tutorial/examples/), Examples 3, 4 and 24 for Nedelec, Raviart--Thomas and mixed exact-sequence operators.
9. R. Hiptmair, [“Finite elements in computational electromagnetism”](https://doi.org/10.1017/S0962492902000041), *Acta Numerica* 11 (2002), 237--339; discrete differential forms, exact sequences and topology.
10. [“Evaluation of Biot--Savart integrals on tetrahedral meshes”](https://arxiv.org/abs/0712.1695); comparative tetrahedral quadrature strategy, not a Fullmag acceptance oracle.
