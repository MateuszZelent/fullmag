---
title: Validation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0910-permalloy-film-fem-demag-benchmark.md
---

(public-docs-physics-interactions-demagnetization-validation)=
# Validation

Demagnetization validation establishes physical correctness, numerical convergence, and backend
qualification separately. A source-level contract test is evidence of an implementation contract,
not proof of an executed GPU result. For full timing and VRAM benchmark matrices, see
{ref}`numerical-methods-performance`, {ref}`numerical-methods-performance-fdm-core`, and
{ref}`numerical-methods-performance-fem-gpu-demag`.

(demag-validation-problem-statement)=
## Physical problem

The observable pair is the demagnetizing field and self-energy. A valid test therefore checks field
direction and magnitude, energy sign and magnitude, and the relation between them.
The test record must also identify whether the field is cell-centred, nodal, element-recovered,
or sampled after interpolation. Comparing fields at different locations can otherwise produce an
apparently small error for the wrong reason.

(demag-validation-governing-equations)=
## Governing equations

```{math}
:label: eq-demag-validation-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

```{math}
:label: eq-demag-validation-residual
r=\nabla\cdot(\mathbf H_{\mathrm d}+\mathbf M),
\qquad
\nabla\times\mathbf H_{\mathrm d}=\mathbf 0.
```

(demag-validation-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $r$ | magnetic divergence residual | $\mathrm{A\,m^{-2}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |

(demag-validation-assumptions-and-validity)=
## Assumptions and validity

Every comparison must state geometry, material, grid/mesh, boundary policy, precision, solver
tolerance, and whether the device actually executed the kernel. Relative errors without absolute
scales are insufficient for near-zero fields.

(demag-validation-python-api)=
## Python API

This stage-first FDM scenario fixes the geometry, grid, precision, boundary policy, initial state,
and output cadence needed by a demagnetization validation artifact. A refinement study should rerun
the same script with successively smaller cells while preserving every other requested setting.

```python
# %% Imports and units
import fullmag as fm

nm = 1.0e-9

# %% Study and reference execution lane
study = fm.study("demag_rectangular_prism_validation")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 4 * nm))

# %% Geometry, material, state, and isolated demagnetization term
prism = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 4 * nm), name="prism"),
    name="prism",
)
prism.Ms = 8.0e5
prism.Aex = 1.3e-11
prism.alpha = 0.02
prism.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange(enabled=False)
study.demag()
study.solver(integrator="rk4", fix_dt=5.0e-15)

# %% Ordered measurement stage
study.stages.add_run(stage_id="measure_demag", until=1.0e-12).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            t_sampl=1.0e-13,
            quantities=[
                "t",
                "mx",
                "my",
                "mz",
                "e_demag",
                "e_total",
                "max_h_demag",
            ],
        ),
        fields=[fm.FieldAutosave("H_demag", every=2.0e-13)],
    )
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | Canonical model validation. | Selects realization under test. | Planner-dependent. | `energy[].realization` |
| `SaveField("H_demag")` | `str` | required | $\mathrm{A\,m^{-1}}$ | Quantity must be materializable. | Requests vector field. | Executable lane-dependent. | `outputs[].quantity` |
| `SaveScalar("E_demag")` | `str` | required | $\mathrm{J}$ | Quantity must be materializable. | Requests global energy. | Executable lane-dependent. | `outputs[].quantity` |

(demag-validation-problem-ir)=
## ProblemIR

The interaction and output requests are lowered separately. Planner validation must verify that the
selected realization can materialize `H_demag` and `E_demag` before execution.

(demag-validation-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The report records **requested intent**, **resolved execution**, **validation errors**, and
**unsupported combinations**. A missing quantity is a fail-closed planner error rather than a
zero-filled result.

Requested intent contains the chosen model, mesh/grid, output quantities, tolerance, `gpu_strategy`,
precision, and device request. Resolved execution contains the selected backend realization, actual
mesh identity, resolved linear solver (`cudss_direct` or `hypre_krylov`), fallback reason, iteration
count, convergence flag, field recovery, energy reduction, and runtime/device identity.

(demag-validation-discrete-realization)=
## Discrete realization

FDM compares cell fields and volume-weighted energy. FEM compares recovered nodal/element fields,
integrated energy, and residuals. CPU/GPU parity requires the same precision and tolerance.
See {numref}`fig-demag-solver-families-comparison` on {doc}`index` for the operator distinctions
between FDM convolution, FEM Poisson airbox, FEM–BEM Fredkin–Koehler, and periodic demagnetization.

For FDM, the reference comparison must fix cell dimensions, padding, kernel convention, FFT
normalization, self-term, and periodic-image policy. For FEM, it must fix the magnetic/air domain,
boundary marker, Robin or Dirichlet closure, mesh topology (`tet4`, `mixed_p1`, `pure_prism_p2`)
and potential order (`P1` vs `P2`), linear solver, preconditioner, `gpu_strategy`, relative
tolerance, absolute tolerance when present, and maximum iterations.

(demag-validation-error-metrics)=
## Error metrics and acceptance

Use more than one metric:

| Quantity | Definition | Why it is required |
|---|---|---|
| Field absolute error | $\lVert\mathbf H-\mathbf H_{\mathrm{ref}}\rVert_2$ | Detects errors near zero without unstable relative division. |
| Field relative error | $\lVert\mathbf H-\mathbf H_{\mathrm{ref}}\rVert_2/(\lVert\mathbf H_{\mathrm{ref}}\rVert_2+H_*)$ | Compares scale after declaring positive reference floor $H_*$. |
| Energy error | $\lvert E-E_{\mathrm{ref}}\rvert/(\lvert E_{\mathrm{ref}}\rvert+E_*)$ | Tests the global reduction independently of pointwise field error. |
| Maxwell residual | Norm of $r$ and curl residual | Detects a plausible energy with an invalid field. |
| Refinement slope | Observed error versus grid/mesh scale | Distinguishes convergence from accidental agreement. |

The report must state $H_*$ and $E_*$ whenever relative metrics are used.

(demag-validation-lane-matrix)=
## Lane-specific qualification and RTX 4080 SUPER evidence

| Lane | Status | Executed evidence summary | Exact boundary |
|---|---|---|---|
| FDM CPU | `reference` | Newell 27-point tensor symmetry, Aharoni rectangular prism (`−6e-7%`), single-layer mixed periodic dipole tail ($r \ge 40\,h_{\max}$), and CPU FP64 multilayer oracles. | Reference FP64 lane. |
| FDM GPU | `implemented` | RTX 4080 SUPER Hermitian `D2Z/Z2D` (FP64) parity: `rel dE_demag <= 1.76e-16` and `rel dE_total = 0.00e+00` (step 50) across all 8 FP64 geometries (`rel dE_total <= 2.63e-14`, `max \|dm\| <= 1.22e-8` at step 500), `−12.0%` to `−23.1%` peak VRAM, up to `3.21×` step speedup. | Single-layer FP64/FP32 verified; FP32+PBC intentionally rejected; multilayer CUDA remains partial. |
| FEM CPU | `implemented` | MFEM/Hypre open Poisson (`tet4` P2, `mixed_p1`, `pure_prism_p2`), periodic reduced P1, and hierarchical $H^2$ Fredkin–Koehler contracts. | Reference CPU FEM lane. |
| FEM GPU | `implemented` | RTX 4080 SUPER A/B parity across open Poisson (`max \|Δm\| <= 2.51e-11`, `19.1×–218.4×`), PBC-reduced 1-D Robin / 2-D film (`max \|Δm\| <= 3.51e-11`, `26.8×–35.5×`), strict GPU FEM–BEM (`max \|Δm\| = 4.88e-14`, `34.6×` vs AMG, `0` memcheck errors), and `pure_prism_p2` Aharoni benchmark (`−0.60%` vs Aharoni, `−0.43%` vs FDM, `+0.30%` vs MuMax3). | Periodic `pure_prism_p2`, unpinned 3-D Neumann, and `fmm` remain fail-closed. |

### Executed RTX 4080 SUPER parity and benchmark summary

All GPU evidence below was collected inside managed Docker DEV containers on an **NVIDIA GeForce
RTX 4080 SUPER** (16 GiB VRAM, SM 8.9, CUDA 12.6, `cuDSS 0.8.0.10`, `precision="double"`):

| Benchmark suite | Configuration | Key accuracy / parity metric | Speedup / VRAM result |
|---|---|---|---|
| FDM GPU Hermitian `D2Z/Z2D` cuFFT (8 FP64 geometries) | Single-layer Heun/RK4 (film, 3-D, `pbcxy`, cylinder) | `rel dE_demag <= 1.76e-16` (s50); `rel dE_total <= 2.63e-14`, `max \|dm\| <= 1.22e-8` (s500) | **1.09×–3.21×** step speedup; **−12.0% to −23.1%** peak VRAM |
| FEM GPU open Poisson `cuDSS` vs `cg_amg` | SP4 (`8,208` nodes) & medium (`49,600` nodes), Heun/RK4, `rtol=1e-8` | `max \|Δm\| <= 2.51e-11`, `rel \|ΔE_d\| <= 4.48e-11`, `max_res <= 8.22e-14` | **19.1×–218.4×** (`auto`/`cuDSS`), **1.24×–2.19×** (`cg_amg`) |
| FEM GPU VRAM budget guard (`MAX_VRAM_MIB=32`) | `49,600` nodes (`3.13 GiB` est. > `32 MiB` cap) | `auto -> hypre_krylov` bit-exact `0.0` vs `cg_amg`; forced `cudss` exits hard `rc=2` | `factorization_started = false` (`factor_nnz = 0`) |
| FEM GPU PBC-reduced `cuDSS` | 1-D Robin & 2-D film (Neumann + pin), `8,379` nodes, Heun/RK4 | `max \|Δm\| <= 3.51e-11`, `max_res <= 1.87e-14`, FSAL `k0` active | **26.8×–35.5×** vs baseline Krylov |
| FEM GPU Fredkin–Koehler FEM–BEM | Open `1,183` nodes, `5,184` `tet4`, `664` boundary nodes, Heun | `max \|Δm\| = 4.88e-14`, `rel \|ΔE_d\| = 1.54e-14`, `rel \|ΔH_d\| = 2.27e-13` vs CPU; `0` memcheck errors | `2.202 ms/step` (**34.6×** vs GPU AMG, **19.5×** vs GPU JACOBI, **5.4×** vs CPU) |
| FEM GPU `pure_prism_p2` thin-film Aharoni benchmark | `300×300×5 nm` Permalloy, `L=2, h=5.0 nm`, `709,253` P2 DOFs, PGBB (`8,153` steps) | Uniform `−0.60%` vs Aharoni (`4.60508e-18` vs `4.63285e-18 J`); relaxed `−0.43%` vs FDM, `+0.30%` vs MuMax3 | Mesh `0.51 s` (**246×** vs `tet P2`), `51.88 ms/step` (`L=1`: `38.53 ms`, **144.8×** vs `cg_amg`), `6.73 GiB` cuDSS |
| Mixed `layers=2` `tet4` conformity untangler | `300×300×5 nm`, `h=2.5 nm`, `pyramid_to_tetrahedra` | `same_side_two_owner_face`: `6 -> 0` (`p05(prism6) = 0.8616`) | `7.52 ms/step` on GPU `cuDSS` (`180 MB`) |

(demag-validation-implementation-mapping)=
## Implementation mapping

Contract tests include `batched_demag_fft_contract.cpp`, `multilayer_create_v2_contract.cpp`,
`cuda_demag_robin_energy_contract.cpp`, `cuda_periodic_demag_contract.cpp`,
`cudss_poisson_budget_contract.cpp`, `demag_fem_bem_gpu_contract.cpp`, and
`fem_pure_prism_p2_gpu_contract.cpp`, backed by executed RTX 4080 SUPER A/B verification runs.

### Control Room support

Demagnetization settings are hosted under `Model Explorer -> Objects -> <object> -> Physics` by
`ObjectPhysicsInspectorPanel`
(`apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx`).
Browser exposure is partial: validation tolerances, solver strategies, and output schedules without
a UI control must be configured in Python or `ProblemIR`. See {doc}`/frontend/capability-register`
for current Control Room coverage.

(demag-validation-validation)=
## Validation matrix

| Test family | Required evidence |
|---|---|
| Analytical rectangle (Aharoni 1998) | Demag factors and uniform energy against exact analytic prism reference (`pure_prism_p2` `−0.60%`, FDM `−6e-7%`). |
| FDM tensor/FFT | Kernel symmetry, self term, padding, exact cuFFT preflight, and RTX 4080 SUPER FP64 Hermitian parity (`<= 1.76e-16`). |
| FEM airbox | Mesh, airbox, and P1/P2 convergence, Robin energy accounting, residual certification, and RTX 4080 SUPER `cuDSS`/Krylov A/B parity. |
| FEM/BEM | Watertight surface orientation, solid-angle/ACA probes, CPU `boundary_tdofs_by_row`, and RTX 4080 SUPER GPU parity (`4.88e-14`) + memcheck. |
| Periodic | Image-count and distant dipole-tail ($r \ge 40\,h_{\max}$) checks for FDM; PBC-reduced 1-D Robin / 2-D film `cuDSS` parity for FEM. |
| Qualification | Same tolerance, same precision, runtime identity, executed device, and strict operator receipt. |

(demag-validation-limitations)=
## Limitations

- Executed RTX 4080 SUPER evidence does not automatically qualify unmeasured GPU architectures,
  multi-GPU execution, or out-of-scope features (FDM CUDA FP32+PBC, multilayer FDM CUDA parity,
  periodic `pure_prism_p2`, unpinned 3-D periodic FEM Neumann, or `fmm`).
- Historical reports and source-only tests do not substitute for fresh executed-device receipts on
  the current commit.

(demag-validation-scientific-bibliography)=
## Scientific bibliography

1. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research: Solid Earth* **98**(B6), 9551–9555
   (1993), [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
2. A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied
   Physics* **83**(6), 3432–3434 (1998),
   [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
3. D. Chernyshenko and H. Fangohr, “Computing the demagnetizing tensor for finite difference
   micromagnetic simulations via numerical integration,” *Journal of Magnetism and Magnetic
   Materials* **381**, 440–445 (2015),
   [doi:10.1016/j.jmmm.2015.01.013](https://doi.org/10.1016/j.jmmm.2015.01.013), Open Access
   preprint: [arXiv:1403.1978](https://arxiv.org/abs/1403.1978).
4. R. Bjørk, E. B. Poulsen, K. K. Nielsen, and A. R. Insinga, “MagTense: A micromagnetic
   framework using the analytical demagnetization tensor,” *Journal of Magnetism and Magnetic
   Materials* **535**, 168057 (2021),
   [doi:10.1016/j.jmmm.2021.168057](https://doi.org/10.1016/j.jmmm.2021.168057), Open Access
   preprint: [arXiv:2107.05364](https://arxiv.org/abs/2107.05364).

(demag-validation-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility | Lane | Immutable link |
|---|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Validation target selection. | Public API | [`energy.py#L51`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` | Single-layer CUDA FP64 Hermitian `D2Z/Z2D` cuFFT production field path. | FDM GPU | [`demag_fp64.cu#L671`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671) |
| `backends/fem/cpu/mfem/interactions/demag.cpp` | `compute_demag_field_for_magnetization` | FEM production field path used by validation. | FEM CPU | [`demag.cpp#L167`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag.cpp#L167) |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_demag_cudss_direct` | Three-state VRAM-guarded `cuDSS` direct solver admission verified in A/B suites. | FEM GPU | [`cudss_direct_solver.cpp#L653`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `compute_device_demag_fem_bem_for_device_stage` | Strict device-resident GPU Fredkin–Koehler field path verified against CPU oracle. | FEM GPU | [`fem_bem.cpp#L1161`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L1161) |
| `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` | `ObjectPhysicsInspectorPanel` | Object-level physics inspector exposing demagnetization settings. | Control Room | [`ObjectPhysicsSpec.tsx#L78`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx#L78) |
