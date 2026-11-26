---
title: Stopping Criteria
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: /physics/foundations/effective-field, /physics/foundations/micromagnetic-energy
---

(public-docs-numerical-methods-relaxation-stopping-criteria)=
# Relaxation stopping criteria and completion

(numerical-methods-relaxation-stopping-problem-statement)=
## Scope and purpose

This page defines the shared accepted-state completion contract for relaxation across all four
discretization/device lanes, separating mandatory torque convergence, optional energy plateau
confirmation, work/time budgets, strict GPU residency receipts, non-converged eigenmode handoff
certificates (`equilibrium_acceptance="force"`), and output cadence.

(numerical-methods-relaxation-stopping-governing-equations)=
## Scientific and numerical model

Relaxation completion is evaluated exclusively over committed accepted states after field refresh,
never merely because an iteration or time ceiling has expired. The primary residual is the maximum
effective-field torque:

```{math}
:label: eq-relax-stop-torque
\tau_{\max}^{(k)}
=\max_i\left\lVert\mathbf m_i^{(k)}\times\mathbf H_{\mathrm{eff},i}^{(k)}\right\rVert_2.
```

If an energy criterion is configured, the accepted energy sequence is checked over the fixed
implementation window $W_E = 50$ accepted samples:

```{math}
:label: eq-relax-stop-energy
\Delta E_{W_E}^{(k)}
=\max_{j\in W_E}E^{(k-j)}-\min_{j\in W_E}E^{(k-j)},
\qquad
\Delta E_{W_E}^{(k)}\leq\varepsilon_E.
```

The combined torque predicate (and, when configured, the 50-sample energy-window predicate) is
observed on fresh accepted states. `torque_confirmed` becomes true only after at least three
consecutive accepted samples satisfy the combined predicate; a failed sample resets the consecutive
counter to zero. Confirmation is independent of output cadence so sparse saving never alters
authoritative completion.

The logical completion rule is conjunction, not disjunction:

```{math}
:label: eq-relax-stop-completion
\mathrm{converged}
=\left(\tau_{\max}\leq\varepsilon_\tau\right)
\land\left(\varepsilon_E\ \mathrm{unset}\ \lor\Delta E_{W_E}\leq\varepsilon_E\right).
```

`max_steps` and `max_relaxation_time_s` are ceilings: exhausting either before the residual rule
holds records a budget-exhausted non-converged stage, never converged by budget alone.

(numerical-methods-relaxation-stopping-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m_i^{(k)}$ | accepted reduced magnetization at point $i$, iteration $k$ | $1$ |
| $\mathbf H_{\mathrm{eff},i}^{(k)}$ | effective field at point $i$ and iteration $k$ | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\max}^{(k)}$ | maximum accepted-state torque | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_\tau$ | torque threshold | $\mathrm{A\,m^{-1}}$ |
| $E^{(k)}$ | accepted total energy | $\mathrm{J}$ |
| $\Delta E_{W_E}^{(k)}$ | energy range in the completion window | $\mathrm{J}$ |
| $\varepsilon_E$ | optional energy threshold | $\mathrm{J}$ |
| $W_E$ | accepted-energy window ($50$ samples) | $1$ |
| $\mathrm{converged}$ | completion predicate | $1$ |
| $k$ | accepted iteration index | $1$ |
| $T_{\mathrm{relax}}$ | optional relaxation-coordinate ceiling | $\mathrm{s}$ |

`max_pseudotime_s` and `max_physical_time_s` are Python aliases for $T_{\mathrm{relax}}$; they must
agree when supplied together and are restricted to `llg_overdamped`. Direct minimizers report
`time=0`, `dt=0`, and `pseudo_time_s=null`.

(numerical-methods-relaxation-stopping-assumptions-and-validity)=
### Assumptions, eigenmode handoff, and strict residency receipts

- Torque is evaluated after committing the accepted state and refreshing $\mathbf H_{\mathrm{eff}}$.
- `tolT` converts to internal $\mathrm{A\,m^{-1}}$ via $\mu_0$ while retaining requested units in
  provenance.
- **Downstream eigenmode handoff (`equilibrium_acceptance`)**: By default, an eigenmode stage
  consuming a preceding relaxation stage requires `converged=true`. Explicitly authoring
  `study.stages.add_eigenmodes(..., equilibrium_acceptance="force")` permits linearizing around a
  non-converged relax state while attaching a mandatory torque certificate recording measured
  $\max\|\mathbf m_0 \times \mathbf H_{\mathrm{eff},0}\|$, `converged=false`, the true `stop_reason`,
  and `forced=true` (recomputed from certified fields during plan binding).
- **Strict GPU residency receipts**: Single-layer FDM CUDA `native_cuda_pgbb` and FEM GPU PGBB
  record device-residency telemetry (`hot_loop_full_vector_h2d/d2h = 0`, `fallback_count = 0`,
  `energy_minimizer_realization`) alongside completion metadata; see
  {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels`.

(numerical-methods-relaxation-stopping-discrete-realization)=
### Discrete realization

| Solver | Device | Status | Stop-metric realization |
|---|---|---|---|
| FDM | CPU | `implemented` | Cellwise maximum torque, 3-sample confirmation, and 50-sample accepted-energy window (`resolve_stage_completion`). |
| FDM | GPU | `implemented` | Device-resident torque/energy reductions (`native_cuda_pgbb` & CUDA LLG) feeding shared `resolve_stage_completion` with strict residency receipt. |
| FEM | CPU | `implemented` | Finite-element magnetic-node torque residual, direct-energy difference proof, and native stage completion. |
| FEM | GPU | `implemented` | Device-resident reductions and telemetry with reduced host syncs (`-2..-3/step` on PGBB) feeding shared completion semantics. |

For direct minimizers, `max_steps` counts accepted minimizer steps (rejected Armijo trials do not
advance it). For `llg_overdamped`, `max_steps` counts accepted integration steps. A failure or user
cancellation is mapped before any budget predicate so it is never reclassified as converged.

(numerical-methods-relaxation-stopping-implementation-mapping)=
### Implementation mapping

`RelaxStop` owns public validation and serialization; `_resolve_flat_relax_stop` normalizes
`tolT`/`tolA` and checks alias agreement. `crates/fullmag-runner/src/relaxation/convergence.rs`
owns `relaxation_converged`, `RelaxationEnergyPlateauWindow`, `RelaxationTorqueConfirmation`,
`llg_overdamped_uses_pure_damping`, and `resolve_stage_completion`.

(numerical-methods-relaxation-stopping-problem-ir)=
## Parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `fm.RelaxStop.torque_tolerance_apm` | `float \| None` | $0.7957747154594767$ | $\mathrm{A\,m^{-1}}$ | positive when set | primary torque threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |
| `fm.RelaxStop.energy_tolerance_j` | `float \| None` | `None` | $\mathrm{J}$ | positive when set | optional 50-sample accepted-energy range threshold | FDM/FEM lanes | `study.stop.energy_tolerance_j` |
| `fm.RelaxStop.max_steps` | `int \| None` | $50{,}000$ | $1$ | positive integer when set | accepted-step work budget | FDM/FEM lanes | `study.stop.max_steps` |
| `fm.RelaxStop.max_relaxation_time_s` | `float \| None` | `None` | $\mathrm{s}$ | positive when set; LLG only | relaxation-coordinate ceiling | `llg_overdamped` only | `study.stop.max_relaxation_time_s` |
| `fm.RelaxStop(max_pseudotime_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | alias; must agree with other time aliases; LLG only | same relaxation-coordinate ceiling | `llg_overdamped` only | `study.stop.max_relaxation_time_s` |
| `fm.RelaxStop(max_physical_time_s=...)` | `float \| None` | `None` | $\mathrm{s}$ | alias; must agree with other time aliases; LLG only | compatibility alias for relaxation coordinate | `llg_overdamped` only | `study.stop.max_relaxation_time_s` |
| `add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | exclusive with `tolA` | user-facing torque threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |
| `add_relax(tolA=...)` | `float` | canonical equivalent | $\mathrm{A\,m^{-1}}$ | exclusive with `tolT` | canonical field threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |

(numerical-methods-relaxation-stopping-python-api)=
## Python API

```python
# %% Configure explicit accepted-state completion criteria
import fullmag as fm

nm = 1.0e-9
study = fm.study("relaxation_stop_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)
study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    stop=fm.RelaxStop(
        torque_tolerance_apm=0.7957747154594767,
        energy_tolerance_j=1.0e-18,
        max_steps=50_000,
    ),
)
```

### `ProblemIR` excerpt

```json
{
  "stop": {
    "torque_tolerance_apm": 0.7957747154594767,
    "energy_tolerance_j": 1e-18,
    "max_steps": 50000
  }
}
```

## Control Room workflow

Use the stage editor to configure torque, optional energy, and work-budget fields, then inspect the
resolved completion reason (`torque`, `max_steps`, `max_physical_time`, `gradient`, `backend_error`,
`user_cancelled`) and provenance metrics.

(numerical-methods-relaxation-stopping-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Round-trip preservation**: Script export preserves grouped `RelaxStop` or equivalent scalar
  stage arguments while separating requested intent (`tolT` vs `tolA`) from resolved execution.
- **Validation errors and unsupported combinations**: Non-positive tolerances or ceilings,
  conflicting stop aliases, empty `RelaxStop`, legacy `tol`, or unsupported combinations such as
  relaxation-time limits attached to direct minimizers fail validation without weakening completion
  rules.
- **Authoritative completion reasons**: `torque` (at-least-three-sample confirmation plus optional
  energy plateau), `max_steps`, `max_physical_time`, `gradient` (stagnation), `backend_error`,
  `user_cancelled`, or unset while incomplete. Energy alone never produces convergence.

(numerical-methods-relaxation-stopping-validation)=
## Validation

Unit and runner tests verify `tolT` $\to$ $\mathrm{A\,m^{-1}}$ conversion, torque/energy
conjunction, rejection of budget-only completion, 3-sample confirmation, non-finite failure
rejection, `equilibrium_acceptance="force"` handoff certificates, and round-trip preservation.

(numerical-methods-relaxation-stopping-limitations)=
## Limitations

The stop contract certifies local stationarity within the discrete tolerance budget; it does not
prove global energy optimality, uniqueness of equilibrium, or cross-mesh trajectory identity.

(numerical-methods-relaxation-stopping-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.
- J. Nocedal and S. J. Wright, *Numerical Optimization*, 2nd ed., Springer, 2006, DOI: [10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).
- FullMag public physics contracts: {doc}`/physics/foundations/effective-field` and {doc}`/physics/foundations/micromagnetic-energy`.

(numerical-methods-relaxation-stopping-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Stop object validation and IR | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L831) | [`class RelaxStop`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L831) | canonical criterion validation and serialization | public API | Python contract tests |
| Flat stage stop normalization | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3321) | [`_resolve_flat_relax_stop`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3321) | `tolT`/`tolA` conversion and alias conflict handling | public API | stage tests |
| Accepted-state completion | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L63) | [`relaxation_converged`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L63) | torque/energy conjunction and budget semantics | FDM/FEM orchestration | Rust tests |
| Pure-damping mode selection | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L193) | [`llg_overdamped_uses_pure_damping`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L193) | distinguishes overdamped LLG from full dynamics | FDM/FEM orchestration | runner tests |
| Energy plateau window | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L18) | [`RelaxationEnergyPlateauWindow`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L18) | fixed 50-sample accepted-energy range | shared orchestration | runner tests |
| Torque confirmation | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L93) | [`RelaxationTorqueConfirmation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L93) | at least three consecutive accepted samples satisfying the combined predicate | shared orchestration | runner tests |
| Final reason mapping | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L235) | [`resolve_stage_completion`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L235) | maps torque, budgets, stagnation, and backend status | shared orchestration | runner tests |
