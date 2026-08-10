# Dynamic current and Oersted coupling

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-08-10
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
- Stage-provider policies: `fem_stage_oersted_callback.v1`,
  `fem_stage_transport_callback.v1`
- FDM direct-oracle version:
  `oersted_direct_surface_potential_long_double.v1`
- FDM independent spot-check policy:
  `oersted_surface_adaptive_spot_check.v1`

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

The one-way steady FEM `closed_geometry` slice has an explicit, narrower cache
policy, `steady_source_invariant.v1`. It may reuse an immutable RT0/OE-F1 view
only when the complete source identity is unchanged: source and conductivity
digests, mesh/topology/geometry, envelope, closure, evaluation time, evaluated
multiplier and the declared source `stage_identity`. A SHA-256 key digest is
published with the artifact. A changed identity requires a fresh transport
solve before a new field can be published; this policy is not a
magnetization-dependent `J_c(m_stage)` solve.

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

For every explicit RK RHS evaluation in a magnetization-dependent or transient
model:

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

The current FEM invariant-source gate is deliberately weaker than this full
stage contract. It remains a compatibility policy for manually constructed
descriptor fixtures. For a public one-way `closed_geometry` or complete
`external_lead` plan with a validated RT0 view, the planner now resolves
`fem_stage_oersted_callback.v1`; the native CPU runner installs a provider that
solves RT0/OE-F1 or RT0/OE-F2 for each callback stage and records the accepted
stage observation. The one-way charge model is still independent of
`m_stage`, so this is not reciprocal M2 and does not publish `torque_stt` into
the LLG RHS. The bounded managed external-lead path now reaches one accepted
native CPU Heun step, an adaptive RK23 rejection/rollback/retry and three-step
callback trajectories for Heun, RK4, RK23 and RK45. ABM3 is not a supported
native FEM integrator and fails closed. Public Python-fixture execution,
device-resident execution and production qualification remain separate gates.

The native CPU path exposes an append-only stage-provider hook outside the
legacy plan ABI. Its evaluator receives the exact `m_stage`, `t_stage`, and a
deterministic `stage_identity`, and must return a complete nodal `H_oe [A/m]`
buffer plus a source-state revision. The public planner binds this hook only
for one-way plans carrying a complete immutable RT0 descriptor (`closed_geometry`
or `external_lead`); the
Rust provider reuses the resolved request shape, updates the stage identity,
and calls the same RT0/OE-F1 or RT0/OE-F2 adapter used by the steady path.
Optional `begin_attempt`, `commit_attempt`, and `rollback_attempt` hooks
surround the adaptive RK attempt; a rejected attempt therefore cannot leave a
stage observation accepted. The GPU path rejects the hook until a
device-resident implementation is qualified. This closes the native
transaction/cadence mechanism and its public CPU binding, but it is not a
reciprocal `J_c(m_stage)` solve, does not feed `torque_stt` into LLG, and does
not promote a production capability.

### 2.6.1 Reciprocal FEM M2 torque at an RK stage (bounded CPU contract)

For the reciprocal FEM lane the charge--spin problem is solved again for the
same normalized `m_stage` and exact `t_stage`. In condensed notation the
monolithic constitutive system is

```text
div J_c = 0,                         div J_s = -R_sf(mu_s),
[J_c, J_s] = C(m_stage) [E, -grad(mu_s)] + S_SHE(m_stage),
E = -grad(V).
```

The symmetric charge/spin blocks, spin-flip/dephasing terms, boundary fluxes
and spin-Hall source are those of the resolved FEM M2 descriptor; they are not
reconstructed from a one-way current after the solve. The transport result is
then projected through the declared torque target and its SI constants to a
direct Gilbert right-hand-side contribution

```{math}
:label: reciprocal-transport-torque-rhs
\begin{aligned}
\tau_{tr} &= \mathcal{T}(J_c,J_s,\mu_s,m_{stage};p,M_s,\lambda_{sf},\lambda_j,\lambda_\phi),\\
\frac{d m}{d t} &= \mathrm{RHS}_{LLG}+\tau_{tr}.
\end{aligned}
```

```text
tau_tr(m_stage,t_stage) = T[J_c,J_s,mu_s,m_stage;
                            p, M_s, lambda_sf, lambda_j, lambda_phi],
dm/dt = rhs_LLG + tau_tr.
```

`tau_tr` is returned as a complete nodal vector in `1/s`, not as `H` in A/m
and not as a post-hoc field. The native RK owner adds it after the ordinary
LLG, STT and SOT terms, then normalizes the candidate magnetization. The
source envelope `a(t_stage)` scales only the authored voltage differences about
the selected Dirichlet reference (or a normal-current drive); the
reference/gauge value is not scaled. Thus a change in `m_stage` changes the
constitutive operator, while a change in `a(t_stage)` changes the external
drive, and both effects are represented in the same charge--spin solve.

The append-only policy `fem_stage_transport_callback.v1` transports
`m_stage`, `t_stage`, `stage_identity`, `tau_tr` and a source revision across
the native ABI. `begin_attempt`, `commit_attempt` and `rollback_attempt` are
transactional: a rejected RK attempt cannot publish a torque observation or
leave a tentative source revision as accepted. This bounded implementation is
CPU/double only. If the same reciprocal M2 source also drives Oersted, policy
`fem_stage_transport_oersted_callback.v1` gives the torque and field adapters a
shared exact-stage evaluator. The first adapter invocation performs one
charge--spin solve; the second consumes the cache entry keyed by
`m_stage`, `t_stage`, `stage_identity` and envelope multiplier. The Oersted
field is reconstructed from that solve's H1/P1 nodal current, so both RHS
contributions carry the same source revision and digest. Closure-aware
RT0/external-lead reciprocal M2, GPU/device-resident, full public end-to-end
and production qualification remain open gates.

(symbols-and-si-units)=
### 2.7 Symbols and SI units

| Symbol | Meaning | SI unit / condition |
|---|---|---|
| `V` | electric potential | V |
| `E` | electric field | V/m |
| `sigma` | conductivity | S/m, positive definite |
| `J_c` | conventional current density | A/m^2 |
| `J_s` | spin-current tensor/vector used by the drift--diffusion solve | A/m^2 (spin-angular-momentum convention is fixed by the operator version) |
| `mu_s` | spin accumulation potential | V |
| `m_stage` | normalized magnetization at an RK stage | 1 |
| `tau_tr` | direct reciprocal transport contribution to `dm/dt` | s^-1 |
| $H_{\mathrm{oe}}$ | Oersted field | $\mathrm{A\,m^{-1}}$ |
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
| $r$ | target-source displacement | $\mathrm{m}$ |
| $o$ | physical union-grid origin | $\mathrm{m}$ |
| $J_c^{\mathrm{cell}}$ | reconstructed cell-centred conventional current density | $\mathrm{A\,m^{-2}}$ |
| $J_c^{\mathrm{face}}$ | signed, globally oriented finite-volume face-current density | $\mathrm{A\,m^{-2}}$ |
| $\chi_c$ | conductor-source cell mask | $1$ (Boolean) |
| $\chi_m$ | magnetic-target cell mask | $1$ (Boolean) |
| $i$ | target or active-cell multi-index, according to context | $1$ |
| $j$ | source-cell multi-index | $1$ |
| $a$ | Cartesian axis selector | $1$ |
| $e_a$ | unit lattice-index vector along axis $a$ | $1$ |
| $\{x,y,z\}$ | ordered Cartesian component set | $1$ |
| $h_a$ | FDM cell size along axis $a\in\{x,y,z\}$ | $\mathrm{m}$, strictly positive |
| $C_j$ | rectangular source cell centred at $x_j$ | $\mathrm{m^3}$ (integration domain) |
| $x_i$ | target-cell centre on the union grid | $\mathrm{m}$ |
| $x_j$ | source-cell centre on the union grid | $\mathrm{m}$ |
| $x'$ | source integration point | $\mathrm{m}$ |
| $\pi$ | circle constant | $1$ |
| $\lVert\cdot\rVert_2$ | Euclidean norm; its value inherits the operand's SI unit | $1$ (operator) |
| $dV'$ | source-volume integration measure | $\mathrm{m^3}$ |
| $\sum_j$ | discrete sum over all source cells indexed by $j$ | $1$ (operator) |
| $K$ | antisymmetric source-cell-integrated Oersted tensor | $\mathrm{m}$ |
| $+0_{3\times3}$ | exact IEEE-754 positive-zero self tensor | $\mathrm{m}$ |
| $k_a$ | scalar component of the source-cell-integrated kernel | $\mathrm{m}$ |
| $\widehat{J}_{c,a}$ | unnormalised forward R2C transform of current component $a$ | $\mathrm{A\,m^{-2}}$ |
| $\widehat{k}_a$ | unnormalised forward R2C transform of kernel component $a$ | $\mathrm{m}$ |
| $\widehat{H}_{\mathrm{oe},a}$ | unnormalised spectral Oersted-field component $a$ | $\mathrm{A\,m^{-1}}$ |
| $N_a$ | physical union-grid size along axis $a$ | $1$ (integer) |
| $P_a$ | padded convolution-grid size along axis $a$ | $1$ (integer) |
| $q_a$ | padded grid index along axis $a$ | $1$ (integer) |
| $d_a$ | signed lattice displacement along axis $a$ | $1$ (integer) |
| $f$ | scalar or Cartesian component sampled at cell centres for an independent diagnostic | $\mathrm{A\,m^{-2}}$ for current or $\mathrm{A\,m^{-1}}$ for field (`A/m^2 or A/m`) |
| $\delta_a^0$ | radius-one centred-difference operator along axis $a$ | $\mathrm{m^{-1}}$ |
| $D_h$ | independent cell-centred divergence operator | $\mathrm{m^{-1}}$ |
| $C_h$ | independent cell-centred curl operator | $\mathrm{m^{-1}}$ |
| $\mathcal I_2$ | diagnostic cell-index set after removal of the open-boundary band | $1$ |
| $b_{\mathrm{open}}$ | excluded open-boundary-band width in cells | $1$ (integer) |
| $V_h$ | Cartesian cell volume $h_xh_yh_z$ | $\mathrm{m^3}$ |
| $\sum_{i\in\mathcal I_2}$ | discrete sum over the diagnostic cell-index set | $1$ (operator) |
| $\lVert\cdot\rVert_{2,h,\mathcal I_2}$ | volume-weighted RMS norm on the diagnostic set | $1$ (operator; result inherits operand unit) |
| $S_J$ | reconstructed-current RMS diagnostic scale | $\mathrm{A\,m^{-2}}$ |
| $S_A$ | Ampere residual diagnostic scale | $\mathrm{A\,m^{-2}}$ |
| $h_{\min}$ | smallest FDM cell dimension | $\mathrm{m}$ |
| $h_{\max}$ | largest FDM cell dimension | $\mathrm{m}$ |
| $\rho_{\mathrm{div}J}$ | normalized post-reconstruction current-divergence residual | $1$ |
| $\rho_{\mathrm{div}H}$ | normalized Oersted-field divergence residual | $1$ |
| $\rho_{\mathrm A}$ | normalized discrete Ampere residual | $1$ |
| $\rho$ | one of the three normalized diagnostic residuals in a refinement rule | $1$ |
| $p$ | observed spatial convergence order | $1$ |
| $p_{\min}$ | minimum accepted spatial convergence order | $1$ |
| $h$ | common refinement-spacing scale | $\mathrm{m}$ |
| $\epsilon_{\mathrm{FP64}}$ | IEEE-754 binary64 machine epsilon | $1$ |
| $k_a^{\mathrm{prod}}$ | production scalar kernel component | $\mathrm{m}$ |
| $\widehat{k}_a^{\mathrm{prod}}$ | production spectral scalar-kernel component | $\mathrm{m}$ |
| $k_a^{\mathrm{ref}}$ | independently integrated reference scalar kernel component | $\mathrm{m}$ |
| $B_a$ | mixed absolute-plus-relative kernel acceptance budget | $\mathrm{m}$ |
| $a_K$ | dimensionless absolute-scale kernel tolerance | $1$ |
| $r_K$ | dimensionless relative kernel tolerance | $1$ |
| $F_a^+$ | positive source-cell face normal to axis a | $\mathrm{m^2}$ |
| $F_a^-$ | negative source-cell face normal to axis a | $\mathrm{m^2}$ |
| $dS'$ | source-face integration measure | $\mathrm{m^2}$ |
| $A_a^{(L)}$ | independent adaptive surface-quadrature spot value at level L | $\mathrm{m}$ |
| $A_a^{(L-1)}$ | previous adaptive surface-quadrature spot value | $\mathrm{m}$ |
| $E_a^{\mathrm{spot}}$ | successive-level adaptive spot-check difference | $\mathrm{m}$ |
| $B_a^{\mathrm{spot}}$ | independent adaptive spot-check budget | $\mathrm{m}$ |
| $a_S$ | dimensionless absolute-scale spot-check tolerance | $1$ |
| $r_S$ | dimensionless relative spot-check tolerance | $1$ |
| $q$ | padded R2C spectral-bin multi-index | $1$ (integer multi-index) |
| $\mathcal Z_{\mathrm{real}}$ | real-space exact-zero index pairs selected by self geometry or parity | $1$ (set) |
| $\mathcal Z_{\mathrm{spec}}$ | spectral exact-zero index pairs selected by DC or full self-conjugacy | $1$ (set) |
| $+0$ | IEEE-754 binary64 positive-zero scalar kernel value | $\mathrm{m}$ |
| $\max$ | maximum-value operator | $1$ (operator; result inherits operand unit) |
| $\min$ | minimum-value operator | $1$ (operator; result inherits operand unit) |
| $\log_2$ | base-two logarithm operator | $1$ (operator) |
| $|\cdot|$ | scalar absolute-value operator | $1$ (operator; result inherits operand unit) |
| $S_{H,i}$ | absolute field-error scale at target cell $i$ | $\mathrm{A\,m^{-1}}$ |
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

#### 3.1.1 Union grid, masks, and exact face-current reconstruction

The operator owns one Cartesian **union grid** that contains the complete
volumetric conductor, including every return segment, and every magnetic target.
It has cell counts $N=(N_x,N_y,N_z)$, strictly positive cell sizes
$h=(h_x,h_y,h_z)$, and lower-corner origin $o$. Cell centre $i=(i_x,i_y,i_z)$
is $x_i=o+((i_x+1/2)h_x,(i_y+1/2)h_y,(i_z+1/2)h_z)$. Source and target grids
that cannot be represented by integer offsets on this same grid are rejected;
interpolation is not part of v1. The conductor mask $\chi_c$ and magnetic
target mask $\chi_m$ are independent. The convolution source is zero where
$\chi_c=0$; crop/publication uses $\chi_m$ and must not erase conductor cells
before convolution.

Finite-volume charge publishes globally positive-oriented face arrays of exact
sizes $(N_x+1)N_yN_z$, $N_x(N_y+1)N_z$, and $N_xN_y(N_z+1)$. For each active
source cell, `fdm_face_to_cell_current.v1` is exactly

```{math}
:label: fdm-oersted-face-to-cell-current
(J_c^{\mathrm{cell}})_{i,a}
=\frac{\chi_{c,i}}{2}\left[
(J_c^{\mathrm{face}})_{i-\frac12 e_a,a}
+(J_c^{\mathrm{face}})_{i+\frac12 e_a,a}\right],
\qquad a\in\{x,y,z\}.
```

The two values are signed face current densities in $\mathrm{A\,m^{-2}}$, not
unsigned flux magnitudes. Boundary faces are real entries, not replicated ghost
values. Array-length mismatch, non-finite input, ambiguous orientation, or an
inactive face carrying current unsupported by the authored conductor topology
is rejected. Oersted consumes this exact accepted face field and its cell
reconstruction; it must never recompute `sigma E`, because that would discard
constitutive additions such as reciprocal iSHE. Multiplying the reconstructed
cell field by a mask is not a replacement for the face-based continuity and
closure certificate.

The arithmetic face mean is a reconstruction rule, not a mimetic projection.
In particular, v1 **does not assert or require a commuting identity** between
that mean and either the finite-volume face divergence or the cell-centred
curl used for field validation. Charge continuity is certified on the original
face field. The following post-reconstruction diagnostics are assembled
independently from the published $J_c^{\mathrm{cell}}$ and $H_{\mathrm{oe}}$;
they cannot reuse the charge residual, the FFT kernel generator, or a value
cached by either owner.

For a cell-centred scalar or Cartesian component $f$, the diagnostic derivative
is the radius-one centred difference

```{math}
:label: fdm-oersted-post-reconstruction-differential-operators
\begin{gathered}
(\delta_a^0 f)_i=\frac{f_{i+e_a}-f_{i-e_a}}{2h_a},
\qquad a\in\{x,y,z\},\\
D_hJ_c^{\mathrm{cell}}
=\delta_x^0(J_c^{\mathrm{cell}})_x
 +\delta_y^0(J_c^{\mathrm{cell}})_y
 +\delta_z^0(J_c^{\mathrm{cell}})_z,\\
C_hH_{\mathrm{oe}}=
\begin{bmatrix}
\delta_y^0H_{\mathrm{oe},z}-\delta_z^0H_{\mathrm{oe},y}\\
\delta_z^0H_{\mathrm{oe},x}-\delta_x^0H_{\mathrm{oe},z}\\
\delta_x^0H_{\mathrm{oe},y}-\delta_y^0H_{\mathrm{oe},x}
\end{bmatrix}.
\end{gathered}
```

Diagnostics use only the interior set $\mathcal I_2$: every retained cell is
at least $b_{\mathrm{open}}=2$ cells from each open outer face of the union
grid. The excluded two-cell open-boundary band is a validation mask; it does
not alter the source, kernel, FFT, crop, or published field. The norm, scales
and three dimensionless residuals are exactly

```{math}
:label: fdm-oersted-post-reconstruction-residuals
\begin{gathered}
V_h=h_xh_yh_z,\qquad
\lVert f\rVert_{2,h,\mathcal I_2}
=\left[
\frac{\sum_{i\in\mathcal I_2}V_h\lVert f_i\rVert_2^2}
{\sum_{i\in\mathcal I_2}V_h}
\right]^{1/2},\\
S_J=\lVert J_c^{\mathrm{cell}}\rVert_{2,h,\mathcal I_2},\qquad
S_A=\max\!\left(
\lVert C_hH_{\mathrm{oe}}\rVert_{2,h,\mathcal I_2},S_J
\right),\qquad
h_{\min}=\min(h_x,h_y,h_z),\\
\rho_{\mathrm{div}J}
=\frac{\lVert D_hJ_c^{\mathrm{cell}}\rVert_{2,h,\mathcal I_2}}
{S_J/h_{\min}},\qquad
\rho_{\mathrm{div}H}
=\frac{\lVert D_hH_{\mathrm{oe}}\rVert_{2,h,\mathcal I_2}}{S_A},\\
\rho_{\mathrm A}
=\frac{\lVert C_hH_{\mathrm{oe}}-J_c^{\mathrm{cell}}
\rVert_{2,h,\mathcal I_2}}{S_A}.
\end{gathered}
```

Every quantitative fixture is nonzero and must have $S_J>0$ and $S_A>0$;
zero scales fail the fixture rather than receiving a dimensioned numerical
floor.

The diagnostic owner evaluates these operators on the complete physical
low-index union-grid field produced by the inverse FFT **before** applying
$\chi_m$. Only the separately published field is cropped to the target mask.
Consequently a sparse target mask and an all-target mask for the same immutable
source snapshot must produce bit-identical diagnostic scalars, while cells
outside the sparse target remain exact zero in the published field.

The standalone native CPU gate uses the same physical smooth, compactly supported
closed-current fixture on three uniform grids $h$, $h/2$, and $h/4$. On the
finest grid it applies the complete acceptance rule

```{math}
:label: fdm-oersted-post-reconstruction-refinement
\begin{gathered}
\rho_{\mathrm{div}J}(h/4)\le2\times10^{-2},\qquad
\rho_{\mathrm{div}H}(h/4)\le2\times10^{-2},\qquad
\rho_{\mathrm A}(h/4)\le5\times10^{-2},\\
p=\log_2\!\frac{\rho(h/2)}{\rho(h/4)}\ge p_{\min}=1.5
\quad\text{when }\rho(h/2),\rho(h/4)>64\epsilon_{\mathrm{FP64}},\\
\rho(h/4)\le
\max\!\left[64\epsilon_{\mathrm{FP64}},
\rho(h/2)+4\epsilon_{\mathrm{FP64}}\right]
\quad\text{otherwise}.
\end{gathered}
```

A residual is roundoff-classified exactly when
$\rho\le64\epsilon_{\mathrm{FP64}}$; no backend may replace this branch by a
different floor.
The separate `closed_face_loop_exact.v1` fixture is also mandatory in that
standalone native gate: it supplies explicitly oriented face arrays, a complete
return path and source cut, and independently different conductor and target
masks. It exercises closure, reconstruction, signs, low-corner packing, crop,
and an oriented Ampere contour, but its sharp corners are not substituted for
the smooth fixture in the refinement-order measurement.

#### 3.1.2 Global closed-current certificate

Before kernel allocation or FFT planning, v1 requires
`global_closed_current_certificate.v1`. The certificate binds the union-grid
geometry/digest, conductor mask revision/digest, exact face-current
revision/digest, connected-component labels, closure kind, and the tolerances
and measured values for all of the following:

1. oriented discrete divergence in every active conductor cell;
2. pairwise cancellation of every shared internal face;
3. zero signed and zero leakage-bounded normal current on the exterior of the
   complete union-grid conductor;
4. zero exterior flux for each connected component, not only after cancellation
   between unrelated components;
5. a globally contained return path for every nonzero driven component.

A solved nonzero closed geometry carries exactly one typed `source_cut` record
for every driven connected conductor component. Each record contains its
component label, stable cut ID, ordered internal face IDs and normals, drive ID,
drive kind/value and SI unit, face-current revision, and digest. V1 accepts the
drive type `impressed_potential_jump.v1` in volts. Each cut trace is encoded as
an even sequence of pairs: both entries in a pair name the same globally
oriented, nonzero internal face; both adjacent cells are active and have the
declared component label; and the pair normals are exactly opposite. Stable cut
IDs, drive IDs and driven-component coverage are unique. A dummy zero-current
face, an inactive face, an unpaired trace, a stale revision, an unsupported
drive type/unit, or a missing/duplicate driven component fails closure.

The cut represents an impressed potential jump or electromotive circulation;
it does not inject charge. The accepted face current is single-valued across
the paired cut traces and their oriented fluxes cancel exactly. A certified
import may instead name its external certification method and immutable field
digest, but it must pass the same global divergence, exterior-flux, component,
and return-path gates. Unknown closure enum values are rejected even for an
otherwise zero-current snapshot. An open two-terminal strip, a locally small
residual, or forcing the spectral DC value to zero cannot manufacture this
certificate.

Any missing/stale digest, open terminal, incomplete return, failed component
gate, or unsupported periodic axis must fail closed before allocation or FFT
planning. PBC is not silently converted to open boundaries: a periodic/Ewald
operator requires a different version.

#### 3.1.3 Frozen cell-integrated tensor

For source cell $C_j$ and target-cell centre $x_i$, define
$r=x_i-x'$. The v1 operator is the **source-cell volume integral evaluated at
the target-cell center**:

```{math}
:label: fdm-oersted-cell-integrated-kernel
\begin{aligned}
k_a(x_i-x_j)
  &=\frac{1}{4\pi}\int_{C_j}
    \frac{(x_i-x')_a}{\lVert x_i-x'\rVert_2^3}\,dV',\\
K(r)&=
\begin{bmatrix}
0&k_z&-k_y\\
-k_z&0&k_x\\
k_y&-k_x&0
\end{bmatrix},
\qquad
H_{\mathrm{oe},i}&=\sum_j K(x_i-x_j)(J_c^{\mathrm{cell}})_j,\\
K(-r)&=-K(r),\qquad K(0)=+0_{3\times3}.
\end{aligned}
```

Thus $K$ has unit $\mathrm m$, $J_c$ has unit
$\mathrm{A\,m^{-2}}$, and $H_{\mathrm{oe}}$ has unit
$\mathrm{A\,m^{-1}}$. There is no $\mu_0$ in this operator. The matrix is the
signed $J_c\times r$ map: $H_x=J_y k_z-J_z k_y$,
$H_y=-J_x k_z+J_z k_x$, and $H_z=J_x k_y-J_y k_x$.
The last line freezes odd parity and the self class. For $i=j$, inversion
symmetry of the centred rectangular source cell gives $K(0)=+0_{3\times3}$
**exactly**; v1 writes three IEEE-754 binary64 positive-zero values and does
not evaluate a singular formula or use a sphere regularisation.

The target is a point at the target-cell centre. No target-cell volume integral
or target-cell average is performed. In particular, the cell-averaged
source--target tensor used by some comparative solvers is not this operator;
**target-cell averaging defines a different operator version**.

The frozen kernel policy is `exact_cell_integral_all_offsets.v1`: every
non-self lattice offset uses the same rectangular source-cell volume integral
in FP64. V1 has `near_far_cutoff=none` and does not replace far entries by a
midpoint/dipole approximation. An implementation may use a stable closed form,
but its entries must meet the independent direct-oracle error budget. Any
near/far approximation, different quadrature rule, or target averaging needs a
new operator or realization version and a separately keyed cache.

#### 3.1.4 Exact open-boundary R2C embedding

Let the physical union-grid size be $N_a$. The padded size is exactly
`P_a=2N_a` for every axis, **also when $N_a=1$**; v1 never optimises a singleton
axis to length one. Arrays use x-fastest logical indexing
`((q_z*P_y)+q_y)*P_x+q_x`. Physical current is packed into
$0\le q_a<N_a$ and every other source entry is exact zero. The signed kernel
displacement is

```text
d_a(q_a) = q_a           for 0 <= q_a < N_a,
           0             for q_a = N_a,
           q_a - P_a     for N_a < q_a < P_a.
```

The `q_a=N_a` kernel slab is exact zero because displacement magnitude $N_a$
does not occur in the required linear convolution. This rule also makes the
second slot zero for a singleton axis. Negative offsets occupy the high end of
the padded array; no `fftshift` is applied. After one circular convolution on
the padded grid, v1 crops exactly the low-index box
$0\le q_a<N_a$ and then selects $\chi_m$ targets.

The logical R2C spectrum has shape
`[P_z][P_y][P_x/2+1]`, with x as the reduced contiguous axis. Forward transforms
are unnormalised. A C2R inverse is multiplied exactly once by
$1/(P_xP_yP_z)$; a library-specific normalised inverse must not receive a
second factor. For the three scalar spectra, the pointwise operation is

```{math}
:label: fdm-oersted-fft-convolution
\begin{bmatrix}
\widehat{H}_{\mathrm{oe},x}\\
\widehat{H}_{\mathrm{oe},y}\\
\widehat{H}_{\mathrm{oe},z}
\end{bmatrix}
=
\begin{bmatrix}
0&\widehat{k}_z&-\widehat{k}_y\\
-\widehat{k}_z&0&\widehat{k}_x\\
\widehat{k}_y&-\widehat{k}_x&0
\end{bmatrix}
\begin{bmatrix}
\widehat{J}_{c,x}\\
\widehat{J}_{c,y}\\
\widehat{J}_{c,z}
\end{bmatrix}.
```

The real-space kernel is jointly odd, so its transform is purely imaginary in
exact arithmetic. The DC bin is exactly zero for all three kernel components.
Because every $P_a$ is even, bins for which every coordinate is either zero or
its axis Nyquist index are self-conjugate spectral bins and are also exactly
zero. No complete Nyquist plane is zeroed: points on an x-, y-, or z-Nyquist
plane whose other coordinates are not self-conjugate retain their computed
Hermitian-paired values. The implementation must reject a spectrum that violates
finite-value or Hermitian-consistency gates; zeroing DC is not a closure repair.

#### 3.1.5 Cache, provenance, direct oracle, and promotion boundary

The published resolved-field cache key is a canonical byte serialization of:
formula/operator/realization versions; FP64 cell sizes; $N$, $P$, origin and
axis order; union-grid digest; `conductor_mask_revision` and digest;
`target_mask_revision` and digest; face-current revision/digest;
`global_closed_current_certificate.v1` revision/digest and `source_cut`
identity; source/envelope/stage/time identity; kernel policy
`exact_cell_integral_all_offsets.v1`; `near_far_cutoff=none`; x-fastest pack,
crop, R2C and inverse-normalisation versions; scalar precision; and engine
identity. Floating-point values are hashed by canonical IEEE-754 binary64 bits,
not locale-dependent text. The artifact publishes this key digest plus every
constituent identity. A narrower reusable kernel/plan cache may omit dynamic
source/time fields, but it must retain all geometry, layout, operator and
precision fields and can never be reported as a resolved-field cache hit.

The standalone owner additionally exposes a zero-allocation trusted fast path.
It is legal only for the same `Problem` object address and the same nonzero
`trusted_snapshot_revision`/`trusted_snapshot_digest` that passed the complete
preflight previously. The caller thereby promises that the accepted object is
immutable for the duration of reuse; modifying it in place is outside this
contract. Every different object, even with equal declared digests, takes the
slow path and recomputes canonical geometry, masks, face current, certificate
and trusted-snapshot digests before cache lookup. Candidate and failure results
are separate from the last accepted payload: any validation or numerical
failure returns an empty failure payload without erasing the accepted field,
so a subsequent trusted hit returns the complete accepted solution. The
`last_invalidation_reason` field describes only the current solve and is empty
on a hit.

Accepted provenance records every cache constituent, including geometry,
conductor/target masks, face current, certificate, trusted snapshot,
source/envelope, stage/time/multiplier, closure kind, every complete source-cut
record, and certified-import method/field digest when applicable. A cache-key
hash without these human-inspectable constituents is not sufficient
provenance.

The primary independent oracle is
`oersted_direct_surface_potential_long_double.v1`. It is not allowed to call
the production kernel generator, FFT code, cache, or its closed-form helper.
For each nonzero component it applies the divergence theorem to the source
cell and evaluates the two rectangular-face potential integrals using a
separate `long double` primitive:

```{math}
:label: fdm-oersted-direct-oracle-surface-reduction
k_a^{\mathrm{ref}}
=\frac{1}{4\pi}\left[
\int_{F_a^+}\frac{dS'}{\lVert x_i-x'\rVert_2}
-\int_{F_a^-}\frac{dS'}{\lVert x_i-x'\rVert_2}
\right].
```

This is validation policy, not an operator change; the production operator
remains `fdm_oersted_cell_integrated_open.v1`. The oracle has no tolerance
arguments and never reports convergence merely because two identical calls
returned the same bits. It must cover exact self zero, axial/edge/corner
neighbours, anisotropic cells, odd parity, all tensor signs, signed-current
reversal, singleton axes, shifted union grids and random certified closed
loops.

For every nonzero scalar kernel component, the sole production--oracle gate is
the mixed bound

```{math}
:label: fdm-oersted-direct-oracle-mixed-bound
\begin{gathered}
h_{\max}=\max_{a\in\{x,y,z\}}h_a,\qquad
B_a=a_Kh_{\max}+r_K|k_a^{\mathrm{ref}}|,\\
|k_a^{\mathrm{prod}}-k_a^{\mathrm{ref}}|\le B_a,\qquad
a_K=2\times10^{-13},\qquad r_K=2\times10^{-11}.
\end{gathered}
```

Thus `atol(scale)` is $a_Kh_{\max}$ and is added to, not ANDed with,
the relative term. The analytic oracle is independently checked by
`oersted_surface_adaptive_spot_check.v1`: a bounded high-order adaptive
surface quadrature, sharing neither the analytic primitive nor production
kernel code, is refined through two successive accepted levels. For the named
axial, edge, corner, anisotropic and cancellation-dominated spot fixtures,

```{math}
:label: fdm-oersted-direct-oracle-spot-check
\begin{gathered}
E_a^{\mathrm{spot}}=|A_a^{(L)}-A_a^{(L-1)}|,\qquad
B_a^{\mathrm{spot}}=a_Sh_{\max}+r_S|A_a^{(L)}|,\\
E_a^{\mathrm{spot}}\le B_a^{\mathrm{spot}},\qquad
|k_a^{\mathrm{ref}}-A_a^{(L)}|\le4B_a^{\mathrm{spot}},\\
a_S=2\times10^{-14},\qquad r_S=2\times10^{-13}.
\end{gathered}
```

The spot checker has a versioned subdivision/evaluation cap. Exhausting it,
missing finite-value gates, or failing either inequality rejects the fixture.
Its v1 realization uses independently coded tensor-product Gauss--Legendre
order 16 on uniformly subdivided rectangular faces, compensated `long double`
accumulation, levels $1,2,4,8,16,32,64$ per tangential axis, and accepts only
when two successive levels meet the displayed bound. The cancellation fixture
propagates the sum of the absolute per-contribution spot budgets; cancellation
may not shrink the error allowance artificially.
The production--oracle mixed bound remains the sole acceptance criterion for
every production kernel component; the stricter spot policy validates that
the independent analytic reference is not self-confirming.

`exact_zero_by_symmetry.v1` defines two typed sets that must not be merged.
$\mathcal Z_{\mathrm{real}}$ contains real-space pairs $(r,a)$ selected by
self geometry or component parity. $\mathcal Z_{\mathrm{spec}}$ contains
spectral pairs $(q,a)$ selected by the DC rule or full self-conjugacy of the
padded R2C bin $q$. The real-space rule applies before quadrature; the spectral
rule applies after transformation and before spectral multiplication. They
require, respectively,

```{math}
:label: fdm-oersted-direct-oracle-exact-zero
\begin{gathered}
(r,a)\in\mathcal Z_{\mathrm{real}}
\quad\Longrightarrow\quad k_a^{\mathrm{prod}}(r)=+0,\\
(q,a)\in\mathcal Z_{\mathrm{spec}}
\quad\Longrightarrow\quad \widehat{k}_a^{\mathrm{prod}}(q)=+0,\\
K(-r)=-K(r),\qquad K(0)=+0_{3\times3}.
\end{gathered}
```

The real-space and spectral zeros are IEEE-754 binary64 positive zero. A small
magnitude never changes either typed class to exact zero, and the mixed bound
is never used to excuse a wrong sign bit or a nonzero value in either class.
Membership in one set does not imply membership in the other. The parity
equality applies to nonzero mirrored entries as an exact sign involution.

The oracle gate includes a **normal-magnitude positive fixture**, a
**cancellation-dominated positive fixture** whose reference field component is
small compared with the sum of its signed source contributions, and an
**over-bound negative fixture** formed by perturbing an otherwise accepted
component to the first representable value strictly beyond its mixed bound.
The first two must pass the same sum-of-absolute-and-relative budget; the last
must fail. FFT is then compared componentwise against the independent direct
$O(N^2)$ sum with field scale
$S_{H,i}=\sum_j\lVert K_{ij}\rVert_\infty
\lVert J_j\rVert_\infty$, absolute coefficient $1024\epsilon_{\mathrm{FP64}}$
and relative coefficient $5\times10^{-12}$ in the same mixed form. Separate
promotion gates must cover the long-wire and cylinder limits, energy/work
identity and named continuum studies. The present standalone gate covers the
independently assembled Ampere/curl and divergence diagnostics above, a
literal oriented Ampere contour around one leg of a closed rectangular loop,
translation, grid refinement, and exact rejection of PBC/open circuits.

The resolved operator remains `fdm_oersted_cell_integrated_open.v1`, with
realization `oersted_fdm_fft_open.v1`. Both FDM CPU and FDM GPU claims remain
`semantic_only`. The names `fdm_oersted_fft_open_v1` and
`fdm_oersted_cufft_open_v1` are engine identities. The former now has the
standalone native CPU/FP64 owner and managed contract described here; the
latter remains reserved without an implementation. Neither name alone is
capability evidence. Promotion requires an independently reviewed public C
ABI/planner/runner path, managed runtime evidence and named
physical/convergence workloads; GPU additionally requires device identity and
CPU/GPU parity evidence with no strict hot-loop host transfers.

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

The public solved-current bridge keeps the legacy transport ABI byte-for-byte
stable.  The OE-F2 execution surface is therefore an append-only wrapper around
the existing closure-aware RT0 request: it returns the mixed-system `A` and
gauge coefficients, the compatible RT0 `B`/`H` fields, residual diagnostics,
the selected gauge variant, and the source-view identity digest.  The backend
must construct one immutable `ConservativeCurrentView` and pass that exact
object to `VectorPotentialSolver::Evaluate`; a nodal H1 current or a second
reconstruction is invalid.  This wrapper is CPU/double reference execution
only until its managed airbox, p/refinement, cross-method, and device-resident
gates have passed.  The exported `converged` flag and residuals are the bounded
CPU fixture certificate: their norms are raw mixed-system diagnostics, not the
production preconditioned/projected LLG-field certificate.  They must not be
used to promote OE-F2 beyond `semantic_only` until the missing physical and
runtime gates are independently measured.  On any failed call, payload lengths,
status, numeric certificates and identity strings are cleared before the error
is returned; consumers must treat `converged == 0` as non-publishable.

The first independent diagnostic gate is deliberately narrower than a
production work observable.  It reconstructs the returned scalar coefficients
in the same `H^1_0` target space and checks every boundary true DOF of
`p_gauge` against the declared zero trace.  On the same fixture it evaluates
the source--potential pairing
`W_J = 1/2 integral_Omega J_RT0 dot A dV` with an independent tetrahedral
quadrature.  A finite positive `W_J` is a source/linear-solve energy check; it
does **not** replace the accepted-state Zeeman/work quantity
`-mu0 integral M dot H_oe dV`, nor does it certify an airbox truncation.  The
latter still require a separate target-space/refinement study on three
geometrically similar airboxes and an accepted-time magnetization snapshot.

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

A bounded reference-only common-limit contract now exercises the same uniform
unit cube, constant signed current, and far target with two independent
discretizations: conforming FEM `RT0` direct tetrahedral quadrature and an FDM
uniform-cell midpoint Biot–Savart sum.  The FEM `n=8` result is used only as a
high-resolution oracle for the fixture; both families are evaluated at
`n=1,2,4,8`, and the contract requires decreasing FEM error, FDM error, and
cross-method discrepancy under 3-D `h` refinement.  This is operator-level
evidence for a common continuum limit, not validation of the production FDM
cell-integrated convolution, solved-current runtime, source projection,
airbox sequence, GPU lane, or magnetization-dependent stage coupling.

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
view is a resolved product of the named current source, but its accepted
snapshot identity and closure are explicit inputs to the public FEM descriptor.
There is no default source-cut and no implicit H1-to-RT0 conversion.
`direct_biot_savart`
and `fem_vector_potential` remain explicit method choices. FEM vector-potential
policy exposes the boundary/gauge variant; omission resolves only to the
baseline `tangential_A_h1_0.v1`, never to the zero-mean variant. Direct tetra
quadrature exposes a tagged deterministic FP64 policy rather than reusing
Krylov fields. Python and UI script export must preserve every selected policy
field and reject unavailable lanes before execution.

Wzajemny M2 ma rozdzielone polityki numeryczne zależnie od jawnie wybranego
operatora. FDM używa `fdm_coupled_charge_spin_fv_block_gmres.v1` wraz z
`reciprocal_nonlinear`; ograniczony FEM CPU/double używa
`fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1` jako jednego liniowego
operatora blokowego i nie przyjmuje polityki Picarda. `ChargeSolverPolicy` oraz
`Problem` sprawdzają zgodność operatora ładunku i spinu, więc poprawny FEM M2
nie jest odrzucany jako konfiguracja FDM, a mieszanie tych wersji kończy się
walidacją przed plannerem.

Kanoniczny moduł `SpinDriftDiffusion` i powiązany
`DriftDiffusionSpinTorque` są również dostępne w obu powierzchniach
skryptowych: `fm.spin_transport(...)` oraz
`fm.study(...).spin_transport(...)` rejestrują moduł w tym samym `ProblemIR`.
Eksport płaskiego skryptu zachowuje materiały, interfejsy, warunki brzegowe,
operator, tolerancje, wykonanie i tryb. Rozszerzony `SceneDocument` przenosi
ten sam payload bez zmiany identyfikatorów, więc ścieżka Python → UI → Python
nie tworzy drugiej semantyki transportu. Rejestracja jest authoringiem; planner
nadal odrzuca niekwalifikowane urządzenia i sprzężenia.

```python
# %%
from fullmag import CurrentTransport, OerstedField, SinusoidalEnvelope

drive = CurrentTransport(
    name="drive",
    current_density=(1.0e10, 0.0, 0.0),
    time_envelope=SinusoidalEnvelope(amplitude=0.2, frequency_hz=2.0e9, offset=1.0),
)
oersted = OerstedField(source=drive.name)
assert oersted.model == "from_current_solution"
```

Dla ograniczonego FEM CPU/double `ohmic_poisson` można przekazać już
zaakceptowany, zamknięty snapshot RT0. Wszystkie identyfikatory i rekordy są
obowiązkowe; brak descriptoru pozostawia ścieżkę H1/P1 jako jawny reference
lane. `external_lead` jest przyjmowany tylko jako kompletny descriptor z
walidacją mesh/ID/interface/electrode; do czasu managed runtime i testu
ilościowego pozostaje niekwalifikowany wykonawczo.
Wariant `closed_geometry` wymaga wersji operatora
`fem_closed_current_geometry.v1`, zgodnej z natywną walidacją MFEM.

```python
view = ConservativeCurrentView(
    stable_vertex_ids=[10, 20, 30, 40],
    boundary_faces=[...],
    identity=ConservativeCurrentIdentity(..., stage_identity=1),
    pins=ConservativeCurrentPins(...),
    closure=ConservativeCurrentClosedGeometry(
        "fem_closed_current_geometry.v1", "closure-1", "sha256:...", source_cuts=[...]
    ),
    algebraic_relative_tolerance=1e-10,
    physical_relative_gate=1e-8,
    physical_absolute_gate_a=1e-12,
)
drive = CurrentTransport(
    name="drive", model="ohmic_poisson", coupling="one_way",
    conservative_current_view=view,
)
```

| Python | Typ | Domyślnie | Jednostka SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.model` | `Literal['prescribed_density','ohmic_poisson','magnetoresistive_poisson']` | `prescribed_density` | `1` | `The bounded FEM solved-current slice requires ohmic_poisson, one_way coupling, steady mode, strict execution and double precision.` | `charge solve producing the source current` | `FEM CPU bounded reference; other lanes remain capability-scoped` | `current_modules[].model` |
| `CurrentTransport.time_envelope` | `TimeEnvelope \| None` | `None` (`a(t)=1`) | `1` (multiplier); time fields `s`, frequency `Hz` | `All ordinates and times finite; pulse interval ordered; tabulated source requires a resolvable artifact; unsupported runtime lanes fail closed.` | `dimensionless source multiplier evaluated at the exact stage time` | `Python/IR/UI round-trip; one-way FEM/FDM CPU stage gate; M2/GPU and external-lead public-fixture qualification remain open` | `current_modules[].time_envelope` |
| `SpinDriftDiffusion.id`, `.current_source_id`, `.domain`, `.mode` | `str`, `str`, `Sequence[RegionRef]`, `Literal['steady','transient']` | `required`, `required`, `required`, `steady` | `1`, `1`, `1`, `1` | `IDs and domain are non-empty; transient mode requires a physical spin capacitance/DOS contract.` | `named spin solve, charge-source binding, solved region set and temporal regime` | `Python/IR/UI authoring; runtime lane remains planner-scoped` | `spin_transport_modules[].id/current_source_id/domain/mode` |
| `SpinDriftDiffusion.materials`, `.interfaces`, `.boundaries` | `Sequence[SpinTransportMaterialAssignment]`, `Sequence[...Interface]`, `Sequence[...Boundary]` | `required`, `[]`, `[]` | `sigma: S/m`, `lambda: m`, conductances `S/m²`, flux `A/m²`, potential `V` | `Material/interface/boundary variants validate finite SI values, normalized normals and explicit external-boundary policy.` | `constitutive coefficients and trace conditions for charge-coupled spin accumulation` | `Python/IR/UI round-trip; FEM M2 bounded CPU/double for the qualified subset` | `spin_transport_modules[].materials/interfaces/boundaries` |
| `SpinDriftDiffusion.requested_execution` | `TransportExecution` | `fdm/cpu/double/strict` | `1` | `Discretization, device, precision and mode are explicit; unsupported resolutions fail closed.` | `requested numerical realization and execution policy` | `Planner-visible; FEM GPU remains unqualified` | `spin_transport_modules[].requested_execution` |
| `SpinDriftDiffusion.solver.operator_version` | `str` | `backend-specific, explicit` | `1` | FDM M2 wymaga fdm_coupled_charge_spin_fv_block_gmres.v1; ograniczony FEM M2 wymaga fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1; operator ładunku i spinu muszą być identyczne. | `versioned charge--spin operator identity` | `FDM CPU/double reference lub FEM CPU/double bounded callback; GPU remains fail-closed` | `spin_transport_modules[].solver.operator_version` |
| `DriftDiffusionSpinTorque.id`, `.solve_id`, `.target` | `str`, `str`, `RegionRef` | `required` | `1` | `Torque must reference an existing `SpinDriftDiffusion`; its RHS contribution is angular rate in `s^-1`, not an H-field.` | `explicit transport-to-LLG torque binding` | `FEM CPU/double callback bounded; other lanes fail closed or remain semantic-only` | `spin_torque_modules[]` |
| `OerstedCylinder.id`, `OerstedField.id` | `str`, `str \| None` | `oersted:cylinder`, `oersted:{source}` | `1` | `Bieżący authoring wymaga niepustej, stabilnej tożsamości; brak pola jest akceptowany wyłącznie przy odczycie historycznego IR.` | `stable module identity independent of energy-term ordering` | `Python/ProblemIR/SceneDocument/script/planner; numerical execution remains capability-scoped` | `energy_terms[].id` |
| `OerstedField.source` | `str` | `required` | `1` | `Must name exactly one CurrentTransport module; the runtime consumes its solved field, not a copied current density.` | `current-source identity` | `FEM/FDM authoring; executable status is planner-scoped` | `energy_terms[].source` |
| `OerstedField.model` | `Literal['from_current_solution']` | `from_current_solution` | `1` | `No alternate implicit model is accepted by the canonical IR.` | `bind Oersted to the named solved current` | `FEM/FDM according to capability matrix` | `energy_terms[].model` |
| `CurrentTransport.conservative_current_view` | `ConservativeCurrentView \| None` | `None` (legacy H1 reference) | `stable IDs: 1`, flux: `A`, drop: `V`, gates: SI | `For FEM CPU/double one-way Ohmic only; exact boundary-face ownership, identity/pins, non-empty closure and finite positive gates; no hidden defaults.` | `accepted RT0/H(div) source view for OE-T0/OE-F1` | `FEM CPU/double closed_geometry or explicitly complete external_lead; planner and stage callback reject incomplete descriptors; managed public-adapter external-lead solve is contract-tested, while full Python-to-LLG qualification remains open` | `current_modules[].conservative_current_view` (flattened charge definition) |
| `ConservativeCurrentExternalLead` | `typed closure descriptor` | `required when closure.kind=external_lead` | `mesh coordinates: m; conductivity: S/m; potential drop: V; IDs: 1` | `Exact fem_closed_current_extension.v1 operator; tet4 lead mesh with tri3 boundary; positive per-element conductivity; unique device/lead IDs; complete unique interface pairs; non-empty disjoint minus/plus outer electrodes; non-zero finite potential drop.` | `volumetric external lead joined to the device by conservative interface flux continuity` | `Python/SceneDocument/script/planner preflight, one-way CPU stage callback and managed Rust-adapter -> C ABI -> MFEM coupled volumetric solve; convergence, Python fixture -> LLG and production qualification remain open` | `current_modules[].conservative_current_view.closure` |
| `ConservativeCurrentLeadInterfacePair` | `tuple[face_vertex_ids, face_vertex_ids]` | `required per interface` | `1` | `Exactly two canonical Tri3 faces with strictly positive, distinct, ascending stable IDs; each device face has closure_interface role and each lead face is a lead boundary face.` | `oriented device/lead trace pairing used for conservative current transfer` | `Python/SceneDocument/script/planner preflight` | `current_modules[].conservative_current_view.closure.interface_pairs` |

`ConservativeCurrentExternalLead` jest drugim, jawnym wariantem zamknięcia.
Nie jest to przewód analityczny ani korekta końcówki: obiekt zawiera pełny
tetraedryczny `lead_mesh`, przewodność dla każdego tet4, stabilne identyfikatory
wierzchołków, pary ściana urządzenia--ściana leadu, dwie rozłączne elektrody
zewnętrzne oraz digest przewodności. `ConservativeCurrentLeadInterfacePair`
kanonizuje obie ściany do rosnących trójek ID. Konstruktor i dekoder odrzucają
operator różny od `fem_closed_current_extension.v1`, zerowy spadek napięcia,
niepełny mesh, niezgodne długości przewodności, duplikaty par i niepoprawne
elektrody. Planner wykonuje dodatkowo walidację względem rzeczywistej siatki
urządzenia i utrzymuje pełny descriptor w `ProblemIR`; brak świeżego managed
solve'u prowadzi do jawnego `fail-closed`, bez fallbacku do drutu lub
`closed_geometry`.

```python
import fullmag as fm

# external-lead descriptor is explicit authoring data; it is not an implicit return path
lead_mesh_ir = {
    "mesh_name": "external_lead",
    "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    "cells": {
        "types": ["tet4"],
        "offsets": [0, 4],
        "nodes": [0, 1, 2, 3],
        "global_ordinals": [0],
    },
    "element_markers": [1],
    "facets": {
        "types": ["tri3", "tri3", "tri3", "tri3"],
        "roles": ["closure_interface", "exterior", "exterior", "exterior"],
        "offsets": [0, 3, 6, 9, 12],
        "nodes": [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
        "global_ordinals": [0, 1, 2, 3],
    },
    "boundary_markers": [10, 11, 12, 13],
}

lead = fm.ConservativeCurrentExternalLead(
    operator_version="fem_closed_current_extension.v1",
    revision="lead-r1",
    digest="sha256:lead",
    drive_id="drive",
    outer_electrode_potential_drop_v=0.1,
    lead_mesh=lead_mesh_ir,
    lead_conductivity_spm_per_element=[5.8e7],
    lead_stable_vertex_ids=[101, 102, 103, 104],
    interface_pairs=[
        fm.ConservativeCurrentLeadInterfacePair(
            [10, 20, 30], [101, 102, 103]
        )
    ],
    minus_outer_electrode_face_vertex_ids=[[101, 102, 104]],
    plus_outer_electrode_face_vertex_ids=[[101, 103, 104]],
    lead_conductivity_digest="sha256:sigma",
)
```

W powyższym fragmencie `lead_mesh_ir` jest canonicalnym `MeshIR` z komórkami
`tet4` i ścianami `tri3`; przykład opisuje obiektowy payload authoringu, a nie
deklaruje jeszcze kwalifikacji runtime.

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
intent only. The optional `CurrentTransport.conservative_current_view` carries
an explicit accepted snapshot descriptor through the flattened charge
definition; the planner verifies it against the resolved FEM mesh and refuses
missing/duplicate faces, mismatched pins, unsupported closure, or reciprocal
coupling. Runtime artifacts still carry the authoritative data-plane face
records and digests.
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
Native CPU contracts for OE-T0 and OE-F1 now exist, and the canonical planner
accepts the explicit closed-geometry descriptor. For a one-way Oersted-bound
descriptor it resolves `stage_coupling=fem_stage_oersted_callback.v1`; the
runner validates the immutable view and installs the native CPU provider. Each
RK callback evaluates the selected OE-F1 or OE-F2 realization on that view and
publishes a bounded stage observation. The older
`steady_source_invariant.v1` policy remains only for compatibility fixtures and
is not the public stage-coupling resolution. The callback still carries a
one-way charge solve: it is not reciprocal M2 and does not publish `torque_stt`
into LLG. A supported `CurrentTransport.time_envelope` is evaluated at the
exact callback stage time. External leads, device-resident execution and
production convergence remain open. Separately, a reciprocal FEM descriptor
with an explicit drift-diffusion torque target resolves
`fem_stage_transport_callback.v1`; this callback performs one M2 charge--spin
solve for the supplied `m_stage` and returns the direct `tau_tr [1/s]` RHS.
When Oersted is bound to the same reciprocal source, the planner instead
selects `fem_stage_transport_oersted_callback.v1`. A shared provider performs
one solve per exact stage and exposes both `tau_tr` and the midpoint
Biot--Savart `H_oe` with identical source identity. This bounded realization is
limited to descriptor-free H1/P1 current on FEM CPU/double; a conservative
RT0/external-lead view remains fail-closed for reciprocal M2.

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

The transport provenance additionally records the invariant-source cache policy,
key digest, last hit/miss observation and bounded hit/miss/invalidation counts.
A stage-bound run adds the separate
`transport/fem_stage_oersted_callback.v1.json` artifact with callback counts,
accepted/last stage observation, source-view identity digest and field digest.
These records describe the exact immutable view and native transaction; they
must not be interpreted as proof of reciprocal M2 or a `torque_stt` RHS.
For reciprocal FEM M2 with a torque target, finalization additionally writes
`transport/fem_stage_transport_callback.v1.json` with callback counters,
accepted/last stage identity, envelope multiplier, source revision and torque
SHA-256/L2 observations. The artifact proves publication of the bounded CPU
callback, not GPU residency, combined Oersted or production convergence.

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
validation and export emits canonical Python. Spin-transport payloads and
canonical drift-diffusion torque are preserved in the same scene document and
script-builder round-trip; no GPU or production capability is implied by this
authoring path.

### 4.5 Bounded executable solved-current FEM slice (2026-08-05)

The current implementation contains one deliberately bounded reference slice
for `OerstedField(model=from_current_solution)` on FEM.  It is legal only for
strict, double-precision, steady, one-way `OhmicPoisson` transport on the
native FEM CPU lane.  The planner records the binding in
`ResolvedFemSpinTransportIR.oersted_source_bound`; a reciprocal FEM M2 request
with the same Oersted source is not routed through this one-shot injection; it
must resolve the exact-stage shared callback described in §4.6.5.
When a complete `closed_geometry` RT0 descriptor is present, the newer public
stage-provider path in §4.6.3 supersedes this midpoint injection; this section
describes the descriptor-free legacy/reference lane only.

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

#### 4.5.1. Invariant-source stage cache (implemented bounded gate)

For a one-way steady Ohmic plan with an explicit `closed_geometry` RT0 view, the
public planner now resolves `stage_coupling=fem_stage_oersted_callback.v1` and
the native CPU provider invokes the transport/Oersted adapter at each RK stage.
`SteadySourceCacheKey` and `SteadySourceStageCoordinator` remain compatibility
contracts for manually constructed invariant-source descriptors. They build the
same exact identity from source, conductivity, mesh, topology, geometry,
envelope, closure, evaluation-time, multiplier and declared stage identities;
the callback provider additionally records every accepted observation. A
changed identity is never silently reused. The old cache gate still protects
legacy static-source fixtures, while the public callback path owns native
begin/commit/rollback transitions.

This compatibility gate protects the static one-way source used by legacy
fixtures. The managed gate runs both the exact-key cache test and the
coordinator test covering a changed stage, rejected-attempt rollback,
retry/FSAL-style reuse and final refresh. The native callback contract and the
public planner binding are now separately qualified; they still do not prove
external-lead closure, reciprocal M2, torque RHS, Tabulated artifact
resolution, device-resident execution, or production capability.

### 4.6. Public ABI boundary and implemented append-only RT0/OE-F1 extension (audyt 2026-08-08)

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

Ta granica v1 pozostaje niezmieniona: standardowy wynik transportu nadal jest
nodalnym rzutem H1/P1 i nie może być przekazany do operatora RT0. Dodano jednak
append-only ścieżkę `rt0_request_v1` oraz osobny symbol OE-F1. Jest ona
aktywna wyłącznie wtedy, gdy resolved plan dostarczy kompletny descriptor
`conservative_current_view`; brak tego descriptoru zachowuje jawny
`solved_current_h1_nodal_midpoint_reference`. Sama obecność nowego symbolu nie
promuje jeszcze ogólnej capability FEM dynamic-Oersted. Planner akceptuje
wyłącznie jawnie dostarczony `closed_geometry` albo kompletny `external_lead` i
dla one-way Oersted wiąże oba warianty z `fem_stage_oersted_callback.v1`;
callback nie tworzy jednak reciprocal magnetization-dependent transportu ani
torque RHS. Pełne M2, torque RHS, tabulowane envelope'y, publiczny fixture
Python external-lead i GPU pozostają otwarte.
Managed testy operatorów i nowy natywny kontrakt
RT0→OE-F1 są dowodem wykonania kontrolowanej ścieżki CPU/double, nie dowodem
kwalifikacji produkcyjnego łańcucha.

#### 4.6.1. Zaimplementowany kontrakt append-only

Implementacja używa nowych, wersjonowanych symboli i struktur;
nie modyfikuje istniejących struktur ani symboli v1:

```text
fullmag_fem_steady_transport_rt0_request_v1
fullmag_fem_steady_transport_rt0_result_v1
fullmag_fem_solve_steady_transport_rt0_v1(...)
fullmag_fem_steady_transport_rt0_oersted_request_v1
fullmag_fem_steady_transport_rt0_oersted_result_v1
fullmag_fem_solve_steady_transport_rt0_oersted_v1(...)
```

`request_v1` zawiera niezmieniony `base` typu
`fullmag_fem_steady_transport_request_v1` oraz wymagany zagnieżdżony
descriptor RT0. Descriptor musi przenosić:

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

`result_v1` zwraca zarówno nodalny bufor pomocniczy (jeśli zażądany),
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
`reference_executable` CPU/double do czasu niezależnej bramki `p`, oracle
direct-tetra, testów zamknięcia/znaku/energii, porównania backendów i managed
end-to-end. Bramka OE-F1 ma już kontrolę `h=1/2/4/16` dla liniowo zmiennego
źródła RT0 oraz osobny test signed-current/singular/near/far.

W kodzie natywnym `fullmag_fem_solve_steady_transport_rt0_oersted_v1` buduje
`ConservativeCurrentView`, a następnie wywołuje
`DirectTetraQuadrature::Evaluate` na dokładnie tym samym immutable view.
Append-only symbol
`fullmag_fem_solve_steady_transport_rt0_oersted_vector_potential_v1` wykonuje
analogiczny krok przez `VectorPotentialSolver::Evaluate` i publikuje `A`,
gauge, kompatybilne `B/H`, residuale oraz ten sam digest widoku. Oba symbole
odrzucają brak closure, niezgodny ABI i zbyt małe bufory; nie ma konwersji
H1→RT0. Managed
`FULLMAG_RUNTIME_PRUNE=0 just verify-fem-steady-transport-cpu-only-contract`
wykonuje trzy kontrakty transportu, ABI i RT0→OE-F1 w obrazie CPU-only
(`FULLMAG_USE_MFEM_STACK=ON`). Kontrakt RT0 sprawdza również skończoność,
ciągłość strumienia, bilans elementów, brak zewnętrznego wycieku i bilans
source-cut. Jest to implementacja natywnego adaptera i kontraktu FFI, ale nie
kwalifikacja produkcyjna: planner nie wytwarza
automatycznie stage snapshotu ani `external_lead`, a OE-F2, etapowe sprzężenie LLG,
niezależnych badań `h`/airbox ani lane GPU.

Append-only native CPU hook `fullmag_fem_backend_set_stage_oersted_callback_v1`
jest właścicielem mechanizmu stage cadence/FSAL/rollback. Publiczny planner
wywołuje go dla one-way `closed_geometry` z RT0 i zapisuje osobny artefakt
telemetrii callbacku. Ten binding rozwiązuje tylko pole Oersteda; nie jest
jeszcze sprzężeniem reciprocal `J_c(m_stage)` ani callbackiem torque.

### 4.6.2. OE-F2 w normalnym runtime FEM CPU/double (zaimplementowana ścieżka ograniczona, 2026-08-08)

Po rozwiązaniu `ResolvedOerstedTerm::SolvedCurrent` planner ustawia w planie
FEM realizację `FemVectorPotential`. Runner wybiera wtedy
`NativeFemSteadyTransportOerstedMethod::FemVectorPotential`, przekazuje pustą
listę punktów celu (pole nie jest liczone z niezależnej kwadratury punktowej) i
wywołuje append-only symbol OE-F2 na **tym samym immutable RT0 view**, który
powstał z rozwiązania transportu. Brak tego widoku kończy się błędem
fail-closed; nie ma powrotu do midpoint H1.

Natywny solver rozwiązuje mieszany problem `H(curl) x H1` z gauge
`tangential_A_h1_0.v1`, a następnie zwraca kompatybilne

```text
B = curl(A),       H = B / mu0.
```

Pole `H` jest polem RT0 na elementach. Interfejs LLG wymaga jednak wartości
ciągłych w węzłach, dlatego backend wykonuje jawny rzut projekcyjny H1/P1,
nie rekonstrukcję prądu:

```text
M u_k = b_k,
b_k[i] = integral_Omega phi_i(x) H_k(x) dV,
k in {x,y,z}.
```

`M` jest skalarną macierzą masy P1, a `u_k` jest wartością nodalną dla
składowej `H_k`. Residuum publikowane w diagnostyce jako
`nodal_projection_residual` jest maksymalnym po składowych

```text
||M u_k - b_k||_2 / max(1, ||b_k||_2).
```

Wersja CPU/double używa deterministycznej gęstej odwrotności macierzy masy i
limitu `maximum_h1_dofs=2048`; jest to bounded reference projection, a nie
skalowalny solver dla dużych siatek. Wynik `nodal_h_xyz_apm` ma kolejność
`[node0.x,node0.y,node0.z,...]`, jednostkę A/m i jest publikowany wyłącznie
po kontroli długości, skończoności, zgodności
`source_view_identity_digest` oraz operatora
`fem_oersted_hcurl_h1_gauge.v1`.

Po pomyślnym solve runner dodaje ten nodalny wektor do planu pola przed
utworzeniem natywnego backendu LLG. Artefakt transportu oznacza realizację
`fem_vector_potential_hcurl_h1`, źródło
`fem_conservative_current_rt0_vector_potential.v1` i zachowuje digest pola
oraz widoku. Ścieżka dotyczy obecnie wyłącznie jednokierunkowego FEM CPU/double
z kompletnym `closed_geometry` albo `external_lead`. W publicznym runtime jest wywoływana przez
callback `fem_stage_oersted_callback.v1` dla RK/FSAL/rollback, ale charge solve
pozostaje one-way i nie jest to reciprocal `J_c(m_stage)` ani torque callback.
Nie zapewnia jeszcze GPU/device-resident,
airbox-sequence, porównania FEM↔FDM ani kwalifikacji
produkcyjnej.

Świeże dowody wykonania:

```text
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-oersted-oef2-cpu-contract                 # PASS
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-steady-transport-stage-cache-contract   # PASS
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-steady-transport-native-contract        # PASS
```

Dokładny test append-only layoutu FFI również przechodzi po zbudowaniu
`fullmag_fem` w obrazie managed. Dowody te potwierdzają kontrakt natywny,
wybór metody, walidację i integrację kodową z planem LLG; brak jeszcze
brak niezależnego fixture'u managed, który wykonałby tę ścieżkę z
kompletnym publicznym `closed_geometry` end-to-end i zamknąłby bramę
produkcyjną.

### 4.6.3. Publiczne podłączenie callbacku stage (CPU/double, bounded)

Planner ustawia `fem_stage_oersted_callback.v1` tylko wtedy, gdy jedyny
transport FEM jest one-way, źródło Oersteda jest nazwane, a descriptor
`ConservativeCurrentView` zawiera kompletne `closed_geometry` albo
`external_lead` RT0. `StageOerstedProvider`
tworzy ten sam request transportu, aktualizuje `evaluation_time_s` i
`stage_identity`, a następnie wywołuje `solve_native_fem_steady_transport_rt0`
na immutable view. `FemVectorPotential` wybiera OE-F2 z projekcją H1/P1; inne
jawne realizacje wybierają OE-F1 direct-tetra. Wynik jest sprawdzany pod kątem
długości, skończoności i digestu source-view przed przekazaniem nodalnego
`H_oe` do natywnego LLG.

`NativeFemBackend` instaluje callback przed `begin_stage`, a `Drop` usuwa go
przed zwolnieniem providera. Hooki `begin_attempt`, `commit_attempt` i
`rollback_attempt` są mapowane jeden-do-jednego na transakcję RK; telemetryczny
artefakt `transport/fem_stage_oersted_callback.v1.json` przechowuje liczniki,
ostatnią zaakceptowaną obserwację, `source_view_identity_digest` i hash pola.
Przy żądaniu GPU albo reciprocal M2 z closure-aware RT0/external-lead
planner/runtime kończy się fail-closed. Kompletny one-way `external_lead` jest
obsługiwany przez ten sam CPU callback, lecz bez publicznego managed artefaktu
nie ma jeszcze statusu kwalifikacji. Ten callback zwraca wyłącznie `H_oe`;
reciprocal torque korzysta z osobnej polityki transportowej albo wspólnej
polityki M2/Oersted z §4.6.5 i jest bezpośrednim składnikiem RHS LLG.

### 4.6.4. Stage-time envelope dla one-way FEM/FDM CPU

`CurrentTransport.time_envelope` jest jednym, bezwymiarowym mnożnikiem źródła
`a(t)`. Python, SceneDocument, `ProblemIR` i planner przechowują ten sam
tagged union; brak envelope'u oznacza `a(t)=1`. W ograniczonej ścieżce FEM
CPU/double `StageOerstedProvider` ewaluje `a(t_stage)` przed solve'em. Dla
`closed_geometry` skaluje wyłącznie bazowe source-cut `potential_drop_v`, a dla
`external_lead` skaluje `outer_electrode_potential_drop_v`; nie zmienia wartości
referencyjnych Dirichleta używanych do wyboru gauge'u. Przy `a(t_stage)=0`
callback publikuje jawnie zerowe `H_oe` bez wywołania zewnętrznego solve'u,
ponieważ descriptor natywny wymaga niezerowego bazowego napędu. Solver zwraca
więc `J_c(t_stage)=a(t_stage)J_c^0`, a operator OE-F1/OE-F2 liczy
`H_oe(t_stage)` z tego samego zamkniętego widoku. To zachowuje SI, konserwację
RT0 i tożsamość źródła; każde stage ma nowy digest rewizji.

FDM CPU one-way stosuje ten sam evaluator w `materialize_one_way_problem`.
Mnożnik skaluje warunki Voltage i OutwardNormalCurrentDensity przed solve'em,
pozostawiając Insulating bez zmian; wynik publikuje
`evaluated_envelope_multiplier` w `transport/spin_transport_accepted.json`,
razem z czasem oceny. Wspólny evaluator obsługuje Constant, Sinusoidal, Pulse,
PiecewiseLinear i Sinc. `Tabulated` wymaga jeszcze resolvera artefaktu; nie ma
niejawnego zera, interpolacji ani hold.

Wzajemny FDM M2 używa tego samego mnożnika przed monolitycznym solve'em
ładunek--spin. Dla ustalonego `m_stage` rozwiązanie jest liniowe względem
źródłowego napięcia/prądu, ale współczynniki konstytutywne nadal są budowane z
aktualnego `m_stage`; z tego samego solve'u publikowane są `J_c(m_stage,t)` oraz
`transport_torque_per_s`. Torque jest składnikiem RHS FDM, a nie polem
post-hoc. Descriptor M2 przechowuje envelope z jawnym `serde(default)`, więc
stare zapisane plany zachowują semantykę `a(t)=1`.

Planner normalizuje sinusoidę/puls do istniejącego kontraktu czasowego dla
cylindrycznych, jawnych źródeł Oersteda. Dynamiczne PWL/Sinc/Tabulated w tym
obniżeniu, non-cylindrical static midpoint, publiczny fixture `external_lead`,
połączone Oersted+torque FEM, FEM GPU i FDM GPU pozostają fail-closed. Torque-only FEM
M2 ma osobną bounded ścieżkę CPU/double opisaną w §4.6.5. Ta implementacja jest
wykonywalną bramą one-way, reciprocal M2 FDM CPU i bounded reciprocal FEM
torque, nie kwalifikacją produkcyjnego STT/SOT/SHE.

Świeże dowody zarządzane:

```text
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-time-domain-cpu-only-contract       # exit 0
FULLMAG_RUNTIME_PRUNE=0 just verify-fem-steady-transport-native-contract   # exit 0
```

Pierwsza recepta buduje obraz `fem-cpu` od zera i uruchamia kontrakty
Oersteda/RK/rollback. Druga buduje CUDA/MFEM oraz sprawdza ABI, planner,
runner, API, provenance, `cargo check --features fem-gpu` i wspólny limit
FEM↔FDM. To jest dowód implementacji i kompilacji zarządzanego runtime'u;
nie jest jeszcze ilościową kwalifikacją pełnego M2, GPU ani produkcyjnego
dynamicznego STT/SOT/SHE.

### 4.6.5. Reciprocal FEM M2 stage torque callback (CPU/double, bounded)

Planner tworzy `fem_stage_transport_callback.v1` wyłącznie dla wzajemnego
FEM M2 z jawnym `DriftDiffusionSpinTorque` wskazującym ten sam moduł. Dla
każdego RHS provider kopiuje `m_stage` do requestu, ewaluje wspólny envelope
na `t_stage`, skaluje różnice `charge_dirichlet` względem elektrody
referencyjnej, a następnie wywołuje
`solve_native_fem_steady_transport` z konstytutywnym modelem
`ReciprocalM2`. Wynikowy `torque_xyz_per_s` jest kopiowany do ABI i dodawany
do RHS LLG przez natywny integrator po standardowych składnikach LLG/STT/SOT.

Append-only ABI `fullmag_fem_backend_set_stage_transport_callback_v1` nie
zmienia istniejących struktur FEM/Oersteda. `TransportStageRuntimeState`
przechowuje wektor torque, `stage_identity`, rewizję źródła i stan próby;
`RkStepTransaction` obejmuje ten payload, a hooki begin/commit/rollback
zapobiegają publikacji odrzuconego solve'u. `NativeFemBackend` odłącza
callback przed zniszczeniem providera. Finalizacja zapisuje
`transport/fem_stage_transport_callback.v1.json` z licznikami i digestami
obserwacji.

Kontrakt zarządzany `fem_rk_explicit_contract` potwierdza niezależną referencję
RK4, próbki wszystkich stage i endpointu, rollback adaptacyjnych RK23,
rollback awarii natywnej oraz jawne odrzucenie ścieżki GPU. Testy planera
potwierdzają wybór osobnej polityki dla reciprocal M2 torque oraz wspólnej
polityki dla reciprocal M2 torque+Oersted. Zarządzany test natywnego kroku
potwierdza identyczną rewizję/digest źródła i dokładnie jeden solve na etap,
z drugim callbackiem obsłużonym przez cache. Osobny adaptacyjny RK23 wymusza
co najmniej jedno odrzucenie, wymaga rollbacku obu adapterów przed retry i
jednego commita wspólnej zaakceptowanej rewizji. To jest
**bounded CPU/double implementation**, nie awans do capability produkcyjnej:
pozostają publiczny fixture end-to-end, reciprocal `external_lead`,
GPU/device-resident, h/p/airbox/energia oraz ilościowa walidacja
FEM↔FDM i względem solverów zewnętrznych.

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

For `fdm_oersted_cell_integrated_open.v1`, the primary direct oracle uses the
versioned independent `long double` surface-potential reduction. The distinct
adaptive surface spot checker validates axial, edge, corner, anisotropic and
cancellation-dominated references against its stricter versioned budget.
Section 3.1.5 owns the sole production mixed absolute-plus-relative kernel and
field budgets, the independent spot-check acceptance and the analytic
exact-zero classification. An implementation must not reinterpret those sums
as two simultaneous inequalities, replace the declared scale by the measured
error, or enlarge the budget because a fixture is near a cancellation point.

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

### 5.4 Publiczne powiązanie FDM CPU/FP64 M1

Append-only granica native dla istniejącego ownera CPU używa symbolu
`fullmag_fdm_cpu_oersted_solve_v1` oraz rekordów
`fullmag_fdm_cpu_oersted_request_v1` i
`fullmag_fdm_cpu_oersted_result_v1`. Request przenosi union grid, rozłączne
maski conductor/target, **accepted raw face-current** `(Jx, Jy, Jz)` z
zaakceptowanego snapshotu charge, pełną identity źródła i certyfikat
`global_closed_current_certificate.v1`. Result publikuje `H_oe [A/m]`,
diagnostykę i dokładne identyfikatory
`fdm_oersted_cell_integrated_open.v1`, `oersted_fdm_fft_open.v1` oraz
`fdm_oersted_fft_open_v1`. Adapter nie ma własnej numeryki i wywołuje wyłącznie
`fullmag::fdm::cpu::oersted::v1::Solver`. Stateless ABI utrzymuje własny trwały,
immutable `Problem` tylko dla bitowo identycznego kompletnego snapshotu; każda
zmiana danych lub metadanych tworzy nowy `Solver` i wymusza pełny preflight
przed cache hit. Pełny manifest `offsetof` pokrywa każde pole rekordów ABI, a
`source_identity` jest odrzucane, jeśli nie mieści się bez utraty w result
provenance (maksymalnie 95 bajtów plus NUL).

To powiązanie nie zmienia publicznej semantyki authoringu. FDM closure
descriptor is not yet present in the public ProblemIR: istniejący bool
`oersted_source_bound` wiąże jedynie nazwane źródło, a FEM-only
`ConservativeCurrentView` nie opisuje ścian structured-grid. Dlatego publiczny
runner NativeM1 musi wywołać nową granicę i zakończyć się fail-closed dla braku
pełnego certyfikatu; nie wolno mu fabrykować closure z residualu charge ani
wracać do Rustowego midpoint. Dodatni niezerowy publiczny run pozostaje
zablokowany do osobnego docs-first, pełnego round-trip Python/UI/ProblemIR/
planner FDM closure descriptor. Sam ABI można kwalifikować bezpośrednim
closed-loop fixture. CPU i GPU pozostają `semantic_only`.

## 6. Completeness checklist

- [x] Bounded FEM steady one-way solved-current midpoint reference slice (not OE-T0/F1/F2)
- [x] Python current/Oersted model and complete envelope export (`closed_geometry`
  descriptor round-trip plus one-way CPU stage evaluation)
- [x] Typed `external_lead` authoring, SceneDocument/script round-trip,
  executable public Python fixture lowering and planner preflight
  (`fem_closed_current_extension.v1`; managed execution of that public fixture
  remains an open runtime gate)
- [ ] ProblemIR, planner, migration, and scoped capabilities
- [x] Frozen documentation contract for `fdm_oersted_cell_integrated_open.v1`
  (source-cell integral at target centre, closure/source-cut, exact 2N R2C
  layout, cache/provenance and direct-oracle gates; both FDM lanes remain
  `semantic_only`)
- [ ] Conservative FDM charge and face-to-cell publication
- [x] FDM standalone CPU/double direct oracle and cell-integrated open FFT
  owner with append-only C ABI/Rust FFI contract; public NativeM1 is
  fail-closed until a complete FDM closure descriptor is available and no
  capability promotion is implied
- [ ] FDM CUDA/cuFFT realization and public planner/runner binding
- [ ] FEM direct oracle and `H(curl)` CPU/GPU vector potential
- [x] OE-T0 immutable conservative RT0 view with revision/digest certificate (native CPU contract; planner/stage promotion remains open)
- [x] OE-F1 cutoff-free direct tetrahedral CPU-double oracle (native CPU contract; h-refinement and balance gates for RT0/OE-F1 are covered; p, cross-backend and production gates remain open)
- [x] Reference-only 3-D FEM/FDM midpoint common-limit operator contract (same uniform cube and far target; production FDM convolution and solved-current coupling remain open)
- [x] OE-F2 exact-sequence `H_0(curl) x H^1_0` baseline and topology gate (bounded CPU/double solver and nodal LLG bridge; GPU, p/airbox and production gates remain open)
- [x] Invariant-source cache gate for one-way closed_geometry (exact-key RHS reuse and changed-identity rejection)
- [x] Native CPU stage-provider cadence, FSAL, rollback, and accepted observation
- [x] Managed public-adapter RT0 external-lead solve with two coincident joins,
  electrode balance and closure-interface certificate
- [x] Managed external-lead stage callback from RT0 through OE-F1 field
  reconstruction, rollback without accepted-state mutation and deterministic
  retry/commit
- [x] One native FEM CPU Heun step with the external-lead Oersted callback
  installed and driven by the real RK cadence
- [x] Native adaptive FEM CPU RK23 rejection, callback rollback and accepted
  retry with rollback count equal to the integrator rejection count
- [x] Three-step native external-lead callback trajectories for all supported
  explicit FEM RK integrators: Heun, RK4, RK23 and RK45
- [x] One-way CPU FEM/FDM stage-time envelope evaluation and multiplier provenance
- [ ] Magnetization-dependent/reciprocal `J_c(m_stage)` and torque RHS
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
| `scripts/test_dynamic_current_oersted_contract_docs.py` | `test_fdm_oersted_open_v1_is_fully_frozen_and_semantic_only` | documentation-only regression for the frozen FDM open-boundary operator; not runtime evidence |
| `backends/fdm/include/fullmag/fdm/cpu/oersted_fft_open_v1.hpp` | `class Solver` | versioned CPU/FP64 numerical owner behind the append-only public adapter |
| `native/include/fullmag_fdm.h` | `fullmag_fdm_cpu_oersted_solve_v1` | append-only CPU/FP64 request/result ABI carrying exact face current, closed-current certificate and provenance |
| `backends/fdm/api/cpu_oersted_fft_v1.cpp` | `fullmag_fdm_cpu_oersted_solve_v1` | validation/copy adapter to the sole numerical owner; no alternate midpoint implementation |
| `backends/fdm/tests/cpu_oersted_fft_public_abi_contract.cpp` | `main` | nonzero public ABI, bit-exact owner parity, immutable cache lifetime, identity boundary and fail-closed regressions |
| `crates/fullmag-fdm-sys/src/lib.rs` | `cpu_oersted_append_only_layout_matches_native_manifest` | exact Rust FFI mirror and every-field C `offsetof` comparison |
| `crates/fullmag-runner/src/fdm/cpu/native_transport.rs` | `solve_native_m1_snapshot` | accepted raw face-current binding; missing public FDM closure descriptor fails closed without midpoint fallback |
| `backends/fdm/cpu/interactions/oersted/cell_integrated_kernel_v1.cpp` | `cell_integrated_kernel_m` | exact source-cell integral at the target centre, SI sign and exact real-space zeros |
| `backends/fdm/cpu/interactions/oersted/fft_open_v1.cpp` | `class Solver::Impl` | closure-aware exact-2N open convolution, accepted/candidate/failure state, trusted fast cache, full-field diagnostics and provenance |
| `backends/fdm/tests/oersted_direct_oracle_v1.cpp` | `OracleKernelResult integrate_source_cell_at_target_center` | independent `long double` surface-potential oracle |
| `backends/fdm/tests/oersted_direct_oracle_v1.cpp` | `adaptive_surface_spot_check` | independent compensated GL16 adaptive surface spot checker |
| `backends/fdm/tests/cpu_oersted_fft_open_contract.cpp` | `main` | managed standalone CPU physics/numerics/cache/fail-closed contract |
| `justfile` | `verify-fdm-cpu-oersted-open-fft-native-contract` | container-backed CPU-only gate using `/mnt/fullmag-zfn2-native/fdm-cpu-oersted-open-fft` |
| `crates/fullmag-plan/src/oersted.rs` | `resolve_oersted_term` | bind Oersted source |
| `crates/fullmag-plan/src/oersted.rs` | `resolve_solved_current_source` | solved-current binding |
| `crates/fullmag-plan/src/spin_transport.rs` | `resolve_m1_fem_spin_transport` | FEM transport descriptor |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | explicit FemVectorPotential selection for solved-current Oersted |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solved_current_midpoint_biot_savart_field` | bounded midpoint field |
| `crates/fullmag-runner/src/dispatch.rs` | `normalized_fem_plan_for_runtime` | FEM field injection |
| `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_coupled_module` | FDM stage owner |
| `crates/fullmag-plan/src/spin_transport.rs` | `fem_ohmic_oersted_binds_the_solved_charge_field` | planner regression |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solved_current_midpoint_biot_savart_is_finite_and_reverses_with_current` | runtime regression |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `execute_native_fem_steady_transport_plans` | artifact provenance |
| `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_v1` | public v1 ABI boundary |
| `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_rt0_oersted_v1` | append-only RT0/OE-F1 ABI |
| `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_rt0_oersted_vector_potential_v1` | append-only RT0/OE-F2 ABI |
| `native/include/fullmag_fem.h` | `fullmag_fem_backend_set_stage_oersted_callback_v1` | append-only CPU stage callback ABI |
| `native/include/fullmag_fem.h` | `fullmag_fem_backend_set_stage_transport_callback_v1` | append-only CPU reciprocal M2 torque callback ABI |
| `backends/fem/cpu/mfem/interactions/oersted.cpp` | `materialize_oersted_stage_field` | native stage callback evaluation and transaction ownership |
| `backends/fem/cpu/mfem/interactions/transport_stage.cpp` | `materialize_transport_stage_rhs` | validate and add reciprocal transport torque RHS in 1/s |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `solve_rt0` | immutable RT0 view and OE-F1/OE-F2 adapters |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentView` | public closure-aware RT0 identity/closure descriptor |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentExternalLead` | typed volumetric lead mesh, interface pairs, electrodes and conductivity digest |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentLeadInterfacePair` | canonical device/lead boundary-face pairing |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | public current source and canonical time-envelope owner |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ChargeSolverPolicy` | versioned FDM/FEM charge-operator and residual validation |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | preserve FDM M2 nonlinear policy versus bounded FEM M2 linear operator identity |
| `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinDriftDiffusion` | canonical spin transport materials, interfaces, boundaries, solver and execution request |
| `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class DriftDiffusionSpinTorque` | explicit transport-to-LLG torque binding and angular-rate contract |
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedCylinder` | stable authored identity for the analytic cylinder Oersted term |
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedField` | stable authored identity and binding to a named solved-current source |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_oersted_entry` | canonical Python export preserving the explicit Oersted identity |
| `crates/fullmag-ir/src/validation.rs` | `validate_oersted_energy_terms` | reject present-but-empty IDs while retaining read compatibility for historical ID-less IR |
| `crates/fullmag-authoring/src/validation.rs` | `validate_scene_conservative_current_view` | SceneDocument/API shape validation for closed_geometry and complete external_lead descriptors; full public runtime qualification remains open |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts` | `buildCurrentTransport` | Control Room descriptor JSON round-trip without dropping closure parameters |
| `crates/fullmag-plan/src/spin_transport.rs` | `validate_conservative_current_view` | planner mesh/identity/interface/electrode validation for external_lead and stage-callback selection; incomplete and unsupported combinations remain fail-closed |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport_rt0` | RT0/OE-F1 FFI and provenance boundary; sizes output buffers for the combined device-plus-lead RT0 space |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | managed Rust-adapter -> append-only C ABI -> MFEM regression for a device joined to two volumetric leads |
| `crates/fullmag-runner/src/native_fem/stage_oersted.rs` | `external_lead_stage_callback_solves_oersted_and_commits_observation` | managed RT0 -> OE-F1 -> stage callback regression with finite non-zero field, accepted-state-preserving rollback and bitwise-identical retry/commit |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_external_lead_oersted_callback_advances_one_cpu_llg_step` | managed native CPU Heun step that installs the provider, lets the real RK cadence evaluate RT0/OE-F1, commits the observation and publishes finite post-step magnetization |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_external_lead_oersted_callback_rolls_back_rejected_adaptive_attempt` | managed adaptive RK23 regression that forces at least one rejected native attempt and proves callback rollback count equals the integrator rejection count before an accepted retry |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_external_lead_oersted_callback_covers_all_explicit_rk_integrators` | managed three-step callback-trajectory regression for fixed Heun/RK4 and adaptive RK23/RK45 with persistent provider state and one commit per step |
| `backends/fem/cpu/mfem/interactions/oersted/vector_potential.cpp` | `project_compatible_h_to_nodes` | bounded RT0-compatible H to H1/P1 nodal projection and residual |
| `crates/fullmag-runner/src/native_fem/steady_transport/stage_cache.rs` | `SteadySourceCache::reuse` | exact-key invariant-source cache and fail-closed identity guard |
| `crates/fullmag-runner/src/native_fem/steady_transport/stage_cache.rs` | `begin_attempt` | checkpoint/rollback coordinator for accepted and rejected source stages |
| `crates/fullmag-runner/src/native_fem/stage_oersted.rs` | `from_plan` | public CPU stage binding for closed_geometry/external_lead to the RT0/OE-F1/OE-F2 adapter, envelope/zero-drive handling, exact stage identity and transactional callbacks |
| `crates/fullmag-runner/src/native_fem/stage_transport.rs` | `StageTransportProvider::evaluate` | public CPU reciprocal M2 stage solve, envelope scaling, torque digest and exact stage identity |
| `crates/fullmag-runner/src/native_fem/stage_coupled.rs` | `StageM2CoupledProvider::evaluate` | one exact-stage reciprocal M2 solve shared by direct torque and descriptor-free H1/P1 solved-current Oersted with common source identity |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_reciprocal_m2_shares_one_stage_solve_for_torque_and_oersted` | managed native CPU LLG regression proving one solve per stage, cache reuse and identical accepted source identity for both callbacks |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_reciprocal_m2_rolls_back_both_callbacks_before_shared_retry` | managed adaptive RK23 regression proving matched rollback/commit counts and one shared accepted source identity after rejected attempts |
| `crates/fullmag-runner/src/native_fem.rs` | `native_fem_reciprocal_m2_shares_source_across_all_explicit_rk_integrators` | managed three-step shared-source trajectories for fixed Heun/RK4 and adaptive RK23/RK45 |
| `crates/fullmag-runner/src/time_envelope.rs` | `evaluate_time_envelope` | shared exact-stage evaluation of source envelopes; unresolved tabulated artifacts fail closed |
| `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `source_envelope_multiplier` | FDM CPU one-way source scaling and accepted multiplier provenance |
| `packages/fullmag-py/src/fullmag/world.py` | `spin_transport` | flat/study registration of canonical spin transport into ProblemIR |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_spin_transports` | canonical Python export of spin transport and torque parameters |
| `packages/fullmag-py/src/fullmag/runtime/scene_document.py` | `_canonical_spin_transports` | preserve validated spin-transport payload across UI scene round-trip |
| `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py` | `test_canonical_fem_spin_transport_and_torque_round_trip_through_flat_script` | Python, SceneDocument and flat-script regression |
| `packages/fullmag-py/tests/test_external_lead_roundtrip.py` | `ExternalLeadRoundTripTests` | typed external-lead serialization, script/SceneDocument round-trip and invalid-input rejection |
| `packages/fullmag-py/tests/test_external_lead_roundtrip.py` | `test_public_external_lead_example_lowers_complete_stage_contract` | load the public fixture with its imported device mesh and prove complete current/spin/Oersted plus external-lead stage lowering |
| `examples/fem_external_lead_oersted_public.py` | `cube_parts` | bounded public Python fixture for an imported tet4 device joined to two volumetric external leads and a dynamic Oersted LLG stage |
| `scripts/validate_fem_external_lead_oersted_runtime.py` | `validate_runtime_log` | fail-closed public-runtime artifact gate for strict FEM CPU/double provenance, external-lead callback commits/digests and finite changed magnetization |
| `scripts/test_validate_fem_external_lead_oersted_runtime.py` | `test_accepts_complete_external_lead_callback_artifacts` | synthetic positive and negative tests for missing callback, uncommitted observation, execution mismatch and unchanged state |
| `crates/fullmag-runner/src/fem/relax/finalize.rs` | `stage_transport_telemetry` | persist reciprocal stage-transport callback telemetry artifact |
| `crates/fullmag-runner/src/fem/relax/finalize.rs` | `finalize_native_fem_relaxation` | append-only callback provenance artifact with accepted/last stage observation and field digest |
| `backends/fem/tests/steady_transport_rt0_contract.cpp` | `main` | managed RT0/OE-F1 contract |
| `backends/fem/tests/steady_transport_abi_contract.cpp` | `main` | RT0 boundary regression |
| `backends/fem/tests/steady_transport_contract.cpp` | `main` | managed transport contract |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `main` | OE-T0 contract |
| `backends/fem/tests/oersted_direct_tetra_contract.cpp` | `main` | OE-F1 contract |
| `backends/fem/tests/oersted_vector_potential_contract.cpp` | `main` | OE-F2 contract |
| `backends/fem/tests/rk_explicit_contract.cpp` | `main` | managed reciprocal FEM M2 torque/RK stage contract |

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
