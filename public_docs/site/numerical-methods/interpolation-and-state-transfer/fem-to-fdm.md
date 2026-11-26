---
title: FEM To FDM
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

(public-docs-numerical-methods-interpolation-and-state-transfer-fem-to-fdm)=
# FEM → FDM state transfer

(numerical-methods-fem-to-fdm-problem-statement)=
## Scope and purpose

This page specifies the continuation transfer from a tetrahedral FEM nodal magnetization state to
target Cartesian FDM cell centres, including BVH element location, P1 barycentric interpolation,
unit-vector normalization, provenance reporting, and explicit failure semantics. This is a
geometric field transfer rather than an operator equivalence between FEM and FDM discretizations.

(numerical-methods-fem-to-fdm-governing-equations)=
## Scientific and numerical model

For a target FDM cell centre $\mathbf x_i$, the BVH locator finds the containing source tetrahedron
$T_i$ and evaluates the P1 nodal field using barycentric weights $\lambda_a$:

```{math}
:label: eq-numerical-fem-to-fdm-p1
\mathbf m_{\mathrm{FDM}}(\mathbf x_i)=
\sum_{a\in T_i}\lambda_a(\mathbf x_i)\mathbf m_a,
\qquad
\sum_{a\in T_i}\lambda_a=1.
```

Because convex interpolation of unit vectors generally reduces norm, continuation applies
unit-sphere renormalization:

```{math}
:label: eq-numerical-fem-to-fdm-normalization
\mathbf m_i^{+}=\frac{\mathbf m_i}{\|\mathbf m_i\|_2}
\quad\text{when }\|\mathbf m_i\|_2>0,
\qquad
\mathbf m_i^{+}=\mathbf m_i\quad\text{otherwise}.
```

(numerical-methods-fem-to-fdm-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x_i$ | target FDM cell centre | $\mathrm{m}$ |
| $T_i$ | containing source FEM tetrahedron | $1$ |
| $\lambda_a$ | P1 barycentric weight | $1$ |
| $\mathbf m_a$ | source FEM nodal magnetization | $1$ |
| $\mathbf m_{\mathrm{FDM}}$ | transferred FDM magnetization | $1$ |
| $\mathbf m_i^{+}$ | normalized continuation magnetization | $1$ |

(numerical-methods-fem-to-fdm-assumptions-and-validity)=
### Assumptions and validity

- Source topology and nodal field ordering must match; target cell centres outside every source
  tetrahedron are reported explicitly as outside/fallback rather than extrapolated silently.
- P1 barycentric interpolation is exact for affine fields inside a tetrahedron (`tet4`), not for
  higher-order or discontinuous fields.
- Renormalization preserves direction while modifying amplitude; pre-normalization norms and
  degenerate-vector counts belong in continuation provenance.

(numerical-methods-fem-to-fdm-discrete-realization)=
### Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | `source-backed` | Tetrahedral BVH point location and P1 barycentric evaluation (`transfer_fem_field_to_grid`). |
| FEM | GPU | `not-applicable` | Source transfer runs host-side on the exported validated FEM continuation artifact. |
| FDM | CPU | `source-backed` | Target cell-centre grid and normalized vectors (`resample_continuation_if_cross_backend`). |
| FDM | GPU | `partial` | Target GPU runtime uploads the validated host-transferred state artifact before advancing. |

(numerical-methods-fem-to-fdm-implementation-mapping)=
### Implementation mapping

Cross-backend continuation dispatch (`resample_continuation_if_cross_backend`) and tetrahedral
FEM-to-FDM field interpolation (`transfer_fem_field_to_grid`) are indexed in
{ref}`numerical-methods-fem-to-fdm-source-code-index`.

(numerical-methods-fem-to-fdm-problem-ir)=
## Parameters

There is no separate user-facing `transfer_fem_to_fdm()` constructor; the resolved parameters are
the source FEM mesh digest, target FDM grid origin/cell size/dimensions, outside-domain policy, and
normalization policy recorded in continuation metadata.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FEM → FDM continuation` | automatic runtime operation | automatic | $1$ | source and target artifacts must be compatible | evaluates FEM field on FDM cell centres | FEM source → FDM target | runtime continuation metadata |

(numerical-methods-fem-to-fdm-python-api)=
## Python API

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
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="continue", algorithm="projected_gradient_bb", tolT=1.0e-6, max_steps=100)
```

### Provenance and `ProblemIR` boundary

The transfer is represented in runtime continuation metadata, not as a new energy term. Provenance
records source mesh digest, target grid geometry, located/outside counts, normalization statistics,
fallback counts, and source/target backend identities.

## Control Room workflow

Author the target FDM grid and continuation stage in Control Room, then inspect the resolved grid
and transfer counters before execution.

(numerical-methods-fem-to-fdm-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent vs resolved execution**: Requested intent (stage backend transitions) is
  tracked separately from resolved execution (transfer counters and artifact digests).
- **Validation errors and unsupported combinations**: Validation errors include missing source
  topology, incompatible field length, and invalid target grid metadata; unsupported combinations
  such as non-tetrahedral source cells fail explicitly without silent extrapolation.

(numerical-methods-fem-to-fdm-validation)=
## Validation

Validate constant-field preservation, affine-field exactness on tetrahedra, outside-domain
accounting, norm statistics, and initial target-stage energy/torque continuity.

(numerical-methods-fem-to-fdm-limitations)=
## Limitations

- `transfer_fem_field_to_grid` (`crates/fullmag-engine/src/fem_solution_transfer.rs`) builds an
  AABB BVH over tetrahedral (`tet4`) elements only; mixed prism–pyramid–tetrahedron and
  `pure_prism_p2` meshes are not supported directly by this BVH transfer primitive.
- Pointwise interpolation is not conservative $L^2$ projection and does not imply equal discrete
  energy or demagnetizing fields between FEM and FDM.

(numerical-methods-fem-to-fdm-scientific-bibliography)=
## Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM Classics in Applied Mathematics **40** (2002), DOI: [10.1137/1.9780898719208](https://doi.org/10.1137/1.9780898719208).
2. S. C. Brenner and L. R. Scott, *The Mathematical Theory of Finite Element Methods*, 3rd ed., Springer (2008), DOI: [10.1007/978-0-387-75934-0](https://doi.org/10.1007/978-0-387-75934-0).

(numerical-methods-fem-to-fdm-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| FEM→FDM interpolation | [`crates/fullmag-engine/src/fem_solution_transfer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fem_solution_transfer.rs#L357) | [`transfer_fem_field_to_grid`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fem_solution_transfer.rs#L357) | tetrahedral BVH point location and P1 barycentric transfer | engine unit tests |
| Runtime selection | [`crates/fullmag-cli/src/step_utils.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/step_utils.rs#L1284) | [`resample_continuation_if_cross_backend`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/step_utils.rs#L1284) | cross-backend continuation routing and counters | CLI tests |
