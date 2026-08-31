---
title: "FDM periodic grids"
description: "Periodic FDM axes and finite-image demagnetization."
summary: "Periodic topology and truncated-image demag are explicit fail-closed policies."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FdmPbc, runner resolution, CPU periodic spectra"
---

(public-docs-numerical-methods-meshing-fdm-periodic-grids)=
# FDM periodic grids

(fdm-periodic-grids-problem-statement)=
## Physical problem

`FdmPbc` records periodic local topology and a separate demagnetization policy. `truncated_images` is finite translated-image magnetostatics, not an infinite periodic Green function.

(fdm-periodic-grids-governing-equations)=
## Governing equations

```{math}
:label: eq-fdm-periodic-images
\mathbf H_d(\mathbf r_i)=\sum_{\mathbf n\in\mathcal I}\sum_j\mathcal N(\mathbf r_i-\mathbf r_j-\mathbf n\odot\mathbf L)\mathbf M_j .
```

(fdm-periodic-grids-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf H_d$ | demagnetizing field | A m^-1 |
| $\mathbf r_i$ | target cell centre | m |
| $\mathbf L$ | unit-cell period | m |
| $\mathbf n$ | image index | 1 |
| $\mathcal I$ | finite image set | 1 |
| $\mathbf M_j$ | source magnetization | A m^-1 |

(fdm-periodic-grids-assumptions-and-validity)=
## Assumptions and validity

`axes` is first iterated and every value is converted with `bool(value)`; only then must the resulting tuple have length three. If `image_counts` is present, every value is first converted with `int(value)`, then the resulting tuple must have length three and contain no negative value. Consequently numeric strings and truncatable floats can be accepted, while conversion itself may raise `TypeError`, `ValueError`, or `OverflowError`. The demagnetization string is normalized with `strip().lower()` before policy validation. Image counts remain valid only with `truncated_images`. FDM rejects `periodic_airbox_k0`, which is FEM-only. Converge image counts and cell size separately.

(fdm-periodic-grids-python-api)=
## Python API

```python
# %%
import fullmag as fm
nm = 1e-9
study = fm.study("periodic-grid")
study.engine("fdm")
study.fdm(default_cell=(2 * nm, 2 * nm, 5 * nm))
study.pbc(x=True, y=True, z=False, demag="truncated_images", images=(4, 4, 0))
study.demag()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FdmPbc.axes` | `tuple[bool, bool, bool]` | required | 1 | iterates input, applies `bool(value)`, then requires length three | periodic flags | FDM CPU source-backed; GPU capability-gated; FEM separate contract | `pbc.axes` as `periodic` or `open` |
| `FdmPbc.demag` | `str` | `open` | 1 | applies `strip().lower()`, then requires `open`, `truncated_images`, or `periodic_airbox_k0` | normalized requested demag policy | FDM CPU open/truncated source-backed; GPU capability-gated; FEM differs | `pbc.demag` |
| `FdmPbc.image_counts` | `tuple[int, int, int] \| None` | `None` | 1 | applies `int(value)`, then requires length three and non-negative results; only `truncated_images` | finite image ranges; when omitted for active periodic truncated demag, resolves to 10 on periodic axes and 0 on open axes | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `pbc.image_counts` |

(fdm-periodic-grids-problem-ir)=
## ProblemIR

`StudyBuilder.pbc(...)` applies the setting to the study and constructs `FdmPbc`; `FdmPbc.to_ir()` emits axis strings, the normalized policy, and optional image counts. FDM lowering rejects `periodic_airbox_k0` rather than changing policy.

(fdm-periodic-grids-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the coerced Boolean flags, normalized demagnetization policy, and integer counts, not necessarily the caller's original Python value types. Resolved execution validates the runtime boundary and periodic workspace. With active demagnetization, at least one periodic axis, and `truncated_images`, omitted `image_counts` first supplies requested counts `[10, 10, 10]`; resolution keeps 10 on each periodic axis and sets every open axis to 0. The resolved number of translated-image terms is

```{math}
N_{\mathrm{images}}=\prod_{\alpha\in\{x,y,z\}}(2n_\alpha+1),
```

where resolved open-axis counts are zero. Resolution rejects more than 1,000,000 image terms. Validation errors cover non-iterable inputs, failed `bool()`/`int()` conversion, wrong post-coercion lengths, negative converted counts, invalid policy, image-budget overflow, or workspace-budget overflow. Unsupported combinations, including FDM `periodic_airbox_k0` and periodic demag without `truncated_images`, fail closed.

(fdm-periodic-grids-discrete-realization)=
## Discrete realization

`resolve_demag_boundary` owns the resolved boundary policy, axis-specific image counts, and 1,000,000-term budget. `resolve_periodic_images` owns execution padding and workspace accounting: a periodic axis uses padding `N`, an open axis uses `2N`, and the estimate includes three real buffers plus twelve complex spectral buffers. A workspace estimate above 8 GiB is rejected before allocation. CPU `compute_periodic_newell_kernel_spectra` owns finite Newell image spectra, while the runner consumes and validates the resolved metadata.

(fdm-periodic-grids-implementation-mapping)=
## Implementation mapping

`StudyBuilder.pbc` applies the public setting; `FdmPbc` owns normalization, schema, and lowering; `resolve_demag_boundary` owns resolved counts and the image-term budget; `resolve_periodic_images` owns padding and workspace accounting; the runner validates the resolved metadata; and CPU FFT owns periodic spectra.

(fdm-periodic-grids-validation)=
## Validation

Sweep image counts at fixed grid and cell size at fixed images; record field, energy, padding, precision, and kernel identity. Confirm FDM plus `periodic_airbox_k0` rejects.

(fdm-periodic-grids-limitations)=
## Limitations

Finite images require convergence and are not an Ewald implementation. The default of 10 images per periodic axis is a resolution default, not evidence of convergence. GPU remains capability-gated.

(fdm-periodic-grids-scientific-bibliography)=
## Scientific bibliography

- C. Abert, *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- A. J. Newell, W. Williams and D. J. Dunlop, *J. Geophys. Res.* **98** (1993), 9551-9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).

(fdm-periodic-grids-source-code-index)=
## Source-code index

| Source | Stable symbol | Evidence |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | public `fdm(...)` and `pbc(...)` application routes |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | policy validation and IR |
| `crates/fullmag-ir/src/execution.rs` | `resolve_demag_boundary` | default/resolved image counts and image-term budget |
| `crates/fullmag-ir/src/execution.rs` | `resolve_periodic_images` | periodic padding and workspace accounting |
| `crates/fullmag-runner/src/fdm/mod.rs` | `resolve_fdm_demag_boundary_for_periodicity` | runtime policy resolution |
| `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | CPU periodic spectra |

## Scope and purpose

This page defines the public contract for periodic FDM grids. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is cell_size, periods, and periodic-axis controls. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.