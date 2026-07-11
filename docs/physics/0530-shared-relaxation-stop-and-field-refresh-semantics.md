# Shared relaxation stop and field-refresh semantics

- Status: implemented backend-specific detail; canonical equilibrium contract in 0580
- Owners: Fullmag core
- Last updated: 2026-07-11
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/fullmag-application-architecture-v2.md`
- Related physics notes:
  - `docs/physics/0500-fdm-relaxation-algorithms.md`
  - `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
  - `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`

The cross-layer equilibrium, legality, observable, and completion contract is
canonical in `0580`. This note retains field-refresh and backend stop detail;
any conflicting historical pseudo-time or torque statement is superseded by
`0580`.

## 1. Problem statement

Fullmag needs one shared contract for two concerns that previously drifted
between backends and authoring surfaces:

1. how a relaxation stage decides that it is finished,
2. how often slowly varying expensive fields, especially demagnetizing field
   realizations, are refreshed relative to the integrator step.

The public model must stay physics-first:

- `dt` belongs to the integrator,
- demag refresh cadence belongs to a field-refresh policy,
- relaxation stopping belongs to an explicit stop contract,
- runtime/UI/provenance must record why a stage ended.

## 2. Physical model

### 2.1 Governing equations

Relaxation still targets the equilibrium condition

$$
\mathbf{m} \times \mathbf{H}_{\mathrm{eff}} = \mathbf{0},
$$

with $\lVert \mathbf{m} \rVert = 1$ pointwise.

The shared stop contract does not change the governing equations. It only makes
the execution control explicit.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\tau_{\max}$ | max torque residual $\max_i \lVert \mathbf{m}_i \times \mathbf{H}_{\mathrm{eff},i} \rVert$ | A/m |
| $\Delta E_{50}$ | total-energy range across the last 50 accepted relax steps, $\max(E)-\min(E)$ | J |
| $N_{\max}$ | hard iteration cap | 1 |
| $t_{\mathrm{relax,max}}$ | stage-local execution-time budget for `llg_overdamped` | s |
| $\Delta t_{\mathrm{demag}}$ | maximum allowed interval between demag refreshes | s |

### 2.3 Assumptions and approximations

1. The stop contract is shared across FDM and FEM. Every backend publishes the
   exact fresh accepted-state field residual; approximate torque reconstruction
   is not a convergence path.
2. `demag_interval_s` is an execution-policy control, not a new physical
   observable.
3. Fullmag public and IR units remain SI-clean. Any ps display is UI-only.
4. `max_relaxation_time_s` is valid only for `llg_overdamped`. Its clock is a
   stage-local execution coordinate and does not advance a later physical
   timeline. Direct minimizers (`projected_gradient_bb`, `nonlinear_cg`, and
   `tangent_plane_implicit`) own neither physical nor pseudo time. Their
   accepted line-search step has unit `m/A`; runtime reports zero stage time,
   no synthetic `dt`, and never converts `max_steps` into a time budget.
5. `energy_tolerance_j` is a stagnation / plateau criterion, not a proof of a
   zero-torque state. Backends that publish `reason=energy` must evaluate it over
   a fixed accepted-step window of 50 total-energy samples. A single small
   step-to-step energy delta is too noisy and must not by itself terminate
   relaxation.
6. The plateau metric is the unsigned range `max(E)-min(E)`, not a signed
   descent difference. This keeps the criterion valid when Zeeman or other
   terms make the physical total energy negative.

## 3. Numerical interpretation

### 3.1 FDM

- FDM keeps using the existing integrator `dt` or adaptive step proposal.
- `FieldRefreshPolicy.demag_interval_s` is interpreted as a separate upper
  bound on how stale the demag field may become relative to accepted solver
  time.
- `RelaxStop` is interpreted as the canonical stop configuration for
  `StudyIR::Relaxation`.

### 3.2 FEM

- FEM uses the same public `RelaxStop` and `FieldRefreshPolicy` contract.
- Native MFEM CPU/GPU implementations may evaluate exchange every RHS call while
  refreshing demag only when the refresh policy requires it.
- Native FEM must emit an explicit completion summary containing:
  - stage status,
  - stop reason,
  - metric name,
  - metric value,
  - threshold.

### 3.3 CPU/GPU/backend interpretation

- CPU and GPU backends must preserve the same stop reasons.
- Every backend computes `max_torque_Apm = max |m x H_eff|` in `A/m` directly
  from the fresh accepted state. Exact zero is valid. `max_torque_T = mu0 *
  max_torque_Apm` is the same residual in `T`; neither value is mechanical
  torque. `max_rhs_norm_per_s = max |dm/dt|` is separate and has unit `1/s`.
- `llg_overdamped` remains the public meaning of “precession disabled during
  relaxation”; no backend-specific boolean alias is introduced.
- The native energy stop metric is `total_energy_plateau_range_J`, computed as
  `max(E)-min(E)` over the last 50 accepted relax steps. If a torque tolerance is
  configured, the energy plateau only completes the stage when torque is also
  below its threshold. This follows the same engineering lesson as MuMax and
  Boris-style relax flows: energy is useful for detecting no further descent,
  while torque-like residuals remain the physically meaningful equilibrium
  signal when requested.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Add:

- `FieldRefreshPolicy(demag_interval_s=...)`
- `LLG(field_refresh=FieldRefreshPolicy(...))`
- `RelaxStop(torque_tolerance_apm=..., energy_tolerance_j=..., max_steps=..., max_relaxation_time_s=...)`
- `Relaxation(stop=RelaxStop(...))`

Existing scalar relax arguments remain supported as compatibility aliases and
lower into `RelaxStop`. Canonical defaults are `1e-4 A/m` and `50000` steps.
The relaxation-time member is legal only with `llg_overdamped`.

### 4.2 ProblemIR representation

Add canonical records:

- `FieldRefreshPolicyIR`
- `RelaxStopIR`
- `StageStopReason`
- `StageCompletionIR`

`StudyIR::Relaxation` carries one explicit stop record rather than ad hoc
scalar fields spread across layers.

### 4.3 Planner and capability-matrix impact

- Planner materialization must preserve `field_refresh` and `stop` into
  backend plans.
- Absence of a time stop in `RelaxStop` remains semantically unbounded across
  Python, CLI, planner, runner, and UI. No layer injects `dt_initial * max_steps`.
- Planner rejects `max_relaxation_time_s` and every `dynamics` payload for
  direct minimizers. Only `llg_overdamped` owns those controls.
- Strict mode and forced GPU reject `tangent_plane_implicit`; extended mode may
  resolve it only to the CPU/MFEM development lane with visible provenance.
- Capability language remains shared; no UI-only relaxation semantics are
  permitted.
- The capability matrix must describe this as shared executable relaxation
  semantics for FDM/FEM, while any higher-level hysteresis authoring surface is
  documented separately from backend authority claims.

## 5. Runtime, session, and provenance impact

- Every relax stage terminates with authoritative execution-owned `status`,
  `converged`, `reason`, metric kind/value/unit, threshold, step count, and
  optional algorithm-specific diagnostics. Reaching an iteration/time budget
  is completed but not converged; numerical stagnation is failed and not
  converged. Sampled artifacts never infer terminal state.
- Session/live state carries structured per-stage completion metadata.
- Control-room logs must expose both requested execution intent and resolved
  refresh policy.

## 6. Validation strategy

### 6.1 Analytical checks

- validate SI units and positivity of all stop / refresh controls,
- validate that `dt` and `demag_interval_s` remain independent parameters.

### 6.2 Cross-backend checks

- FDM/FEM relax runs should agree on the reported stop reason for equivalent
  stop budgets and convergence outcomes within discretization tolerance.

### 6.3 Regression tests

- Python → IR round-trip for `LLG(field_refresh=...)` and `Relaxation(stop=...)`,
- runner/native FEM tests for torque stop, 50-step energy plateau stop,
  max-step stop, and demag cadence,
- API/UI tests for structured stage completion state,
- STNO vortex acceptance with explicit relax completion metadata.

## 7. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 8. Known limits and deferred work

- This slice does not introduce a Tetmag backend.
- It does not yet claim matrix-free eigensolve/operator-cache work.
- Hysteresis authoring can land semantically ahead of full backend-native loop
  execution, but it must still lower through the canonical stage contract.
