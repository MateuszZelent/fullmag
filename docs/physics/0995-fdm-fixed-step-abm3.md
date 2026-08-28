# Fixed-step ABM3 contract for the FDM reference solver

- Status: implementation contract
- Owners: Fullmag numerics
- Last updated: 2026-08-28
- Related finding: `FDM-CPU-NUM-003`
- Related public documentation: `public_docs/site/numerical-methods/time-integration/index.md`

(problem-statement)=
## Problem statement

Fullmag exposes the third-order Adams--Bashforth--Moulton predictor/corrector
(`abm3`) for time integration of the finite-difference Landau--Lifshitz--Gilbert
(LLG) equation. The implemented coefficients are the classical constant-step
coefficients. Reusing their right-hand-side (RHS) history after a step-size
change is mathematically invalid. Storing the predictor RHS instead of the RHS
at the accepted corrected state also changes the recurrence and can reduce its
observed order.

This note freezes the production contract to fixed-step ABM3. It does not add a
variable-step Adams method or an embedded error estimator.

(governing-equations)=
## Governing equations

For the normalized magnetization $\mathbf m$ and effective field
$\mathbf H_{\mathrm{eff}}$, Fullmag integrates the Gilbert-form LLG RHS
$\mathbf f(t,\mathbf m)$:

```{math}
:label: abm3-llg-rhs
\frac{\mathrm d\mathbf m}{\mathrm dt}
=\mathbf f(t,\mathbf m)
=-\frac{\gamma}{1+\alpha^2}
\left[\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times
(\mathbf m\times\mathbf H_{\mathrm{eff}})\right],
\qquad \lVert\mathbf m\rVert_2=1.
```

With constant step $h$, accepted state $\mathbf m_n$, and accepted endpoint
RHS values $\mathbf f_n=\mathbf f(t_n,\mathbf m_n)$, the AB3 predictor is

```{math}
:label: abm3-predictor
\mathbf m_{n+1}^{p}
=\mathcal P\!\left(
\mathbf m_n+
\frac{h}{12}
\left(23\mathbf f_n-16\mathbf f_{n-1}+5\mathbf f_{n-2}\right)
\right),
```

and the AM3 corrector is

```{math}
:label: abm3-corrector
\mathbf m_{n+1}
=\mathcal P\!\left(
\mathbf m_n+
\frac{h}{12}
\left(5\mathbf f(t_{n+1},\mathbf m_{n+1}^{p})
+8\mathbf f_n-\mathbf f_{n-1}\right)
\right).
```

Here $\mathcal P(\mathbf v)=\mathbf v/\lVert\mathbf v\rVert_2$ is the same
stage projection used by the FDM reference solver. After the corrector passes
all finite-value and projection checks, the history is advanced with

```{math}
:label: abm3-accepted-history
\mathbf f_{n+1}
=\mathbf f(t_{n+1},\mathbf m_{n+1}),
```

not with the predictor value
$\mathbf f(t_{n+1},\mathbf m_{n+1}^{p})$.

(symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $t,t_n$ | physical time and accepted-step time | $\mathrm{s}$ |
| $h$ | fixed integration step | $\mathrm{s}$ |
| $\mathbf m,\mathbf m_n$ | normalized magnetization | $1$ |
| $\mathbf m_{n+1}^{p}$ | projected AB3 predictor | $1$ |
| $\mathbf f,\mathbf f_n$ | LLG RHS at an accepted state | $\mathrm{s^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field strength | $\mathrm{A\,m^{-1}}$ |
| $\gamma$ | gyromagnetic ratio used by the LLG model | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | Gilbert damping constant | $1$ |
| $\mathcal P$ | unit-sphere stage projection | $1$ |
| $r_h$ | ABM history revision | $1$ |
| $N_{\mathrm{reset}}$ | cumulative history-reset count | $1$ |
| $N_{\mathrm{rhs}}$ | RHS evaluations in one accepted step | $1$ |

(assumptions-and-validity)=
## Assumptions and validity

- Every interval represented by a ready ABM history has the same finite,
  positive $h$ within the implementation tolerance.
- The history belongs to one physics revision $r_h$. Changes to the frozen-spin
  mask, material/operator configuration, dynamic source contract, or restored
  state invalidate it before another multistep formula is evaluated.
- Two startup steps use Heun and store the RHS at each accepted corrected
  endpoint. Startup is part of the requested ABM3 realization, not a fallback
  to another public integrator.
- Trial state and trial RHS never mutate accepted magnetization, time, or
  history before all checks succeed.
- Variable-step ABM, adaptive ABM, discontinuous regional field drives, and
  unqualified staged-multilayer execution remain outside this contract.

(python-api)=
## Python API

The canonical stage-first authoring form is:

```python
# %% Author the physical problem.
import fullmag as fm

study = fm.study("fixed_step_abm3")
study.engine("fdm")
study.cell(5e-9, 5e-9, 5e-9)

magnet = study.geometry(fm.Box(40e-9, 20e-9, 5e-9), name="magnet")
magnet.Ms = 800e3
magnet.Aex = 13e-12
magnet.alpha = 0.02
magnet.m = fm.texture.uniform(1, 0, 0)

# %% Select fixed-step ABM3 and define the ordered stage graph.
study.solver(integrator="abm3", fix_dt=1e-15)
study.stages.add_run(until=1e-12)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `StudyBuilder.solver(integrator=...)` | `str \| None` | `None` | $1$ | canonical value `abm3`; aliases do not change this contract | requested time integrator | FDM CPU reference; other lanes remain capability-gated | `study.dynamics.integrator` |
| `StudyBuilder.solver(fix_dt=...)` | `float \| None` | `None` | $\mathrm{s}$ | finite and greater than zero; mutually exclusive with adaptive policy | constant ABM3 step | FDM CPU reference | `study.dynamics.fixed_timestep` |

(problem-ir)=
## ProblemIR

The authoring request lowers without loss to `DynamicsIR::Llg` with
`integrator = "abm3"`, a finite positive `fixed_timestep`, and no
`adaptive_timestep`. `ProblemIR::validate` rejects an ABM3 request carrying an
adaptive policy. The planner records the requested and resolved integrator and
must not replace ABM3 with Heun, RK, CPU/GPU, or another precision lane.

The relevant canonical serialized fragment produced by the example is:

```json
{
  "study": {
    "dynamics": {
      "type": "llg",
      "integrator": "abm3",
      "fixed_timestep": 1e-15,
      "adaptive_timestep": null
    }
  }
}
```

(round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export and reload must preserve `integrator="abm3"` and `fix_dt`.
Unsupported adaptive or discontinuous-source combinations fail before runtime.
The requested intent is fixed-step ABM3; resolved execution must identify the
same integrator and the selected backend/runtime in provenance. Validation errors identify
incompatible timestep policy before execution, and unsupported combinations never select a
silent fallback.
At runtime, a changed step or revision produces a typed history reset followed
by Heun startup. A non-finite predictor, corrector, accepted RHS, or projection
error leaves accepted magnetization, time, history, revision, and reset count
unchanged. A versioned checkpoint either restores all accepted ABM fields or is
rejected; silently reconstructing a supposedly ready history is forbidden.

(discrete-realization)=
## Discrete realization

| Solver | Device | Status | Scope and qualification |
|---|---|---|---|
| FDM | CPU | reference executable; managed qualification pending | AoS, buffer-SoA, and persistent-SoA reference paths with source tests for order, accepted history, restart, checkpoint, and fault handling |
| FDM | GPU | not qualified by this note | no device result is inferred from CPU source tests |
| FEM | CPU | separate reference contract | shared integrator name does not promote the native FEM lane |
| FEM | GPU | unsupported for ABM3 | native ABI rejects the method; no fallback is permitted |

For a ready history, the steady-state step performs one RHS evaluation at the
predictor and one at the accepted corrected endpoint. The endpoint evaluation
also supplies observables and is reused for history; it is not duplicated.
Startup performs the Heun predictor/corrector evaluations plus one accepted
endpoint RHS evaluation. No heap allocation, plan creation, or backend transfer
is permitted in the steady-state loop.

(implementation-mapping)=
## Implementation mapping

| Responsibility | Path | Stable symbol |
|---|---|---|
| fixed-step history and restart predicate | `crates/fullmag-engine/src/fdm/cpu/state.rs` | `AbmHistory::requires_restart_for_dt`, `AbmHistorySoA::requires_restart_for_dt` |
| AoS predictor/corrector | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `ExchangeLlgProblem::abm3_step_buf` |
| buffer-SoA predictor/corrector | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `ExchangeLlgProblem::abm3_step_soa_buf` |
| persistent-SoA predictor/corrector | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `ExchangeLlgProblem::abm3_step_soa_state_buf` |
| typed accepted-step telemetry | `crates/fullmag-engine/src/fdm/shared/observables.rs` | `Abm3StepTelemetry` |
| versioned solver checkpoint | `crates/fullmag-engine/src/fdm/cpu/state.rs` | `FdmCpuSolverCheckpointV1` |
| adaptive-policy rejection | `crates/fullmag-ir/src/validate.rs` | `validate_dynamics` |
| interaction capability gates | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` |
| canonical Python authoring | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.solver` |
| public checkpoint resume | `crates/fullmag-runner/src/lib.rs` | `resume_reference_fdm_from_abm3_checkpoint` |
| checkpoint artifact and telemetry projection | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `FdmAbm3RunnerCheckpointV1`, `fdm_abm3_checkpoint_value` |

(validation)=
## Validation

Qualification requires all of the following evidence:

1. A regression test proves each realization stores
   $\mathbf f(t_{n+1},\mathbf m_{n+1})$ after a full ABM3 step.
2. A constant-$+z$-field macrospin is compared with the independent exact
   Gilbert-form oracle. Halving $h$ in the asymptotic range must demonstrate an
   observed global order consistent with three.
3. AoS, buffer-SoA, and persistent-SoA trajectories agree within a declared
   floating-point tolerance.
4. A $2\times$ step change resets history before coefficients consume it and
   increments typed reset telemetry exactly once.
5. Checkpoint/resume with a ready history gives the same next accepted step and
   digest as uninterrupted execution. A schema mismatch fails closed.
6. Fault injection before commit preserves the full accepted-state digest.
7. Telemetry proves two RHS evaluations per steady-state ABM3 step, three per
   startup step, and zero unplanned allocations or backend transfers.
8. Python round-trip and IR/planner tests prove requested, resolved, and
   executed ABM3 without fallback.

The source qualification suite measures macrospin errors
`[7.45628728204828e-8, 9.318478710884648e-9, 1.1646871245218904e-9]`
for successive step halving, corresponding to observed orders
`[3.0002910945179972, 3.0001519979384574]`. Engine tests cover all three
history realizations, telemetry, transactional restoration, and schema/time
rejection. The runner E2E test proves bitwise continuation after JSON
checkpoint serialization and fail-closed rejection of changed plan identity.

(limitations)=
## Limitations

- This contract does not support variable steps, adaptive control, or an ABM
  local-error estimator.
- Any event scheduler that shortens one step must restart ABM history; planners
  without a qualified event-restart path reject the combination.
- The current capability must remain scoped to combinations covered by the
  evidence above. Source presence alone is not production qualification.

(scientific-bibliography)=
## Scientific bibliography

1. E. Hairer, S. P. Nørsett, and G. Wanner, *Solving Ordinary Differential
   Equations I: Nonstiff Problems*, 2nd revised edition, Springer, 1993,
   chapters III.1--III.2.
2. J. C. Butcher, *Numerical Methods for Ordinary Differential Equations*,
   3rd edition, Wiley, 2016, chapter 4.
3. T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic
   materials,” *IEEE Transactions on Magnetics* 40(6), 3443--3449, 2004.

(source-code-index)=
## Source-code index

The adjacent `0995-fdm-fixed-step-abm3.source-map.json` is the machine-readable
index for equations, symbols, public parameters, lane status, and stable source
symbols. The document and source map must validate together before publication.

| Claim | Path | Symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| fixed-step history | `crates/fullmag-engine/src/fdm/cpu/state.rs` | `AbmHistory` | owns accepted RHS history and restart predicate | FDM CPU | source-qualified; managed receipt pending |
| AoS recurrence | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `abm3_step_buf` | transactional AoS startup and predictor/corrector | FDM CPU | accepted-history regression passes |
| buffer-SoA recurrence | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `abm3_step_soa_buf` | transactional buffer-SoA recurrence | FDM CPU | accepted-history regression passes |
| persistent-SoA recurrence | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `abm3_step_soa_state_buf` | transactional persistent-SoA recurrence | FDM CPU | order, telemetry, and checkpoint tests pass |
| typed telemetry | `crates/fullmag-engine/src/fdm/shared/observables.rs` | `Abm3StepTelemetry` | reports startup, history reset, reset total, and RHS count | FDM CPU | startup/steady/reset regression passes |
| versioned engine checkpoint | `crates/fullmag-engine/src/fdm/cpu/state.rs` | `FdmCpuSolverCheckpointV1` | validates and restores complete accepted solver state | FDM CPU | JSON round-trip and fail-closed tests pass |
| runner checkpoint | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `FdmAbm3RunnerCheckpointV1` | binds continuation state to exact plan and runtime counters | FDM CPU | bitwise resume E2E passes |
| adaptive-policy validation | `crates/fullmag-ir/src/validation.rs` | `validate_adaptive_timestep` | rejects adaptive ABM3 | public IR | unit test exists |
| planner capability gates | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | rejects regional drives, Brown thermal noise, Frozen Spins, and multilayer ABM3 | FDM | planner regressions pass |
| Python authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | validates and stores solver policy through `StudyBuilder.solver` | public API | round-trip regression passes |
| public resume | `crates/fullmag-runner/src/lib.rs` | `resume_reference_fdm_from_abm3_checkpoint` | exposes fail-closed checkpoint continuation | public runner | runner E2E passes |
