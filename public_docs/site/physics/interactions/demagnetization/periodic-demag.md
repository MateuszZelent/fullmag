---
title: Periodic Demag
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0800-fem-static-pbc-demag.md
---

(public-docs-physics-interactions-demagnetization-periodic-demag)=
# Periodic Demagnetization

Periodic demagnetization changes the magnetostatic Green problem. Fullmag exposes separate FDM
truncated-image and FEM periodic-airbox policies; neither is interchangeable with open-boundary
demagnetization. For GPU throughput and VRAM scaling on periodic domains, see
{ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-demag`.

(demag-periodic-problem-statement)=
## Physical problem

Periodic axes identify corresponding degrees of freedom or image cells. The treatment of the
zero-wave-number mode and the remaining open axes determines whether a scalar potential is unique.
The periodic request therefore has three independent parts: the periodic equivalence relation,
the finite image or reduced-space realization, and the zero-mode/gauge policy. Changing one of
these changes the discrete magnetostatic problem.

(demag-periodic-governing-equations)=
## Governing equations

### FEM periodic-reduced Poisson system

For periodic FEM Poisson demagnetization, full-column-rank equivalence-class prolongation
$P$ maps reduced periodic classes to full nodal degrees of freedom:

```{math}
:label: eq-periodic-demag-reduction
A_p=P^{\mathsf T}A_{\mathrm{open}}P,
\qquad
b_p=P^{\mathsf T}b,
\qquad
A_pu_p=b_p.
```

```{math}
:label: eq-periodic-demag-field
\mathbf H_{\mathrm d}=-\nabla(Pu_p),
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

Because $\operatorname{rank}(P) = N_{\mathrm{red}}$, strict symmetric positive definiteness of
$A_{\mathrm{open}}$ implies strict symmetric positive definiteness of $A_p$ whenever the constant
nullspace is removed — specifically for **1-D periodic Robin** ($\beta > 0$), **2-D periodic film
with pure Neumann** ($\beta = 0$) plus a singleton open-boundary gauge pin, and **1-D/2-D periodic
Dirichlet**. Pure unpinned 3-D periodic Neumann remains singular and is excluded from SPD Cholesky
solves.

### FDM finite truncated images and distant point-dipole limit

For a Cartesian FDM layer with periodic axis $p$, physical period $L_p = N_p h_p$, and replica
half-count $I$ per side, the folded periodic tensor is

```{math}
:label: eq-periodic-demag-fdm-images
N^{P}_{ij}(\mathbf r)
= \sum_{n=-I}^{I} N_{ij}(\mathbf r + n L_p \hat{\mathbf e}_p),
\qquad
\mathbf H_{\mathrm d} = -N^{P} * \mathbf M.
```

In a single magnetic layer with mixed periodicity (one in-plane axis periodic, transverse axis and
thickness open), naive binary64 Newell finite differences suffer severe catastrophic cancellation
at large replica distances because the Newell primitives scale as $r^3$ while the physical tensor
decays as $r^{-3}$ (for example at lag $(16000, 0, 0)$ in a $500 \times 800 \times 1$ control grid,
naive Newell subtraction yields $N_{xx} = -3.2141 \times 10^{-4}$ instead of the quadrature value
$-3.8856 \times 10^{-14}$). Fullmag therefore evaluates exact equal-cell Newell stencils for near
lags and switches to the point-dipole limit for distant pairs at
$\lvert\mathbf r\rvert \ge 40\,h_{\max}$:

```{math}
:label: eq-periodic-demag-distant-dipole
N_{ij}(\mathbf r)
\simeq
\frac{V}{4\pi\lvert\mathbf r\rvert^3}
\left(\delta_{ij} - \frac{3 r_i r_j}{\lvert\mathbf r\rvert^2}\right),
\qquad
\lvert\mathbf r\rvert \ge 40\,h_{\max}.
```

The finite cell-size correction decays as $O(h_{\max}^2 / \lvert\mathbf r\rvert^2)$ relative to the
tensor scale; all requested images still participate, Nyquist self-conjugate lags average nearest
signed representatives, and folding occurs directly into the padded convolution buffer without
allocating memory proportional to $I$.

```{figure} /_static/diagrams/demag-fdm-newell-and-multilayer.svg
:alt: Two-panel diagram highlighting periodic image truncation and k=0 uniform-mode convergence in panel (b) right side: numerically computed uniform-mode demagnetization factors N_zz(I) approaching 1.00 and N_xx(I) approaching 0.00 for a 20 x 20 x 2 nm thin film as periodic image half-count I increases from 0 to 32, alongside FFT padding rules and rejection of periodic_airbox_k0 in FDM.
:width: 100%
:name: fig-demag-periodic-image-truncation
:figclass: fm-physics-figure

Periodic demagnetization conventions (panel (b), right): finite FDM `truncated_images` convergence of the uniform ($k=0$) thin-film demagnetization factors $N_{zz}(I)\to 1$ and $N_{xx}(I)\to 0$ with image half-count $I_x=I_y$, contrasted with open $2N$ vs. periodic $N$ FFT padding and FEM `periodic_airbox_k0` requirements (Lebecki *et al.* 2008; Newell *et al.* 1993).
```

(demag-periodic-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $A_p$ | reduced periodic FEM stiffness operator | $\mathrm{m}$ |
| $A_{\mathrm{open}}$ | unreduced FEM stiffness operator | $\mathrm{m}$ |
| $P$ | periodic representative prolongation | $1$ |
| $b_p$ | reduced Poisson right-hand side | $\mathrm{A\,m}$ |
| $u_p$ | reduced scalar potential | $\mathrm{A}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $N^{P}_{ij}$ | periodically folded FDM demagnetizing tensor component | $1$ |
| $N_{ij}$ | open equal-cell demagnetizing tensor component | $1$ |
| $\mathbf r$ | displacement vector between cell centers | $\mathrm{m}$ |
| $I$ | number of periodic replicas per side | $1$ |
| $L_p$ | physical period along periodic axis $p$ | $\mathrm{m}$ |
| $\hat{\mathbf e}_p$ | unit vector along periodic axis $p$ | $1$ |
| $V$ | single FDM cell volume | $\mathrm{m^3}$ |
| $h_{\max}$ | maximum FDM cell pitch $\max(h_x, h_y, h_z)$ | $\mathrm{m}$ |
| $\delta_{ij}$ | Kronecker delta | $1$ |

(demag-periodic-assumptions-and-validity)=
## Assumptions and validity

- Periodic FEM currently requires at least one open axis and an explicit zero-mode/gauge policy
  (1-D periodic Robin, 2-D periodic film with singleton gauge pin, or 1-D/2-D Dirichlet); pure
  unpinned 3-D periodic Neumann is mathematically singular and fails closed.
- Periodic `pure_prism_p2` (P2 wedge periodic edge/face DOF equivalence classes) is not yet
  qualified and fails closed; qualified periodic FEM uses P1 reduced operators.
- FDM `truncated_images` is a finite approximation to an infinite image sum; the distant
  point-dipole cutoff $\lvert\mathbf r\rvert \ge 40\,h_{\max}$ eliminates binary64 Newell
  cancellation while keeping finite replica truncation distinct from pair-approximation error
  (independent cubature across 19 in-plane directions gives relative Frobenius error up to
  $1.71 \times 10^{-7}$ for cubic cells and $6.24 \times 10^{-4}$ for 20:1 anisotropic cells at
  the cutoff).
- Single-layer FDM CUDA **FP32 + PBC** is intentionally rejected (`rc=1`) by the qualification
  gate; use `precision="double"` for periodic FDM GPU runs.

(demag-periodic-python-api)=
## Python API

The complete stage-first scenario below requests an FDM film that is periodic in-plane and uses
four translated demagnetization images on each periodic axis.

```python
# %% Imports and units
import fullmag as fm

nm = 1.0e-9

# %% Study, execution lane, and periodic grid
study = fm.study("periodic_demag_convergence")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(3 * nm, 3 * nm, 4 * nm))
study.pbc(
    x=True,
    y=True,
    z=False,
    demag="truncated_images",
    images=(4, 4, 0),
)

# %% Geometry, material, initial state, and interactions
film = study.geometry(
    fm.Box(size=(96 * nm, 48 * nm, 4 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.exchange()
study.demag()

# %% Ordered relaxation stage and reproducible observables
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=500,
    tolT=1.0e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=[
                "step",
                "mx",
                "my",
                "mz",
                "e_demag",
                "e_total",
                "max_torque_T",
            ],
        ),
        fields=[fm.FieldAutosave("H_demag", every_steps=20)],
    )
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | Exactly three booleans. | Periodic status of x, y, z. | FDM and FEM planners. | `pbc.axes` |
| `FdmPbc.demag` | `str` | `open` | $1$ | `open`, `truncated_images`, or `periodic_airbox_k0`. | Demag boundary policy (`periodic_airbox_k0` requires x/y periodic and open z). | Solver-specific (FDM rejects `periodic_airbox_k0`). | `pbc.demag` |
| `FdmPbc.image_counts` | `optional tuple[int,int,int]` | `None` | $1$ | Non-negative; only with `truncated_images`. | Finite image count per axis. | FDM CPU and FDM GPU FP64. | `pbc.image_counts` |

(demag-periodic-problem-ir)=
## ProblemIR

`FdmPbc.to_ir()` writes periodic/open axis names, the selected demag policy, and optional
`image_counts`. The planner resolves explicit/default image counts (`resolve_periodic_images`),
rejects `periodic_airbox_k0` for FDM, rejects FP32+PBC on FDM CUDA, and validates the FEM periodic
reduction and gauge policy separately.

(demag-periodic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is preserved verbatim even when a target lane rejects it. **Resolved execution**
records the effective periodic kernel, image count, reduced operator topology, gauge policy,
`resolved_linear_solver` (`cudss_direct` or `hypre_krylov` on FEM GPU), and device identity
separately.

Periodic axes with an incompatible policy, invalid or negative `image_counts`, `image_counts`
supplied without `truncated_images`, or a singular unpinned 3-D periodic Neumann operator
(`CUDSS_DATA_INFO != 0`, fail-closed even under `gpu_strategy="auto"`) are **validation errors**.
FDM CUDA FP32+PBC, multilayer FDM PBC, periodic `pure_prism_p2`, and FDM `periodic_airbox_k0` are
**unsupported combinations** that fail closed and are never silently converted to open boundaries.

(demag-periodic-discrete-realization)=
## Discrete realization

### Four-lane support and qualification matrix

| Solver | Device | Status | Realization summary | Qualification boundary |
|---|---|---|---|---|
| FDM | CPU | `reference` | Finite `truncated_images` spectra (`compute_periodic_newell_kernel_spectra`) plus single-layer mixed-boundary dipole cutoff ($r \ge 40\,h_{\max}$, `compute_single_layer_mixed_newell_kernels`). | Reference FP64 lane; multilayer PBC rejected fail-closed. |
| FDM | GPU | `implemented` | Uploads the same host periodic spectra (including single-layer mixed-boundary dipole tail) into Hermitian `D2Z/Z2D` FP64 cuFFT. | Verified FP64 (`pbcxy 128×128×2` Heun: `rel dE_demag = 0.00e+00`, `−12.0%` VRAM on RTX 4080 SUPER); **FP32+PBC intentionally rejected** (`rc=1`). |
| FEM | CPU | `implemented` | Periodic equivalence-class prolongation $P$ and reduced P1 Poisson solve (`solve_demag_periodic_poisson_reduced`). | Verified for 1-D Robin, 2-D film (Neumann + gauge pin), and 1-D/2-D Dirichlet; pure unpinned 3-D Neumann and periodic `pure_prism_p2` fail closed. |
| FEM | GPU | `implemented` | Strict device-resident reduced operator $A_p = P^{\mathsf T} A_{\mathrm{open}} P$ with **`cuDSS` direct Cholesky** (`gpu_strategy="auto" \| "cudss"`) and `hypre_krylov` fallback (`coarse_relax_type=18`), plus Heun/RK4 FSAL `k0` reuse. | Verified on RTX 4080 SUPER for **1-D Robin** (`26.8×–28.6×`, residual `<= 6.51e-15`) and **2-D film (Neumann + pin)** (`33.0×–35.5×`, residual `<= 1.87e-14`, `max \|Δm\| <= 3.51e-11`); unpinned 3-D Neumann fails closed (`CUDSS_DATA_INFO != 0`). |

### FDM CPU and GPU

Both CPU and CUDA share the host periodic tensor builder (`compute_periodic_newell_kernel_spectra`,
and `compute_single_layer_mixed_newell_kernels` / `point_dipole_pair_tensor` for single-layer
mixed-boundary meshes). On CUDA FP64, the folded periodic spectrum executes through the single-layer
Hermitian `D2Z/Z2D` cuFFT pipeline. Single-precision CUDA (`precision="single"`) with periodic
boundaries is rejected intentionally by the qualification gate.

### FEM CPU and GPU

FEM identifies periodic node equivalence classes, forms $A_p = P^{\mathsf T} A_{\mathrm{open}} P$
and $b_p = P^{\mathsf T} b$, solves the reduced system, and lifts $u = P u_p$ to the full mesh.
On FEM GPU, both **1-D periodic Robin** and **2-D periodic film (pure Neumann $\beta = 0$ +
singleton open-boundary gauge pin)** are strictly SPD and are admitted directly into `cuDSS`
Cholesky factorization (`try_initialize_demag_cudss_direct`) under `gpu_strategy="auto"` or
`"cudss"`, with clean VRAM-budget fallback to `hypre_krylov` (`CG/AMG`, `coarse_relax_type=18`)
under `"auto"`. Deterministic Heun and RK4 steps reuse the post-projection FSAL `k0` derivative
(`3 -> 2` and `5 -> 4` solves/step from step 2 onward), while the narrower RK23/RK45 endpoint
shortcut remains disabled under PBC to guarantee periodic projection idempotence.

(demag-periodic-zero-mode)=
## Zero mode and convergence evidence

For FDM, report the image truncation sequence and observable convergence of both field and energy.
For FEM, report the reduced-system residual, gauge/nullspace policy, open-axis solvability,
seam continuity across periodic node pairs, and resolved linear solver provenance.

(demag-periodic-implementation-mapping)=
## Implementation mapping

`FdmPbc` owns Python validation and `resolve_periodic_images` resolves image counts in IR.
FDM periodic spectra are built by `compute_periodic_newell_kernel_spectra` and
`compute_single_layer_mixed_newell_kernels` / `point_dipole_pair_tensor`. FEM CPU periodic
reduction is owned by `solve_demag_periodic_poisson_reduced`; FEM GPU periodic `cuDSS` / Hypre
dispatch is owned by `initialize_demag_poisson_hypre_device_solver` and
`try_initialize_demag_cudss_direct`.

### Control Room support

Periodic demagnetization settings appear under `Model Explorer -> Objects -> <object> -> Physics`
via `ObjectPhysicsInspectorPanel`
(`apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx`).
Browser exposure is partial: image counts, `periodic_airbox_k0`, and GPU solver strategies without
a dedicated UI control must be configured in Python or `ProblemIR`. See
{doc}`/frontend/capability-register` for current Control Room coverage.

(demag-periodic-validation)=
## Validation

### Executed RTX 4080 SUPER periodic GPU A/B results

- **FEM GPU PBC-reduced `cuDSS` (`20×20×18` Kuhn `tet4`, `8,379` nodes, P1 reduced, `rtol=1e-8`, 50 steps):**
  - **1-D Robin Heun:** baseline `56.813 ms/step` $\to$ `cg_amg` `37.641 ms` (**1.51×**) $\to$ `auto` (`cudss_direct`) **`1.986 ms/step` (28.6×)**, `max_res = 6.51e-15`, `max |Δm| = 3.51e-11`, `fsal_reused = true` (`3 -> 2`).
  - **1-D Robin RK4:** baseline `92.188 ms/step` $\to$ `auto` (`cudss_direct`) **`3.445 ms/step` (26.8×)**, `max_res = 6.46e-15`, `max |Δm| = 2.66e-11`, `fsal_reused = true` (`5 -> 4`).
  - **2-D film (Neumann + singleton pin) Heun:** baseline `72.749 ms/step` $\to$ `cg_amg` `57.087 ms` (**1.27×**) $\to$ `auto` (`cudss_direct`) **`2.052 ms/step` (35.5×)**, `max_res = 1.86e-14`, `max |Δm| = 3.39e-11`.
  - **2-D film (Neumann + singleton pin) RK4:** baseline `118.116 ms/step` $\to$ `auto` (`cudss_direct`) **`3.580 ms/step` (33.0×)**, `max_res = 1.87e-14`, `max |Δm| = 3.42e-11`.
- **FDM GPU FP64 `pbcxy 128×128×2` Heun:** Hermitian `D2Z/Z2D` cuFFT achieves `rel dE_demag = 0.00e+00` (step 50), `rel dE_total = 1.47e-14` (step 500), and **−12.0%** peak `gpu_workspace` VRAM (`25.34 -> 22.29 MB`); FP32+PBC is intentionally rejected (`rc=1`).
- **Single-layer mixed-boundary dipole tail (`one_layer_periodic_images_preserve_demag_tensor_at_long_lags`):** validates long-lag diagonal and off-diagonal tensor accuracy and Nyquist parity against independent cell-volume quadrature.

(demag-periodic-limitations)=
## Limitations

- Finite FDM images are not an exact Ewald or infinite periodic sum; image-count convergence must
  be checked per geometry.
- FDM CUDA FP32+PBC and multilayer FDM PBC fail closed.
- Pure unpinned 3-D periodic FEM Neumann is mathematically singular (`CUDSS_DATA_INFO != 0`) and
  fails closed; periodic `pure_prism_p2` remains unqualified and fails closed.

(demag-periodic-scientific-bibliography)=
## Scientific bibliography

1. K. M. Lebecki, M. J. Donahue, and M. Gutowski, “Periodic boundary conditions for
   demagnetization interactions in micromagnetic simulations,” *Journal of Physics D: Applied
   Physics* **41**(17), 175005 (2008),
   [doi:10.1088/0022-3727/41/17/175005](https://doi.org/10.1088/0022-3727/41/17/175005), Open
   Access repository PDF:
   [KOPS Uni Konstanz](https://kops.uni-konstanz.de/server/api/core/bitstreams/f715126e-8c47-4ab2-869c-c67af14c3efd/content).
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research: Solid Earth* **98**(B6), 9551–9555
   (1993), [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
3. P. Gruszecki, M. Kasprzak, A. E. Serebryannikov, M. Krawczyk, and W. Śmigaj, “Microwave
   excitation of spin wave beams in thin ferromagnetic films,” *Scientific Reports* **6**, 22367
   (2016), [doi:10.1038/srep22367](https://doi.org/10.1038/srep22367).

(demag-periodic-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility | Lane | Immutable link |
|---|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | Periodic policy validation and `ProblemIR` serialization. | Public API | [`problem.py#L220`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) |
| `crates/fullmag-ir/src/execution.rs` | `resolve_periodic_images` | Resolves explicit/default periodic replica counts. | IR | [`execution.rs#L409`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/execution.rs#L409) |
| `crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs` | `compute_single_layer_mixed_newell_kernels` | Folds finite periodic replicas into single-layer mixed-boundary tensor with $r \ge 40\,h_{\max}$ cutoff. | FDM CPU/GPU setup | [`mixed_single_layer.rs#L5`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) |
| `crates/fullmag-fdm-demag/src/newell.rs` | `point_dipole_pair_tensor` | Evaluates the distant equal-cell point-dipole tensor limit eliminating binary64 cancellation. | FDM CPU/GPU setup | [`newell.rs#L424`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L424) |
| `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | FDM periodic tensor spectra builder. | FDM CPU/GPU setup | [`fft.rs#L713`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L713) |
| `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `one_layer_periodic_images_preserve_demag_tensor_at_long_lags` | Regression checking distant periodic diagonal and off-diagonal tensor accuracy. | FDM test | [`fft.rs#L1436`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L1436) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` | `solve_demag_periodic_poisson_reduced` | FEM CPU reduced periodic Poisson solve. | FEM CPU | [`demag_poisson_periodic.cpp#L199`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp#L199) |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_demag_cudss_direct` | Three-state VRAM-guarded `cuDSS` admission for PBC-reduced 1-D Robin and 2-D film operators. | FEM GPU | [`cudss_direct_solver.cpp#L653`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | Dispatches PBC-reduced GPU Poisson between `cuDSS` direct Cholesky and `hypre_krylov`. | FEM GPU | [`hypre_device_solver.cpp#L257`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp#L257) |
| `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` | `ObjectPhysicsInspectorPanel` | Object-level physics inspector exposing demagnetization controls. | Control Room | [`ObjectPhysicsSpec.tsx#L78`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx#L78) |
