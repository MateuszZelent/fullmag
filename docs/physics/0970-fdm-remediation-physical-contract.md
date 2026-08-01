# FDM remediation physical and execution contract

- Status: approved for remediation
- Owners: Fullmag core
- Last updated: 2026-07-19
- Related audit: `docs/audits/2026-07-19-fdm-solver-audit.md`
- Related ledger: `docs/audits/2026-07-19-fdm-solver-remediation-ledger.md`
- Related notes: `0400-fdm-exchange-demag-zeeman.md`,
  `0440-fdm-interfacial-dmi.md`, `0460-fdm-bulk-dmi.md`,
  `0480-fdm-higher-order-and-adaptive-time-integrators.md`,
  `0550-fdm-sub-cell-staircase-correction.md`,
  `0800-fdm-sot.md`, and
  `0960-canonical-llg-time-domain-solver-and-qualification-contract.md`

## 1. Problem statement

This note freezes the physical and public-contract decisions required to
remediate the FDM audit. It is the implementation prerequisite for every
change that affects the FDM equation, discrete operator, execution legality,
observable, Python/ProblemIR representation, or Control Room round-trip.

It does not promote an FDM lane to production. A lane is only `validated` or
`production` after its own managed qualification gate records executed cases,
numerical tolerances, artifacts, and provenance.

## 2. Canonical physical contracts

### 2.1 LLG, fields, and direct torques

For active cells, Fullmag advances the reduced magnetization `m` using

\[
\partial_t m = -\frac{\gamma_0}{1+\alpha^2}
\left[m\times H_\mathrm{eff}+\alpha m\times(m\times H_\mathrm{eff})\right]
+ \tau_\mathrm{nc},
\qquad \gamma_0=\mu_0|\gamma|.
\]

`H_eff` and every published `H_*` have unit `A/m`. Every direct
non-conservative contribution, including SOT, has unit `1/s`, is named
`tau_*`, and is added only through `tau_nc`; it is never placed in an
`H_*` buffer and never mixed with a field without the `gamma0` conversion.
The public and ABI `gyromagnetic_ratio` value is `gamma0 [m/(A s)]`.

SOT uses prescribed current density `J [A/m²]`, a unit polarization `sigma`,
ferromagnet thickness `t_F [m]`, and efficiencies `xi_dl`, `xi_fl [1]`. Its
field amplitudes are

\[
H_{DL,FL}=\frac{\hbar |J|\xi_{DL,FL}}
{2e\mu_0 M_s t_F}\quad [A/m].
\]

The exported direct torque is the fully converted, post-Gilbert-form RHS
contribution `tau_sot [1/s]`. It must be computed centrally from these field
amplitudes and `gamma0`, not independently in CPU and CUDA kernels. SOT has
no conservative energy density or scalar energy. Inactive cells always keep
`m = 0` and `tau_* = 0`.

### 2.2 Conservative energy, partial cells, and bulk DMI

For a conservative term `q`, the discrete total energy is

\[
E_q=\sum_{i\in\mathrm{active}} \varphi_i V_i e_{q,i},
\]

where `phi_i` is physical material volume fraction, `V_i` is the full cell
volume, and `e_q [J/m³]` is the term's density. Pairwise exchange links use a
single symmetric face/link weighting rule; a link is counted exactly once.
The same `phi`, face weights, and boundary geometry instance must drive the
field, energy, scalar reductions, and derivative tests.

For a local density (Zeeman, prescribed Oersted, uniaxial anisotropy, or
cubic anisotropy), `phi_i V_i` multiplies the scalar energy, while the same
factor cancels from the discrete variational field
`H_i=-(mu0 Ms phi_i V_i)^{-1} dE/dm_i`; therefore the local RHS field is not
artificially scaled by `phi_i`. Nonlocal operators must instead realize the
same weighted variational discretization in both their stencil and scalar
energy. Until that exists, T0/T1 rejects DMI rather than publishing a scalar
energy whose derivative disagrees with the stepping field.

For a self field such as demagnetization, the discrete field-dot energy uses
`-1/2 mu0 Ms m . H_self`. For an applied Zeeman field, including a native
stacked multilayer external field, it uses `-mu0 Ms m . H_ext` with no half
factor. These reductions must remain separate in total and per-object
observables.

The static Oersted field of a cylindrical conductor is also an applied field
for this purpose.  For the exact cellwise field `H_Oe,i [A/m]` added to the
LLG RHS, its contribution is

\[
E_\mathrm{Oe}=-\mu_0 M_s V_\mathrm{cell}
\sum_{i\in\mathrm{active}} m_i\mathbin{\cdot}H_{\mathrm{Oe},i}.
\]

It is reported in the existing external/Zeeman scalar, and therefore included
once in total energy; it is not a self-field and must never receive a
one-half factor.  The CPU AoS and SoA energy helpers, full step observables,
and finite-difference derivative tests must use the same cellwise field as
the effective-field RHS.  Time-dependent Oersted stage evaluation and CUDA
geometry parity remain separate requirements and do not justify reporting a
zero static Oersted energy.

The native CUDA FP64 and FP32 reductions use that same expression with the
uniform external field plus `oersted_field_scale(t) H_oe_static`. A managed
native source contract prevents either precision lane from dropping the
Oersted summand; numerical device parity still requires a GPU qualification
case and is not inferred from that contract.

For native single-grid CUDA, dynamic `StepStats` and an explicit snapshot
publish the same scalar decomposition: exchange, demagnetization, external
(including Oersted where present), uniaxial plus cubic anisotropy, bulk or
interfacial DMI, and their sum. The runner maps cubic energy into `e_ani` and
DMI into `e_dmi` in both paths; zero is only a physical zero, never a stand-in
for an omitted observable. A device identity test is required before this
contract can be called qualified.

For uniaxial magnetocrystalline anisotropy, with `p = m . u` for a unit
material axis `u`, Fullmag uses

\[
e_\mathrm{uni}=-K_{u1}p^2-K_{u2}p^4,
\qquad
H_\mathrm{uni}=-\frac{1}{\mu_0M_s}\frac{\partial e_\mathrm{uni}}{\partial m}.
\]

`Ku1` and `Ku2` are signed, finite material parameters in `J/m³`. Positive
`Ku1` makes `u` an easy axis; negative `Ku1` makes it the normal of an easy
plane. The material property is the only public representation; a legacy
standalone uniaxial term is migrated to that property under the documented
single-material rule.

For cubic magnetocrystalline anisotropy in the orthonormal crystal frame
`(c1, c2, c3 = c1 x c2)`, Fullmag uses

\[
\sigma=m_1^2m_2^2+m_2^2m_3^2+m_3^2m_1^2,
\qquad
e_\mathrm{cub}=K_{c1}\sigma+K_{c2}m_1^2m_2^2m_3^2+K_{c3}\sigma^2,
\]

with `Kc1`, `Kc2`, and `Kc3` in `J/m³` and
`H_cub = -(mu0 Ms)^-1 d e_cub / d m` in `A/m`. The CPU reference, CUDA
single-grid, and CUDA multilayer paths must use this same energy and its
derivative; field-dot-energy shortcuts are invalid for these non-quadratic
terms.

Bulk DMI is

\[
E_\mathrm{bDMI}=D\int m\cdot(\nabla\times m)\,dV,
\qquad
H_\mathrm{bDMI}=-\frac{2D}{\mu_0M_s}\nabla\times m.
\]

`D [J/m²]`; `H_bDMI [A/m]`; `e_bDMI [J/m³]`; and `E_bDMI [J]`. CPU,
CUDA FP64, CUDA FP32, single-grid, and any promoted multilayer realization
must use this sign. A natural exchange+DMI boundary condition is required for
any lane advertising free-surface bulk DMI; otherwise that lane is rejected.

### 2.3 Boundary correction and demagnetization

T0/T1 requires a certified SDF-derived boundary dataset with volume fraction,
face fractions, and the T1 intersection distances. `strict` rejects geometry
that cannot supply this dataset. No planner warning may silently lower a
T0/T1 request to tier 0. Until field, energy, and parity gates pass, CUDA FP32
T0/T1 and FP32 sub-cell demag are explicitly unsupported.

The public CUDA ABI accepts caller-supplied, validated Newell spectra. Its
automatic Newell branch is unavailable until it completes FFT construction and
upload, validates spectrum sizes/symmetry, and proves parity. It must fail
closed rather than mark uninitialized spectra ready.

### 2.4 Thermal stochastic dynamics

There is one `ThermalConfig` in the canonical problem model:
`temperature [K]`, `seed [u64]`, and an explicit SDE policy. Legacy
`Problem.temperature` and `ThermalNoise` inputs migrate into that one config
and conflict if they disagree. Brown field variance is

\[
\sigma_H^2=\frac{2\alpha k_B T}
{\gamma_0\mu_0M_s\varphi V\,\Delta t}
\quad [A²/m²].
\]

The initial public stochastic lane is fixed-step Heun with a Stratonovich
interpretation. Adaptive stochastic execution is unsupported until a separate
qualified SDE policy is added. The counter-based RNG key is `(seed,
accepted_step, cell, stage)`: rejected attempts do not consume accepted-step
state, and CPU/CUDA replay uses the same documented mapping. The actual
attempted `dt` is supplied on every backend call.

### 2.5 Time, history, and masks

Every RHS receives `t_stage = t_n + c_i dt` from a single stage-time context.
The context covers external fields, regional drives, antennas, Oersted, and
thermal sampling. Uploading state, changing a plan/source, changing `dt`, or
rejecting a step invalidates FSAL and ABM history before another accepted
step. Every accepted-stage normalization applies only to active cells; all
inactive cells remain exactly zero.

## 3. Public model and execution legality

Anisotropy is a material/region property. `UniaxialAnisotropy` and
`CubicAnisotropy` are not standalone `EnergyTerm` variants; legacy scripts are
migrated to material anisotropy or rejected with an actionable error when no
material target exists. The general validation rule is that a problem needs a
defined material and at least one executable interaction or material
anisotropy; it does not require Exchange, Demag, or Zeeman specifically.

Requested execution fields are typed enums: discretization, device,
precision, execution mode, and UI mode. A requested GPU is fail-closed when
unavailable. `auto` may resolve to CPU only with a retained fallback trail in
run, stage, interactive, hysteresis, API, and script provenance. Unknown
values and invalid GPU indices are rejected at the public boundary. Current
execution is single-device only: `gpu_count` may be `0` or `1`; a request
above one fails during Python and ProblemIR validation with an explicit
multi-GPU-unimplemented diagnostic rather than being silently ignored.

FDM demagnetization has no `allow_single_grid_fallback` switch. The author
must request `strategy="single_grid"`, `"multilayer_convolution"`, or
`"auto"`; an ineligible `auto` resolution fails with its planner reason until
it has an explicit, provenance-bearing resolution contract. Legacy uses of
the removed switch fail with a migration error rather than silently changing
the selected realization.

Adaptive FDM is currently qualified only for the explicit CPU double lane.
An adaptive request for `device="cuda"` or `"gpu"` is rejected by the
planner before native materialization because no matching executable timestep
identity exists. This is a legality restriction, not a runtime fallback.

Host availability, intrinsic engine support, and active-session plan legality
are separate resources using shared identifiers and reason codes. The active
session legality resource is the only UI gating owner; platform capabilities
remain host inventory. The runtime `supported_terms` catalog is selected from
the planned FDM profile rather than from dormant source ownership: single-grid
may advertise its executable thermal, STT, SOT, and Oersted scope, with the
machine-readable `term_scopes` map carrying restrictions such as CUDA's
constant `+z` cylinder and static precomputed-field support. The public
multilayer profile omits thermal, torque, Oersted, bulk DMI, magnetoelastic,
and CUDA boundary correction because its planner rejects them. Multilayer
profiles reject unsupported features before lowering, including field drives
until a lossless plan representation exists.

## 4. IR, API, and workspace impact

`ProblemIR` carries `ThermalConfig`, typed runtime selection, literal
requested integrator intent, resolved execution identity, realization ID, and
fallback trail. It preserves the canonical material anisotropy form and
rejects ambiguous legacy forms. `FdmMultilayerPlanIR` either owns every
accepted source or planner validation rejects it.

The browser contract is resource-first. A session-scoped legality resource
contains plan-specific availability and reason codes; status carries only its
revision/summary. OpenAPI, generated transport, typed facade, hooks, and
Control Room consume the same vocabulary. Quantities distinguish `H_* [A/m]`
from `tau_* [1/s]`; unsupported quantities are explicit states.

The authoring schema is versioned and shared by the Rust adapter, Python
SceneDocument adapter, and script renderer. It contains execution selection,
global relaxation, and field drives. A UI transaction must export and parse
to an equivalent `ProblemIR` before its authoring surface can be considered
supported.

### 4.1 Time-integrator intent and resolution provenance

`integrator="auto"` is authored physical/execution intent, not an omitted
value. `ExecutionPlanIR.provenance.integrator_resolution` therefore stores a
typed `requested_integrator` (`auto`, `heun`, `rk4`, `rk23`, `rk45`, or
`abm3`) separately from the concrete `resolved_integrator`. The existing
`TimestepPolicyProvenance` remains the typed record of the selected timestep
policy and execution identity; this plan-level pair is its input provenance,
not a replacement. At artifact finalization the compatibility
`ExecutionProvenance.requested_integrator` and `resolved_integrator` fields
are populated using lower-case public spelling. Device implementation,
fallback, and hardware facts remain runtime provenance and must not be folded
into the integrator intent.

## 5. Backend interpretation

CPU reference is the FP64 oracle. CUDA FP64 is qualified only by parity with
the oracle for a named lane; CUDA FP32 has separately declared tolerances and
never inherits FP64 status. Multilayer native-stacked and CUDA-assisted are
distinct realizations with their own capability rows, residency telemetry, and
validation gates. The assisted realization must publish
`fdm_multilayer_transfer_telemetry` in execution provenance with
`execution_shape="cuda_assisted_multilayer"`,
`data_residency="host_authoritative_with_cuda_field_roundtrips"`, and exact
vector H2D/D2H counts and payload bytes measured at each FFI transfer. Those
values describe the complete executed run, including staged RHS and native
multilayer-demag transfers; they are not a prediction from the requested
integrator or timestep. FEM semantics are unchanged by this note; it shares
the public physical vocabulary but is not evidence for FDM execution.

## 6. Validation strategy

Each remediation finding maps to one acceptance gate in the remediation
ledger. Conservative operators require an independent analytical or
manufactured oracle and an energy-field finite-difference derivative check.
Time integrators require non-autonomous order, discontinuity, restart, and
history-reset tests. Thermal lanes require deterministic replay and statistical
variance checks. Every public lane requires planner rejection coverage for
illegal configurations, Python/IR round-trip, provenance/API evidence, and a
managed CPU/CUDA qualification artifact. A GPU test skipped because no device
exists is recorded as skipped and cannot satisfy a required GPU gate.

## 7. Completeness checklist

- [x] Physical conventions and SI units frozen for remediation.
- [x] Public fallback, legality, and provenance policy frozen.
- [x] Acceptance-gate mapping recorded in the remediation ledger.
- [ ] Python API and legacy migration implemented.
- [ ] ProblemIR, planner, runtime, and ABI implemented.
- [ ] CPU/CUDA/multilayer numerical gates passed.
- [ ] OpenAPI, Control Room, and browser round-trip implemented.
- [ ] Managed production qualification artifacts published.

## 8. Deferred work

Adaptive stochastic integration, natural bulk-DMI boundaries, full current
transport, magnetoelastic FDM execution, multilayer PBC/thermal/torque,
device-resident assisted multilayer, and FDM frequency-domain solving remain
unsupported until their own physics contract and qualification gate exist.
