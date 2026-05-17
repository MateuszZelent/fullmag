# Shared relaxation stop and field-refresh semantics

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-04-16
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/fullmag-application-architecture-v2.md`
- Related physics notes:
  - `docs/physics/0500-fdm-relaxation-algorithms.md`
  - `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`

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
| $t_{\mathrm{pseudo,max}}$ | pseudo-time budget used by relax scheduling | s |
| $t_{\mathrm{phys,max}}$ | physical-time budget for true time-based relax workflows | s |
| $\Delta t_{\mathrm{demag}}$ | maximum allowed interval between demag refreshes | s |

### 2.3 Assumptions and approximations

1. The stop contract is shared across FDM and FEM, even when one backend uses a
   more approximate internal torque estimator than another.
2. `demag_interval_s` is an execution-policy control, not a new physical
   observable.
3. Fullmag public and IR units remain SI-clean. Any ps display is UI-only.
4. If neither `max_pseudotime_s` nor `max_physical_time_s` is provided, the
   relax stage is not implicitly time-bounded. `max_steps` remains an iteration
   cap only and must not be converted into a synthetic pseudo-time budget.
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
- A backend may internally use native torque metrics, but the published metric
  name and threshold must match the shared contract.
- `llg_overdamped` remains the public meaning of “precession disabled during
  relaxation”; no backend-specific boolean alias is introduced.
- `gyromagnetic_ratio` used by the fallback torque reconstruction is the
  reduced `gamma_mu0` in `m/(A s)` (typical value `2.211e5`), not the electron
  gyromagnetic ratio in `rad/(T s)`.
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
- `RelaxStop(torque_tolerance_apm=..., energy_tolerance_j=..., max_steps=..., max_pseudotime_s=..., max_physical_time_s=...)`
- `Relaxation(stop=RelaxStop(...))`

Existing scalar relax arguments remain supported as compatibility aliases and
lower into `RelaxStop`.

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
- Absence of a time stop in `RelaxStop` must remain semantically unbounded
  across Python, CLI, planner, runner, and UI. No layer may silently inject a
  fallback like `dt_initial * max_steps`.
- Capability language remains shared; no UI-only relaxation semantics are
  permitted.
- The capability matrix must describe this as shared executable relaxation
  semantics for FDM/FEM, while any higher-level hysteresis authoring surface is
  documented separately from backend authority claims.

## 5. Runtime, session, and provenance impact

- Every relax stage must terminate with an explicit stop reason.
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
