---
title: Periodic Demag
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: /physics/interactions/demagnetization/periodic-demag
---

(public-docs-numerical-methods-demag-solvers-periodic-demag)=
# Periodic demagnetization solvers

(numerical-methods-periodic-demag-problem-statement)=
## Scope and purpose

The canonical interaction is owned by {doc}`../../physics/interactions/demagnetization/periodic-demag`.
Periodic demagnetization is a different Green-function problem from open-boundary demagnetization:
an axis marked periodic identifies translated cells or representative mesh degrees of freedom, and
the zero-wave-number or null-potential policy becomes part of the numerical problem. Fullmag has
two documented realization families: finite translated-image summation for FDM (including distant
point-dipole stabilized single-layer mixed boundaries and XY-periodic multilayer CUDA PG-BB) and a
reduced periodic Poisson system for FEM (supporting both 1D-periodic Robin and 2D-periodic
pure-Neumann film-pin solves on CPU and GPU `cuDSS`/`CG+AMG`). Neither is silently substituted
for the other or for the open kernel.

(numerical-methods-periodic-demag-governing-equations)=
## Scientific and numerical model

For FEM, let $P$ lift one value per periodic representative to all equivalent mesh degrees of
freedom. The reduced stiffness system is

```{math}
:label: eq-numerical-periodic-demag-reduction
A_p=P^{\mathsf T}A_{\mathrm{open}}P,
\qquad
b_p=P^{\mathsf T}b,
\qquad
A_pu_p=b_p.
```

Because $P$ has full column rank, $A_p$ is strictly SPD whenever $A_{\mathrm{open}}$ has its
constant nullspace removed — enabling direct factor-once `cuDSS` Cholesky on GPU for 1D-periodic
Robin ($\beta > 0$), 2D-periodic thin films, and 1D/2D Dirichlet closures. For 2D-periodic thin
films requesting `poisson_robin`, a nonzero Robin parameter $\beta$ introduces an algebraic
stray-field leak $N_{zz}^{\mathrm{Robin}} = (1 + \beta d)/(1 + \beta L) < 1$; the native boundary
operator ([`initialize_demag_poisson_boundary_operator`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124))
therefore resolves 2D-periodic films to pure Neumann ($\beta = 0$) and removes the constant
nullspace by eliminating one singleton open-boundary potential DOF ([`film_neumann_gauge_pin_tdof`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88)),
zeroing the eliminated class in $b_p$ on both CPU and GPU so $N_{zz} = 1$ with zero stray field in
the exterior air.

The physical potential is lifted before taking its gradient, and the field-based energy is reduced
over the magnetic volume:

```{math}
:label: eq-numerical-periodic-demag-field-energy
\mathbf H_{\mathrm d}=-\nabla(Pu_p),
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

For FDM, the open Newell tensor is replaced by a periodic finite-image tensor. With translation
vectors $\mathbf t_{\boldsymbol\ell}$ and image set $\mathcal I$, the discrete convolution is

```{math}
:label: eq-numerical-periodic-demag-fdm-sum
\mathbf H_{\mathrm d}(\mathbf r_i)=
-\sum_{\boldsymbol\ell\in\mathcal I}
\sum_j
\mathbf N(\mathbf r_i-\mathbf r_j-\mathbf t_{\boldsymbol\ell})\mathbf M(\mathbf r_j),
\qquad
\mathcal I=\{-n_x,\ldots,n_x\}\times\{-n_y,\ldots,n_y\}\times\{-n_z,\ldots,n_z\}.
```

For single-layer mixed-boundary films (one periodic in-plane axis, one open in-plane axis),
[`compute_single_layer_mixed_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5)
folds images directly into centred lags and transitions distant lags ($r \ge 40\max(h_x,h_y,h_z)$)
to the point-dipole limit to eliminate binary64 cancellation at long replica ranges. The image
counts change the operator itself; they are not a gauge parameter and are not interchangeable with
the FEM null-space treatment.

(numerical-methods-periodic-demag-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $A_p$ | reduced periodic FEM stiffness operator | $\mathrm{m}$ |
| $A_{\mathrm{open}}$ | unreduced FEM stiffness operator | $\mathrm{m}$ |
| $P$ | periodic representative prolongation | $1$ |
| $b_p$ | reduced Poisson right-hand side | $\mathrm{A\,m}$ |
| $b$ | unreduced Poisson right-hand side | $\mathrm{A\,m}$ |
| $u_p$ | reduced scalar potential | $\mathrm{A}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic volume | $\mathrm{m^3}$ |
| $\mathbf r_i$ | FDM cell-center position | $\mathrm{m}$ |
| $\mathbf t_{\boldsymbol\ell}$ | periodic translation vector | $\mathrm{m}$ |
| $\mathcal I$ | finite image-index set | $1$ |
| $n_x$ | periodic image count along $x$ | $1$ |
| $n_y$ | periodic image count along $y$ | $1$ |
| $n_z$ | periodic image count along $z$ | $1$ |
| $\mathbf N$ | demagnetizing tensor kernel | $1$ |
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |

(numerical-methods-periodic-demag-assumptions-and-validity)=
## Assumptions and validity

- `FdmPbc.axes` contains exactly three Boolean axis flags. `demag="truncated_images"` is a finite
  approximation to an infinite image sum; increasing image counts is required for a convergence
  study.
- On FDM GPU, FP64 supports single-layer periodic demagnetization (including `D2Z`/`Z2D` half-spectrum
  cuFFT and mixed single-layer kernels) as well as XY-periodic multilayer PG-BB relaxation
  ([`context_multilayer_bb`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/multilayer_bb.cu#L159));
  FP32 periodic CUDA remains intentionally gated off.
- FEM periodic reduction requires a valid periodic mesh certificate and a separately recorded
  null-space/zero-mode policy. 2D-periodic films automatically resolve `poisson_robin` to pure
  Neumann ($\beta = 0$) with a singleton open-boundary gauge pin; missing singleton boundary DOFs
  or 3D-periodic pure-Neumann systems without a gauge pin fail closed (`CUDSS_DATA_INFO != 0` on
  GPU even under `gpu_strategy="auto"`).
- `periodic_airbox_k0` is FEM-only. It is a planner error for FDM and must not silently fall back
  to `open` or `truncated_images`.

(numerical-methods-periodic-demag-python-api)=
## Python API

The public authoring surface is stage-first. Periodicity is attached to the study before stages are
created; it is not expressed through a legacy aggregate problem object.

```python
# %% Periodic FDM demagnetization with explicit image truncation
import fullmag as fm

nm = 1.0e-9
study = fm.study("periodic_fdm_demag")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.pbc(x=True, y=True, z=False, demag="truncated_images", images=(4, 4, 0))
film = study.geometry(
    fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.demag()
study.solver(
    integrator="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-12,
    max_err=1.0e-7,
)
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-12,
    max_err=1.0e-7,
    max_steps=100,
    tolT=1.0e-6,
)
```

`study.pbc(...)` is the stage-first facade. The equivalent serialized object is `fm.FdmPbc`; the
constructor is useful when inspecting or testing the Python contract, while the documented script
should keep study construction and stage ordering visible.

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | exactly three Boolean values | periodic status of x, y, z | FDM planner; FEM mesh planner consumes the same intent | `pbc.axes` |
| `FdmPbc.demag` | `str` | `open` | $1$ | `open`, `truncated_images`, or `periodic_airbox_k0` | demagnetization boundary policy | FDM supports `open`/`truncated_images`; FEM supports 1D/2D periodic airbox and `periodic_airbox_k0` | `pbc.demag` |
| `FdmPbc.image_counts` | `tuple[int,int,int] \| None` | `None` | $1$ | exactly three non-negative integers; only with `truncated_images` | finite image counts $n_x,n_y,n_z$ | FDM CPU and FP64 CUDA (including mixed single-layer and XY-periodic multilayer) | `pbc.image_counts` |
| `study.pbc(..., x/y/z=...)` | `bool` flags | all `False` | $1$ | at least one axis for non-open policy | stage-first authoring facade for `FdmPbc.axes` | Python authoring; planner resolves backend legality | `pbc.axes` |

(numerical-methods-periodic-demag-problem-ir)=
## ProblemIR and provenance

The periodic policy is lowered independently from the interaction term:

```json
{
  "energy_terms": [{"kind": "demag"}],
  "backend_policy": {
    "engine": "fdm",
    "pbc": {
      "axes": ["periodic", "periodic", "open"],
      "demag": "truncated_images",
      "image_counts": [4, 4, 0]
    }
  }
}
```

The IR records requested periodic axes and the selected policy. Resolved execution additionally
records the chosen FDM/FEM lane, precision, actual image counts or representative-map certificate,
zero-mode/gauge-pin treatment, `resolved_linear_solver` (`"cudss_direct"` or `"hypre_krylov"` on
FEM GPU), solver residuals, field recovery, and energy reduction. Requested intent and resolved
execution are separate provenance fields.

(numerical-methods-periodic-demag-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Script export preserves the stage-first study, periodic axes, and demagnetization policy. Validation
errors include a wrong axis tuple length, invalid image counts, image counts without
`truncated_images`, `periodic_airbox_k0` requested for FDM, missing periodic mesh pairing, missing
singleton open-boundary DOF for 2D-film pure Neumann, and singular 3D-periodic pure Neumann without
a gauge pin (`CUDSS_DATA_INFO != 0`). Unsupported combinations are rejected explicitly; no fallback
to the open kernel or from GPU to CPU is permitted. Requested intent remains visible even when
resolved execution reports an unsupported lane, and the planner reports validation errors before
runtime submission.

(numerical-methods-periodic-demag-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | implemented | Periodic Newell spectra with finite translated-image truncation and far-lag point-dipole stabilization for mixed single layers |
| FDM | GPU | implemented | FP64 CUDA periodic single-layer `D2Z`/`Z2D` cuFFT (RTX 4080 SUPER verified) and XY-periodic multilayer PG-BB (`context_multilayer_bb`); FP32 periodic CUDA gated off |
| FEM | CPU | implemented | Periodic representative reduction $A_p = P^{\mathsf T} A_{\mathrm{open}} P$ with 1D Robin or 2D-film pure-Neumann ($\beta = 0$) + singleton gauge pin |
| FEM | GPU | implemented | PBC-reduced 1D Robin and 2D film-pin `cuDSS` direct Cholesky (`auto`/`cudss`) and HYPRE `CG/AMG` (`cg_amg`/fallback) with FSAL reuse; RTX 4080 SUPER A/B verified |

For FDM, changing `image_counts` changes the convolution kernel and therefore the computed field.
For FEM, changing the periodic node equivalence classes changes the matrix topology and right-hand
side.

(numerical-methods-periodic-demag-implementation-mapping)=
## Implementation mapping

Public periodic boundary policy lowering (`FdmPbc`), finite-image and mixed single-layer FDM kernel
construction, XY-periodic multilayer CUDA PG-BB, 2D-film pure-Neumann gauge pinning, and reduced
periodic FEM CPU/GPU (`cuDSS` and `CG/AMG`) solves are mapped in
{ref}`numerical-methods-periodic-demag-source-code-index`.

(numerical-methods-periodic-demag-validation)=
## Validation

- **FEM GPU PBC-reduced `cuDSS` A/B (RTX 4080 SUPER, `20×20×18` Kuhn `TET4`, `8,379` nodes, P1
  reduced, `rtol = 1e-8`, 50 timed steps):**
  - **1D-periodic Robin:** `auto` (`cudss_direct`, `25.3 MiB` VRAM, residual `<= 6.51e-15`) achieves
    **`28.6×`** Heun (`56.81 -> 1.99 ms/step`, `max |dm| = 3.51e-11`, `rel |dE_demag| = 1.22e-11`)
    and **`26.8×`** RK4 (`92.19 -> 3.44 ms/step`, `max |dm| = 2.66e-11`), with `fsal_reused == true`
    from step 2 (`3 -> 2` Heun, `5 -> 4` RK4).
  - **2D-periodic film (pure Neumann $\beta = 0$ + singleton gauge pin):** `auto` (`cudss_direct`,
    `25.2 MiB` VRAM, residual `<= 1.87e-14`) achieves **`35.5×`** Heun (`72.75 -> 2.05 ms/step`,
    `max |dm| = 3.39e-11`) and **`33.0×`** RK4 (`118.12 -> 3.58 ms/step`, `max |dm| = 3.42e-11`).
- **FDM GPU periodic & mixed single-layer:** `pbcxy` `128×128×2` Heun FP64 achieves `rel dE_total = 1.47e-14`,
  `max |dm| = 1.68e-9` vs baseline with `-12.0%` GPU workspace memory (`25.34 -> 22.29 MB`); mixed
  single-layer kernels match independent quadrature at long replica lags (`16,000`-cell lag error
  reduced from `O(10^-4)` to machine/quadrature level); XY-periodic multilayer CUDA PG-BB is covered
  by `multilayer_create_v2_contract` and `periodic_xy_kernel`.

See {ref}`numerical-methods-performance-fem-gpu-demag` and
{ref}`numerical-methods-performance-fdm-core` for full benchmark tables.

(numerical-methods-periodic-demag-limitations)=
## Limitations

Finite image summation is not an exact Ewald or infinite periodic Green function. CUDA FP32
periodic FDM remains intentionally gated off. 3D-periodic pure-Neumann FEM static demagnetization
without a gauge pin is singular and fails closed, and periodic `pure_prism_p2` is not yet qualified.
The Rust reference CPU FEM fallback (`crates/fullmag-engine/src/fem.rs`) retains Robin on 2D
periodic films whereas the native MFEM CPU and CUDA paths apply pure Neumann ($\beta = 0$) plus
singleton gauge pin.

(numerical-methods-periodic-demag-scientific-bibliography)=
## Scientific bibliography

- A. J. Newell, W. Williams, and D. J. Dunlop, “A method for computing the magnetostatic demagnetizing tensor for rectangular prisms,” *Geophysical Journal International* 124 (1993), 938–946, DOI: [10.1111/j.1365-246X.1993.tb04780.x](https://doi.org/10.1111/j.1365-246X.1993.tb04780.x).
- P. Gruszecki et al., “Influence of magnetic surface anisotropy on spin wave reflection from the edge of ferromagnetic film,” *Scientific Reports* 6 (2016), 22367, DOI: [10.1038/srep22367](https://doi.org/10.1038/srep22367).
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/periodic-demag`.
- Performance references: {ref}`numerical-methods-performance-fem-gpu-demag`, {ref}`numerical-methods-performance-fdm-core`.

(numerical-methods-periodic-demag-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Python periodic contract | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) | [`class FdmPbc`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) | validation and IR lowering | Python contract tests |
| FDM periodic spectra | [`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L713) | [`compute_periodic_newell_kernel_spectra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L713) | finite-image kernel spectrum | FDM source contract |
| FDM mixed single-layer images | [`crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) | [`compute_single_layer_mixed_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) | point-dipole stabilized single-layer mixed dipolar images | Rust quadrature tests |
| FDM XY-periodic multilayer PG-BB | [`backends/fdm/gpu/cuda/runtime/multilayer_bb.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/multilayer_bb.cu#L159) | [`context_multilayer_bb`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/multilayer_bb.cu#L159) | XY-periodic multilayer FP64 CUDA PG-BB relaxation | CUDA contract tests |
| FEM 2D-film pure-Neumann pin | [`backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88) | [`film_neumann_gauge_pin_tdof`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88) | singleton open-boundary gauge pin for $\beta = 0$ films | FEM periodic contracts |
| FEM reduced solve | [`backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp#L199) | [`solve_demag_periodic_poisson_reduced`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp#L199) | periodic Poisson reduction and eliminated-RHS zeroing | FEM source contract |
| FEM GPU PBC `cuDSS` | [`backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) | [`try_initialize_demag_cudss_direct`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) | PBC-reduced 1D Robin & 2D film-pin GPU Cholesky solve | RTX 4080 SUPER A/B verified |
