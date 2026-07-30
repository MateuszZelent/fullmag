---
title: Demagnetization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-demagnetization)=
# Demagnetization Python API

This page documents the Python authoring contract. The physical equations and backend realization
details live in {doc}`../../physics/interactions/demagnetization/index`; this page owns constructor
signatures, validation, lowering, and copyable examples.

(demag-api-problem-statement)=
## Physical problem

`fullmag.Demag` enables the non-local magnetostatic interaction. It has no floating-point physical
coefficient of its own: magnetization and material values come from the magnetic object and the
selected backend discretization.

(demag-api-governing-equations)=
## Governing equations

```{math}
:label: eq-python-demag-field
\mathbf H_{\mathrm d}=-\nabla u,
\qquad
\Delta u=\nabla\cdot\mathbf M.
```

```{math}
:label: eq-python-demag-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

(demag-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $u$ | scalar potential | $\mathrm{A}$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |

(demag-api-assumptions-and-validity)=
## Assumptions and validity

The constructor describes requested semantics, not a guarantee that every backend/device can run
them. Physical validity additionally depends on mesh resolution, boundary policy, solver residual,
and the documented qualification state.

(demag-api-python-api)=
## Constructors and complete parameters

```python
# %% Copyable Python/Jupyter example
import json
import fullmag as fm

terms = [
    fm.Demag(),
    fm.Demag(model="airbox", variant="robin"),
    fm.Demag(model="airbox", variant="dirichlet"),
    fm.Demag(model="fredkin_koehler"),
]
for term in terms:
    print(json.dumps(term.to_ir()))

# %% FDM policy and periodic boundary policy
fdm_policy = fm.FDMDemag(
    strategy="multilayer_convolution",
    mode="two_d_stack",
    common_cells_xy=(512, 512),
)
pbc = fm.FdmPbc(
    axes=(True, True, False),
    demag="truncated_images",
    image_counts=(10, 10, 0),
)
print(fdm_policy.to_ir())
print(pbc.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | `airbox`, `bem`, `fredkin_koehler`, or `fmm`. | Canonical realization family. | Planner-dependent. | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | Airbox only: `auto`, `robin`, `dirichlet`. | Airbox closure. | FEM airbox lanes. | `energy[].realization` |
| `Demag.realization` | `optional str` | `None` | $1$ | Legacy realization; cannot mix with `model`. | Backward-compatible input. | Normalized before planning. | `energy[].realization` |
| `FDMDemag.strategy` | `str` | `auto` | $1$ | `auto`, `single_grid`, `multilayer_convolution`. | FDM convolution strategy. | FDM lanes. | `discretization.demag.strategy` |
| `FDMDemag.mode` | `str` | `auto` | $1$ | `auto`, `two_d_stack`, `three_d`. | FDM stack mode. | FDM lanes. | `discretization.demag.mode` |
| `FDMDemag.common_cells` | `optional tuple[int,int,int]` | `None` | $1$ | Exactly three positive integers. | Explicit 3-D common convolution grid. | FDM lanes. | `discretization.demag.common_cells` |
| `FDMDemag.common_cells_xy` | `optional tuple[int,int]` | `None` | $1$ | Exactly two positive integers. | Explicit in-plane common grid. | FDM lanes. | `discretization.demag.common_cells_xy` |
| `FDMDemag.allow_single_grid_fallback` | `optional bool` | `None` | $1$ | Any non-`None` value raises `ValueError`. | Removed compatibility switch; never lowered. | No backend support. | Not serialized |
| `FDMDemag.explain` | `bool` | `True` | $1$ | Boolean. | Human-readable plan summary switch; not serialized. | FDM authoring helper. | Not serialized |
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | Exactly three booleans. | Periodic axes x, y, z. | FDM planner. | `pbc.axes` |
| `FdmPbc.demag` | `str` | `open` | $1$ | `open`, `truncated_images`, `periodic_airbox_k0`. | Periodic demag policy. | Planner validates solver legality. | `pbc.demag` |
| `FdmPbc.image_counts` | `optional tuple[int,int,int]` | `None` | $1$ | Non-negative and only with `truncated_images`. | Finite periodic-image counts. | FDM. | `pbc.image_counts` |
| `demag(enabled=...)` | `bool` | `True` | $1$ | Boolean. | Flat-API demag enable/disable. | Flat scripting API. | `energy[].realization` plus enabled state |
| `fem_demag_solver(solver=..., preconditioner=..., rtol=..., atol=..., max_iterations=..., print_level=...)` | keyword parameters | `CG`, `AMG`, `1e-8`, `None`, `500`, `0` | mixed control units | Solver `CG`/`GMRES`; preconditioner `AMG`/`JACOBI`/`NONE`; positive tolerance and integer controls. | FEM Poisson linear-solver policy. | FEM lanes. | `discretization.fem.demag_solver_policy` |
| `demag_quality(profile)` | `str` | required | $1$ | `exact`, `balanced`, or `fast`. | Selects demag refresh cadence. | Flat scripting API. | `study.field_refresh.demag_interval_s` |

(demag-api-problem-ir)=
## ProblemIR lowering

`Demag()` lowers to `{"kind": "demag", "realization": "auto"}`. `model="airbox"` with the
default or Robin variant lowers to `poisson_robin`; Dirichlet lowers to `poisson_dirichlet`.
`FDMDemag` and `FdmPbc` lower to their own discretization and periodicity objects.

(demag-api-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical export preserves requested intent and does not replace it with resolved execution metadata. The
following are validation errors: mixing `model` and `realization`, using an airbox `variant` with
another model, invalid names, supplying `image_counts` for `open`, and requesting
`periodic_airbox_k0` for FDM. Unsupported combinations are planner results, not silent fallbacks.

(demag-api-discrete-realization)=
## Discrete realization

The Python object is backend-neutral. FDM consumes `FDMDemag`; FEM consumes the demag realization
and mesh/solver policy. CPU and GPU paths remain separate execution realizations in provenance.

(demag-api-implementation-mapping)=
## Implementation mapping

`Demag.__post_init__` validates arguments, `_resolved_realization` normalizes aliases, and `to_ir`
creates the canonical term. `FDMDemag.__post_init__` validates FDM policies. `FdmPbc.__post_init__`
validates periodic semantics.

(demag-api-validation)=
## Validation

Test constructor acceptance/rejection, exact IR normalization, Python export round-trip, planner
fail-closed behavior, and materializable output quantities (`H_demag`, `E_demag`, `demag_phi`).

(demag-api-limitations)=
## Limitations

`bem` and `fmm` are accepted vocabulary values but must not be represented as production-qualified
without planner and runtime evidence. Python constructor acceptance is not backend qualification.

(demag-api-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag API implementation: `packages/fullmag-py/src/fullmag/model/energy.py`.

(demag-api-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Public constructor and interaction lowering. |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | FDM demag policy. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | Periodic demag policy. |
| `packages/fullmag-py/src/fullmag/world.py` | `demag` | Flat-API demag enable and realization selection. |
| `packages/fullmag-py/src/fullmag/world.py` | `fem_demag_solver` | Flat-API FEM solver policy. |
| `packages/fullmag-py/src/fullmag/world.py` | `demag_quality` | Flat-API demag refresh cadence. |
| `crates/fullmag-ir/src/plan.rs` | `requires_airbox` | IR realization mesh requirement. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM planner resolution. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM planner resolution. |
| `crates/fullmag-plan/src/validate.rs` | `validate_executable_outputs` | Fail-closed output validation. |
