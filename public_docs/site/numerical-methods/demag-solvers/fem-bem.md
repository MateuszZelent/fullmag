---
title: FEM Bem
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-demag-solvers-fem-bem)=
# FEM/BEM Fredkin–Koehler demagnetization

(numerical-methods-demag-bem-problem-statement)=
## Scope and purpose

The canonical interaction is owned by {doc}`../../physics/interactions/demagnetization/index`.
Fredkin–Koehler is a body-only FEM realization (`tet4` magnetic mesh, scalar P1 potential): the
magnetic volume is meshed with FEM, while the open exterior is represented by a boundary-integral
operator on the closed magnetic surface $\Gamma_m = \partial\Omega_m$. Both FEM CPU (hierarchical
H2 boundary operator with small dense reference oracle) and FEM GPU (strict device-resident
`device_hypre_fem_bem` with flattened near-field CSR + ACA far-field blocks, device HYPRE `CG/AMG`
or `JACOBI`, and atomic `(u1, u2)` `cuDSS` direct Cholesky solves) are implemented and verified.

(numerical-methods-demag-bem-governing-equations)=
## Scientific and numerical model

The total potential is decomposed into an interior source potential and a harmonic correction:

```{math}
:label: eq-numerical-demag-bem-decomposition
u=u_1+u_2,
\qquad
\int_{\Omega_m}\nabla u_1\cdot\nabla v\,\mathrm dV
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV.
```

The boundary trace of $u_2$ is supplied by the Fredkin–Koehler double-layer boundary operator:

```{math}
:label: eq-numerical-demag-bem-boundary-map
g_2=\mathcal B\left(\gamma u_1\right),
\qquad
\mathbf H_{\mathrm d}=-\nabla(u_1+u_2).
```

The interior Neumann problem for $u_1$ has one constant nullspace per connected component of
$\Omega_m$; symmetric `EliminateRowCol` (`DIAG_ONE`) pins the smallest global node per connected
component, producing a strictly SPD matrix $K_{\mathrm{neumann}}$. Eliminating all boundary nodes
on $\Gamma_m$ yields a strictly SPD Dirichlet matrix $K_{\mathrm{dirichlet}}$ for $u_2$. Boundary
triangles contribute exact Lindholm near-field weights and deterministic ACA low-rank $UV^{\mathsf T}$
far-field blocks, including the oriented solid-angle self term:

```{math}
:label: eq-numerical-demag-bem-solid-angle
\mathcal B_{ii}\propto\omega_{T_i},
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

On FEM GPU, both SPD systems $(u_1, u_2)$ are admitted atomically into `cuDSS` Cholesky
([`try_initialize_fem_bem_cudss_pair`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L761))
against the sequential peak VRAM bound $\max(\hat M_{\mathrm{peak},1}, \hat M_{\mathrm{stable},1} + \hat M_{\mathrm{peak},2}) \le B$,
so both solves always share the same linear-solver family (`cudss_direct` or `hypre_krylov`) and
emit mutually exclusive GPU receipt bits (`DIRECT_SOLVE` vs `PRECONDITIONER`).

(numerical-methods-demag-bem-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $u$ | total scalar potential | $\mathrm{A}$ |
| $u_1$ | interior Poisson potential | $\mathrm{A}$ |
| $u_2$ | harmonic boundary correction | $\mathrm{A}$ |
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $v$ | FEM test function | $1$ |
| $\Omega_m$ | magnetic volume | $\mathrm{m^3}$ |
| $\Gamma_m$ | closed magnetic surface | $\mathrm{m^2}$ |
| $\gamma$ | FEM trace operator | $1$ |
| $\mathcal B$ | Fredkin–Koehler boundary-integral map | $1$ |
| $g_2$ | boundary values for $u_2$ | $\mathrm{A}$ |
| $\omega_T$ | oriented solid angle of triangle $T$ | $1$ |
| $T$ | oriented boundary triangle | $\mathrm{m^2}$ |
| $i$ | boundary-node index | $1$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |

(numerical-methods-demag-bem-assumptions-and-validity)=
## Assumptions and validity

- The active magnetic domain must be a body-only `tet4` mesh with scalar P1 potential and a
  closed, consistently oriented watertight surface (`prism6`, `pyramid5`, and P2 potentials are
  rejected fail-closed outside the Fredkin–Koehler contract).
- Each connected magnetic component receives one deterministic Neumann gauge pin; a singular
  matrix is not an accepted solve.
- Production CPU execution uses [`HierarchicalDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L1475)
  (exact near-field Lindholm + deterministic ACA far-field); [`DenseDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L364)
  is reserved as a small memory-guarded reference oracle.
- **Krylov `DIAG_ONE` scaling vs `cuDSS` immunity:** `EliminateRowCol` sets boundary diagonal
  entries of $K_{\mathrm{dirichlet}}$ to `1.0` while interior stiffness entries scale with mesh
  spacing $h$ ($\sim 10^{-8}\,\mathrm{m}$, a $\sim 1/h \approx 10^8$ jump). Under Krylov
  (`cg_amg`), the global residual norm $\|r\|_2 / \|b\|_2$ is dominated by boundary rows, so
  `rtol = 1e-8` leaves $O(10^{-5})$ interior error in $u_2$ and requires a tighter `rtol` (such as
  `1e-12`) for high-precision Krylov parity. Factor-once `cuDSS` Cholesky (`gpu_strategy="auto"|"cudss"`)
  is completely immune to `DIAG_ONE` scaling, reaching machine precision already at `rtol = 1e-8`.
- The method is body-only FEM/BEM. An airbox is not implicitly added, and an explicit GPU request
  never falls back silently to CPU.

(numerical-methods-demag-bem-python-api)=
## Python API

```python
# %% Configure the body-only FEM/BEM demag stage (CPU or GPU with gpu_strategy)
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_bem_demag")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.demag(model="fredkin_koehler")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
    max_iterations=500,
    gpu_strategy="auto",
)
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-14,
    max_err=1.0e-7,
    tolT=1.0e-6,
    max_steps=50_000,
)
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `str \| None` | `None` | $1$ | `fredkin_koehler` selects body-only FEM/BEM | realization family | FEM CPU (H2) and FEM GPU (`device_hypre_fem_bem` / `cuDSS`) | `energy[].realization` |
| `Demag.variant` | `str \| None` | `None` | $1$ | omitted for non-airbox models | airbox-only selector, not BEM policy | not applicable | `energy[].realization` |
| `FEM.order` | `int` | required | $1$ | `1` for body-only `tet4` FEM/BEM | interior FE order | FEM CPU/GPU | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | finite positive; `hmax` alias | body mesh size | FEM CPU/GPU | `backend_policy.discretization_hints.fem.hmax` |
| `FemLinearSolverPolicy.solver` | `Literal["CG","GMRES"]` | `"CG"` | $1$ | `CG` or `GMRES` | sparse solver for $u_1$ and $u_2$ (CPU and GPU Krylov fallback) | FEM CPU/GPU | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG","JACOBI","NONE"]` | `"AMG"` | $1$ | `AMG`, `JACOBI`, or `NONE` | sparse preconditioner (`coarse_relax_type = 18` for GPU AMG; unused under `cudss_direct`) | FEM CPU/GPU | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto","cg_amg","cudss"]` | `"auto"` | $1$ | `auto`, `cg_amg`, or `cudss` | selects atomic `(u1, u2)` `cuDSS` pair vs device HYPRE Krylov | FEM GPU (ignored on FEM CPU) | `demag_solver_policy.gpu_strategy` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | finite and positive | algebraic tolerance certifying both $u_1$ and $u_2$ solves | FEM CPU/GPU | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | integer greater than or equal to $1$ | solve iteration ceiling (direct solves report 1 iteration per system) | FEM CPU/GPU | `demag_solver_policy.max_iterations` |

(numerical-methods-demag-bem-problem-ir)=
## ProblemIR and provenance

The canonical request is a demag interaction with a body-only FEM/BEM realization:

```json
{
  "energy_terms": [{"kind": "demag", "realization": "fredkin_koehler"}],
  "backend_policy": {
    "discretization_hints": {
      "fem": {
        "order": 1,
        "hmax": 2e-8,
        "demag_solver_policy": {
          "solver": "CG",
          "preconditioner": "AMG",
          "rtol": 1e-10,
          "max_iterations": 500,
          "print_level": 0,
          "gpu_strategy": "auto"
        }
      }
    }
  }
}
```

Requested realization and resolved execution (`device_hypre_fem_bem` on GPU or hierarchical H2 on
CPU) remain separate. Provenance on `FemBemDemagProvenance` records boundary-node count, ACA
near/far block statistics, gauge DOFs, `requested_linear_solver_strategy`, `resolved_linear_solver`
(`"cudss_direct"` or `"hypre_krylov"`), `linear_solver_fallback_reason`, residuals, iteration
counts, and GPU execution receipt bits.

(numerical-methods-demag-bem-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Script export preserves the stage-first study, BEM realization, and `gpu_strategy`.
Validation errors include an unsupported model, non-airbox variant, non-`tet4` or non-watertight surface
topology, gauge failure, invalid sparse solver policy, malformed VRAM budget env vars, and
non-positive tolerances. Unsupported combinations are explicit: `prism6`/`pyramid5`/P2 meshes fail
closed, forced `gpu_strategy="cudss"` over the atomic pair budget fails closed before either
factorization starts (`factorization_started = false`), and an explicit GPU request never falls
back silently to CPU. Requested intent and resolved execution are recorded separately.

(numerical-methods-demag-bem-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | implemented | Interior FEM $u_1$ (gauge-pinned), hierarchical H2 boundary operator (near Lindholm + far ACA; dense oracle for small checks), harmonic $u_2$, two sparse solves, and field recovery |
| FEM | GPU | implemented | Strict device-resident `device_hypre_fem_bem`: flattened near-field CSR + ACA far-field blocks uploaded once, atomic `(u1, u2)` `cuDSS` Cholesky (`auto`/`cudss`) or device HYPRE `CG/AMG` (`coarse_relax_type = 18`) / `JACOBI` (`cg_amg`/fallback), `HypreStreamInterop` event fences, and shared 256-block CUB residual certification (2× sync / 32 B per demag eval); RTX 4080 SUPER A/B verified |
| FDM | CPU | not-applicable | Use FDM tensor convolution ({doc}`fdm-convolution`) |
| FDM | GPU | not-applicable | Use FDM CUDA half-spectrum convolution ({doc}`fdm-convolution`) |

(numerical-methods-demag-bem-implementation-mapping)=
## Implementation mapping

Public `Demag` policy lowering, the MFEM CPU Fredkin–Koehler sequence (gauge-pinned Neumann RHS,
hierarchical H2 and dense boundary operators, sparse interior solves, Dirichlet boundary injection,
potential recombination, field recovery, and energy reduction), and the CUDA `device_hypre_fem_bem`
plus atomic `(u1, u2)` `cuDSS` pipeline are indexed in {ref}`numerical-methods-demag-bem-source-code-index`.

(numerical-methods-demag-bem-validation)=
## Validation

- **RTX 4080 SUPER A/B verification (`fembem_open`, `1,183` nodes, `5,184` `TET4`, `664` boundary
  nodes, body-only without airbox, Heun, 50 timed steps, `rtol = 1e-8` vs CPU FEM/BEM oracle at
  `rtol = 1e-10`):**
  - `gpu_strategy="auto"` (`cudss_direct`, `factor_nnz = 87,736`, `10.5 MiB` VRAM): **`2.20 ms/step`**
    (**`34.6×`** faster than GPU `AMG` `76.10 ms/step`, **`19.5×`** faster than GPU `JACOBI`
    `42.90 ms/step`, and **`5.4×`** faster than CPU FEM/BEM `11.97 ms/step`), achieving machine-level
    parity **`max |dm| = 4.88e-14`**, **`rel |dE_demag| = 1.54e-14`**, **`rel |dH_demag| = 2.27e-13`**,
    and residual `1.10e-23`.
  - `gpu_strategy="cg_amg"` (`hypre_krylov`): `AMG` (`coarse_relax_type = 18`) runs `76.10 ms/step`
    (`11.25` iters/solve) and `JACOBI` runs `42.90 ms/step` (`52.19` iters/solve); tightening Krylov
    `rtol` from `1e-8` to `1e-12` overcomes `DIAG_ONE` boundary scaling and reduces discrepancy vs CPU
    from `2.32e-5` to **`3.36e-9`** ($m$) and **`3.01e-8`** ($H_{\mathrm{demag}}$).
- **Memory safety and contracts:** `fem_demag_fem_bem_contract`, `fem_demag_fem_bem_gpu_contract`,
  and `compute-sanitizer --tool memcheck` (0 memory errors) all pass.

See {ref}`numerical-methods-performance-fem-gpu-demag` for full comparative tables.

(numerical-methods-demag-bem-limitations)=
## Limitations

Body-only FEM/BEM is restricted to `tet4` meshes with scalar P1 potential; large-scale thin-film
physical qualification against independent external benchmarks remains a separate validation track.
Krylov paths under `cg_amg` are sensitive to `DIAG_ONE` boundary-row scaling and require tighter
`rtol` (e.g., `1e-12`) when high-precision interior accuracy is needed without `cuDSS`.

(numerical-methods-demag-bem-scientific-bibliography)=
## Scientific bibliography

- D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* 26 (1990), 415–417, DOI: [10.1109/20.106342](https://doi.org/10.1109/20.106342).
- J. A. Osborn, “Demagnetizing factors of the general ellipsoid,” *Physical Review* 67 (1945), 351–357, DOI: [10.1103/PhysRev.67.351](https://doi.org/10.1103/PhysRev.67.351).
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/fem-bem`.
- Performance reference: {ref}`numerical-methods-performance-fem-gpu-demag`.

(numerical-methods-demag-bem-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public realization | [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) | [`class Demag`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) | model and IR | public API | Python tests |
| Gauge RHS | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp#L18) | [`prepare_demag_fem_bem_neumann_rhs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp#L18) | gauge-pinned source | FEM CPU | source contracts |
| Dense oracle | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L364) | [`DenseDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L364) | small reference boundary map | FEM CPU | source contracts |
| Hierarchical H2 operator | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L1475) | [`HierarchicalDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L1475) | production near-Lindholm + ACA far-field operator | FEM CPU/GPU setup | contract tests |
| Boundary values | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp#L40) | [`prepare_demag_fem_bem_dirichlet_rhs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp#L40) | row-aligned boundary-value injection | FEM CPU | contract tests |
| Sparse solves | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp#L185) | [`solve_demag_fem_bem_sparse_system`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp#L185) | $u_1/u_2$ solves | FEM CPU | runtime telemetry |
| CPU orchestration | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp#L30) | [`context_compute_demag_fem_bem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp#L30) | sequence and artifacts | FEM CPU | runtime tests |
| Potential combine | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp#L43) | [`combine_demag_fem_bem_total_potential`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp#L43) | total potential $u_1 + u_2$ | FEM CPU | source contracts |
| Field recovery | [`backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) | [`recover_demag_poisson_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) | field recovery | FEM CPU | source contracts |
| Energy reduction | [`backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) | [`demag_poisson_energy_from_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) | energy reduction | FEM CPU | source contracts |
| GPU FEM/BEM init | [`backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L697) | [`gpu_demag_fem_bem_initialize`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L697) | `device_hypre_fem_bem` upload, AMG `relax_type=18`, and `cuDSS` pair wiring | FEM GPU | RTX 4080 SUPER A/B verified |
| GPU FEM/BEM stage | [`backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L1161) | [`compute_device_demag_fem_bem_for_device_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L1161) | device-resident $u_1 \to \text{BEM} \to u_2 \to \mathbf H_{\mathrm d}, E_{\mathrm d}$ | FEM GPU | RTX 4080 SUPER A/B verified |
| GPU atomic `cuDSS` pair | [`backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L761) | [`try_initialize_fem_bem_cudss_pair`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L761) | atomic `(u1, u2)` sequential VRAM preflight and Cholesky factorization | FEM GPU | RTX 4080 SUPER A/B verified |
