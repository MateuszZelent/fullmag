# Dynamic current and Oersted coupling

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-08-05
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

(problem-statement)=
## 1. Problem statement

All current-induced physics must consume one signed, conservative current field
at the same stage time. Computing torque from one current approximation and
Oersted field from another creates an internally inconsistent multiphysics
problem. This note defines charge-source timing, global circuit closure,
Oersted field/energy semantics, FDM cell-integrated convolution, FEM
`H(curl)` vector potential, caching, rollback, observables, and qualification.

It specifies a target contract and does not claim existing lanes satisfy it.

(governing-equations)=
## 2. Governing equations and physical model

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

```{math}
:label: instantaneous-biot-savart-h
H_{\mathrm{oe}}(x,t)=\frac{1}{4\pi}\int_{\Omega_c}
\frac{J_c(x',t)\times(x-x')}{|x-x'|^3}\,dV'.
```

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

(symbols-and-si-units)=
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
| `r` | target-source displacement | m |
| `V_e` | active tetrahedron volume | m^3 |
| `r_reg` | equivalent-sphere self regularization radius of the bounded midpoint slice | m |
| `mu_0` | vacuum permeability used only when converting H to B or evaluating Zeeman energy | H/m |

(assumptions-and-validity)=
### 2.8 Assumptions and validity limits

The model excludes displacement current, propagation delay, full-wave
electromagnetics, unresolved skin/eddy-current redistribution, and magnetic
material response inside the Oersted operator. Unsupported PBC, missing closure,
nonconservative prescribed current, undefined source time, or strict operation
outside the regime fail closed rather than selecting a plausible fallback.

(discrete-realization)=
## 3. Numerical interpretation and discrete realization

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
  envelope_revision, envelope_digest, evaluated_envelope_multiplier,
  canonical_face_record_count, face_record_payload_sha256,
  canonical_face_digest, balance_certificate_digest, view_identity_digest,
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
serialization. Section 3.2.1 freezes the sole composite digest preimage; no
alternative preimage that hashes records directly is permitted. Stable vertex
identities are independent of element numbering and MPI ownership. Element
reorder, local face reorder, true-dof reorder and MPI repartition must therefore
leave the digest unchanged.

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

The periodic solve request and immutable accepted snapshot both carry the exact
`source_module_id`, `source_state_revision`, `source_field_digest`,
`evaluation_time_s`, `stage_identity`, `envelope_revision` and
`envelope_digest`, plus the evaluated finite envelope multiplier. OE-T0 accepts
the snapshot only when all values equal its RT build request. A potential from
another current module, source/field revision, stage time, stage identity or
envelope is stale even when mesh and conductivity are unchanged.

The OE-T0 manufactured periodic qualification is not satisfied by snapshot
summary getters. On the unit cube with `sigma=4 S/m` and a `-1 V` jump, an
independent test evaluates every P1 node and volume quadrature point against
`V=0.5-x V`, evaluates every physical gradient against `(-1,0,0) V/m`, and
integrates each cut-face flux against
`sigma grad(V).n=(-4,0,0).n A/m^2`. It independently assembles
`integral sigma grad(V).grad(phi_i) dV` from element shape gradients and then
combines the two cut-side entries belonging to each periodic quotient basis
function. Every combined residual and every non-cut residual is at most
`1e-12 A`. Thus exact traces alone cannot hide an incorrect interior weak
solution.

The construction request contains the potential and conductivity snapshots,
stable vertex identities, classified boundary faces, terminal/source-cut
constraints, closure support, all source/mesh/topology revisions and digests,
`envelope_revision`, `envelope_digest`, the evaluated envelope multiplier,
evaluation time and stage identity. `closed_geometry` accepts either a
periodic-drop reconstruction sourced by the same current module or a certified
imported closed RT0 field. The closure object itself never invents a drive;
absent either source, its only admissible potential-derived solution is zero
current. `external_lead_extension` participates in the same coupled
constrained solve. OE-T0 rejects analytic returns, incomplete interface pairing
and any attempt to manufacture closure by zeroing an open terminal flux.
The reference lead fixture uses a device on `x in [0,1]` and disjoint
volumetric leads on `[-1,0]` and `[1,2]`, joined only on the conforming planes
`x=0` and `x=1`. For constant cross-section `A`, piecewise conductivities
`sigma_L,sigma_D,sigma_R` and outer-electrode drop `Delta V`, the required
series oracle is
`I=Delta V/(L_L/(sigma_L A)+L_D/(sigma_D A)+L_R/(sigma_R A))`.
Changing lead conductivity must change the device current; otherwise the
implementation has not included lead impedance in one coupled solve.
Device and lead stable vertex identities occupy disjoint namespaces even at
coincident join coordinates, so the two one-sided interface faces retain
distinct canonical keys. The combined immutable mesh orders device vertices
first and lead vertices second, and its identity vector is the exact
concatenation of the two authored vectors. Recomputing combined IDs from
coordinates is forbidden; geometric coincidence validates pairing but never
collapses identity.

Constraint rank is owned by
`cpu/mfem/transport/conservative_constraint_rank.hpp`, never by an ad hoc
floating dense rank check inside `ConservativeCurrentView::Build`. Its frozen
C++ contract is:

```cpp
enum class ConservativeConstraintRankRowKind : uint8_t {
    Generic = 1,
    ClosedComponentDivergence = 2,
};
enum class ConstraintOmissionReason : uint8_t {
    ClosedComponentDivergenceDependency = 1,
    ConsistentLinearDependency = 2,
};
struct ConservativeConstraintRankRow {
    std::string constraint_id;
    ConservativeConstraintRankRowKind kind;
    std::array<uint64_t, 4> closed_component_anchor_element;
    std::array<uint64_t, 4> row_element_key;
    std::vector<uint64_t> canonical_column_ids;
    std::vector<int64_t> incidence_coefficients;
    double rhs_a;
};
struct ConstraintRankOmittedRow {
    std::string constraint_id;
    ConstraintOmissionReason reason;
    double residual_a;
    std::array<uint64_t, 4> closed_component_anchor_element;
};
struct ConstraintRankCertificate {
    uint64_t rows_before;
    uint64_t rank;
    std::vector<ConstraintRankOmittedRow> omitted_rows;
};
class InconsistentDependentConstraint : public std::runtime_error {
public:
    const std::string &constraint_id() const noexcept;
    double residual_a() const noexcept;
};
class ConstraintRankResourceLimitExceeded : public std::runtime_error {};
struct ResourceCounts {
    uint64_t rows;
    uint64_t distinct_columns;
    uint64_t total_nonzeros;
    uint64_t maximum_nonzeros_per_row;
    uint64_t maximum_intermediate_nonzeros;
    uint64_t intermediate_storage_bits;
    uint64_t bareiss_work_units;
    uint64_t maximum_intermediate_bit_length;
};
class ConservativeConstraintRank {
public:
    static constexpr std::size_t kMaximumRows = 1u << 20;
    static constexpr std::size_t kMaximumDistinctColumns = 1u << 20;
    static constexpr std::size_t kMaximumNonzeros = 1u << 24;
    static constexpr std::size_t kMaximumColumnsPerRow = 4096;
    static constexpr uint64_t kMaximumIntermediateNonzeros = uint64_t{1} << 24;
    static constexpr uint64_t kMaximumIntermediateStorageBits = uint64_t{1} << 31;
    static constexpr uint64_t kMaximumBareissWorkUnits = uint64_t{1} << 32;
    static constexpr uint64_t kMaximumIntermediateBitLength = uint64_t{1} << 20;
    static void ValidateResourceCounts(const ResourceCounts &counts);
    static ConstraintRankCertificate Analyze(
        const std::vector<ConservativeConstraintRankRow> &rows,
        double physical_absolute_gate_a = 1e-18,
        double physical_relative_gate = 1e-10);
};
```

The row kind is semantic input, not inferred from `constraint_id`. Generic rows
must carry all-zero sentinels for both component anchor and row element key.
Closed-component divergence rows must carry four strictly increasing, nonzero
stable vertex IDs in both fields, with `anchor<=row_element_key`. Rows sharing
an anchor form one component, their row keys are unique, and exactly one row
per component has `row_element_key==anchor`. Missing/duplicate candidates,
duplicate component row keys, unknown row kinds and inconsistent metadata
reject. The analyzer derives the omission reason and copied anchor only from
these fields; parsing an ID or postprocessing an omission is forbidden.
Its frozen processing key places every generic and closed non-candidate row
before all unique anchor candidates, with canonical constraint ID as the
tie-breaker within each class. Thus the unique minimum-anchor divergence row
is the dependent row considered last and omitted deterministically even when
its ID sorts first. Column IDs are strictly increasing canonical stable face/constraint-column
identities, coefficients are exact signed integers, row IDs are nonempty and
unique, and canonical constraint ID orders rows only within each frozen
processing-key class. For
`r1=[1,0], r2=[0,1], r3=[1,1]`, RHS `(1,1,2)` deterministically retains r1/r2
and omits r3 with `ConsistentLinearDependency` and zero residual; RHS
`(1,1,3)` throws typed `InconsistentDependentConstraint` for r3. Build and
Import must use this analyzer and persist its certificate. Physical
closed-component omissions use `ClosedComponentDivergenceDependency` and the
lexicographically smallest stable tetrahedron key as both component anchor and
the omitted candidate's row element key. Physical B-row construction must
populate both fields for every divergence row before calling `Analyze`.
The coefficient rank is deterministic fraction-free Bareiss elimination over
`boost::multiprecision::cpp_int`; no fixed-width overflow or floating pivot
tolerance can change it. The public `ValidateResourceCounts` seam is mandatory
inside `Analyze`, uses checked addition/multiplication, and throws only the
typed fail-closed `ConstraintRankResourceLimitExceeded` for resource excess.
Pre-allocation caps are `2^20` rows, `2^20` distinct
columns, `2^24` total nonzeros and 4096 nonzeros per row. Empty/duplicate row
IDs, unsorted/duplicate columns, mismatched vector sizes, stored zero
coefficients, nonfinite RHS and cap overflow reject. A dependent RHS is
consistent only under the frozen current absolute/relative physical gate, and
the independently recomputed ampere residual is persisted. Legal but
pathological matrices additionally stop before `2^24` intermediate nonzeros,
`2^31` aggregate intermediate storage bits, `2^32` checked Bareiss work units,
or an intermediate `cpp_int` exceeds `2^20` bits; all use the same typed
resource exception. Limit and limit+1 are tested through the seam without huge
fixtures. The physical gate is exactly
`abs(residual)<=max(abs_gate,rel_gate*max(abs(rhs),1e-30))`.
Exact-width qualification uses `M=4,000,000,000` and
`C=-2,446,744,073,709,551,616`: `[M,1]`, `[C,M]`, and their sum are rank two,
while `cpp_int` proves the independent determinant `M*M-C=2^64`. The sum row
must be the persisted zero-residual generic omission.

The canonical C++ interface is exactly:

```cpp
class ConservativeCurrentView {
public:
    using Ptr = std::shared_ptr<const ConservativeCurrentView>;
    static Ptr Build(const ConservativeCurrentBuildRequest &);
    static Ptr Import(const ConservativeCurrentImportRequest &);
    const mfem::FiniteElementSpace &space() const;
    const mfem::GridFunction &field() const;
    const ConservativeCurrentIdentity &identity() const;
    const ConservativeCurrentBalanceCertificate &balance() const;
    const ConstraintRankCertificate &constraint_rank_certificate() const;
    const std::vector<CanonicalFaceFluxRecord> &
        canonical_face_flux_records() const;
    const std::vector<uint8_t> &
        canonical_balance_certificate_bytes() const;
    bool canonical_face_flux_records_are_global_and_broadcast() const;
private:
    ConservativeCurrentView();
};
```

`Build` and `Import` are the only factories and construction remains private.
The returned `Ptr` owns an immutable deep copy of the mesh, RT collection,
finite-element space, grid function, globally sorted and rank-broadcast
canonical records, identity metadata, and the complete canonical balance
certificate bytes. Destroying every build/import input cannot invalidate
`space()`, `field()`, record or certificate access. The transport owner stores
only this `Ptr`; readers use `std::atomic_load` and the owner publishes with
atomic shared-pointer replacement only after all gates succeed. Failure leaves
the previous accepted pointer intact; tentative/rejected-stage state is never
published.

The workflow freezes this ownership through one named public owner:

```cpp
class ConservativeCurrentViewOwner {
public:
    explicit ConservativeCurrentViewOwner(
        mfem::GridFunction &nodal_visualization);
    ConservativeCurrentViewOwner(const ConservativeCurrentViewOwner &) = delete;
    ConservativeCurrentViewOwner &operator=(
        const ConservativeCurrentViewOwner &) = delete;
    ConservativeCurrentViewOwner(ConservativeCurrentViewOwner &&) = delete;
    ConservativeCurrentViewOwner &operator=(
        ConservativeCurrentViewOwner &&) = delete;
    ConservativeCurrentView::Ptr conservative_charge_current() const;
    const mfem::GridFunction &charge_current_density() const;
    void publish_accepted(ConservativeCurrentView::Ptr accepted);
};
```

`conservative_charge_current()` performs `std::atomic_load` of the accepted
RT0 pointer. `publish_accepted` rejects null/tentative views and atomically
replaces the pointer only after `Build` or `Import` succeeds. Failed build,
import or publication retains the prior pointer. The nodal
`charge_current_density()` is separate visualization storage and cannot alias
the RT0 `field()`. The visualization argument is an explicit non-owning borrow:
its mesh, finite-element space and `GridFunction` must outlive the owner. The
owner is neither copyable nor movable, so the borrow cannot silently migrate
to another lifetime domain. The immutable RT0 `Ptr` remains independently
owned and may outlive every build/import input.

The balance certificate is evaluated from the physical Piola-mapped field by
independent quadrature, not from the KKT residual. It records every element
residual, shared-face trace jump, terminal/source-cut flux, closure-interface
pair, net outer flux and normalized global balance using a `1e-30 A` floor.
The public summary may expose maxima, but the complete diagnostic artifact is
retained.
Qualification must independently decode the complete artifact and reproduce
every element, face, circuit and omitted-constraint row from physical
quadrature, boundary roles and closure pairing. It then recomputes all gates,
summary maxima, outer/source-cut/electrode/interface fluxes and
`closure_complete`; matching only the artifact hash is not evidence of a
physically correct certificate. The decoder constructs the exact map
`boundary_element -> stable face key -> (role,circuit_id)`, requires every
circuit key to be a one-sided physical boundary face, matches source-cut and
lead-interface rows to the authored ordered face pairs, and proves terminal
and outer-boundary row-set completeness. Substituting an internal face is a
hard failure. Before reserve/iteration it enforces every `2^31-1` row cap;
every length-prefixed semantic string is at most 4096 bytes, valid shortest-form
UTF-8, contains no surrogate/out-of-range scalar and no embedded NUL.
The omitted-row count is not hardcoded. A required integration fixture imports
`J=(4,0,0) A/m^2` on two disconnected periodic unit-cube components (the
second translated in y), with disjoint stable face IDs and unique source cuts.
An independent oracle materializes the real `D=[B;C]`: canonical free RT0 face
columns after insulating-outer elimination, signed element/outward-face B rows,
and exact authored cut-pair C rows. `cpp_int` Bareiss proves B is full row rank,
D has nullity two and removing exactly the minimum-anchor divergence row of
each component makes reduced D full row rank. The accepted view must report
the exact oracle `rows_before`, `rank`, `rows_before-rank=2` and exactly two omitted
divergence rows, one per stable component anchor, each with reason
`ClosedComponentDivergenceDependency` and independently integrated residual
at most `1e-12 A`; the canonical decoder matches this variable omitted set.

For canonical face records, the sorted stable vertex triple `(a<b<c)` defines
the face key and its ordered coordinates define the canonical normal. Repeated
identities, degenerate faces, non-finite fluxes, or identity/coordinate
disagreement across ranks are rejected. Records normalize negative zero,
encode unsigned identities and binary64 flux in little-endian form. The raw
32-byte record stream has `face_record_payload_sha256=SHA256(file_bytes)`.
`canonical_face_digest` has one and only one preimage. Define
`LP(x)=u64le(byte_length(x)) || UTF8(x)`. Then it is exactly

```text
SHA256(
  LP("fem_rt0_canonical_face_digest.v1") ||
  LP("fem_conservative_current_rt0_view.v1") ||
  LP("stable_vertex_lexicographic_normal.v1") ||
  LP(geometry_digest) ||
  u64le(canonical_face_record_count) ||
  decode_hex_32(face_record_payload_sha256)
)
```

The raw record bytes participate only through the nested decoded 32-byte
`face_record_payload_sha256`; they are not appended again. This replaces every
earlier informal/direct-record preimage. The digest changes only when this
versioned physical/geometry preimage changes.

`view_identity_digest` uses
`fem_conservative_current_view_identity_digest.v1`. Its preimage is the fixed
ordered field list: schema tag, `canonical_face_digest`, source module ID,
source state revision, source field digest, mesh revision, topology revision,
geometry digest, closure revision, closure digest, envelope revision, envelope
digest, evaluated envelope multiplier, evaluation time, stage identity and
`balance_certificate_digest`. Every string is UTF-8 encoded as
`u64le byte_length || bytes`; `stage_identity` is `u64le`; multiplier and time
are finite IEEE-754 binary64 little-endian with negative zero normalized to
positive zero.
The balance digest is the SHA-256 of the canonical bytes of
`fem_conservative_current_balance_certificate.v1`, not a pointer/reference or
only the five-field API summary. That persisted binary contains sorted stable
element, face, terminal, source-cut, interface and outer-boundary records plus
the applied gates and summary. A revision-only
change therefore invalidates the view/cache without falsely changing the
physical record digest.

The exact balance-v1 prefix is schema LP, three gate f64 values,
`u64le(rows_before)`, `u64le(rank)`, then the four row-family counts. Each
omitted row is `LP(constraint_id) || u8(reason) || 4*u64le(anchor) ||
f64le(residual_A)`. Reasons are exactly
`1=ClosedComponentDivergenceDependency` and
`2=ConsistentLinearDependency`. Reason 1 requires four strictly increasing,
nonzero stable tetrahedron IDs, that exact anchor must exist in the decoded
element-row set, and its constraint ID must equal
`divergence:<v0>:<v1>:<v2>:<v3>`; its residual must equal that exact element
row. Reason 2 requires `(0,0,0,0)`, using reserved stable ID zero as the generic
sentinel. `balance_certificate_digest` hashes these exact rank
bytes together with every other certificate row and summary, so the existing
`view_identity_digest` transitively covers the complete rank certificate.

Balance face rows restrict `side_count` to `1|2`. A two-sided row orders its
sides by the lexicographic stable adjacent-element key (the four sorted stable
vertex IDs), never by local element/face/RT-DOF number. A one-sided row writes
the absent `side2_flux_A` as the canonical positive-zero binary64 sentinel.
Circuit kind is exactly `1=terminal`, `2=source_cut`,
`3=closure_interface`, `4=outer_boundary`. Source-cut and closure-interface
rows require two nonzero face keys and paired physical fluxes. Terminal and
outer-boundary rows require the absent second face key `(0,0,0)` and
`paired_flux_A=+0.0`; stable vertex ID zero is reserved and cannot occur in a
real key. All binary64 zero values, including mismatch sentinels, are encoded
as positive zero. `closure_complete` is `0|1`; every other enum value is
rejected.

Each row-family count is at most `2^31-1`, each UTF-8 ID is at most 4096 bytes,
and the checked total certificate byte length is at most `2^63-1`. Count/size
multiplication or addition overflow is rejected before allocation. Every row
family is strictly sorted by its documented key; duplicate element, face,
circuit or omitted-constraint keys are rejected rather than coalesced.

All four SHA-256 values in this contract are transported and persisted as
exactly 64 lowercase ASCII hexadecimal characters without a prefix. Import
rejects any other length/alphabet/case. When one SHA value participates in
another hash preimage it is decoded to its 32 raw bytes; it is never hashed as
an implementation-selected textual spelling. Import/restore deep-copies the
complete certificate bytes, recomputes `face_record_payload_sha256`,
`canonical_face_digest`, `balance_certificate_digest`, and
`view_identity_digest` from their frozen preimages, and rejects before
publication if any one differs.

The OE-T0 v1 reference executable guarantees byte-identical one-rank/two-rank
results by gathering the canonical affine mesh, coefficients and constraints,
performing the reconstruction in deterministic canonical order on rank zero,
and broadcasting canonical records and the accepted field. This is an
explicit correctness/reference realization, not the production-scalability
claim. A future distributed reconstruction may replace it only under a new
deterministic reduction/quantization contract and must retain the same
physical gates.

OE-T0 GREEN requires both managed commands:
`just verify-fem-oersted-oet0-cpu-contract` and
`just verify-fem-oersted-oet0-tsan-cpu-contract`. The latter uses the isolated
`oersted-oet0-tsan` build directory, compiles and links only the serial contract
with `-fsanitize=thread -fno-omit-frame-pointer`, executes no MPI launcher, and
sets `TSAN_OPTIONS=halt_on_error=1:exitcode=66`; any report is a hard failure.
With `FULLMAG_OET0_TSAN=ON`, CMake skips the MFEM MPI probe, explicit MPI target
link and every MPI CTest, and defines `FULLMAG_OET0_DISABLE_MPI=1`; MPI code and
CLI compile only under `MFEM_USE_MPI && !FULLMAG_OET0_DISABLE_MPI`. The shared
MPI-enabled MFEM library may retain a transitive MPI dependency, but the TSan
target contains no Fullmag MPI code, launcher or test. GREEN conditionally adds
`conservative_constraint_rank.cpp`, `periodic_charge_potential.cpp` and
`conservative_current_view.cpp` directly to the instrumented contract target;
zero existing files is RED, partial existence is CMake FATAL, and all three are
compiled with the same sanitizer flags rather than linked from unsanitized
`fullmag_fem`. The runner audits CTest registration, compile definition,
source-object list and flags.

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

The current bounded CPU reference profile is FP64 with tetrahedral base order 4,
segment/Duffy order increased by two per adaptive level, maximum subdivision
depth 6, absolute field tolerance $10^{-9}\,\mathrm{A/m}$ and relative
tolerance $10^{-5}$. These values are an executable small-problem envelope,
not a production accuracy claim: a tighter requested tolerance must either
provide a larger depth budget or fail closed with an unconverged-pair
diagnostic. The direct implementation uses the same physical target point
after barycentric classification; it does not delete a self cell or introduce
a distance cutoff. A target inside/on a tetrahedron is split into
positive-volume target-vertex tetrahedra and mapped with
$r=\xi[(1-\eta)e_1+\eta(1-\zeta)e_2+\eta\zeta e_3]$, whose Jacobian is
$|\det(e_1,e_2,e_3)|\xi^2\eta$; the radial $\xi^2$ factor cancels the
$1/r^2$ singularity before Gauss integration.

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

The bounded CPU reference now exposes the projection operation as
`DirectTetraQuadrature::ProjectField`. It accepts an RT0 source and a distinct
three-component `H1_3D_*` target space with `Ordering::byVDIM`, evaluates the
direct field at the target tetrahedral quadrature points, and assembles one
scalar consistent mass system per Cartesian component. Each system is solved
with the deterministic FP64 MFEM PCG/Gauss--Seidel path and checked by a mass
equation residual of at most $10^{-10}\max(1,\|l\|_2)$. Source--target pair,
refinement, and unconverged-pair diagnostics are accumulated across all three
components. This is a reference-only projection contract: it does not publish
an API/runtime field, does not claim a target-quadrature error bound, and does
not qualify overlapping source/target meshes at production scale; an exhausted
near-pair depth remains a fail-closed error.

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

(implementation-mapping)=
## 4. API, IR, planner, runtime, and workspace impact

(python-api)=
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

```python
# %%
from fullmag import CurrentTransport, OerstedField

drive = CurrentTransport(name="drive", current_density=(1.0e10, 0.0, 0.0))
oersted = OerstedField(source=drive.name)
assert oersted.model == "from_current_solution"
```

| Python | Typ | Domyślnie | Jednostka SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.model` | `Literal['prescribed_density','ohmic_poisson','magnetoresistive_poisson']` | `prescribed_density` | `1` | `The bounded FEM solved-current slice requires ohmic_poisson, one_way coupling, steady mode, strict execution and double precision.` | `charge solve producing the source current` | `FEM CPU bounded reference; other lanes remain capability-scoped` | `current_modules[].model` |
| `OerstedField.source` | `str` | `required` | `1` | `Must name exactly one CurrentTransport module; the runtime consumes its solved field, not a copied current density.` | `current-source identity` | `FEM/FDM authoring; executable status is planner-scoped` | `energy_terms[].source` |
| `OerstedField.model` | `Literal['from_current_solution']` | `from_current_solution` | `1` | `No alternate implicit model is accepted by the canonical IR.` | `bind Oersted to the named solved current` | `FEM/FDM according to capability matrix` | `energy_terms[].model` |

(round-trip-and-failure-semantics)=
#### 4.1.1 Requested intent, resolved execution and failures

Round-trip preserves the author's `requested intent` and the planner's
`resolved execution`, including source identity, closure, envelope and lane.
`validation errors` are returned before native execution. `unsupported combinations`
remain explicit and fail closed; they are never replaced by a
different current source or a hidden backend fallback.

(problem-ir)=
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
certificate. The manifest persists the complete identity tuple:
`source_module_id`, `source_state_revision`, `source_field_digest`,
`mesh_revision`, `topology_revision`, `geometry_digest`, `closure_revision`,
`closure_digest`, `envelope_revision`, `envelope_digest`,
`evaluated_envelope_multiplier`, `evaluation_time_s`, `stage_identity`, all
four record/certificate/view digests, schema/operator/orientation versions,
record count/length and SI/component/FE tags. Oersted artifacts record the consumed source digest (not merely
its display-field revision), quadrature/linear-solve convergence, topology and
airbox certificate, projection identity, and work-snapshot identity. A missing
or mismatched manifest fails closed. No generic dispatcher, `Context`, or
`mfem_bridge.cpp` owns these algorithms: they belong to current-transport and
Oersted subsystems under `backends/fem`.

Until the public runner consumes the immutable RT0/H(div) view, its bounded
steady FEM reference path is intentionally versioned separately as
`fullmag.fem.steady_spin_transport.v2`. That artifact publishes the nodal
midpoint `H_oe` plus SHA-256 identities for the nodal source current and the
mesh/domain mask, and labels the realization
`solved_current_h1_nodal_midpoint_reference`. These digests improve replay and
do not satisfy the RT0 closure, stage-revision, or OE-F1/OE-F2 certificate
requirements above.

Provenance records authored source and closure, formula/operator versions,
current convention, envelope/bandwidth, validity metrics/override, requested
and resolved execution, energy semantics, revisions, and external-oracle version.

Resource-first API projects revisioned Current Transport and Oersted Field
models while heavy fields remain in `/data/fields`. Dedicated Explorer and
Inspector nodes show source, signed current, closure, method, refresh, SI units,
regime, freshness, residual, and capability scope. UI Apply shares canonical
validation and export emits canonical Python.

### 4.5 Bounded executable solved-current FEM slice (2026-08-05)

The current implementation contains one deliberately bounded reference slice
for `OerstedField(model=from_current_solution)` on FEM.  It is legal only for
strict, double-precision, steady, one-way `OhmicPoisson` transport on the
native FEM CPU lane.  The planner records the binding in
`ResolvedFemSpinTransportIR.oersted_source_bound`; a reciprocal FEM M2 request
with the same Oersted source is rejected because the existing one-shot FEM
transport solve is not stage-consistent with `J_c(m_stage)`.

The runtime ordering is explicit:

1. solve the named native FEM charge/spin transport problem to convergence;
2. read the converged nodal `J_c [A/m^2]` from that exact result;
3. verify the source mask, finite values and affine `tet4` support, average the
   four nodal values to each active element, and evaluate the regularized
   midpoint Biot--Savart sum

   ```text
   H_oe(x_i) = sum_e (1/(4 pi)) V_e
               [J_e x (x_i-r_e)] /
               (|x_i-r_e|^2 + r_reg,e^2)^(3/2),
   r_reg,e = (3 V_e/(4 pi))^(1/3);
   ```

4. inject that field into the cloned FEM plan before constructing the LLG
   backend, while preserving any independently planned field by componentwise
   addition.

This is a **bounded reference realization**, not the canonical OE-T0/OE-F1 or
OE-F2 implementation.  The H1 nodal current projection does not provide an
immutable RT0/H(div) conservative-current view, a closure certificate, a
weak-Ampere residual, an airbox vector-potential solve, or a singularity-free
tetrahedral quadrature proof.  Consequently it does not promote the general
FEM dynamic-Oersted capability, does not claim closed-circuit physical
validity, and remains unavailable on FEM GPU.  The separate FDM stage workflow
continues to derive its field from the same accepted charge solution.  The
planner and runtime tests cover source identity, FEM M2 fail-closed behavior,
finite/sign-reversing midpoint fields, and injection length/cylinder guards;
managed FEM execution is still required before any qualification promotion.

### 4.6. Public ABI boundary and next append-only extension (audyt 2026-08-08)

Audyt publicznego łańcucha wykazał, że obecny
`fullmag_fem_steady_transport_request_v1`/`result_v1` nie może jeszcze
materializować kanonicznego prądu dla Oersteda. Żądanie v1 opisuje wyłącznie
ustalony transport H1 z warunkami Dirichleta, a wynik publikuje
`charge_current_density_xyz_apm2` jako nodalny rzut P1/H1. Ten bufor jest
wizualizacją i ograniczonym referencyjnym wynikiem transportu; **nie jest
konserwatywnym widokiem prądu RT0/H(div)**. W v1 nie ma także stabilnych
identyfikatorów wierzchołków, ról ścian, par source-cut, interfejsu leadu,
zaakceptowanego snapshotu okresowego potencjału, rewizji źródła/stage'u ani
certyfikatu bilansu. Dodanie tych pól do istniejącego tailu v1 zmieniłoby
`struct_size` i naruszyło kontrakt ABI.

Do czasu zamknięcia poniższego rozszerzenia publiczny runner musi pozostawać
jawnie oznaczony jako
`solved_current_h1_nodal_midpoint_reference`. Nie wolno zmieniać tego
`source_kind` na `fem_conservative_current_rt0_view.v1`, wywoływać OE-F1/OE-F2
z nodalnego bufora ani promować capability FEM dynamic-Oersted. Istniejące
managed testy `verify-fem-oersted-oet0-cpu-contract`,
`verify-fem-oersted-oef1-cpu-contract` i
`verify-fem-oersted-oef2-cpu-contract` dowodzą operatorów w izolacji; nie są
dowodem połączenia transport → widok RT0 → Oersted → LLG.

#### 4.6.1. Wymagany kontrakt append-only

Następna implementacja ma być nowym, wersjonowanym symbolem i strukturami;
nie modyfikuje istniejących struktur ani symboli v1:

```text
fullmag_fem_steady_transport_rt0_request_v1
fullmag_fem_steady_transport_rt0_result_v1
fullmag_fem_solve_steady_transport_rt0_v1(...)
```

`request_v1` zawiera niezmieniony `base` typu
`fullmag_fem_steady_transport_request_v1` oraz wymagany
`conservative_source_descriptor_v1`. Descriptor musi przenosić:

1. `closure_kind` (`closed_geometry` albo `external_lead_extension`) oraz
   kompletny opis mesha leadu/interfejsów, jeśli wybrano drugi wariant;
2. `stable_vertex_ids` dla każdego wierzchołka, z wersją
   `stable_mesh_vertex_u64.v1`, i rekordy boundary-face z rolą
   `insulating_outer`, `source_cut` albo `closure_interface` oraz stabilnym
   `circuit_id`;
3. source-cut face pairs z uporządkowanymi kluczami trójkątów, wektorem
   translacji i signed `potential_drop_v`, albo jawne pary interfejsu
   urządzenie–lead oraz obie elektrody zewnętrzne;
4. pełną tożsamość snapshotu: `source_module_id`,
   `source_state_revision`, `source_field_digest`, `mesh_revision`,
   `topology_revision`, `geometry_digest`, `closure_revision`,
   `closure_digest`, `envelope_revision`, `envelope_digest`,
   `evaluated_envelope_multiplier`, `evaluation_time_s` i `stage_identity`;
5. politykę tolerancji algebraicznej/fizycznej oraz jawny tryb CPU/GPU.

`result_v1` musi zwrócić zarówno nodalny bufor pomocniczy (jeśli zażądany),
jak i immutable RT0 view: scalar RT0 DOFs na własnym meshu, kanoniczne rekordy
`(face_vertex_ids[3], flux_a)` posortowane po stabilnych ID, bytes certyfikatu
bilansu oraz pola `operator_version`, `fe_space`, `unit`,
`canonical_face_digest`, `balance_certificate_digest` i
`view_identity_digest`. Części wynikowe mają jawne długości i pojemności; brak
któregokolwiek digestu, closure albo stage identity kończy się błędem przed
wywołaniem Oersteda.

Implementacja tego symbolu musi wewnątrz backendu wykonać
`ConservativeCurrentView::Build` (dla snapshotu okresowego lub sprzężonego
leadu) albo `ConservativeCurrentView::Import` z niezależnym certyfikatem. Ten
sam immutable view, bez rekonstrukcji z nodalnego P1, jest jedynym wejściem do
`DirectTetraQuadrature::Evaluate` (OE-F1) lub
`VectorPotentialSolver::Evaluate` (OE-F2). Runner dopisuje do artefaktu
`source_view_identity_digest` i `stage_identity`; LLG może przyjąć pole dopiero
po zgodności wszystkich rewizji. Wersja v1 tego rozszerzenia pozostaje
`reference_executable` CPU/double do czasu trzech poziomów `h`, oracle
direct-tetra, testów zamknięcia/znaku/energii i managed end-to-end.

To jest kontrakt projektowy, nie zaimplementowany symbol. Do jego ukończenia
bounded nodalny midpoint pozostaje jedyną publiczną ścieżką referencyjną i nie
może być opisywany jako produkcyjny dynamiczny Oersted FEM.

(validation)=
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
| owner publication | concurrent readers/writer see only whole accepted pointers; rejected publish preserves prior pointer; ThreadSanitizer run has no race |
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

- [x] Bounded FEM steady one-way solved-current midpoint reference slice (not OE-T0/F1/F2)
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

(limitations)=
## 7. Known limits and deferred work

Full Maxwell waves, displacement current, skin/eddy redistribution, magnetic
`mu_r` in the Oersted solve, periodic Ewald kernels, higher-order Nedelec,
exact open-boundary FEM treatments, and hybrid source projection require
separate publications and gates. An expert regime override is provenance, not
evidence that the approximation is accurate.

(source-code-index)=
### 7.1. Source-code index

| Path | Symbol | Responsibility |
|---|---|---|
| `crates/fullmag-plan/src/oersted.rs` | `resolve_oersted_term` | bind Oersted source |
| `crates/fullmag-plan/src/oersted.rs` | `resolve_solved_current_source` | solved-current binding |
| `crates/fullmag-plan/src/spin_transport.rs` | `resolve_m1_fem_spin_transport` | FEM transport descriptor |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solved_current_midpoint_biot_savart_field` | bounded midpoint field |
| `crates/fullmag-runner/src/dispatch.rs` | `normalized_fem_plan_for_runtime` | FEM field injection |
| `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_coupled_module` | FDM stage owner |
| `crates/fullmag-plan/src/spin_transport.rs` | `fem_ohmic_oersted_binds_the_solved_charge_field` | planner regression |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solved_current_midpoint_biot_savart_is_finite_and_reverses_with_current` | runtime regression |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `execute_native_fem_steady_transport_plans` | artifact provenance |
| `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_v1` | public v1 ABI boundary |
| `backends/fem/tests/steady_transport_abi_contract.cpp` | `main` | RT0 boundary regression |
| `backends/fem/tests/steady_transport_contract.cpp` | `main` | managed transport contract |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `main` | OE-T0 contract |
| `backends/fem/tests/oersted_direct_tetra_contract.cpp` | `main` | OE-F1 contract |
| `backends/fem/tests/oersted_vector_potential_contract.cpp` | `main` | OE-F2 contract |

(scientific-bibliography)=
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
