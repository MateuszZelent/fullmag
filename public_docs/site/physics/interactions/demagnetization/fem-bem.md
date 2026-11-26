---
title: FEM Bem
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0870-fem-bem-demag-open-boundary.md
---

(public-docs-physics-interactions-demagnetization-fem-bem)=
# FEM/BEM Fredkin–Koehler demagnetization

The Fredkin–Koehler realization keeps the magnetic volume in FEM and represents the unbounded
exterior by a boundary integral on $\Gamma_m = \partial\Omega_m$. It therefore differs
fundamentally from the finite airbox realization: there is no exterior air volume in the
body-only `tet4` mesh, and no Dirichlet or Robin condition is imposed on an artificial outer airbox
boundary.

Both **FEM CPU** and **FEM GPU** execute body-only P1 `tet4` Fredkin–Koehler demagnetization:
- **FEM CPU** uses a hierarchical $H^2$ boundary-element operator (exact Lindholm near blocks plus
  deterministic ACA $UV^{\mathsf T}$ far blocks, with `DenseDemagBemOperator` retained as a
  small-scale oracle) paired with MFEM/Hypre solves for $u_1$ and $u_2$.
- **FEM GPU** runs a strict device-resident CUDA Fredkin–Koehler operator
  (`backends/fem/gpu/cuda/demag_fem_bem/`) flattening the same near-field CSR and admissible ACA
  far-field blocks onto device memory, coupled to atomic `(u1, u2)` `cuDSS` direct Cholesky solves
  (`gpu_strategy="auto" | "cudss"`) or device Hypre Krylov (`CG/AMG` default with
  `coarse_relax_type=18`, or `CG/JACOBI`).

For GPU timing comparisons and solver architecture details, see
{ref}`numerical-methods-performance-fem-gpu-demag`. Generic `bem` and `fmm` remain distinct
unimplemented requests and are never silently rewritten to Fredkin–Koehler.

(demag-bem-problem-statement)=
## 1. Physical problem and domain

Let $\Omega_m$ be a closed tetrahedral (`tet4`) magnetic body with watertight boundary
$\Gamma_m = \partial\Omega_m$. The exterior is magnetostatic free space. The magnetic source is the
volume magnetization $\mathbf M=M_s\mathbf m$; the exterior contribution is represented through the
trace of the potential on $\Gamma_m$.

The body-only requirement is strict. A mesh with an airbox is a different FEM realization and must
use {doc}`fem-poisson-airbox`. A non-closed or non-manifold surface cannot define the exterior
boundary integral and fails closed during workspace construction rather than being silently filled
with air.

(demag-bem-governing-equations)=
## 2. Governing equations

The scalar potential satisfies

```{math}
:label: eq-fem-bem-field
\mathbf H_{\mathrm d}=-\nabla u,
\qquad
\Delta u=\nabla\cdot\mathbf M\quad\text{in }\Omega_m.
```

The implementation decomposes the total potential into an interior Poisson part and a harmonic
boundary correction:

```{math}
:label: eq-fem-bem-decomposition
u=u_1+u_2,
\qquad
\int_{\Omega_m}\nabla u_1\cdot\nabla v\,\mathrm dV
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV.
```

The first solve is a Neumann problem whose nullspace dimension equals the number of connected
components of $\Omega_m$. For each connected component, the workspace deterministically pins the
minimum global node via symmetric `EliminateRowCol` (`DIAG_ONE`) and zeroes its RHS entry:

```{math}
:label: eq-fem-bem-gauge
b_{1,0}=0,
\qquad
u_1\leftarrow u_1+C\ \text{is fixed by the gauge choice }C=0.
```

Let $\gamma u_1$ be the FEM trace on $\Gamma_m$. The boundary-integral operator maps this trace to
the Dirichlet data for the harmonic correction:

```{math}
:label: eq-fem-bem-boundary-map
g_2=\mathcal B\,\gamma u_1,
\qquad
\Delta u_2=0\ \text{in }\Omega_m,
\qquad
\gamma u_2=g_2\ \text{on }\Gamma_m.
```

The diagonal contains the solid-angle contribution. For a boundary node $x_i$ and adjacent
surface triangles $T$, the diagonal contribution has the implemented form

```{math}
:label: eq-fem-bem-solid-angle
\mathcal B_{ii}=\frac{\sum_{T\ni x_i}\omega_T(x_i)}{4\pi}-1.
```

Off-diagonal near-field entries use the exact Lindholm linear-triangle boundary weights (triangle
area, oriented unit normal, edge logarithms, and solid angle), while admissible far-field blocks
are compressed by deterministic adaptive cross approximation (ACA) into $UV^{\mathsf T}$ factors so
the full $N_b \times N_b$ dense matrix is never materialized in production. Vertex-coincident terms
are guarded explicitly.

After essential gauge elimination ($u_1$) and boundary elimination ($u_2$), both discrete systems
$K_{\mathrm{neumann}}$ and $K_{\mathrm{dirichlet}}$ are strictly symmetric positive definite (SPD),
allowing `cuDSS` Cholesky factorization on GPU. To keep both systems in one linear-solver family,
atomic GPU admission checks the combined sequential VRAM peak before either factorization starts:

```{math}
:label: eq-fem-bem-cudss-pair-budget
\hat{M}_{\mathrm{peak,FK}}
= \max\!\left(\hat{M}_{\mathrm{peak},1},\; \hat{M}_{\mathrm{stable},1} + \hat{M}_{\mathrm{peak},2}\right)
\le B.
```

The final field and energy use the combined potential:

```{math}
:label: eq-fem-bem-total-field-energy
\mathbf H_{\mathrm d}=-\nabla(u_1+u_2),
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}
\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

No separate airbox Robin surface energy is added because this realization has no Robin airbox
operator.

```{figure} /_static/diagrams/demag-fem-bem-fredkin-koehler-pipeline.svg
:alt: Two-panel diagram of Fullmag's Fredkin-Koehler FEM-BEM demagnetization method on a closed body-only mesh Omega_m without an airbox: (a) seven-stage dataflow from magnetic RHS assembly, gauge pin b_{1,0}=0, Neumann solve u_1, surface trace gamma u_1 on Gamma_m, BEM operator B, Dirichlet data g_2 = B gamma u_1, harmonic Laplace solve u_2, to combined field H_d = -grad(u_1 + u_2) and energy E_d; (b) analytical sphere potential splitting u = u_1 + u_2, solid-angle geometry omega_T(x_i), and FEM CPU/GPU lane contract.
:width: 100%
:name: fig-demag-fem-bem-fredkin-koehler-pipeline
:figclass: fm-physics-figure

Fullmag's two-solve Fredkin–Koehler algorithm on a body-only tetrahedral domain $\Omega_m$ without an airbox: sequential sparse solves ($u_1$, $u_2$) and hierarchical near/far ACA boundary map $\mathcal{B}$ in panel (a), with potential splitting ($u = u_1 + u_2$), solid-angle diagonal $\mathcal{B}_{ii} = \sum_{T\ni x_i}\omega_T/(4\pi) - 1$, and strict FEM CPU/GPU boundaries in panel (b) (Fredkin & Koehler 1990; Hertel *et al.* 2019; Abert *et al.* 2013).
```

(demag-bem-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $u$ | total scalar potential | $\mathrm{A}$ |
| $u_1$ | interior Poisson potential | $\mathrm{A}$ |
| $u_2$ | harmonic boundary correction | $\mathrm{A}$ |
| $v$ | FEM test function | $1$ |
| $\Omega_m$ | magnetic volume | $\mathrm{m^3}$ |
| $\Gamma_m$ | closed magnetic surface | $\mathrm{m^2}$ |
| $\gamma$ | FEM trace operator on $\Gamma_m$ | $1$ |
| $\mathcal B$ | boundary-integral map (hierarchical near/far ACA or dense oracle) | $1$ |
| $g_2$ | boundary values for $u_2$ | $\mathrm{A}$ |
| $\omega_T$ | oriented solid angle of surface triangle $T$ | $1$ |
| $T$ | oriented boundary triangle | $\mathrm{m^2}$ |
| $x_i$ | boundary node location | $\mathrm{m}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $b_1$ | Neumann right-hand-side vector for $u_1$ | $\mathrm{A\,m}$ |
| $C$ | additive potential gauge constant | $\mathrm{A}$ |
| $i$ | boundary-node index | $1$ |
| $\hat{M}_{\mathrm{peak,FK}}, \hat{M}_{\mathrm{peak},1}, \hat{M}_{\mathrm{peak},2}$ | combined and per-system cuDSS post-analysis VRAM peak estimates | $\mathrm{B}$ |
| $\hat{M}_{\mathrm{stable},1}$ | steady device VRAM residency of the factored $u_1$ cuDSS handle | $\mathrm{B}$ |
| $B$ | effective CUDA device VRAM budget for atomic `(u1, u2)` admission | $\mathrm{B}$ |

(demag-bem-assumptions-and-validity)=
## 4. Assumptions and validity limits

The implementation assumes a closed, watertight, consistently oriented triangular surface extracted
from a body-only `tet4` P1 magnetic mesh (`prism6`, `pyramid5`, and P2 potentials fail closed on
the Fredkin–Koehler lane).

The two sparse solves are not interchangeable:

| Stage | Problem | Boundary data | Numerical consequence |
|---|---|---|---|
| $u_1$ | Interior Poisson/Neumann problem | Magnetic RHS plus one gauge pin per connected component | Constant nullspace removed via symmetric `EliminateRowCol` (`DIAG_ONE`), yielding strictly SPD $K_{\mathrm{neumann}}$. |
| $u_2$ | Interior harmonic/Dirichlet problem | BEM trace $g_2 = \mathcal B\gamma u_1$ | Boundary values injected via `EliminateRowCol` (`DIAG_ONE`), yielding strictly SPD $K_{\mathrm{dirichlet}}$. |

### Krylov `DIAG_ONE` elimination scaling nuance

Because `EliminateRowCol` inserts `1.0` on boundary diagonal rows of $K_{\mathrm{dirichlet}}$
while interior stiffness entries scale with element size $K_{\mathrm{int}} \sim h$ (e.g.
$h \approx 8 \times 10^{-9}\,\mathrm{m}$, a $\sim 1/h \approx 10^8$ scale jump), the global norm
$\lVert b_2 \rVert_2$ is dominated by boundary entries $b_\Gamma$. Under iterative Krylov solvers
(`cg_amg` with `AMG` or `JACOBI`), a loose global stopping threshold `rtol=1e-8` can therefore
leave $O(10^{-4})$ relative error in interior rows of $u_2$; tightening Krylov to `rtol=1e-12`
eliminates this error (`max |Δm| = 3.36e-9`). By contrast, `cuDSS` direct Cholesky (`gpu_strategy="auto"`
or `"cudss"`) is completely insensitive to the `DIAG_ONE` scale jump and reaches machine-precision
parity (`max |Δm| = 4.88e-14`) even at `rtol=1e-8`.

(demag-bem-python-api)=
## 5. Python API and complete solver parameters

The Fredkin–Koehler path uses a closed body-only mesh without an airbox. Switching `study.device`
to `("gpu", precision="double")` selects the strict device-resident CUDA Fredkin–Koehler lane with
three-state `gpu_strategy` (`"auto"` defaults to atomic `(u1, u2)` `cuDSS` when within VRAM budget).

```python
# %% Imports and body-only FEM/BEM study
import fullmag as fm

nm = 1.0e-9
study = fm.study("demag_fredkin_koehler_sphere")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Closed magnetic body, material, initial state, and volume mesh
body = study.geometry(
    fm.Sphere(radius=30 * nm, name="sphere"),
    name="sphere",
)
body.Ms = 8.0e5
body.Aex = 1.3e-11
body.alpha = 0.1
body.m = fm.init.UniformMagnetization((0.0, 0.0, 1.0))
body.mesh(
    maximum_element_size=12 * nm,
    order=1,
    algorithm_2d=1,
    algorithm_3d=1,
    size_factor=1,
    size_from_curvature=0,
    smoothing_steps=1,
    optimize_iterations=1,
    narrow_regions=0,
    compute_quality=False,
    per_element_quality=False,
)

# %% Fredkin–Koehler interaction and the two-solve FEM policy
study.exchange(enabled=False)
study.demag(model="fredkin_koehler")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
    max_iterations=500,
    gpu_strategy="auto",
)

# %% Ordered stage and scientific outputs
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=2_000,
    tolT=1.0e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "e_demag", "e_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("H_demag", every_steps=100)],
    )
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | `fredkin_koehler` selects the executable body-only FEM/BEM path; `bem` and `fmm` remain separate planner requests. | Selects the FEM/BEM realization family. | FEM CPU and FEM GPU (`tet4` P1 body-only). | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | Must be omitted for non-airbox models; otherwise constructor validation fails. | Airbox-only boundary selector, not a BEM parameter. | Not applicable to Fredkin–Koehler. | `energy[].realization` |
| `FEM.order` | `int` | required | $1$ | Integer equal to `1` for Fredkin–Koehler execution. | Polynomial order of the interior FEM space. | FEM CPU and FEM GPU body-only P1 path. | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | Finite positive value; `hmax` is an alias. | Target maximum element size for the magnetic body. | FEM CPU and FEM GPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy \| None` | `None` | $1$ | Policy fields are validated individually. | Linear-solver policy for the $u_1$ and $u_2$ sparse solves. | FEM CPU and FEM GPU. | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `"CG"` | $1$ | Must be `CG` or `GMRES`. | Krylov solver used for each sparse FEM solve on CPU and GPU HYPRE fallback. | FEM CPU and FEM GPU. | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `"AMG"` | $1$ | Must be `AMG`, `JACOBI`, or `NONE`. | Preconditioner for each sparse solve (`AMG` default with GPU `coarse_relax_type=18`; `JACOBI` supported for time-domain Krylov). | FEM CPU and FEM GPU. | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | Finite and strictly positive. | Relative Euclidean certification tolerance applied to both $u_1$ and $u_2$ solves (use `<= 1e-12` for Krylov under `DIAG_ONE` scaling). | FEM CPU and FEM GPU. | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `float \| None` | `None` | $1$ | When supplied, finite and strictly positive. | Optional absolute stopping tolerance for each sparse solve. | FEM CPU and FEM GPU. | `demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | Integer greater than or equal to $1$. | Maximum iterations for each sparse solve; telemetry reports $u_1$ and $u_2$ separately. | FEM CPU and FEM GPU. | `demag_solver_policy.max_iterations` |
| `FemLinearSolverPolicy.print_level` | `int` | `0` | $1$ | Integer greater than or equal to $0$. | Solver diagnostic verbosity. | FEM CPU and FEM GPU. | `demag_solver_policy.print_level` |
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto", "cg_amg", "cudss"]` | `"auto"` | $1$ | Must be `auto`, `cg_amg`, or `cudss`. | Selects atomic `(u1, u2)` `cuDSS` Cholesky vs device `hypre_krylov` on FEM GPU. | FEM GPU (ignored on FEM CPU). | `demag_solver_policy.gpu_strategy` |

(demag-bem-problem-ir)=
## 6. ProblemIR and normalization

The example lowers the interaction to

```json
{
  "kind": "demag",
  "realization": "fredkin_koehler"
}
```

The FEM hint carries `demag_solver_policy` (including `gpu_strategy`) separately. The planner
resolves `ResolvedFemDemagIR::FredkinKoehler`, checks body-only `tet4` P1 legality and watertight
surface closure, and publishes `ExecutionProvenance.fem_bem_demag` (`FemBemDemagProvenance`) with
BEM near/far block metrics plus `requested_linear_solver_strategy`, `resolved_linear_solver`
(`"cudss_direct"` or `"hypre_krylov"`), and `linear_solver_fallback_reason` on GPU.

(demag-bem-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

**Requested intent** contains `fredkin_koehler`, the body-only FEM hint, and the complete solver
policy. **Resolved execution** contains the surface topology, near/far ACA block fingerprint and
rank, `resolved_linear_solver`, `linear_solver_fallback_reason`, $u_1$ and $u_2$
iterations/residuals, total field, energy, executed-operator receipt bits (`DIRECT_SOLVE` vs
`PRECONDITIONER`, strictly mutually exclusive), and runtime identity.

Invalid model/variant combinations, non-positive tolerances, invalid iteration limits, non-closed
or non-manifold surfaces, non-`tet4` elements, malformed VRAM caps, and failed gauge preparation are
**validation errors**. Generic `bem`, unresolved `fmm`, periodic Fredkin–Koehler, P2/prismatic
Fredkin–Koehler, and forced `gpu_strategy="cudss"` exceeding {eq}`eq-fem-bem-cudss-pair-budget` are
**unsupported combinations** that fail closed. The planner never silently substitutes a Poisson
airbox, FDM convolution, a half-factored `(u1, u2)` pair, or a CPU run for a GPU request.

(demag-bem-discrete-realization)=
## 8. Discrete realization and CPU/GPU separation

### Four-lane support and qualification matrix

| Solver | Device | Status | Realization summary | Qualification boundary |
|---|---|---|---|---|
| FDM | CPU | `not-applicable` | FEM/BEM is a body-only FEM boundary-integral realization, not an FDM operator. | Use {doc}`fdm-convolution`. |
| FDM | GPU | `not-applicable` | FEM/BEM is a body-only FEM boundary-integral realization, not an FDM CUDA operator. | Use {doc}`fdm-convolution`. |
| FEM | CPU | `implemented` | Hierarchical $H^2$ BEM (`HierarchicalDemagBemOperator::build`) + small dense oracle (`DenseDemagBemOperator::build`), multi-component gauge pinning, and MFEM/Hypre $u_1$/$u_2$ solves. | Verified CPU oracle (including `boundary_tdofs_by_row` scatter fix for unsorted meshes) on body-only `tet4` P1 meshes. |
| FEM | GPU | `implemented` | Strict CUDA Fredkin–Koehler (`backends/fem/gpu/cuda/demag_fem_bem/`): flattened near-field CSR + ACA far-field GPU apply, atomic `(u1, u2)` `cuDSS` pair (`try_initialize_fem_bem_cudss_pair`) or device Hypre `CG/AMG` (`coarse_relax_type=18`) / `CG/JACOBI`, `HypreStreamInterop`, and shared CUB residual certification. | Verified on RTX 4080 SUPER (`2.202 ms/step` under `auto`/`cuDSS`, `34.6×` vs GPU AMG, `19.5×` vs GPU JACOBI, `5.4×` vs CPU, `max \|Δm\| = 4.88e-14`) and `compute-sanitizer --tool memcheck` (0 errors). |

### FEM CPU

The CPU sequence builds the watertight boundary surface (`build_demag_boundary_surface`), pins one
minimum-index gauge DOF per connected component, constructs the hierarchical $H^2$ operator
(exact Lindholm near blocks + deterministic ACA $UV^{\mathsf T}$ far blocks), solves $u_1$, applies
$\mathcal B$ to $\gamma u_1$, injects the boundary trace into $u_2$ using row-ordered
`boundary_tdofs_by_row` (fixing boundary scatter on unsorted meshes), solves $u_2$, forms
$u = u_1 + u_2$, and reuses the common field recovery and energy reduction contracts.

### FEM GPU

`gpu_demag_fem_bem_initialize` uploads the flattened near-field CSR blocks, ACA far-field
$U, V$ factors, and `d_boundary_tdofs` map once to device memory (fixing a prior missing upload of
`d_boundary_tdofs`, verified clean under `compute-sanitizer --tool memcheck`). During setup:

1. Under `gpu_strategy="auto"` or `"cudss"`, `try_initialize_fem_bem_cudss_pair` analyzes both
   $K_{\mathrm{neumann}}$ and $K_{\mathrm{dirichlet}}$ before factoring either matrix, checking
   {eq}`eq-fem-bem-cudss-pair-budget`. If the pair exceeds $B$, both analysis handles are released
   with `factorization_started = false` (hard error under `"cudss"`, clean pair fallback to
   `hypre_krylov` under `"auto"`). If $u_2$ factorization fails after $u_1$ succeeds, `u1_solver`
   is destroyed immediately so no partial pair ever exists.
2. Under `hypre_krylov` (`gpu_strategy="cg_amg"` or `"auto"` fallback), `configure_amg` configures
   device BoomerAMG with `coarse_relax_type=18` on both $u_1$ and $u_2$ (with `0.1 * rtol` inner
   Krylov certification margin; `CG/JACOBI` is also supported).
3. In the hot loop (`compute_device_demag_fem_bem_for_device_stage`), `u1` solve, device near/far
   BEM apply (`fullmag_cuda_fem_bem_apply`), Dirichlet RHS build, `u2` solve, potential addition,
   field recovery, and energy reduction stay strictly on device via `HypreStreamInterop` event
   fences, with shared multi-block CUB residual certification (`certify_gpu_hypre_demag_residual`:
   2 barriers / `32 B` total for $u_1$ and $u_2$).

(demag-bem-implementation-mapping)=
## 9. Implementation mapping

| Stage | CPU owner | GPU owner |
|---|---|---|
| Watertight surface & gauge | `build_demag_boundary_surface`, `prepare_demag_fem_bem_neumann_rhs` | `gpu_demag_fem_bem_initialize` (uploads flattened near/far blocks and `d_boundary_tdofs`) |
| BEM operator apply | `HierarchicalDemagBemOperator::build`, `DenseDemagBemOperator::build` | `fullmag_cuda_fem_bem_apply` |
| Sparse solves (`u1`, `u2`) | `solve_demag_fem_bem_sparse_system` | `try_initialize_fem_bem_cudss_pair`, `configure_amg`, `solve_linear_system` |
| Residual certification | `solve_demag_fem_bem_sparse_system` | `certify_gpu_hypre_demag_residual` |
| Boundary values & potential sum | `prepare_demag_fem_bem_dirichlet_rhs`, `combine_demag_fem_bem_total_potential` | `compute_device_demag_fem_bem_for_device_stage` |
| Orchestration & provenance | `context_compute_demag_fem_bem` | `compute_device_demag_fem_bem_for_device_stage`, `FemBemDemagProvenance` |
| Field and energy | `recover_demag_poisson_field` and `demag_poisson_energy_from_field` | Shared GPU recovery and energy reduction kernels |

### Control Room support

FEM–BEM demagnetization settings are exposed under
`Model Explorer -> Objects -> <object> -> Physics` by `ObjectPhysicsInspectorPanel`
(`apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx`).
Browser exposure is partial: solver policy fields (including `gpu_strategy`) without a dedicated UI
control must be configured via the Python API or `ProblemIR`. See
{doc}`/frontend/capability-register` for current Control Room coverage.

(demag-bem-validation)=
## 10. Validation and qualification

### Executed RTX 4080 SUPER A/B benchmark (`fembem_open`)

Measured on an **NVIDIA GeForce RTX 4080 SUPER** (16 GiB VRAM, SM 8.9, CUDA 12.6.85,
`cuDSS 0.8.0.10`) on the open body-only tetrahedral fixture (`1,183` nodes, `5,184` `tet4`, `664`
boundary nodes, Heun, 50 timed steps, FP64):

| Variant | `wall_ms/step` | Speedup | `iters/step` (`iters/slv`) | `max_res` | `coarse_relax_type` | `max \|Δm\|` vs CPU | `rel \|ΔE_d\|` vs CPU | `rel \|ΔH_d\|` vs CPU |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| CPU FEM/BEM oracle (`rtol=1e-10`) | `11.970` | baseline CPU | `210.32` (`35.05`) | `6.52e-14` | — | *ref* | *ref* | *ref* |
| GPU `cg_amg` + `JACOBI` (`rtol=1e-8`) | `42.904` | — | `208.74` (`52.19`) | `1.78e-12` | `-1` | `4.68e-05` | `1.54e-05` | `4.27e-04` |
| GPU `cg_amg` + `AMG` (`rtol=1e-8`) | `76.099` | — | `45.00` (`11.25`) | `1.31e-12` | `18` | `2.32e-05` | `1.55e-06` | `2.04e-04` |
| GPU `cg_amg` + `AMG` (`rtol=1e-12`) | `132.421` | Krylov `DIAG_ONE` check | `80.00` (`20.00`) | `3.78e-17` | `18` | `3.36e-09` | `1.26e-10` | `3.01e-08` |
| **GPU `auto` (`cudss_direct`, `rtol=1e-8`)** | **`2.202`** | **34.6× vs AMG / 19.5× vs JACOBI / 5.4× vs CPU** | **`4.00` (`1.00`)** | **`1.10e-23`** | **`-1`** | **`4.88e-14`** | **`1.54e-14`** | **`2.27e-13`** |

Additionally, `compute-sanitizer --tool memcheck` on `fem_demag_fem_bem_gpu_contract` completed
with **0 errors**, confirming the `d_boundary_tdofs` upload and device-resident near/far apply.

| Test | What it proves | What it does not prove |
|---|---|---|
| Closed-body surface extraction | Watertight boundary-node and triangle topology are valid. | Continuum convergence on arbitrary thin films. |
| Solid-angle and ACA probe contract | Diagonal convention, singular guard, and ACA near/far accuracy are stable. | Large-scale FMM scaling. |
| $u_1/u_2$ residual telemetry & atomic `cuDSS` | Both sparse solves satisfy their policies and stay in one solver family. | Discretization error of coarse meshes. |
| RTX 4080 SUPER CPU/GPU parity | Strict device residency (`DIRECT_SOLVE`/`PRECONDITIONER` exclusivity) and `4.88e-14` parity under `cuDSS`. | Large-film multi-million-DOF production qualification. |

(demag-bem-limitations)=
## 11. Limitations

- Fredkin–Koehler is currently scoped to closed body-only `tet4` P1 meshes; `prism6`, `pyramid5`,
  P2 potentials, and periodic domains fail closed.
- Generic `model="bem"` and `model="fmm"` remain unimplemented vocabulary and fail closed.
- Under `hypre_krylov` (`cg_amg`), the `DIAG_ONE` elimination scaling on $K_{\mathrm{dirichlet}}$
  requires tighter `rtol` (such as `1e-12`) to suppress interior $u_2$ error when `cuDSS` is not
  selected.
- While GPU FEM/BEM is verified on RTX 4080 SUPER for small/medium body-only fixtures, large
  thin-film production validation remains tracked separately from open-airbox `pure_prism_p2`.

(demag-bem-scientific-bibliography)=
## 12. Scientific bibliography

1. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE
   Transactions on Magnetics* **26**(2), 415–417 (1990),
   [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
2. R. Hertel, S. Christophersen, and S. Börm, “Large-scale magnetostatic field calculation in
   finite element micromagnetics with $\mathcal{H}^2$-matrices,” *Journal of Magnetism and
   Magnetic Materials* **477**, 118–123 (2019),
   [doi:10.1016/j.jmmm.2018.12.103](https://doi.org/10.1016/j.jmmm.2018.12.103), Open Access
   preprint: [arXiv:1811.05731](https://arxiv.org/abs/1811.05731).
3. C. Abert, L. Exl, F. Bruckner, A. Drews, and D. Suess, “magnum.fe: A micromagnetic
   finite-element simulation code based on FEniCS,” *Journal of Magnetism and Magnetic Materials*
   **345**, 29–35 (2013),
   [doi:10.1016/j.jmmm.2013.05.051](https://doi.org/10.1016/j.jmmm.2013.05.051), Open Access
   preprint: [arXiv:1301.3061](https://arxiv.org/abs/1301.3061).
4. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York, 1963.
   [WorldCat record](https://search.worldcat.org/title/536451).

(demag-bem-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility | Lane | Immutable link |
|---|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | BEM model validation and IR normalization. | Public authoring | [`energy.py#L51`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | Body-only mesh and solver-policy hint. | Public authoring | [`discretization.py#L484`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | `rtol`, `atol`, iteration, solver, and `gpu_strategy` controls. | Public authoring | [`discretization.py#L161`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) |
| `crates/fullmag-runner/src/types.rs` | `FemBemDemagProvenance` | FEM/BEM operator telemetry plus GPU linear-solver strategy and fallback provenance. | FEM provenance | [`types.rs#L4390`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/types.rs#L4390) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp` | `build_demag_boundary_surface` | Watertight closed `tet4` surface extraction and orientation validation. | FEM CPU/GPU setup | [`demag_fem_bem_surface.cpp#L604`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp#L604) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp` | `prepare_demag_fem_bem_neumann_rhs` | Gauge-pinned Neumann RHS. | FEM CPU | [`demag_fem_bem_rhs.cpp#L18`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp#L18) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp` | `DenseDemagBemOperator::build` | Dense reference surface operator, solid-angle diagonal, and Lindholm weights. | FEM CPU | [`demag_fem_bem_operator.cpp#L364`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L364) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp` | `HierarchicalDemagBemOperator::build` | Hierarchical $H^2$ near/far ACA boundary operator. | FEM CPU | [`demag_fem_bem_operator.cpp#L1475`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L1475) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp` | `solve_demag_fem_bem_sparse_system` | Policy-controlled CPU sparse solves. | FEM CPU | [`demag_fem_bem_linear_solve.cpp#L185`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp#L185) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp` | `prepare_demag_fem_bem_dirichlet_rhs` | Row-ordered `boundary_tdofs_by_row` boundary-value injection for $u_2$. | FEM CPU | [`demag_fem_bem_boundary_values.cpp#L40`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp#L40) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` | `context_compute_demag_fem_bem` | Full CPU Fredkin–Koehler sequence and telemetry. | FEM CPU | [`demag_fem_bem_solve.cpp#L30`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp#L30) |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp` | `combine_demag_fem_bem_total_potential` | Potential sum $u = u_1 + u_2$. | FEM CPU | [`demag_fem_bem_potential.cpp#L43`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp#L43) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | Common field recovery and energy handoff. | FEM CPU | [`demag_poisson_recovery.cpp#L745`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | Common demagnetization energy reduction. | FEM CPU | [`demag_poisson_energy.cpp#L25`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `gpu_demag_fem_bem_initialize` | GPU Fredkin–Koehler setup, `d_boundary_tdofs` upload, `HypreStreamInterop`, and atomic `cuDSS`/Hypre setup. | FEM GPU | [`fem_bem.cpp#L697`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L697) |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `configure_amg` | Device BoomerAMG configuration enforcing `coarse_relax_type=18` on both $u_1$ and $u_2$. | FEM GPU | [`fem_bem.cpp#L263`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L263) |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `solve_linear_system` | Device `cuDSS`/Hypre solve dispatch, residual certification, and exclusive receipt bits. | FEM GPU | [`fem_bem.cpp#L488`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L488) |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `compute_device_demag_fem_bem_for_device_stage` | Strict device-resident Fredkin–Koehler stage evaluation ($u_1 \to \mathcal B \to u_2 \to \mathbf H_{\mathrm d}, E_{\mathrm d}$). | FEM GPU | [`fem_bem.cpp#L1161`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L1161) |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu` | `fullmag_cuda_fem_bem_apply` | CUDA near-field CSR and ACA far-field $U(V^{\mathsf T}x)$ boundary operator apply. | FEM GPU | [`fem_bem_kernels.cu#L132`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu#L132) |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_fem_bem_cudss_pair` | Atomic two-factor VRAM preflight and factorization for GPU FEM/BEM `(u1, u2)`. | FEM GPU | [`cudss_direct_solver.cpp#L761`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L761) |
| `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp` | `certify_gpu_hypre_demag_residual` | Shared multi-block CUB residual certification for both $u_1$ and $u_2$. | FEM GPU | [`hypre_residual_certification.cpp#L25`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp#L25) |
| `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` | `ObjectPhysicsInspectorPanel` | Object-level physics inspector panel exposing demagnetization controls. | Control Room | [`ObjectPhysicsSpec.tsx#L78`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx#L78) |
