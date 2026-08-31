---
title: FEM To FDM
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
---

(public-docs-numerical-methods-interpolation-and-state-transfer-fem-to-fdm)=
# FEM → FDM state transfer

## Scope and purpose

This page specifies the source-backed continuation from a FEM nodal state to target FDM cell
centres, including element location, interpolation, normalization and failure reporting.

## Scientific and numerical model

The target grid is sampled geometrically from the source FEM topology; this operation does not
claim equivalence of the FEM and FDM operators or trajectories.

(numerical-methods-fem-to-fdm-problem-statement)=
## Physical and numerical problem

When a FEM continuation state is used to start an FDM stage, nodal FEM magnetization is evaluated
at target FDM cell centres. This is a geometric field transfer, not a solver conversion: the target
grid, cell-centre convention, outside-domain policy and unit-vector renormalization are part of the
resolved operation.

(numerical-methods-fem-to-fdm-governing-equations)=
## Governing equations

For a target cell centre $\mathbf x_i$, locate the containing source element $T_i$ and evaluate the
P1 field using barycentric weights $\lambda_a$:

```{math}
:label: eq-numerical-fem-to-fdm-p1
\mathbf m_{\mathrm{FDM}}(\mathbf x_i)=
\sum_{a\in T_i}\lambda_a(\mathbf x_i)\mathbf m_a,
\qquad
\sum_{a\in T_i}\lambda_a=1.
```

For magnetization, interpolation can change the norm, therefore the continuation path applies

```{math}
:label: eq-numerical-fem-to-fdm-normalization
\mathbf m_i^{+}=\frac{\mathbf m_i}{\|\mathbf m_i\|_2}
\quad\text{when }\|\mathbf m_i\|_2>0,
\qquad
\mathbf m_i^{+}=\mathbf m_i\quad\text{otherwise}.
```

(numerical-methods-fem-to-fdm-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x_i$ | target FDM cell centre | $\mathrm{m}$ |
| $T_i$ | containing source FEM element | $1$ |
| $\lambda_a$ | P1 barycentric weight | $1$ |
| $\mathbf m_a$ | source FEM nodal magnetization | $1$ |
| $\mathbf m_{\mathrm{FDM}}$ | transferred FDM magnetization | $1$ |
| $\mathbf m_i^{+}$ | normalized continuation magnetization | $1$ |

(numerical-methods-fem-to-fdm-assumptions-and-validity)=
## Assumptions and validity

- Source topology and nodal field ordering must match. Cell centres outside every source element are
  reported as outside/fallback; they are not silently extrapolated as valid FEM values.
- P1 interpolation is exact for affine fields inside a simplex, not for arbitrary higher-order or
  discontinuous fields.
- Renormalization preserves direction but changes the interpolated amplitude; record this whenever
  magnetization is transferred.

(numerical-methods-fem-to-fdm-python-api)=
## Python API

There is no separate user-facing `transfer_fem_to_fdm()` constructor. The operation is automatically
performed by the runtime when a FEM continuation artifact feeds an FDM stage. The author still uses
the normal stage-first study contract:

```python
# %% Stage-first target FDM continuation
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_continuation_target")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_relax(stage_id="continue", algorithm="nonlinear_cg", tolT=1.0e-6, max_steps=100)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FEM → FDM continuation` | automatic runtime operation | automatic | $1$ | source and target artifacts must be compatible | evaluates FEM field on FDM cell centres | FEM source → FDM target | runtime continuation metadata |

(numerical-methods-fem-to-fdm-problem-ir)=
## Parameters

The resolved parameters are the source FEM topology, target FDM grid, outside-domain policy and
normalization policy recorded by the continuation operation; there is no separate public transfer
constructor.

## ProblemIR and provenance

The transfer is represented in runtime continuation metadata, not as a new energy term. Record source
mesh digest, target grid origin/cell size/dimensions, interpolated/outside counts, normalization
policy, fallback count and source/target backend identity.

(numerical-methods-fem-to-fdm-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Diagnostics must distinguish located and outside target points, interpolation failures,
normalization changes, field-length mismatches and source/target artifact identities. Missing
topology or invalid grid metadata is a validation error rather than an implicit fallback.

## Round-trip and failure semantics

Requested intent is the requested continuation backend sequence; resolved execution is the actual
source/target transfer result. Validation errors include missing topology, incompatible field length,
invalid target grid and transfer failure. Unsupported combinations are reported with outside/fallback
counts; no silent extrapolation is allowed.

(numerical-methods-fem-to-fdm-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | source-backed | source nodal field and element location |
| FEM | GPU | not applicable | source transfer is host-side continuation metadata |
| FDM | CPU | source-backed | target cell-centre grid and normalized vectors |
| FDM | GPU | target-dependent | target runtime consumes transferred state only after artifact validation |

(numerical-methods-fem-to-fdm-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| FEM field to grid | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_fem_field_to_grid` | locate/interpolate FEM field at FDM centres | transfer |
| Continuation orchestration | `crates/fullmag-cli/src/step_utils.rs` | `resample_continuation_if_cross_backend` | selects cross-backend transfer | runtime |

(numerical-methods-fem-to-fdm-validation)=
## Validation

Use affine-field exactness, uniform-field preservation, outside-domain accounting, norm statistics,
and continuation energy/torque checks on the first target stage. Report all transfer counters.

(numerical-methods-fem-to-fdm-limitations)=
## Limitations

The transfer is interpolation, not conservative projection of arbitrary FEM quantities. It does not
prove that FEM and FDM discretizations have identical energy or demagnetizing fields.

(numerical-methods-fem-to-fdm-scientific-bibliography)=
## Scientific bibliography

- Standard P1 finite-element interpolation and barycentric coordinates reference.
- Canonical continuation implementation is listed below.

(numerical-methods-fem-to-fdm-source-code-index)=

## Control Room workflow

Author the target FDM grid and continuation stage in Control Room, then inspect the resolved grid
and transfer counters before execution. Only controls surfaced by the current stage draft are
authorable.

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Where this is implemented

The source-code index below records the stable routing and interpolation declarations used by this
page and its sidecar map.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| FEM→FDM interpolation | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_fem_field_to_grid` | field transfer | engine unit tests |
| Runtime selection | `crates/fullmag-cli/src/step_utils.rs` | `resample_continuation_if_cross_backend` | continuation routing | CLI tests |
