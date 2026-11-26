---
title: "FDM periodic grids"
description: "Periodic FDM axes and finite-image demagnetization."
summary: "Periodic topology and truncated-image demag are explicit fail-closed policies."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "FdmPbc, runner resolution, half-spectrum D2Z/R2C cuFFT workspace preflight, CPU periodic spectra"
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
| $\mathbf H_d$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf r_i$ | target cell centre | $\mathrm{m}$ |
| $\mathbf L$ | unit-cell period | $\mathrm{m}$ |
| $\mathbf n$ | image index | $1$ |
| $\mathcal I$ | finite image set | $1$ |
| $\mathbf M_j$ | source magnetization | $\mathrm{A\,m^{-1}}$ |

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
film = study.geometry(fm.Box(100 * nm, 40 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.pbc(x=True, y=True, z=False, demag="truncated_images", images=(4, 4, 0))
study.demag()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FdmPbc.axes` | `tuple[bool, bool, bool]` | required | $1$ | iterates input, applies `bool(value)`, then requires length three | periodic flags | FDM CPU source-backed; GPU capability-gated; FEM separate contract | `pbc.axes` as `periodic` or `open` |
| `FdmPbc.demag` | `str` | `open` | $1$ | applies `strip().lower()`, then requires `open`, `truncated_images`, or `periodic_airbox_k0` | normalized requested demag policy | FDM CPU open/truncated source-backed; GPU capability-gated; FEM differs | `pbc.demag` |
| `FdmPbc.image_counts` | `tuple[int, int, int] \| None` | `None` | $1$ | applies `int(value)`, then requires length three and non-negative results; only `truncated_images` | finite image ranges; when omitted for active periodic truncated demag, resolves to 10 on periodic axes and 0 on open axes | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `pbc.image_counts` |

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

`resolve_demag_boundary` owns the resolved boundary policy, axis-specific image counts, and the 1,000,000-term budget. `resolve_periodic_images` owns execution padding and workspace accounting: a periodic axis uses padding `N` and an open axis uses `2N`, estimating **three real-domain buffers** on `padded_cells` plus **twelve Hermitian half-spectrum complex buffers** (six half-spectrum Newell kernels and six half-spectrum spectral work buffers) on `(padded_x / 2 + 1) * padded_y * padded_z` (`spectral_cells`), rejecting estimates above 8 GiB before allocation.

On CUDA FDM GPU, demagnetization uses Hermitian half-spectrum **D2Z/Z2D** (FP64) and **R2C/C2R** (FP32) `cuFFT` plans with shared forward/inverse work area (`max(work_fwd, work_inv)`) and **exact cuFFT workspace preflight** (`alloc_fft_workspace` with `cufftSetAutoAllocation(..., 0)` and exact `cufftMakePlanMany` sizing before allocation). Across the 15 audited RTX 4080 SUPER geometries, half-spectrum transforms reduce `gpu_workspace.peak_vram_bytes` by **12.0–23.1%** (e.g., `-12.0%` on `pbcxy_128x128x2` FP64 from `25.34 MB` to `22.29 MB` and `-22%` to `-23%` on open 3D grids). XY-periodic multilayer PG-BB relaxation is also supported on FP64 CUDA. CPU `compute_periodic_newell_kernel_spectra` owns finite Newell image spectra, while the runner validates resolved metadata. See {ref}`numerical-methods-performance-fdm-core` for full CUDA benchmark evidence.

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FDM | CPU | implemented | Open and `truncated_images` finite Newell spectra via `compute_periodic_newell_kernel_spectra` |
| FDM | GPU | implemented (FP64; FP32+PBC gated) | D2Z/Z2D half-spectrum cuFFT with exact workspace preflight (`-12.0%` VRAM on `pbcxy_128x128x2`) and XY-periodic multilayer FP64 PG-BB; FP32 + PBC remains fail-closed |
| FEM | CPU | not applicable | Periodic FEM airbox meshes use [Periodic FEM airbox mesh](../fem/airbox/periodic-airbox.md) |
| FEM | GPU | not applicable | Periodic FEM airbox meshes use [Periodic FEM airbox mesh](../fem/airbox/periodic-airbox.md) |

(fdm-periodic-grids-implementation-mapping)=
## Implementation mapping

`StudyBuilder.pbc` applies the public setting; `FdmPbc` owns normalization, schema, and lowering; `resolve_demag_boundary` owns resolved counts and the image-term budget; `resolve_periodic_images` owns half-spectrum padding and workspace accounting; `alloc_fft_workspace` owns exact CUDA cuFFT workspace preflight and allocation; the runner validates resolved metadata; and CPU FFT owns periodic spectra.

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
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) | public `fdm(...)` and `pbc(...)` application routes |
| [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) | [`class FdmPbc`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) | policy validation and IR |
| [`crates/fullmag-ir/src/execution.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/execution.rs#L357) | [`resolve_demag_boundary`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/execution.rs#L357) | default/resolved image counts and image-term budget |
| [`crates/fullmag-ir/src/execution.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/execution.rs#L409) | [`resolve_periodic_images`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/execution.rs#L409) | periodic padding and workspace accounting |
| [`crates/fullmag-runner/src/fdm/mod.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/mod.rs#L102) | [`resolve_fdm_demag_boundary_for_periodicity`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/mod.rs#L102) | runtime policy resolution |
| [`backends/fdm/gpu/cuda/runtime/context.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/context.cu#L2886) | [`alloc_fft_workspace`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/context.cu#L2886) | exact cuFFT half-spectrum workspace preflight and shared forward/inverse work area |
| [`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L712) | [`compute_periodic_newell_kernel_spectra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L712) | CPU periodic spectra |
