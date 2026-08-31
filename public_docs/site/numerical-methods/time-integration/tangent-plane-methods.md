---
title: Tangent Plane Methods
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
source_of_truth: "Relaxation validation, relax-stage lowering, and planner capability status"
---

(public-docs-numerical-methods-time-integration-tangent-plane-methods)=
# Tangent-plane methods

Tangent-plane methods constrain the magnetization update to the tangent space of the unit
sphere. In the current public Fullmag model this method family is exposed as the
`tangent_plane_implicit` relaxation algorithm, not as a general-purpose `LLG.integrator`
choice for a physical-time `run` stage. That distinction is intentional and prevents a
relaxation minimizer from being presented as a dynamic time integrator.

## Scope and purpose

This page documents the tangent-plane relaxation contract and its boundary with physical-time
integration. The current public API exposes `tangent_plane_implicit` as a relaxation algorithm;
it does not expose a general tangent-plane `LLG.integrator`.

(time-integration-tangent-plane-methods-problem-statement)=
## Scientific and numerical model

At a normalized magnetization $μ_i$, admissible first-order variations satisfy
$\mu_i\cdot\delta\mu_i=0$. A tangent-plane relaxation method solves for an increment in this
subspace and then updates the state while enforcing the sphere constraint.

(time-integration-tangent-plane-methods-governing-equations)=
## Governing equations

The tangent projector at point $i$ is

```{math}
:label: eq-tangent-projector
P_i=I-\mu_i\mu_i^{\mathsf T},
\qquad P_i\,\mu_i=0.
```

The projected effective field is

```{math}
:label: eq-tangent-field
H_i^{\perp}=P_iH_{\mathrm{eff},i}.
```

The current public contract describes the implicit tangent-plane method as a relaxation
algorithm; its complete nonlinear linearization and production solver details are therefore
reported as a separate backend qualification item rather than invented here.

(time-integration-tangent-plane-methods-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mu_i$ | normalized magnetization at point i | $1$ |
| $\delta\mu_i$ | admissible tangent variation | $1$ |
| $P_i$ | tangent-space projector | $1$ |
| $I$ | three-dimensional identity tensor | $1$ |
| $H_{\mathrm{eff},i}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $H_i^{\perp}$ | projected effective field | $\mathrm{A\,m^{-1}}$ |

(time-integration-tangent-plane-methods-assumptions-and-validity)=
## Assumptions and validity

- The input state is non-zero and is interpreted as a unit magnetization after normalization by
  the surrounding relaxation contract.
- This page does not claim a physical-time tangent-plane integrator.
- FEM-only availability is a public algorithm contract; FDM lanes must reject the request unless
  a future capability declaration explicitly enables it.

(time-integration-tangent-plane-methods-python-api)=
## Python API

```python
# %% Configure a tangent-plane relaxation request
import fullmag as fm

nm = 1.0e-9
study = fm.study("tangent_plane_relaxation")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_relax(
    algorithm="tangent_plane_implicit",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Relaxation.algorithm` | `str` | `"llg_overdamped"` | $1$ | supported identifier; unknown names rejected | relaxation algorithm request | FEM contract; FDM rejects | `study.relaxation.algorithm` |
| `RelaxStop.torque_tolerance_apm` | `float \| None` | `0.7957747154594767` | $\mathrm{A\,m^{-1}}$ | positive when set | torque stopping threshold | FEM/FDM relaxation stop contract | `study.relaxation.stop.torque_tolerance_apm` |
| `RelaxStop.max_steps` | `int \| None` | `50000` | $1$ | positive integer when set | iteration limit | FEM/FDM relaxation stop contract | `study.relaxation.stop.max_steps` |

## Parameters

The following rows are the public relaxation and stopping parameters used by the example. The
FDM rows remain explicitly unsupported for this algorithm, as recorded in the source map.

(time-integration-tangent-plane-methods-problem-ir)=
## ProblemIR

The requested algorithm lowers to:

```json
{"kind": "relaxation", "algorithm": "tangent_plane_implicit", "stop": {"torque_tolerance_apm": 0.7957747154594767, "max_steps": 50000}}
```

The planner resolves whether the selected FEM lane can execute it. The JSON request is not proof
that a native tangent-plane solve was run.

(time-integration-tangent-plane-methods-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Round-trip preserves requested intent, the algorithm request, and stop policy. Validation errors cover unknown
algorithm names, non-positive stop values, and incompatible time-limit parameters. Unsupported combinations
combinations are explicit: the FDM planner must reject `tangent_plane_implicit` rather than
silently selecting `llg_overdamped`. Requested intent and resolved execution remain separate in
provenance.

(time-integration-tangent-plane-methods-discrete-realization)=
## Discrete realization

| Lane | Status | Reason |
|---|---|---|
| FEM CPU | documented contract | relaxation algorithm is exposed as FEM-only in the public model |
| FEM GPU | source-backed, qualification-dependent | device execution requires managed runtime evidence |
| FDM CPU | unsupported | current algorithm contract is FEM-only |
| FDM GPU | unsupported | current algorithm contract is FEM-only |

(time-integration-tangent-plane-methods-implementation-mapping)=
## Where this is implemented

The public algorithm set and validation live in `Relaxation`; the stage builder lowers the
request through `relax_stage`. Backend implementation status is resolved by planner capabilities,
not by the Python string alone.

(time-integration-tangent-plane-methods-validation)=
## Validation

Validation must separate projector algebra, relaxation convergence, and runtime lane
qualification. A source-level algorithm identifier is not numerical evidence. The minimum report
contains torque norm, energy change, iteration count, final norm defect, selected FEM lane,
precision, and whether the GPU device actually executed.

(time-integration-tangent-plane-methods-limitations)=
## Limitations

The public documentation does not claim that this method is a general dynamic integrator, an
FDM method, or a universally qualified FEM GPU method. The full linear-system policy and
preconditioner controls must be added only when their public and native contracts are present.

(time-integration-tangent-plane-methods-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.
- J. E. Marsden, T. J. R. Hughes, *Mathematical Foundations of Elasticity*, Dover, 1994, for constrained variational discretization principles.

(time-integration-tangent-plane-methods-source-code-index)=

## Control Room workflow

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public relaxation algorithm contract | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` | validates algorithm and serializes relaxation IR | public API | Python tests |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `relax_stage` | captures ordered relaxation stage | public API | stage tests |
