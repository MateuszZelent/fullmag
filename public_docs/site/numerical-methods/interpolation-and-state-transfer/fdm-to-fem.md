---
title: FDM To FEM
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

(public-docs-numerical-methods-interpolation-and-state-transfer-fdm-to-fem)=
# FDM → FEM state transfer

(numerical-methods-fdm-to-fem-problem-statement)=
## Scope and purpose

This page specifies the continuation transfer from a Cartesian cell-centred FDM magnetization state
to a target FEM mesh, including trilinear sampling, unit-vector renormalization, provenance
reporting, and explicit failure semantics. The runtime samples the source grid geometrically rather
than reinterpreting FDM cell values as FEM nodal values without coordinates, and never transfers
solver operators or derived fields between discretizations.

(numerical-methods-fdm-to-fem-governing-equations)=
## Scientific and numerical model

For a target FEM interpolation point $\mathbf x$ with local fractional cell coordinates
$(\xi, \eta, \zeta) \in [0, 1]^3$ relative to the surrounding eight source cell centres, trilinear
interpolation with weights $w_{abc}$ evaluates

```{math}
:label: eq-numerical-fdm-to-fem-trilinear
\mathbf m_{\mathrm{FEM}}(\mathbf x)=
\sum_{a,b,c\in\{0,1\}}w_{abc}(\mathbf x)\mathbf m_{abc},
\qquad
\sum_{a,b,c}w_{abc}=1.
```

The interpolated magnetization is evaluated on the target FEM topology and renormalized onto the
unit sphere $\mathbb{S}^2$ wherever $\|\mathbf m_{\mathrm{FEM}}(\mathbf x)\|_2 > 0$.

(numerical-methods-fdm-to-fem-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x$ | target FEM point | $\mathrm{m}$ |
| $\mathbf m_{abc}$ | source FDM corner-cell magnetization | $1$ |
| $w_{abc}$ | trilinear interpolation weight | $1$ |
| $\mathbf m_{\mathrm{FEM}}$ | transferred FEM magnetization | $1$ |

(numerical-methods-fdm-to-fem-assumptions-and-validity)=
### Assumptions and validity

- The source FDM grid origin, cell size, and dimensions are mandatory provenance metadata; omitting
  them fails validation.
- Target FEM points outside the source grid coverage require an explicit fallback or failure policy;
  extrapolation is never substituted silently for interpolation.
- This operation transfers only magnetization state, never FEM scalar potentials, stiffness
  matrices, or effective-field snapshots; all derived fields are rebuilt on the target backend.

(numerical-methods-fdm-to-fem-discrete-realization)=
### Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | `source-backed` | Cartesian source grid (`resample_continuation_if_cross_backend`). |
| FDM | GPU | `partial` | Exported host-validated continuation artifact from GPU state before transfer. |
| FEM | CPU | `source-backed` | Target FEM topology and nodal field initialization (`transfer_vector_field`). |
| FEM | GPU | `partial` | Target GPU runtime uploads the validated host-interpolated state artifact. |

(numerical-methods-fdm-to-fem-implementation-mapping)=
### Implementation mapping

Cross-backend continuation dispatch in the CLI orchestrator (`resample_continuation_if_cross_backend`)
and vector-field interpolation in `fullmag-engine` (`transfer_vector_field`) are indexed in
{ref}`numerical-methods-fdm-to-fem-source-code-index`.

(numerical-methods-fdm-to-fem-problem-ir)=
## Parameters

There is no separate public transfer constructor; the resolved parameters are the source FDM grid
metadata, target FEM mesh digest, outside-domain coverage policy, and unit-vector normalization
policy recorded in runtime continuation metadata.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDM → FEM continuation` | automatic runtime operation | automatic | $1$ | source grid and target FEM topology required | evaluates FDM state on FEM target | FDM source → FEM target | runtime continuation metadata |

(numerical-methods-fdm-to-fem-python-api)=
## Python API

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
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="continue", algorithm="projected_gradient_bb", tolT=1.0e-6, max_steps=100)
```

### Provenance and `ProblemIR` boundary

Continuation provenance records source FDM grid metadata, target FEM mesh digest, interpolated and
outside-domain counts, normalization statistics, and source/target backend identities without
mutating the requested physics terms in `ProblemIR`.

## Control Room workflow

Author the target FEM stage in Control Room and inspect the resolved continuation resource before
execution. Transfer counters and artifact digests are displayed as runtime provenance.

(numerical-methods-fdm-to-fem-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent vs resolved execution**: Requested intent (stage backend transitions) is stored
  separately from resolved execution (transfer counters, outside-domain counts, and
  pre-normalization norm diagnostics).
- **Validation errors and unsupported combinations**: Validation errors include missing source grid
  metadata, target topology mismatch, and uncovered target points without an explicit policy;
  unsupported combinations are rejected explicitly rather than applying silent nearest-neighbour or
  extrapolation fallbacks.

(numerical-methods-fdm-to-fem-validation)=
## Validation

Validate constant and affine vector fields, grid coverage, target mesh coverage, pre- and
post-normalization unit-vector norms, and first-stage energy/torque continuity on the target FEM
backend.

(numerical-methods-fdm-to-fem-limitations)=
## Limitations

- Pointwise trilinear interpolation is not a conservative $L^2$ projection and does not preserve
  discrete energy, topological charge, or auxiliary fields across discretizations.
- The underlying FEM-side transfer primitive (`crates/fullmag-engine/src/fem_solution_transfer.rs`)
  targets tetrahedral (`tet4`) topologies; mixed prism–pyramid–tet and `pure_prism_p2` meshes are
  outside that tetrahedral transfer primitive.

(numerical-methods-fdm-to-fem-scientific-bibliography)=
## Scientific bibliography

1. S. C. Brenner and L. R. Scott, *The Mathematical Theory of Finite Element Methods*, 3rd ed., Springer (2008), DOI: [10.1007/978-0-387-75934-0](https://doi.org/10.1007/978-0-387-75934-0).
2. W. H. Press, S. A. Teukolsky, W. T. Vetterling, and B. P. Flannery, *Numerical Recipes: The Art of Scientific Computing*, 3rd ed., Cambridge University Press (2007), Ch. 3 (Multidimensional Trilinear Interpolation).

(numerical-methods-fdm-to-fem-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Runtime routing | [`crates/fullmag-cli/src/step_utils.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/step_utils.rs#L1284) | [`resample_continuation_if_cross_backend`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/step_utils.rs#L1284) | cross-backend transfer selection and counters | CLI tests |
| Vector transfer | [`crates/fullmag-engine/src/fem_solution_transfer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fem_solution_transfer.rs#L284) | [`transfer_vector_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fem_solution_transfer.rs#L284) | vector-field interpolation primitive | engine unit tests |
