---
title: "FDM multi-magnet grids"
description: "Per-magnet FDM grids and common convolution planning."
summary: "Native grids and demagnetization policy are lowered and fail closed before allocation when incompatible."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FDM schema and runner preflight"
---

(public-docs-numerical-methods-meshing-fdm-multi-magnet-grids)=
# FDM multi-magnet grids

(fdm-multi-magnet-grids-problem-statement)=
## Physical problem

`FDMGrid` provides body-local Cartesian cells; `FDMDemag` requests a common demagnetization strategy. A request is not an implicit resampling permission.

(fdm-multi-magnet-grids-governing-equations)=
## Governing equations

```{math}
:label: eq-fdm-multi-demag
\mathbf H_a=\sum_b\mathcal N_{ab}*\mathbf M_b .
```

(fdm-multi-magnet-grids-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf H_a$ | field on layer $a$ | A m^-1 |
| $\mathcal N_{ab}$ | cross-kernel | 1 |
| $\mathbf M_b$ | magnetization on layer $b$ | A m^-1 |

(fdm-multi-magnet-grids-assumptions-and-validity)=
## Assumptions and validity

Names are non-empty and values are `FDMGrid`. With multiple magnets,
`strategy="single_grid"` is rejected; the executable strategy is
`multilayer_convolution`. Explicit `fftw` and `mkl` requests are unavailable in this build,
`rustfft` is the CPU realization, and `cufft` is the CUDA realization. Any explicit FFT
backend requires an active demag interaction.

`common_cell_size` is incompatible with explicit `mode="two_d_stack"`. For a 3-D plan, every
component must divide the corresponding common convolution extent into an integer cell count
within the planner tolerance; strict mode rejects a nonintegral ratio and does not round it.
Runner preflight additionally requires a compatible certificate, common grid, transfers, masks,
and memory accounting. This is not a convergence proof.

(fdm-multi-magnet-grids-python-api)=
## Python API

```python
# %%
import fullmag as fm
nm = 1e-9
study = fm.study("two-magnet-grid")
study.engine("fdm")
study.fdm(
    default_cell=(2 * nm, 2 * nm, nm),
    per_magnet={
        "free": fm.FDMGrid(cell=(2 * nm, 2 * nm, nm)),
        "reference": fm.FDMGrid(cell=(4 * nm, 4 * nm, nm)),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(256, 128),
        fft_backend="rustfft",
    ),
)
study.demag()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FDMGrid.cell` | `Sequence[float]` | required | m | exactly three positive finite values | native cell dimensions | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `per_magnet.<name>.cell` |
| `FDM.cell` | `Sequence[float] \| None` | `None` | m | exclusive with `default_cell`; three positive finite values | compatibility alias for default grid | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `cell` and `default_cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | m | three positive finite values | default grid | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `default_cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | m | non-empty names and `FDMGrid` values | named grid overrides | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | 1 | `FDMDemag` annotation; no constructor type guard; `.to_ir()` is called when present | nested demag policy | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `demag` |
| `FDMDemag.strategy` | `str` | `auto` | 1 | `auto`, `single_grid`, or `multilayer_convolution`; `single_grid` rejects multiple magnets | demag strategy | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `demag.strategy` |
| `FDMDemag.mode` | `str` | `auto` | 1 | `auto`, `two_d_stack`, `three_d` | grid topology mode | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `demag.mode` |
| `FDMDemag.common_cells` | `tuple[int, int, int] \| None` | `None` | cells | three positive integers; exclusive with `common_cells_xy` and `common_cell_size`; incompatible with `two_d_stack` | common 3-D cell counts | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `demag.common_cells` |
| `FDMDemag.common_cells_xy` | `tuple[int, int] \| None` | `None` | cells | positive values; only `auto` or `two_d_stack` | common in-plane cells | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `demag.common_cells_xy` |
| `FDMDemag.common_cell_size` | `tuple[float, float, float] \| None` | `None` | m | positive finite; exclusive with count fields; forbidden with explicit `two_d_stack`; must divide every common extent without rounding | common convolution cell size | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `demag.common_cell_size` |
| `FDMDemag.fft_backend` | `str` | `auto` | 1 | explicit choice requires active demag; `fftw` and `mkl` unavailable; `rustfft` CPU; `cufft` CUDA | requested FFT backend | `auto` resolves by lane; `rustfft` CPU; `cufft` CUDA; `fftw`/`mkl` unsupported | `demag.fft_backend` |
| `FDMDemag.explain` | `bool` | `True` | 1 | no runtime type guard | authoring-only explanation flag | authoring only; not a backend capability | not lowered |
| `FDMDemag.allow_single_grid_fallback` | `bool \| None` | `None` | 1 | any non-`None` value raises `ValueError` | removed compatibility input | unsupported on all lanes | no field; construction fails |

(fdm-multi-magnet-grids-problem-ir)=
## ProblemIR

`StudyBuilder.fdm(...)` applies the complete FDM policy to the current study. `FDM(cell=...)` is
the compatibility form: it emits both `cell` and `default_cell`, and cannot be combined with
`default_cell`. `FDM.demag` nests `FDMDemag.to_ir()` as `demag`. That payload always contains
`strategy`, `mode`, and `fft_backend`, and conditionally contains `common_cells`,
`common_cells_xy`, or `common_cell_size`. `explain` is accepted by the Python object but
deliberately not lowered.

(fdm-multi-magnet-grids-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves native grids and the nested demag policy, including requested FFT
realization. Resolved execution requires a certified common grid and a lane-compatible FFT
backend. Validation errors cover malformed grids, conflicting common-grid controls, nondivisible
common extents, unknown enum values, unavailable/lane-incompatible FFT requests, explicit FFT
without active demag, multi-body `single_grid`, and every non-`None` request for the removed
fallback input. Unsupported combinations, transfers, certificates, or budgets reject before
allocation without fallback.

(fdm-multi-magnet-grids-discrete-realization)=
## Discrete realization

`validate_multilayer_grid_budget` checks topology-bound certificates, layer grid equality, masks,
and kernel accounting. The CPU operator owner is
`MultilayerDemagRuntime::compute_demag_fields_checked`: it pushes each source to the convolution
grid, performs FFTs, accumulates every destination/source tensor pair, then inverse-transforms and
pulls fields to native grids. CUDA owns the analogous FP64/FP32 paths in
`launch_multilayer_demag_field_fp64` and `launch_multilayer_demag_field_fp32`.

(fdm-multi-magnet-grids-implementation-mapping)=
## Implementation mapping

Python owns schema/lowering and `StudyBuilder.fdm(...)` applies it to the active study.
`FdmDemagHintsIR::validate` owns the explicit `two_d_stack`/`common_cell_size` rejection;
`plan_fdm_multilayer` owns multi-body strategy and exact common-grid resolution;
`plan_fdm_fft` owns FFT lane selection. Runner owns preflight. The engine and native CUDA
functions listed below own convolution execution.

(fdm-multi-magnet-grids-validation)=
## Validation

Check IR names and grids, require a resolved certificate, then test invalid common-grid/certificate inputs. Sweep native and common cells for physical convergence.

(fdm-multi-magnet-grids-limitations)=
## Limitations

This contract does not prove `two_d_stack` equals `three_d` or GPU parity. `explain` has no
runtime type guard and is not represented in ProblemIR. `FDM.demag` likewise relies on its
annotation and calls `.to_ir()` when present. The example applies its per-magnet grids and FFT
policy directly through `StudyBuilder.fdm(...)`.

(fdm-multi-magnet-grids-scientific-bibliography)=
## Scientific bibliography

- C. Abert, *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- A. J. Newell, W. Williams and D. J. Dunlop, *J. Geophys. Res.* **98** (1993), 9551-9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).

(fdm-multi-magnet-grids-source-code-index)=
## Source-code index

| Source | Stable symbol | Evidence |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | public `fdm(...)` application route |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | per-magnet grid |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | policy validation |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | FDM lowering |
| `crates/fullmag-ir/src/mesh_hints.rs` | `FdmDemagHintsIR` | IR validation, including `common_cell_size` mode restriction |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_fft` | executable FFT backend and active-demag checks |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | multi-body strategy and common-grid resolution |
| `crates/fullmag-runner/src/fdm/mod.rs` | `validate_multilayer_grid_budget` | fail-closed preflight |
| `crates/fullmag-runner/src/fdm/cpu/multilayer_reference/construction.rs` | `build_contexts_and_states` | CPU construction |
| `crates/fullmag-engine/src/multilayer.rs` | `compute_demag_fields_checked` | CPU convolution operator |
| `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu` | `launch_multilayer_demag_field_fp64` | CUDA FP64 convolution owner |
| `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu` | `launch_multilayer_demag_field_fp32` | CUDA FP32 convolution owner |

## Scope and purpose

This page defines the public contract for multiple magnets on one FDM grid. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is cell_size, origin, object placement, and overlap policy. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.