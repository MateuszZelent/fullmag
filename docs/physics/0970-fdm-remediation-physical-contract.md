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
values and invalid GPU indices are rejected at the public boundary.

Host availability, intrinsic engine support, and active-session plan legality
are separate resources using shared identifiers and reason codes. The active
session legality resource is the only UI gating owner; platform capabilities
remain host inventory. Multilayer profiles reject unsupported features before
lowering, including field drives until a lossless plan representation exists.

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

## 5. Backend interpretation

CPU reference is the FP64 oracle. CUDA FP64 is qualified only by parity with
the oracle for a named lane; CUDA FP32 has separately declared tolerances and
never inherits FP64 status. Multilayer native-stacked and CUDA-assisted are
distinct realizations with their own capability rows, residency telemetry, and
validation gates. FEM semantics are unchanged by this note; it shares the
public physical vocabulary but is not evidence for FDM execution.

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
