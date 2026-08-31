---
title: FDM To FEM
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
---

(public-docs-numerical-methods-interpolation-and-state-transfer-fdm-to-fem)=
# FDM → FEM state transfer

## Scope and purpose

This page specifies the source-backed continuation from a Cartesian FDM state to a target FEM
state, including interpolation, normalization, provenance and explicit failure reporting.

## Scientific and numerical model

The transfer samples the source grid at target FEM points and does not transfer solver operators or
derived fields between discretizations.

(numerical-methods-fdm-to-fem-problem-statement)=
## Physical and numerical problem

FDM→FEM continuation transfers a Cartesian cell-centred magnetization to a new FEM mesh when a
continuation changes backend or FEM mesh. The runtime uses the target element locator and interpolates
the source grid field; it does not reinterpret FDM cell values as FEM nodal values without geometry.

(numerical-methods-fdm-to-fem-governing-equations)=
## Governing equations

For a target FEM point $\mathbf x$, trilinear interpolation over the source cell with weights
$w_{abc}$ is

```{math}
:label: eq-numerical-fdm-to-fem-trilinear
\mathbf m_{\mathrm{FEM}}(\mathbf x)=
\sum_{a,b,c\in\{0,1\}}w_{abc}(\mathbf x)\mathbf m_{abc},
\qquad
\sum_{a,b,c}w_{abc}=1.
```

The target FEM field is then sampled on its target topology and normalized using the same unit-vector
policy as the continuation contract.

(numerical-methods-fdm-to-fem-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x$ | target FEM point | $\mathrm{m}$ |
| $\mathbf m_{abc}$ | source FDM corner-cell magnetization | $1$ |
| $w_{abc}$ | trilinear interpolation weight | $1$ |
| $\mathbf m_{\mathrm{FEM}}$ | transferred FEM magnetization | $1$ |

(numerical-methods-fdm-to-fem-assumptions-and-validity)=
## Assumptions and validity

- The FDM grid origin, cell size and dimensions are resolved metadata; omitting them makes the
  transfer non-reproducible.
- Target FEM points outside the source grid require an explicit fallback/error policy. Extrapolation
  is not equivalent to interpolation.
- This operation transfers magnetization state, not FEM potentials, stiffness matrices or energy
  fields. Those quantities must be recomputed on the target backend.

(numerical-methods-fdm-to-fem-python-api)=
## Python API

There is no separate public transfer constructor. The runtime selects this operation when a FDM
continuation state is consumed by a FEM stage; the user continues to author the target study through
the stage-first API:

```python
# %% Stage-first target FEM continuation
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_continuation_target")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_relax(stage_id="continue", algorithm="nonlinear_cg", tolT=1.0e-6, max_steps=100)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDM → FEM continuation` | automatic runtime operation | automatic | $1$ | source grid and target FEM topology required | evaluates FDM state on FEM target | FDM source → FEM target | runtime continuation metadata |

(numerical-methods-fdm-to-fem-problem-ir)=
## Parameters

The resolved parameters are the source-grid metadata, target FEM topology, coverage policy and
normalization policy recorded by the continuation operation; there is no separate public transfer
constructor.

## ProblemIR and provenance

Record source FDM grid metadata, target FEM mesh digest, target-point coverage, fallback/error policy,
normalization, transfer counters and source/target backend identity. The transferred state is not a
new physical interaction and must not alter the requested energy terms.

(numerical-methods-fdm-to-fem-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Diagnostics must distinguish interpolated points, outside-domain points, fallback or error
decisions, normalization changes and source/target artifact mismatches. Missing grid metadata or
target topology is a validation failure, not an implicit default.

## Round-trip and failure semantics

Requested intent and resolved execution are recorded separately. Validation errors include missing
grid metadata, target topology mismatch and outside-domain failure. Unsupported combinations are
explicitly reported; no invisible nearest-neighbour or extrapolation fallback is permitted.

(numerical-methods-fdm-to-fem-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | source-backed | Cartesian source grid |
| FDM | GPU | source-backed when artifact is valid | exported continuation state |
| FEM | CPU | source-backed | target FEM topology and field initialization |
| FEM | GPU | target-dependent | target runtime consumes validated state artifact |

(numerical-methods-fdm-to-fem-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Cross-backend transfer | `crates/fullmag-cli/src/step_utils.rs` | `resample_continuation_if_cross_backend` | chooses and reports transfer | runtime |
| Vector transfer primitive | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_vector_field` | field interpolation and transfer result | engine |

(numerical-methods-fdm-to-fem-validation)=
## Validation

Validate affine/vector fields, grid coverage, target mesh coverage, unit-vector norms and first-stage
energy/torque continuity. Report outside/fallback counts and the source/target artifact digests.

(numerical-methods-fdm-to-fem-limitations)=
## Limitations

State interpolation does not transfer FDM convolution kernels, FEM potentials or discretization
operators. After transfer the target backend must rebuild all derived fields.

(numerical-methods-fdm-to-fem-scientific-bibliography)=
## Scientific bibliography

- Standard trilinear interpolation reference for Cartesian grids.
- Canonical continuation implementation is listed below.

(numerical-methods-fdm-to-fem-source-code-index)=

## Control Room workflow

Author the target FEM stage in Control Room and inspect the resolved continuation resource before
execution. Only controls surfaced by the current stage draft are authorable; transfer counters and
artifact provenance remain runtime evidence.

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Where this is implemented

The source-code index below records the stable routing and interpolation declarations used by this
page and its sidecar map.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Runtime routing | `crates/fullmag-cli/src/step_utils.rs` | `resample_continuation_if_cross_backend` | transfer selection and counters | CLI tests |
| Vector transfer | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_vector_field` | interpolation primitive | engine unit tests |
