---
title: Stopping Criteria
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-relaxation-stopping-criteria)=
# Relaxation stopping criteria and completion

(numerical-methods-relaxation-stopping-problem-statement)=
## Completion problem

Relaxation completion is a contract over the accepted state, not a label attached after an iteration
budget expires. The canonical policy combines a torque residual with optional energy and time/step
budgets. A budget limits work; it does not by itself prove equilibrium.

(numerical-methods-relaxation-stopping-governing-equations)=
## Governing equations

The primary residual is the maximum effective-field torque:

```{math}
:label: eq-relax-stop-torque
\tau_{\max}^{(k)}
=\max_i\left\lVert\mathbf m_i^{(k)}\times\mathbf H_{\mathrm{eff},i}^{(k)}\right\rVert_2.
```

If an energy criterion is configured, the accepted energy sequence is checked over the implementation
window $W_E$:

```{math}
:label: eq-relax-stop-energy
\Delta E_{W_E}^{(k)}
=\max_{j\in W_E}E^{(k-j)}-\min_{j\in W_E}E^{(k-j)},
\qquad
\Delta E_{W_E}^{(k)}\leq\varepsilon_E.
```

The logical completion rule is conjunction, not disjunction:

```{math}
:label: eq-relax-stop-completion
\mathrm{converged}
=\left(\tau_{\max}\leq\varepsilon_\tau\right)
\land\left(\varepsilon_E\ \mathrm{unset}\ \lor\Delta E_{W_E}\leq\varepsilon_E\right).
```

`max_steps` and `max_relaxation_time_s` are ceilings. If a ceiling is reached before the residual
rule is true, the result is budget-exhausted or non-converged, never converged by budget alone.

(numerical-methods-relaxation-stopping-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m_i^{(k)}$ | accepted reduced magnetization at point $i$, iteration $k$ | $1$ |
| $\mathbf H_{\mathrm{eff},i}^{(k)}$ | effective field at point $i$ and iteration $k$ | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\max}^{(k)}$ | maximum accepted-state torque | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_\tau$ | torque threshold | $\mathrm{A\,m^{-1}}$ |
| $E^{(k)}$ | accepted total energy | $\mathrm{J}$ |
| $\Delta E_{W_E}^{(k)}$ | energy range in the completion window | $\mathrm{J}$ |
| $\varepsilon_E$ | optional energy threshold | $\mathrm{J}$ |
| $W_E$ | accepted-energy window | $1$ |
| $\mathrm{converged}$ | completion predicate | $1$ |
| $k$ | accepted iteration index | $1$ |
| $T_{\mathrm{relax}}$ | optional relaxation-coordinate ceiling | $\mathrm{s}$ |

(numerical-methods-relaxation-stopping-assumptions-and-validity)=
## Assumptions and validity

- The torque is evaluated after the accepted state has been committed and after the effective field
  has been refreshed according to the selected field-refresh policy.
- The field residual is in A/m internally. A `tolT` request is converted through $\mu_0$ and the
  requested unit is retained in provenance.
- `energy_tolerance` is an optional secondary condition. Setting it does not remove the torque
  requirement.
- `max_steps` is an integer work budget. `max_relaxation_time_s` is meaningful only for
  `llg_overdamped`; direct minimizers have no time coordinate.
- A failed field solve, invalid state, failed line search, or non-finite metric is a failure and
  cannot satisfy the stop contract.

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
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    stop=fm.RelaxStop(
        torque_tolerance_apm=0.7957747154594767,
        energy_tolerance_j=1.0e-18,
        max_steps=50_000,
    ),
)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `fm.RelaxStop.torque_tolerance_apm` | `float \| None` | $0.7957747154594767$ | $\mathrm{A\,m^{-1}}$ | positive when set | primary torque threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |
| `fm.RelaxStop.energy_tolerance_j` | `float \| None` | `None` | $\mathrm{J}$ | positive when set | optional accepted-energy range threshold | FDM/FEM lanes | `study.stop.energy_tolerance_j` |
| `fm.RelaxStop.max_steps` | `int \| None` | $50,000$ | $1$ | positive integer when set | work budget | FDM/FEM lanes | `study.stop.max_steps` |
| `fm.RelaxStop.max_relaxation_time_s` | `float \| None` | `None` | $\mathrm{s}$ | positive when set; LLG only | relaxation-coordinate ceiling | `llg_overdamped` only | `study.stop.max_relaxation_time_s` |
| `add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | exclusive with `tolA` | user-facing torque threshold | FDM/FEM lanes | normalized A/m stop field |
| `add_relax(tolA=...)` | `float` | canonical default equivalent | $\mathrm{A\,m^{-1}}$ | exclusive with `tolT` | canonical field threshold | FDM/FEM lanes | normalized A/m stop field |

The `stop=` object is the canonical grouped form. Scalar aliases are accepted on
`study.stages.add_relax`, but mixing a scalar with a conflicting field in `RelaxStop` is rejected.
The legacy `tol` parameter is removed and must not be documented as usable.

(numerical-methods-relaxation-stopping-problem-ir)=
## ProblemIR

The grouped stop object lowers to a canonical payload:

```json
{
  "stop": {
    "torque_tolerance_apm": 0.7957747154594767,
    "energy_tolerance_j": 1e-18,
    "max_steps": 50000
  }
}
```

Normalization converts `tolT` to A/m before runtime comparison. Requested unit and authored field
remain provenance metadata; resolved execution stores the canonical A/m threshold and the actual
completion reason.

(numerical-methods-relaxation-stopping-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves the grouped `RelaxStop` values or the equivalent scalar stage arguments.
Validation errors cover non-positive tolerances, non-positive step/time ceilings, conflicting stop
aliases, a stop with no criterion, energy-only completion assumptions, and time limits on direct
minimizers. Unsupported combinations are rejected instead of weakening the completion rule.
The result must identify requested intent, `converged`, `stop_reason`, `stop_metric`, `stop_value`, and
`stop_threshold`; a budget-exhausted result is not a converged result.

(numerical-methods-relaxation-stopping-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Stop-metric realization |
|---|---|---|---|
| FDM | CPU | source-backed | cellwise maximum torque and accepted-energy window |
| FDM | GPU | source-backed | CUDA/native reduction with explicit completion metrics |
| FEM | CPU | source-backed | finite-element magnetic-node residual and native stage completion |
| FEM | GPU | source-backed | device reduction/telemetry with runtime-qualified completion evidence required |

The shared stop semantics do not imply identical floating-point reductions. Each lane must record
precision, mesh/grid identity, field refresh, and runtime provenance with its metrics.

(numerical-methods-relaxation-stopping-implementation-mapping)=
## Implementation mapping

`RelaxStop` owns public validation and serialization. The runner convergence module owns accepted
state completion, torque confirmation, energy-window policy, budget handling, and pure-damping mode
selection. Backend-specific reducers provide the metrics consumed by that shared policy.

(numerical-methods-relaxation-stopping-validation)=
## Validation

Tests must prove: torque conversion from T to A/m; conjunction of torque and energy criteria;
rejection of budget-only completion; exact zero torque behavior; confirmation on accepted states;
failure on non-finite metrics; and round-trip preservation of requested/resolved stop policy.
Runtime qualification adds backend/device identity and artifact evidence.

(numerical-methods-relaxation-stopping-limitations)=
## Limitations

The stop contract does not prove a global energy minimum, physical-time equilibrium uniqueness, or
cross-mesh trajectory equality. The energy window is a numerical completion criterion, not a proof
that the continuous functional has reached its global minimum.

(numerical-methods-relaxation-stopping-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.
- J. Nocedal and S. J. Wright, *Numerical Optimization*, 2nd ed., Springer, 2006, DOI: [10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).
- Fullmag canonical equilibrium contract: [`0580-canonical-relaxation-equilibrium-contract.md`](https://github.com/MateuszZelent/fullmag/blob/master/docs/physics/0580-canonical-relaxation-equilibrium-contract.md).

(numerical-methods-relaxation-stopping-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Stop object validation and IR | `packages/fullmag-py/src/fullmag/model/study.py` | `class RelaxStop` | canonical criterion validation and serialization | public API | Python contract tests |
| Flat stage stop normalization | `packages/fullmag-py/src/fullmag/world.py` | `_resolve_flat_relax_stop` | tolT/tolA conversion and alias conflict handling | public API | stage tests |
| Accepted-state completion | `crates/fullmag-runner/src/relaxation/convergence.rs` | `relaxation_converged` | torque/energy conjunction and budget semantics | FDM/FEM orchestration | Rust tests |
| Pure-damping mode selection | `crates/fullmag-runner/src/relaxation/convergence.rs` | `llg_overdamped_uses_pure_damping` | distinguishes overdamped LLG from full dynamics | FDM/FEM orchestration | runner tests |
