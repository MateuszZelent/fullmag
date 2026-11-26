---
title: FEM Poisson Airbox
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-demag-solvers-fem-poisson-airbox)=
# FEM Poisson airbox solver

(numerical-methods-demag-poisson-problem-statement)=
## Scope and purpose

The canonical physical demagnetization definition is owned by
{doc}`../../physics/interactions/demagnetization/index`. This page describes the shared-domain
FEM realization: the magnetic body $\Omega_m$ is embedded in an airbox so that a scalar potential
can be solved on $\Omega_a=\Omega_m\cup\Omega_{\mathrm{air}}$. The airbox boundary marker, outer
closure, polynomial order (automatic P2 on non-periodic `tet4` and `pure_prism_p2` meshes),
linear-solver policy (`CG/AMG` or VRAM-guarded `cuDSS` Cholesky on FEM GPU), field recovery, and
energy reduction are one numerical problem.

The page covers Dirichlet and Robin outer closures as well as the 2D-periodic film pure-Neumann
($\beta = 0$) singleton gauge-pin resolution. Closures are not aliases for one solver setting and
results must record both requested intent and resolved execution provenance.

(numerical-methods-demag-poisson-governing-equations)=
## Scientific and numerical model

The magnetostatic scalar-potential field is recovered as

```{math}
:label: eq-numerical-demag-poisson-field
\mathbf H_{\mathrm d}=-\nabla u.
```

In the magnetic domain, the strong equation is

```{math}
:label: eq-numerical-demag-poisson-strong
\nabla^2u=\nabla\cdot\mathbf M\quad\text{in }\Omega_m,
\qquad
\nabla^2u=0\quad\text{in }\Omega_a\setminus\Omega_m.
```

For test function $v$, the Robin weak form is

```{math}
:label: eq-numerical-demag-poisson-robin-weak
\int_{\Omega_a}\nabla u\cdot\nabla v\,\mathrm dV
+\int_{\Gamma_a}\beta u v\,\mathrm dS
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV.
```

The Robin boundary condition is

```{math}
:label: eq-numerical-demag-poisson-robin
\partial_nu+\beta u=0\quad\text{on }\Gamma_a,
\qquad
\beta=\frac{c}{R_\star}.
```

For Dirichlet, the selected outer degrees of freedom satisfy $u=0$ and the boundary mass term is
absent. On a 2D-periodic thin film where `poisson_robin` is requested, a non-zero $\beta$ leaks a
uniform stray field with $N_{zz}^{\mathrm{Robin}} = (1+\beta d)/(1+\beta L) < 1$; the native
boundary operator ([`initialize_demag_poisson_boundary_operator`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124))
therefore resolves 2D-periodic films to pure Neumann ($\beta = 0$) and eliminates one singleton
open-boundary potential DOF ([`film_neumann_gauge_pin_tdof`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88)) to remove the constant nullspace while keeping the reduced matrix strictly SPD.

After solving, the demagnetization energy is reduced from the recovered magnetic field:

```{math}
:label: eq-numerical-demag-poisson-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

### GPU `cuDSS` factor-once Cholesky, VRAM preflight, and Krylov potential predictor

Because the boundary-conditioned matrix $A_{\mathrm R}$ depends only on the mesh and boundary
conditions, the FEM GPU direct realization (`cudss_direct`) computes a fill-reducing permutation
and Cholesky factorization $P A_{\mathrm R} P^{\mathsf T} = L L^{\mathsf T}$ once during backend
creation ([`fullmag_fem_backend_create_v6`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L5921)) and performs two triangular solves on
`hypre_stream` per field evaluation. Factorization starts only after symbolic analysis confirms the
post-analysis peak estimate $\hat M_{\mathrm{peak}}$ fits the device budget
$B = \min(M_{\mathrm{free}} - \max(512\,\mathrm{MiB}, M_{\mathrm{total}}/20),\, B_{\mathrm{cap}})$,
where $B_{\mathrm{cap}}$ combines `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` and
`FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` via $\min$.

When `hypre_krylov` runs (`gpu_strategy="cg_amg"` or `"auto"` VRAM fallback), explicit RK stages
with strictly advancing stage time ($t_{\mathrm{eval}} > t_{\mathrm{last}}$) and step ratio
$\Delta t_n / \Delta t_{n-1} \le 2$ warm-start PCG using the two-step linear potential predictor

```{math}
:label: eq-numerical-demag-poisson-predictor
\phi^{(0)}(t_{\mathrm{eval}})
= \phi_n + \frac{t_{\mathrm{eval}} - t_n}{t_n - t_{n-1}}\bigl(\phi_n - \phi_{n-1}\bigr),
```

with zero overhead (unallocated no-op) under `cudss_direct`. Both `cudss_direct` and `hypre_krylov`
certify every solve independently on GPU via the shared 256-block CUB `ScaledNormPair` residual
check ([`certify_gpu_hypre_demag_residual`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp#L25)
and [`fullmag_cuda_demag_validation_norm_pair`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L265)),
requiring only 1 stream synchronization and 16 B D2H per solve.

(numerical-methods-demag-poisson-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $u$ | magnetic scalar potential | $\mathrm{A}$ |
| $v$ | FEM test function | $1$ |
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d}$ | recovered demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\Omega_a$ | complete magnetic-plus-air domain | $\mathrm{m^3}$ |
| $\Omega_m$ | magnetic subdomain | $\mathrm{m^3}$ |
| $\Gamma_a$ | selected outer airbox boundary | $\mathrm{m^2}$ |
| $\mathbf n$ | outward unit normal on $\Gamma_a$ | $1$ |
| $\beta$ | Robin boundary coefficient | $\mathrm{m^{-1}}$ |
| $c$ | dimensionless Robin coefficient | $1$ |
| $R_\star$ | open-axis reference radius | $\mathrm{m}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $K$ | volume stiffness matrix | $\mathrm{m}$ |
| $B_{\Gamma}$ | boundary mass matrix | $\mathrm{m^2}$ |
| $A_{\mathrm R}$ | Robin matrix $K+\beta B_{\Gamma}$ | $\mathrm{m}$ |
| $b$ | assembled magnetic right-hand side | $\mathrm{A\,m}$ |
| $\widehat u$ | potential degree-of-freedom vector | $\mathrm{A}$ |
| $\phi^{(0)}$ | predicted initial scalar potential for Krylov warm start | $\mathrm{A}$ |
| $\phi_n, \phi_{n-1}$ | accepted scalar potentials at steps $n$ and $n-1$ | $\mathrm{A}$ |
| $t_{\mathrm{eval}}, t_n, t_{n-1}$ | RK stage evaluation and accepted step timestamps | $\mathrm{s}$ |

(numerical-methods-demag-poisson-assumptions-and-validity)=
## Assumptions and validity

- The mesh is conforming across the magnetic body and airbox and carries a stable outer boundary
  marker. A magnetic-only mesh is not a Poisson airbox problem.
- Dirichlet is a finite-domain truncation, not the exact infinite-domain condition. Robin is a
  mesh-scaled open-boundary approximation whose coefficient and open axes must be recorded.
- Automatic P2 scalar potential resolves on non-periodic all-tetrahedral (`tet4`) and pure-prism
  (`pure_prism_p2`, `H1_WedgeElement(2)`) meshes with zero `pyramid5` cells, while mixed
  `prism6 + pyramid5 + tet4` meshes remain scalar P1.
- `cuDSS` direct solves require strictly SPD matrices in FP64 on a single GPU. A singular operator
  such as 3D-periodic pure Neumann without a gauge pin triggers `CUDSS_DATA_INFO != 0` and always
  fails closed — even under `gpu_strategy="auto"`.
- `rtol` and `max_iterations` control the algebraic linear solve. They do not establish airbox,
  mesh, quadrature, or field-recovery accuracy.
- The energy is computed from the recovered magnetic field and must not be replaced by a matrix
  quadratic form unless the implementation records that alternative reduction.

(numerical-methods-demag-poisson-python-api)=
## Python API

```python
# %% Configure a shared-domain FEM Poisson demag stage with gpu_strategy
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_poisson_airbox_demag")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
study.universe.mesh(
    minimum_element_size=3 * nm,
    maximum_element_size=20 * nm,
    maximum_element_growth_rate=1.7,
    grading="geometric",
)
film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=5 * nm,
    maximum_element_size=5 * nm,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pure_prism",
    order=1,
)
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-12,
    max_iterations=500,
    gpu_strategy="auto",
)
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    tolT=1.0e-7,
    max_steps=50_000,
)
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `str \| None` | `None` | $1$ | `airbox`, `bem`, `fredkin_koehler`, or `fmm` | realization family | FEM planner | `energy[].realization` |
| `Demag.variant` | `str \| None` | `None` | $1$ | with `model="airbox"`: `auto`, `robin`, `dirichlet` | outer closure | FEM CPU/GPU | `energy[].realization` |
| `Demag.realization` | `str \| None` | `None` | $1$ | legacy aliases normalize before planning | compatibility selector | normalized before planning | `energy[].realization` |
| `FEM.order` | `int` | required | $1$ | integer greater than or equal to $1$ | finite-element polynomial order | FEM CPU/GPU | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | finite positive; `hmax` alias | target mesh size | FEM CPU/GPU | `backend_policy.discretization_hints.fem.hmax` |
| `FemLinearSolverPolicy.solver` | `Literal["CG","GMRES"]` | `"CG"` | $1$ | `CG` or `GMRES` | Krylov method (FEM CPU and GPU HYPRE fallback) | FEM CPU/GPU | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG","JACOBI","NONE"]` | `"AMG"` | $1$ | `AMG`, `JACOBI`, or `NONE` | Krylov preconditioner (default `AMG` on CPU and GPU fallback; unused under `cudss_direct`) | FEM CPU/GPU | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto","cg_amg","cudss"]` | `"auto"` | $1$ | `auto`, `cg_amg`, or `cudss` | GPU demag direct-vs-Krylov selection policy delivered via `fullmag_fem_backend_create_v6` | FEM GPU (ignored on FEM CPU) | `demag_solver_policy.gpu_strategy` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | finite and strictly positive | relative algebraic tolerance certifying every solve | FEM CPU/GPU | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `float \| None` | `None` | $1$ | positive when supplied | optional absolute algebraic tolerance | FEM CPU/GPU | `demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | integer greater than or equal to $1$ | Krylov iteration ceiling (direct solves report 1 iteration) | FEM CPU/GPU | `demag_solver_policy.max_iterations` |
| `study.universe.mesh(maximum_element_size)` | `float` | inherited/default | $\mathrm{m}$ | finite positive | airbox mesh maximum size | FEM meshing | `study_universe.airbox_hmax` |
| `study.universe.mesh(minimum_element_size)` | `float \| None` | `None` | $\mathrm{m}$ | positive and no larger than maximum | airbox mesh lower bound | FEM meshing | `study_universe.airbox_hmin` |

(numerical-methods-demag-poisson-problem-ir)=
## ProblemIR and provenance

The interaction and FEM solver policy remain distinct:

```json
{
  "energy_terms": [{"kind": "demag", "realization": "poisson_robin"}],
  "backend_policy": {
    "discretization_hints": {
      "fem": {
        "order": 1,
        "hmax": 2e-8,
        "demag_solver_policy": {
          "solver": "CG",
          "preconditioner": "AMG",
          "rtol": 1e-12,
          "max_iterations": 500,
          "print_level": 0,
          "gpu_strategy": "auto"
        }
      }
    }
  }
}
```

`airbox` with omitted or `auto` variant normalizes to `poisson_robin`. Omitted GPU demag solver
policies resolve to `CG` + `AMG` with `gpu_strategy="auto"` ([`resolved_native_fem_demag_solver_policy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/native_fem/plan.rs#L63)).
Execution provenance records `requested_linear_solver_strategy`, `resolved_linear_solver`
(`"cudss_direct"` or `"hypre_krylov"`), `linear_solver_fallback_reason` (populated only on `"auto"`
fallback: `"cudss_unavailable"`, `"cudss_factor_exceeds_vram_budget"`, or
`"cudss_memory_estimate_unavailable"`), achieved residual, iteration count, and mutually exclusive
GPU operator receipt bits (`FULLMAG_FEM_GPU_OPERATOR_DIRECT_SOLVE` vs `PRECONDITIONER`).

(numerical-methods-demag-poisson-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Script export preserves the stage-first workflow, `transition="pure_prism"`, and `gpu_strategy`.
Validation errors include conflicting `model` and legacy `realization`, invalid variant, missing
conforming airbox, invalid `gpu_strategy`, malformed `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` or
`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` caps (always fail-closed even under
`"auto"` or `"cg_amg"`), `CUDSS_DATA_INFO != 0`, invalid `rtol`, and exhausted `max_iterations`.
Unsupported combinations are explicit: an FDM request cannot silently select Poisson, forced
`gpu_strategy="cudss"` over VRAM budget fails hard before factorization (`factorization_started = false`)
with zero fallback, and an unavailable GPU path never falls back silently to CPU. Requested intent,
resolved execution, and validation errors are recorded separately.

(numerical-methods-demag-poisson-discrete-realization)=
## Discrete realization and CPU/GPU separation

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | implemented | MFEM assembly, fixed-mesh cached RHS/recovery sparse transfers, Dirichlet/Robin/2D-film-Neumann operators, Hypre/MFEM `CG/AMG` solve, field recovery, and energy |
| FEM | GPU | implemented | Device CSR RHS/recovery, `device_hypre_poisson` with `fullmag_fem_backend_create_v6`, VRAM-guarded `cuDSS` Cholesky (`auto`/`cudss`), HYPRE `CG/AMG` (`coarse_relax_type = 18`) + two-step $\phi^{(0)}$ predictor (`cg_amg` / fallback), and 256-block CUB residual certification; RTX 4080 SUPER A/B verified |
| FDM | CPU | not-applicable | Uses the Newell tensor convolution page ({doc}`fdm-convolution`) |
| FDM | GPU | not-applicable | Uses the CUDA half-spectrum cuFFT convolution page ({doc}`fdm-convolution`) |

The weak form is shared by CPU and GPU. On CPU, fixed RHS and physical/visual recovery transfer
matrices are cached in [`demag_poisson_transfer.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_transfer.hpp#L133)
with bounded setup budgets. On GPU, `device_hypre_poisson` keeps RHS assembly, solve, recovery, and
energy reduction strictly device-resident with zero hot-loop host compute.

(numerical-methods-demag-poisson-implementation-mapping)=
## Implementation mapping

Public `Demag` and `FemLinearSolverPolicy` normalization, MFEM CPU right-hand side, transfer caching,
boundary closures (including 2D-film pure-Neumann gauge pinning), Hypre solves, field recovery,
energy reduction, pure-prism P2 meshing, and CUDA `cuDSS` / HYPRE / predictor / certification
components are mapped in {ref}`numerical-methods-demag-poisson-source-code-index`.

(numerical-methods-demag-poisson-validation)=
## Validation

- **RTX 4080 SUPER A/B (`cuDSS` guarded Cholesky & Krylov predictor):**
  - Open-airbox SP4 (`8,208` nodes, `60,791` P2 DOFs, `rtol = 1e-8`): `auto` (`cudss_direct`)
    achieves **`218.4×`** Heun (`813.13 -> 3.72 ms/step`, `325.6 MiB` VRAM, `max |dm| = 5.65e-12`,
    `rel |dE_demag| = 1.66e-12`) and **`150.8×`** RK4 (`1215.01 -> 8.06 ms/step`, `max |dm| = 5.97e-12`).
  - Open-airbox medium (`49,600` nodes, `380,701` P2 DOFs): `auto` (`cudss_direct`) achieves
    **`20.36×`** Heun (`477.30 -> 23.45 ms/step`, `3.13 GiB` VRAM, `max |dm| = 2.51e-11`) and
    **`19.07×`** RK4 (`874.73 -> 45.87 ms/step`, `max |dm| = 2.39e-11`); `cg_amg` with the two-step
    predictor $\phi^{(0)}$ cuts PCG iterations per solve by **`-22.0%`** (Heun) and **`-42.3%`**
    (RK4), and **`-48.0%`/`-53.9%`** combined with FSAL (`1.87×–2.19×` wall speedup).
  - Tight VRAM cap (`FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB=32` on `49,600` nodes): `auto` cleanly
    falls back to `hypre_krylov` with `linear_solver_fallback_reason="cudss_factor_exceeds_vram_budget"`,
    `factorization_started = false`, bitwise `0.0` parity vs `cg_amg`; forced `cudss` fails closed
    before factorization with zero fallback.
- **Pure-prism P2 thin-film benchmark (`300×300×5 nm` Permalloy, $h = 5.0\,\mathrm{nm}$, RTX 4080 SUPER):**
  - `L=1` (`594,239` P2 DOFs, `5.14 GiB` `cuDSS`, `0.50 s` mesh): `-0.80%` uniform Aharoni error
    (vs `-30.11%` for mixed P1), relaxed $E_{\mathrm{total}}$ `-0.50%` vs FDM, **`38.53 ms/step`**
    (**`144.8×`** faster than `cg_amg` `5,579.74 ms/step`).
  - `L=2` (`709,253` P2 DOFs, `5.76×` fewer than `tet P2`, `6.73 GiB` `cuDSS`, `0.51 s` mesh):
    `-0.60%` uniform Aharoni error, relaxed $E_{\mathrm{total}}$ `-0.43%` vs FDM, **`51.88 ms/step`**.

See {ref}`numerical-methods-performance-fem-gpu-demag` for complete benchmark tables.

(numerical-methods-demag-poisson-limitations)=
## Limitations

Robin is an approximation to open decay and depends on the airbox/reference-radius policy.
Dirichlet is a finite truncation. `cuDSS` is currently single-GPU, single-process FP64; symbolic
analysis runs before `CUDSS_DATA_MEMORY_ESTIMATES` is queried, so extreme meshes can still exhaust
VRAM during analysis before factorization preflight runs. `pure_prism_p2` currently targets single
axis-aligned boxes with open-boundary Poisson demagnetization (periodic `pure_prism_p2` fails closed).

(numerical-methods-demag-poisson-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied Physics* **83**, 3432–3434 (1998), [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
- P. F. Fischer, “Projection techniques for iterative solution of $Ax = b$ with successive right-hand sides,” *Computer Methods in Applied Mechanics and Engineering* **163**, 193–204 (1998), [doi:10.1016/S0045-7825(98)00012-7](https://doi.org/10.1016/S0045-7825(98)00012-7).
- T. A. Davis, *Direct Methods for Sparse Linear Systems*, SIAM, 2006, [doi:10.1137/1.9780898718881](https://doi.org/10.1137/1.9780898718881).
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/fem-poisson-airbox`.
- Performance reference: {ref}`numerical-methods-performance-fem-gpu-demag`.

(numerical-methods-demag-poisson-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public realization | [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) | [`class Demag`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) | model and variant normalization | public API | Python tests |
| Solver policy | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) | [`class FemLinearSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) | linear solver and `gpu_strategy` controls | public API | Python tests |
| Pure-prism P2 mesher | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6669) | [`generate_pure_prism_box_airbox_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6669) | 100% `prism6` P2-capable shared-domain mesh | FEM meshing | RTX 4080 SUPER A/B verified |
| Default GPU policy | [`crates/fullmag-runner/src/native_fem/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/native_fem/plan.rs#L63) | [`resolved_native_fem_demag_solver_policy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/native_fem/plan.rs#L63) | unified `CG/AMG` + `gpu_strategy` resolution | FEM runner | Rust tests |
| RHS assembly & transfer cache | [`backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) | [`assemble_demag_poisson_rhs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) | magnetic source assembly and CPU transfer caching | FEM CPU | contract tests |
| Boundary closure | [`backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124) | [`initialize_demag_poisson_boundary_operator`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124) | Dirichlet, Robin, and 2D-film pure-Neumann closure | FEM CPU/GPU | boundary contracts |
| 2D-film gauge pin | [`backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88) | [`film_neumann_gauge_pin_tdof`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88) | singleton open-boundary gauge pin for $\beta = 0$ films | FEM CPU/GPU | periodic contracts |
| CPU solve | [`backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) | [`solve_demag_poisson_hypre`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) | Hypre/MFEM solve and telemetry | FEM CPU | managed runtime evidence |
| Field recovery | [`backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) | [`recover_demag_poisson_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) | recovered field and CPU recovery cache | FEM CPU | recovery contracts |
| Energy reduction | [`backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) | [`demag_poisson_energy_from_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) | energy reduction | FEM CPU | reduction contracts |
| GPU RHS | [`backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L350) | [`demag_rhs_csr_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L350) | device CSR RHS | FEM GPU | CUDA contracts |
| GPU `cuDSS` direct | [`backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) | [`try_initialize_demag_cudss_direct`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) | VRAM-guarded Cholesky factor-once resolver | FEM GPU | RTX 4080 SUPER A/B verified |
| GPU HYPRE init | [`backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp#L257) | [`initialize_demag_poisson_hypre_device_solver`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp#L257) | three-state GPU solver setup and AMG `coarse_relax_type = 18` | FEM GPU | RTX 4080 SUPER A/B verified |
| GPU linear predictor | [`backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu#L69) | [`gpu_demag_predictor_apply_warm_start`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu#L69) | two-step linear potential predictor $\phi^{(0)}$ | FEM GPU | RTX 4080 SUPER A/B verified |
| GPU residual cert | [`backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp#L25) | [`certify_gpu_hypre_demag_residual`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp#L25) | multi-block CUB `ScaledNormPair` certification | FEM GPU | RTX 4080 SUPER A/B verified |
| Creation-time ABI | [`backends/fem/src/api.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L5921) | [`fullmag_fem_backend_create_v6`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L5921) | delivers `gpu_strategy` before demag workspace init | FEM C ABI | ABI & contract tests |
