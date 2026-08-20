# Canonical relaxation and equilibrium contract

- Status: approved contract; implementation incomplete
- Owners: Fullmag physics, planner, backend, API, and Control Room maintainers
- Last updated: 2026-08-02
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/capability-matrix-v0.md`,
  `docs/specs/resource-first-control-room-api-v2.md`,
  `docs/superpowers/specs/2026-07-10-canonical-relaxation-contract-design.md`
- Supersedes: conflicting relaxation-time, direct-minimizer step-unit, torque,
  and capability statements in `0500`, `0510`, and `0530`

(problem-statement)=
## 1. Problem statement

Fullmag exposes several workflows under the public name `Relaxation`:

1. damping-only LLG relaxation;
2. projected-gradient Barzilai--Borwein energy minimization;
3. nonlinear conjugate-gradient energy minimization;
4. a CPU/MFEM tangent-space implicit development method.

The existing implementation and authoring surfaces do not preserve one
physical contract across those methods. In particular:

- direct minimizers can carry time-integrator parameters that they do not use;
- line-search steps with units `m/A` are reported as seconds;
- nonconservative torques and stochastic fields can be accepted by workflows
  that minimize a conservative energy and then be ignored by the minimizer;
- `max_torque_Apm` can be replaced by a reconstruction from `dm/dt`, despite
  the backends already owning the exact field residual;
- terminal status, convergence, stop reason, provenance, Python defaults, and
  Control Room defaults can disagree;
- capability surfaces expose algorithms that the selected backend, device, or
  runtime mode cannot execute or has not scientifically qualified.

This note defines the canonical equilibrium problem, algorithm families,
observable semantics, legality rules, stop criteria, authoring contract, and
validation gates. A backend or UI implementation that disagrees with this note
is incorrect even if an existing regression test accepts it.

## 2. Physical model

(governing-equations)=
### 2.1 Equilibrium problem

For a magnetization direction field

\[
\mathbf m : \Omega_m \rightarrow \mathbb S^2,
\qquad |\mathbf m|=1,
\]

and a conservative micromagnetic energy

\[
E[\mathbf m]
=E_{\mathrm{ex}}+E_{\mathrm{demag}}+E_{\mathrm{Z}}
 +E_{\mathrm{ani}}+E_{\mathrm{DMI}}+E_{\mathrm{me}}+\cdots,
\]

the effective field is

\[
\mathbf H_{\mathrm{eff}}
=-\frac{1}{\mu_0 M_s}\frac{\delta E}{\delta \mathbf m}.
\]

A constrained stationary state satisfies

\[
\mathbf P_{\mathbf m}\mathbf H_{\mathrm{eff}}=0,
\qquad
\mathbf P_{\mathbf m}=\mathbf I-\mathbf m\mathbf m^{\mathsf T},
\]

or equivalently

\[
\mathbf m\times\mathbf H_{\mathrm{eff}}=0.
\]

This is a stationarity condition, not proof of a global minimum. Relaxation
can converge to a local minimum, saddle, or numerically stationary state.
Energy descent, Hessian information, perturbation tests, and problem-specific
validation distinguish those cases where required.

### 2.2 Canonical torque residual

The canonical equilibrium residual is

\[
T_{\max}^{A/m}
=\max_{i\in\Omega_m}
\left|\mathbf m_i\times\mathbf H_{\mathrm{eff},i}\right|.
\]

Its public scalar name is `max_torque_Apm` and its unit is `A/m`. The auxiliary
magnetic-induction representation is

\[
T_{\max}^{T}=\mu_0 T_{\max}^{A/m},
\]

published as `max_torque_T`. The two values describe the same field residual.
Neither is mechanical torque in `N m`.

The canonical value is computed directly from the accepted magnetization and
fresh accepted-state effective field. It is never reconstructed from
`max_dm_dt` for convergence. Exact zero is a valid residual. Missing data needs
an explicit availability state; NaN, infinity, a stale field, or an unavailable
reduction is a backend error.

The dynamic quantity

\[
R_{\max}=\max_i|\dot{\mathbf m}_i|
\]

has unit `1/s` and is a separate observable named `max_rhs_norm_per_s`. It may
include precession, damping, direct torques, and other dynamic sources. It must
not be labeled `max_torque_Apm`.

For diagnostic-only legacy conversion and uniform scalar `alpha`, the
field-only Gilbert-explicit LLG relation is

\[
T_{\max}^{A/m}
=\frac{\sqrt{1+\alpha^2}}{\gamma}R_{\max}
\]

when precession and damping are both enabled, and

\[
T_{\max}^{A/m}
=\frac{1+\alpha^2}{\gamma\alpha}R_{\max}
\]

for pure damping. These identities are invalid with spatially varying
coefficients or added direct torques and are never a stop-path fallback.

### 2.3 Algorithm families

#### 2.3.1 Damping-only LLG relaxation

`llg_overdamped` solves

\[
\dot{\mathbf m}
=-\frac{\gamma\alpha}{1+\alpha^2}
\mathbf m\times(\mathbf m\times\mathbf H_{\mathrm{eff}}),
\]

with precession disabled. It is a relaxation evolution with a stage-local
time coordinate measured in seconds. Because precession is removed and the
stage may override damping, the trajectory is not a physical switching-time
prediction. The stage-local relaxation clock does not advance the physical
timeline consumed by subsequent `TimeEvolution` stages.

Only this algorithm owns:

- an explicit RK integrator;
- fixed or adaptive time-step controls;
- relaxation damping override;
- `max_relaxation_time_s`.

Every advertised integrator must execute its documented tableau. Routing an
RK4, RK23, RK45, or ABM3 request through Heun is a correctness defect.

#### 2.3.2 Projected-gradient BB

Define the tangent field gradient

\[
\mathbf g_i=-\mathbf P_{\mathbf m_i}\mathbf H_{\mathrm{eff},i},
\qquad [\mathbf g]=A/m.
\]

The update is

\[
\mathbf m_{k+1}
=\mathcal R_{\mathbf m_k}(-\lambda_k\mathbf g_k),
\qquad [\lambda]=m/A,
\]

where `R` is a norm-preserving nodal retraction. BB products, curvature
guards, descent checks, and line search use the same physical discrete energy
metric. For nodal weights `V_i`,

\[
\langle\mathbf a,\mathbf b\rangle_E
=\mu_0\sum_i M_{s,i}V_i\,\mathbf a_i\cdot\mathbf b_i.
\]

The BB secant is defined in the accepted tangent space rather than by
subtracting ambient vectors from consecutive nodal spheres. With the
normalization retraction, the canonical transport is

\[
P_{\mathbf m_k}\mathbf v=
\mathbf v-(\mathbf m_k\cdot\mathbf v)\mathbf m_k,
\qquad
\widetilde{\mathbf s}_k=P_{\mathbf m_k}(\mathbf m_k-\mathbf m_{k-1}),
\qquad
\widetilde{\mathbf y}_k=\mathbf g_k-P_{\mathbf m_k}\mathbf g_{k-1}.
\]

BB1 and BB2 use `s_tilde` and `y_tilde` in the energy metric. This transport
does not change the public algorithm name, accepted-state retraction, or the
`m/A` step unit.

The Armijo slope

\[
\phi'(0)=\langle\mathbf g,\mathbf p\rangle_E
\]

has units `J A/m`, so `lambda * phi'(0)` is in joules. A line search that
compares joules with an unweighted vector dot product is dimensionally invalid.

For FEM direct minimizers, sufficient decrease is evaluated from a direct
energy increment, not from subtraction of independently published endpoint
totals:

\[
\Delta E=E(m_1)-E(m_0)
\le c_1\lambda\langle g,p\rangle_E.
\]

Every interaction contributes its local difference before reduction. For the
linear Poisson demag operator,

\[
\Delta E_d=-\frac{\mu_0}{2}\sum_iM_{s,i}V_i(m_{1,i}-m_{0,i})\cdot
(H_{d,0,i}+H_{d,1,i}),
\]

with the Robin boundary condition already represented by both endpoint fields;
no separate boundary-form increment is added. This keeps
the Armijo condition in joules while avoiding cancellation against a large
constant energy offset. If the resulting numerical interval overlaps the
threshold, a bounded internal fresh-solve refinement may resolve the decision;
both ordinary and refined values must satisfy strict Armijo. An unresolved
interval is a rejected trial, never an accepted energy increase or convergence
claim.

#### 2.3.3 Nonlinear conjugate gradient

`nonlinear_cg` uses the same tangent gradient, physical energy metric,
retraction, and Armijo rule as PG-BB. Its beta formula and restart/descent
guards use physically consistent weighted products. Any preconditioner is an
approximation of the constrained energy Hessian and must be symmetric positive
definite on the active tangent space for the path that claims a descent
direction.

For FEM exchange, combining the `Ms`-weighted mass form with the raw exchange
stiffness requires the exchange field scale. A mass-plus-exchange operator has
the form

\[
M_{M_s}+\lambda\frac{2}{\mu_0}K_A,
\]

not `M_Ms + lambda K_A`. Local field-curvature blocks use the same
`Ms`-weighted mass convention.

#### 2.3.4 Tangent-plane implicit development method

The current `tangent_plane_implicit` implementation is a tangent-space
implicit energy-descent step with retraction and Armijo acceptance. It is not
the standard time-marching tangent-plane LLG scheme from the numerical
analysis literature. The public name remains available only as a migration
identifier while the implementation is a development capability.

It is not production-qualified until all of the following hold:

1. assembled and matrix-free operator terms share one derived energy-Hessian
   metric and SI scale;
2. exchange includes `2/mu0` relative to the `Ms` mass form;
3. anisotropy, Zeeman, DMI, demag, and magnetoelastic curvature actions have
   manufactured operator-action and finite-difference checks;
4. heterogeneous `Ms`, per-node axes, nonmagnetic masks, and shared-domain
   weights are covered;
5. solver residual, descent, retraction, energy, and final torque gates pass;
6. the capability matrix describes CPU development availability without
   implying GPU or production qualification.

Until those gates pass, strict production planning rejects TPI. Extended
development mode may resolve it only to the native CPU/MFEM lane with an
explicit warning and requested/resolved provenance. Forced GPU rejects it.

### 2.4 Conservative and nonconservative legality

`Relaxation` solves a conservative equilibrium problem. It rejects:

- Zhang--Li spin-transfer torque;
- Slonczewski spin-transfer torque;
- spin--orbit torque;
- stochastic thermal fields;
- time-dependent external fields or time-dependent material coefficients;
- any interaction present in `H_eff` without the matching energy used by the
  direct-minimizer line search.

The rejection applies to all relaxation algorithms, including overdamped LLG.
A damping-only trajectory with direct torque is a driven steady-state solve,
not conservative relaxation, and its stationarity residual is the full RHS.
A future `DrivenSteadyState` workflow will own that contract.

A static Oersted field is conservative with respect to magnetization and may be
used only when the identical realized field contributes to both `H_eff` and
the Zeeman energy for every trial state. Until field-energy parity is proven
for a lane, that lane rejects Oersted during relaxation.

(symbols-and-si-units)=
### 2.5 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `m` | unit magnetization direction | `1` |
| `Ms` | saturation magnetization | `A/m` |
| `H_eff` | conservative effective field | `A/m` |
| `mu0` | vacuum permeability | `N/A^2` |
| `gamma` | gyromagnetic ratio used with `H` | `m/(A s)` |
| `alpha` | Gilbert damping | `1` |
| `E` | total conservative energy | $\mathrm{J}$ |
| `g` | tangent field gradient | `A/m` |
| `p` | direct-minimizer search direction | `A/m` |
| `lambda` ($\lambda$) | direct-minimizer line-search step | $\mathrm{m\,A^{-1}}$ |
| `V_i` | nodal/cell integration weight | `m^3` |
| `max_torque_Apm` | maximum field equilibrium residual | `A/m` |
| `max_torque_T` | `mu0` times field residual | `T` |
| `max_rhs_norm_per_s` | maximum total dynamic RHS norm | `1/s` |
| `relaxation_time_s` | LLG-relaxation stage-local clock | `s` |
| `epsilon_E_single` ($\varepsilon_{E,\mathrm{single}}$) | FP32 CUDA absolute energy roundoff budget | $\mathrm{J}$ |
| `epsilon_f32` ($\varepsilon_{\mathrm{f32}}$) | float32 machine epsilon | $1$ |
| `E_trial` ($E_{\mathrm{trial}}$) | candidate trial energy in line search | $\mathrm{J}$ |
| `E_previous` ($E_{\mathrm{previous}}$) | last accepted energy | $\mathrm{J}$ |
| `c_1` ($c_1$) | Armijo coefficient | $1$ |
| `phi_prime` ($\phi'(0)$) | physical-metric directional energy derivative | $\mathrm{J\,A\,m^{-1}}$ |

(assumptions-and-validity)=
### 2.6 Assumptions and validity limits

- Magnetization is normalized at every accepted active magnetic degree of
  freedom.
- Torque convergence requires a fresh accepted-state `H_eff` containing every
  conservative interaction selected by the problem.
- Direct minimizers require a deterministic energy and fresh trial energy.
- Demag reuse may accelerate internal evaluations only when the approximation
  is documented and the convergence decision forces a fresh exact refresh.
- `max_torque_Apm` is a maximum norm, not an average and not a mesh-integrated
  quantity.
- A torque threshold is mesh-comparable only when the discretization resolves
  the physical state; it is not a substitute for mesh-convergence analysis.
- Single precision needs algorithm- and workload-specific qualification. It
  must not silently reuse double-precision thresholds when roundoff dominates.

(discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM

For cells `i`, `V_i` is the magnetic cell volume and material coefficients are
sampled at the cell. CPU and CUDA use the same equations and weights.

- Native CUDA step telemetry publishes its exact `max_torque_Apm`; the runner
  must not overwrite it with an RHS-derived approximation.
- PG-BB and NCG CPU/CUDA use `mu0 Ms_i V_i` in Armijo, BB, and CG products.
- Multilayer LLG executes the requested supported tableau. If a lane implements
  only Heun, its capability advertises only Heun and rejects other requests.
- Every direct minimizer refreshes all conservative fields and energies for
  every trial entering line search.

#### 3.1.1 FP32 CUDA Armijo resolution

The CUDA FDM single-precision lane stores the magnetization and interaction
fields as `float`, while its scalar energy reduction is exported as joules in
`double`. Near an equilibrium, the physically expected decrease can therefore
be smaller than the energy resolution induced by the FP32 state. Treating that
roundoff as a backend failure would make a legal `execution_precision="single"`
run stop before the torque criterion is reached.

For a CUDA single-precision trial, the direct PG-BB line search uses the
absolute energy budget

```{math}
:label: fdm-cuda-fp32-armijo-budget

\\varepsilon_{E,\\mathrm{single}}(E)
 = 8\\,\\varepsilon_{\\mathrm{f32}}\\,\\max(|E|,0),
\\qquad
\\varepsilon_{\\mathrm{f32}}=2^{-23},
```

and accepts a finite trial only when

```{math}
:label: fdm-cuda-fp32-armijo-acceptance

E_{\\mathrm{trial}}
 \\le E_{\\mathrm{previous}}
 + c_1\\lambda\\,\\phi'(0)
 + \\varepsilon_{E,\\mathrm{single}}(E_{\\mathrm{previous}}).
```

The budget has unit `J`, is applied only to the internal trial decision, and
does not modify the reported energy, torque, or stop threshold. CUDA double and
the CPU reference keep the strict budget `\\varepsilon_E=0`. The policy is a
roundoff guard, not an energy-increase allowance for a macroscopic change: the
budget remains bounded by the current FP32 energy scale, and the accepted state
must still pass the canonical fresh torque criterion. No CPU fallback is
performed; provenance continues to identify the CUDA device and requested
precision.

### 3.2 FEM

FEM uses the realized magnetic-domain integration weights and material fields.
CPU/MFEM and GPU/CUDA share the physical contract but own separate runtime
realizations.

- Energy directional derivatives use the realized `mu0 Ms_i V_i` metric.
- Every demag energy compared by a direct-minimizer line search is evaluated
  from the same deterministic zero initial Poisson iterate. Rejected trials
  must not contaminate the accepted-state energy through solver warm starts.
- FEM PG-BB, NCG, and development-only TPI with demag require a qualified linear-solver
  relative tolerance no looser than `1e-12` in double precision. A missing policy
  resolves to `1e-12`; an explicitly looser policy is rejected before runtime.
  This algorithm-specific requirement does not change the `1e-8` default used
  by LLG dynamics.
- FEM PG-BB with demag is production-qualified through direct polarized
  Armijo increments on CPU/MFEM and GPU/CUDA; no fallback is used.
- PG-BB/NCG preconditioners and TPI operators use dimensionally compatible mass,
  stiffness, and local-curvature blocks.
- Native nonfinite torque, energy, gradient, error estimate, or solver residual
  is an error, never zero or successful convergence.
- GPU PG-BB/NCG provenance names the CUDA implementation, not MFEM.
- TPI is CPU/MFEM development-only until the gates in section 2.3.4 pass.

The subsystem boundaries remain:

- interactions own field/energy/operator actions;
- relaxation modules own optimizer state and line search;
- explicit RK modules own LLG time integration;
- runtime owns accepted-state lifecycle and native stage completion;
- Rust owns planning, ABI orchestration, artifacts, and public provenance.

No new relaxation physics belongs in a monolithic bridge or cross-cutting
`Context` helper.

### 3.3 Hybrid

Hybrid relaxation is unsupported. `backend=hybrid` rejects rather than
splitting one equilibrium solve across unqualified FDM/FEM or CPU/GPU methods.

### 3.4 Stop semantics

Canonical convergence criteria are:

- torque: `max_torque_Apm <= torque_tolerance_apm`;
- energy plateau: range `max(E)-min(E)` over the last 50 accepted states is at
  most `energy_tolerance_j`; a plateau is a controller signal and never proves
  equilibrium by itself;
- `converged=true` requires a configured, finite torque tolerance and at least
  three consecutive fresh accepted-state torque samples at or below it;
- when energy tolerance is configured, its plateau condition must also hold,
  but it cannot replace the torque condition;
- a candidate LLG relaxation step whose fresh total energy exceeds the last
  accepted energy by more than the configured absolute-plus-relative numerical
  budget is rejected and rolled back before it can affect completion metrics;
- an energy plateau above the torque threshold tightens adaptive error control
  or the fixed time step by `sqrt(2)` down to its configured floor; it does not
  terminate the stage;
- a complete plateau window above the torque threshold after the controller has
  reached its floor terminates as `numerical_stagnation`, with
  `converged=false`;
- `max_steps` is a terminal budget, not proof of convergence;
- `max_relaxation_time_s` is valid only for `llg_overdamped`;
- direct minimizers have no seconds-valued time budget.

Direct-minimizer line-search step sums are not time and are not exposed as
`pseudo_time_s`. Algorithm diagnostics may publish `accepted_step_m_per_A`,
`line_search_backtracks`, `rhs_evaluations`, and `accepted_steps` with explicit
units.

Every terminal stage has exactly one typed stop reason. `torque` is the only
equilibrium convergence reason. `energy` is retained only as a compatibility
decode value for historical artifacts and must not be emitted for new runs.
`gradient` is converged only when the canonical torque criterion also passes;
otherwise a degenerate direction is `numerical_stagnation`. Budgets,
cancellation, unsupported paths, and backend failures never set
`converged=true`.

Completion is emitted from the state that owned the stop decision. It is not
reconstructed from sparsely sampled output rows.

### 3.5 Same-tolerance CPU/GPU equilibrium parity

Execution coverage and equilibrium parity are separate claims. A fixed-budget
CPU/GPU pair may have different trajectories and accepted-step counts. Step
counts are reported as diagnostics and are not required to be equal. A pair is
eligible for parity only when both rows use the same typed solver-mesh
signature and each row has `converged=true`, `stop_reason="torque"`, the same
finite `resolved_torque_tolerance_apm`, a final torque at or below that target,
native `time_to_tolerance_seconds`, accepted-step and demagnetization-solve
counts, all final energy components, a finite `norm_defect <= 1e-9`, and
captured `m_final.json` evidence with its canonical content identity.

The machine-readable comparison is
`fullmag.fem.relaxation_equilibrium_parity.v1`. Its initial FP64 envelope is
energy `rtol=1e-6`, `atol=1e-30 J`, maximum magnetization component difference
`<=1e-9`, and norm defect `<=1e-9`. The report additionally records RMS
component difference, p99 vector difference, mean-vector difference, and each
energy-component difference. A solver-mesh mismatch, missing final field,
`max_steps`/timeout/backend failure, nonconverged row, or final torque above
the resolved threshold is a hard failure; it is never downgraded to
`coverage_only`.

`time_to_tolerance_seconds` starts after backend creation enters stage
execution and stops at the first accepted state satisfying the torque
criterion. It is the sum of native accepted-step diagnostics and excludes
Python orchestration, scalar/table serialization, artifact-writer field
copies, and report generation. Missing native timing is missing measurement,
not a substitution with subprocess wall time. Qualification uses one warmup
and five measured repeats per backend/fixture/algorithm; p50, p95, and
standard deviation are retained for time, accepted steps, and demagnetization
solve count.

Parity status is one of `not_requested`, `not_qualified`, `checked`, or
`failed`. `checked` is emitted only after the final-state comparator runs. No
speedup or production-physics claim may consume a `coverage_only`, `max_steps`,
timeout, or otherwise incomplete row.

## 4. API, IR, planner, runtime, and workspace impact

(python-api)=
### 4.1 Python API surface

The default public torque threshold is `tolT=1e-6`, expressed in tesla to
match the `Max Torque` observable. `tolA` is the explicit alternative in
amperes per metre. Exactly one of `tolT` and `tolA` may be supplied; omitting
both selects `tolT=1e-6`. The public lowering is

```{math}
:label: relax-tolerance-unit-lowering

H_{\mathrm{tol}} = \frac{B_{\mathrm{tol}}}{\mu_0},
\qquad
B_{\mathrm{tol}} = \mu_0 H_{\mathrm{tol}},
\qquad
\mu_0 = 4\pi\times10^{-7}\ \mathrm{T\,m\,A^{-1}}.
```

Thus `tolT=1e-6` lowers to
`torque_tolerance_apm=0.7957747154594767`. `tol` is not a compatibility
alias: it is rejected with a migration error requiring `tolT` or `tolA`.
The canonical stop criterion remains A/m-valued because the runtime consumes
`torque_tolerance_apm`.

Canonical low-level authoring remains:

```python
fm.Relaxation(
    algorithm="llg_overdamped",
    dynamics=fm.LLG(
        integrator="rk23",
        adaptive_timestep=fm.AdaptiveTimeStep(...),
    ),
    stop=fm.RelaxStop(
        torque_tolerance_apm=1e-4,
        energy_tolerance_j=None,
        max_steps=50_000,
        max_relaxation_time_s=None,
    ),
)
```

The parity benchmark is authored through the same stage-first public surface:

```python
# %%
import fullmag as fm

# %%
study = fm.study("equilibrium_parity")
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=50_000,
    tolA=8_000.0,
)
```

For `projected_gradient_bb`, `nonlinear_cg`, and development-only
`tangent_plane_implicit`, `dynamics` must be `None`; integrator, fixed/adaptive
step, damping override, and relaxation-time parameters are rejected.

The canonical torque default is set from a versioned CPU/GPU/demag calibration
matrix and must not be changed from a single workload. The resolved numerical
controller policy is versioned runtime policy, not a physical `RelaxStop`
surface: three consecutive torque samples, a calibrated absolute-plus-relative
energy-increase budget, tightening by `1/sqrt(2)`, and an explicit controller
floor. Requested physical criteria and the resolved controller policy are both
recorded in provenance. Validation rejects NaN and infinity as well as values
outside their documented domains. An explicit `None` survives every facade and
disables an optional diagnostic criterion; the mandatory convergence torque
criterion cannot be disabled for a run that claims equilibrium.

Adaptive timestep authoring is also part of the canonical contract. The
`AdaptiveTimestep` constructor records whether `dt_min` was explicitly
authored; an omitted value is therefore distinguishable from an explicit
minimum and cannot silently satisfy the advanced-controller requirement.
`run_while(..., relax=...)` forwards only optional relaxation controls that the
caller actually supplied, while preserving authored `dt_min` and `dt_max`.
This keeps Python-to-ProblemIR round trips lossless and prevents an internal
unset sentinel from leaking into a backend relaxation call.

Migration:

- `torque_tolerance` remains a deprecated alias for
  `torque_tolerance_apm` with identical A/m semantics;
- public `relax`, `minimize`, and staged relaxation methods accept `tolT` or
  `tolA` and reject `tol` as well as simultaneous unit parameters;
- `max_physical_time_s` and `max_pseudotime_s` are deprecated aliases for
  `max_relaxation_time_s` only on `llg_overdamped`;
- either legacy time field on a direct minimizer is an error;
- conflicting canonical and legacy fields are an error.

(problem-ir)=
### 4.2 ProblemIR representation

`StudyIR::Relaxation` contains:

- `algorithm: RelaxationAlgorithmIR`;
- `dynamics: Option<DynamicsIR>`;
- `stop: RelaxStopIR` with canonical fields;
- `sampling: SamplingIR`.

Validation requires `Some(LLG)` exactly for `llg_overdamped` and `None` for
direct minimizers. The planner never manufactures an integrator for a direct
minimizer. Requested aliases are normalized before canonical IR serialization;
canonical exports do not re-emit deprecated names.

### 4.3 Planner and capability matrix

The planner rejects illegal interactions before backend selection and reports
the physical reason. Capability decisions are explicit for discretization,
device, precision, execution mode, and algorithm.

- FDM: LLG, PG-BB, NCG where the selected lane is qualified; no TPI.
- FEM CPU: production LLG/PG-BB/NCG; TPI only in explicit extended development
  mode until qualification.
- FEM GPU: production LLG/PG-BB/NCG where qualified; forced TPI unsupported.
- Automatic TPI may fall back to CPU only in extended development mode and
  must record the fallback reason.
- Strict mode never hides a fallback or development capability.

Runtime capability resources expose supported algorithms, supported LLG
integrators, qualification state, and rejection/fallback diagnostics so Python
and UI use the same vocabulary.

(round-trip-and-failure-semantics)=
### 4.4 Runtime, completion, artifacts, and provenance

The requested intent is preserved separately from the resolved execution;
validation errors and unsupported combinations are returned before runtime
selection and are never silently rewritten into a different backend.

Runtime records:

- requested and resolved algorithm;
- requested and resolved discretization/device/precision/mode;
- exact implementation realization;
- integrator and time-step policy only for LLG;
- gradient metric, line-search policy, and preconditioner policy only for the
  relevant minimizer;
- for native FEM direct minimizers, the requested and resolved direction
  policy, linear solver, preconditioner, and the names of any environment
  overrides that affected policy resolution;
- fresh final torque, energy plateau, step count, and typed stop reason;
- requested and resolved convergence-controller policy, consecutive-torque
  count, rejected energy-increase trials, tightening count, and controller
  floor state;
- `converged` independently from terminal `status`;
- degraded/development/fallback reason;
- completion in generic FDM and FEM metadata artifacts.

`BackendError`, nonfinite telemetry, line-search exhaustion, and solver failure
produce failed completion. They cannot be represented by
`status="completed"`.

### 4.5 OpenAPI and resources

OpenAPI uses typed relaxation algorithm, stop-reason, and metric-kind enums.
Stage metric resources include value, threshold, and unit. The canonical
metric kind serializes as `max_torque_apm`; scalar resource fields retain the
public quantity name `max_torque_Apm`.

The structured relax command exposes the complete canonical authoring
contract and rejects algorithm-inapplicable fields. Generated TypeScript is
regenerated from OpenAPI; generated files are never edited manually.

Solver status distinguishes:

- terminal state;
- equilibrium convergence;
- `max_torque_Apm` in A/m;
- `max_torque_T` in T;
- `max_rhs_norm_per_s` in `1/s`.

The legacy ambiguous `max_torque` field is deprecated and cannot carry
different units in different resources.

### 4.6 Unified workspace and Control Room

The Study inspector is a draft transaction over canonical scene data.

- Algorithm options are capability-gated for the requested backend/device/mode.
- LLG shows integrator, fixed/adaptive step, damping, field-refresh, and
  relaxation-time controls.
- Direct minimizers hide and remove those controls from the serialized draft.
- TPI is absent in strict mode and visibly marked development-only in eligible
  extended mode.
- Torque threshold and current value always display A/m and the auxiliary T
  conversion.
- Energy plateau, steps, algorithmic step, stop reason, convergence, terminal
  failure, and fallback state have distinct labels.
- Unsupported combinations are blocked before submission, not submitted with
  a warning.
- Canonical import/export round-trips `integrator`, fixed/adaptive step,
  `demag_interval_s`, algorithm, stop criteria, and explicit `None`.
- The nonexistent `euler` option is removed.

Defaults come from one shared canonical contract and are tested against Python
serialization. UI-local Tesla-derived or script-builder fallback defaults are
forbidden.

(implementation-mapping)=
## 5. Validation strategy
(validation)=

### 5.1 Analytical checks

1. Single-cell constant-field macrospin:
   - exact `|m cross H|`;
   - zero residual for parallel state;
   - pure-damping exponential/alignment behavior;
   - no physical timeline advancement after relaxation.
2. One-cell energy directional derivative for Zeeman and anisotropy.
3. Exchange manufactured modes for FDM and FEM.
4. FEM explicit-matrix oracle for
   `M_Ms + lambda (2/mu0) K_A` and every enabled TPI curvature block.
5. Retraction norm and tangent-direction checks.
6. Nonfinite metric/error injection must fail.

### 5.2 Cross-backend checks

- FDM CPU/CUDA PG-BB and NCG accepted-energy, torque, and final-state parity.
- FEM CPU/GPU PG-BB and NCG derivative, convergence, and provenance parity.
- Every supported LLG integrator gets an observed-order or exact one-step
  tableau check on each advertised lane.
- Heterogeneous `Ms`, mesh weights, masks, DMI, anisotropy, demag, and static
  Oersted field-energy parity use nontrivial fixtures.
- TPI has no CPU/GPU parity claim until a GPU implementation exists.

### 5.3 Contract and regression tests

- Python construction, finite validation, aliases, explicit `None`, canonical
  serialization, and script export/import.
- ProblemIR algorithm/dynamics invariants and migration deserialization.
- Planner legality for thermal, STT, SOT, time-dependent fields, Oersted
  parity, backend/device/mode, TPI, and multilayer integrators.
- Runtime exact-zero torque, nonfinite torque, stop ordering, sparse-output
  independence, cancellation, failure, and provenance.
- OpenAPI generation and generated TypeScript drift.
- Control Room defaults, conditional fields, capability gating, units,
  import/export, completion, and failure rendering.
- Browser smoke for the Study inspector transaction and submitted payload.

### 5.4 Managed runtime gates

FEM/MFEM/CUDA proof uses repository container recipes. The final qualification
set includes the matching current recipes for:

- native source and derivative contracts;
- managed runtime freshness/rebuild;
- relaxation runtime and convergence;
- CPU/GPU consistency;
- production interaction matrix;
- algorithm-specific TPI checks only after TPI is re-enabled.

Host builds are diagnostic only. FDM Rust/CUDA gates and frontend/Python gates
run through their repository-owned commands.

## 6. Completeness checklist

- [x] Python API and canonical defaults
- [x] ProblemIR algorithm/dynamics split and migration
- [x] Planner legality and capability matrix
- [x] FDM CPU exact torque and completion
- [x] FDM CUDA exact torque and physical direct minimizers
- [x] FDM multilayer integrator truthfulness
- [x] FEM CPU PG-BB/NCG operator and metric correctness
- [x] FEM GPU PG-BB/NCG metric and provenance correctness
- [x] FEM TPI disabled or fully qualified
- [x] Conservative/nonconservative legality
- [x] Runtime stop/completion ownership
- [x] OpenAPI and generated frontend types
- [x] Control Room inspector and round-trip
- [x] Artifacts and provenance
- [x] Analytical and cross-backend tests
- [x] Managed runtime verification
- [x] Canonical physics contract

(limitations)=
## 7. Known limits and deferred work

### 7.1 Default torque calibration status

The general FEM default torque tolerance remains unqualified.  It must not be
changed from its current compatibility value until
`calibrate-fem-relaxation-torque-default` completes a fail-closed matrix with
CPU and GPU, exchange-only and Poisson-demag cases, fixed and adaptive RK, and
at least two stable solver meshes at three step budgets.

The calibration harness writes raw CSV, a machine-readable summary, and a PNG
convergence plot under
`.fullmag/reports/fem-relaxation-torque-calibration`.  It rejects transient
floors, incomplete CPU/GPU pairs, missing demag coverage, and mesh-dependent
recommendations instead of emitting a default.

The current managed-runtime attempt is blocked before the first accepted LLG
step: native FEM remains in stage `build` for more than 360 seconds on a
1,395-node magnet-only mesh while one worker consumes a full CPU core.  The
same symptom occurs for a 1,200-node shared-domain mesh.  Separately, fresh SP4
meshing rejects degenerate thin-film tetrahedra after Delaunay and HXT and then
fails in the Frontal fallback.  These are initialization/meshing defects, not
evidence for any torque threshold.  No calibrated default may be published
from the current runs.

- `DrivenSteadyState` is a separate future physics/API design. This work only
  reserves the boundary and rejects driven terms from `Relaxation`.
- Hybrid relaxation remains unsupported.
- GPU TPI is not introduced by this work.
- Promotion of CPU TPI requires all section 2.3.4 gates; fixing one scale factor
  is insufficient.
- Global-minimum certification is outside the relaxation contract.
- Publication-scale standard problems remain required for backend qualification
  even after unit and contract tests pass.

(source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class AdaptiveTimestep` | Preserves whether `dt_min` was explicitly authored. |
| `packages/fullmag-py/src/fullmag/world.py` | `_relax_chunk_kwargs` | Forwards only authored optional relaxation controls during chunked execution. |
| `scripts/validate_fem_relaxation_equilibrium_parity.py` | `compare_equilibrium_states` | Compares converged CPU/GPU states without requiring equal step counts. |
| `scripts/analysis/fem_gpu_benchmark.py` | `equilibrium_parity_summary` | Produces the versioned parity summary from benchmark rows. |
| `examples/bench_fem_gpu_long.py` | `solver_time_to_tolerance_evidence` | Computes native accepted-step time to the first torque-qualified state. |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `fp32ArmijoBudget` / `direct_minimizer_energy_tolerance_j` | Resolves the bounded FP32 CUDA energy budget. |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `fp32ArmijoAcceptance` / `projected_gradient_armijo_accepts_with_tolerance` | Applies precision-aware Armijo acceptance. |
| `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs` | `cudaDirectMinimizer` / `execute_direct_minimizer` | Executes the CUDA FDM direct-minimizer loop. |
| `backends/fdm/gpu/cuda/runtime/telemetry.cu` | `nativeF32Energy` / `context_fill_current_stats` | Publishes FP32-state energy reductions as joules. |
| `crates/fullmag-runner/src/relaxation/direct_minimizer.rs` | `fp32ArmijoRegression` / `single_precision_armijo_uses_bounded_energy_roundoff_budget` | Guards single-vs-double acceptance semantics. |

(scientific-bibliography)=
## 8. References

1. W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
2. L. Exl et al., "LaBonte's method revisited: An effective steepest descent
   method for micromagnetic energy minimization," *J. Appl. Phys.* 115,
   17D118 (2014), arXiv:1309.5796.
3. L. Exl et al., "Preconditioned nonlinear conjugate gradient method for
   micromagnetic energy minimization," arXiv:1801.03690 (2018).
4. J. Kraus et al., "Iterative solution and preconditioning for the tangent
   plane scheme in computational micromagnetics," *J. Comput. Phys.* 398,
   108866 (2019), arXiv:1808.10281.
5. MuMax3 official API, `Relax()` and `Minimize()` semantics,
   https://mumax.github.io/api.html.
6. NIST OOMMF User's Guide, `Oxs_MinDriver` and `Oxs_TimeDriver` stopping
   semantics, https://math.nist.gov/oommf/doc/userguide12b2/userguide.pdf.
