---
title: FEM Poisson Airbox
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-demag-solvers-fem-poisson-airbox)=
# FEM Poisson airbox solver

(numerical-methods-demag-poisson-problem-statement)=
## Physical and numerical problem

The canonical physical demagnetization definition is owned by
{doc}`../../physics/interactions/demagnetization/index`. This page describes the shared-domain
FEM realization: the magnetic body $\Omega_m$ is embedded in an airbox so that a scalar potential
can be solved on $\Omega_a=\Omega_m\cup\Omega_{\mathrm{air}}$. The airbox boundary marker, outer
closure, linear-solver policy, field recovery and energy reduction are one numerical problem.

The page has two distinct closures. Dirichlet fixes the outer potential; Robin adds a boundary
operator approximating open decay. They are not two names for one solver setting and results must
record the selected closure.

(numerical-methods-demag-poisson-governing-equations)=
## Governing equations

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
absent. After solving, the demagnetization energy is reduced from the recovered magnetic field:

```{math}
:label: eq-numerical-demag-poisson-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

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

(numerical-methods-demag-poisson-assumptions-and-validity)=
## Assumptions and validity

- The mesh is conforming across the magnetic body and airbox and carries a stable outer boundary
  marker. A magnetic-only mesh is not a Poisson airbox problem.
- Dirichlet is a finite-domain truncation, not the exact infinite-domain condition.
- Robin is a mesh-scaled open-boundary approximation. Its coefficient and selected open axes must
  be recorded; it is not a universal constant.
- `rtol` and `max_iterations` control the algebraic linear solve. They do not establish airbox,
  mesh, quadrature or field-recovery accuracy.
- The energy is computed from the recovered magnetic field and must not be replaced by a matrix
  quadratic form unless the implementation records that alternative reduction.

(numerical-methods-demag-poisson-python-api)=
## Python API

```python
# %% Configure a shared-domain FEM Poisson demag stage
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
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-12,
    max_iterations=500,
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

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `str \| None` | `None` | $1$ | `airbox`, `bem`, `fredkin_koehler`, or `fmm` | realization family | FEM planner | `energy[].realization` |
| `Demag.variant` | `str \| None` | `None` | $1$ | with `model="airbox"`: `auto`, `robin`, `dirichlet` | outer closure | FEM CPU/GPU subject to qualification | `energy[].realization` |
| `Demag.realization` | `str \| None` | `None` | $1$ | legacy aliases normalize before planning | compatibility selector | normalized before planning | `energy[].realization` |
| `FEM.order` | `int` | required | $1$ | integer greater than or equal to $1$ | finite-element polynomial order | FEM CPU/GPU | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | finite positive; `hmax` alias | target mesh size | FEM CPU/GPU | `backend_policy.discretization_hints.fem.hmax` |
| `FemLinearSolverPolicy.solver` | `Literal["CG","GMRES"]` | `"CG"` | $1$ | `CG` or `GMRES` | Krylov method | FEM CPU/GPU | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG","JACOBI","NONE"]` | `"AMG"` | $1$ | `AMG`, `JACOBI`, or `NONE` | preconditioner | FEM CPU/GPU | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | finite and strictly positive | relative algebraic tolerance | FEM CPU/GPU | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `float \| None` | `None` | $1$ | positive when supplied | optional absolute algebraic tolerance | FEM CPU/GPU | `demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | integer greater than or equal to $1$ | Krylov iteration ceiling | FEM CPU/GPU | `demag_solver_policy.max_iterations` |
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
          "max_iterations": 500
        }
      }
    }
  }
}
```

`airbox` with omitted or `auto` variant normalizes to the Robin family. Explicit `dirichlet`
remains distinct. Resolved mesh topology, boundary marker, essential DOFs, solver residual,
iteration count, precision, CPU/GPU lane and actual device are provenance, not inferred defaults.

(numerical-methods-demag-poisson-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves the stage-first workflow and separate airbox/solver policies. Validation
errors include conflicting `model` and legacy `realization`, invalid variant, missing conforming
airbox, invalid `rtol`, invalid solver/preconditioner, and exhausted `max_iterations`. Unsupported combinations
are explicit: a FDM request cannot silently select Poisson, and an unavailable GPU
Hypre path cannot silently fall back to CPU. A linear-solver non-convergence is a failed demag
evaluation, not an accepted field.

Requested intent, resolved execution and validation errors are recorded separately. Unsupported combinations
remain explicit in planner provenance rather than being replaced by a different solver.

(numerical-methods-demag-poisson-discrete-realization)=
## Discrete realization and CPU/GPU separation

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | implemented/source-backed | MFEM assembly, explicit Dirichlet/Robin operator, Hypre/MFEM solve, field recovery and energy |
| FEM | GPU | source-backed/qualification-dependent | device CSR RHS/recovery, device Hypre policy and staged energy reduction |
| FDM | CPU | not applicable | uses the Newell tensor convolution page |
| FDM | GPU | not applicable | uses the CUDA tensor convolution page |

The weak form is shared by CPU/GPU. The assembled operator, sparse solver library, memory residency,
boundary-DOF preparation, reductions and telemetry are separate lane contracts.

(numerical-methods-demag-poisson-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Demag normalization | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | model/variant aliases and IR | public API |
| FEM solver policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | CG/GMRES, preconditioner, tolerances and limits | public API |
| RHS | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | magnetic Poisson RHS | FEM CPU |
| Boundary operator | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Dirichlet/Robin construction | FEM CPU |
| Linear solve | `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | solver and telemetry | FEM CPU |
| Field recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | gradient, mask and field handoff | FEM CPU |
| Device RHS/recovery | `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_rhs_csr_kernel` | device CSR RHS and recovery kernels | FEM GPU |

(numerical-methods-demag-poisson-validation)=
## Validation

Validation must separately test boundary markers and operators, manufactured Poisson fields, solver
residual/iteration telemetry, airbox-size and mesh convergence, recovered-field energy identity,
Dirichlet-versus-Robin differences, and executed CPU/GPU evidence. `rtol=1e-12` proves only an
algebraic policy if mesh and airbox convergence are not also measured.

(numerical-methods-demag-poisson-limitations)=
## Limitations

Robin is an approximation to open decay and depends on the airbox/reference-radius policy.
Dirichlet is a finite truncation. This page does not claim universal GPU Hypre qualification or
equivalence between the two closures.

(numerical-methods-demag-poisson-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., *Micromagnetics*, Wiley, 1963.
- A. J. F. Siegert and A. J. Newell, open-boundary scalar-potential formulations as summarized in the canonical Fullmag demagnetization note.
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/fem-poisson-airbox`.

(numerical-methods-demag-poisson-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public realization | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | model and variant normalization | public API | Python tests |
| Solver policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | linear solver controls | public API | Python tests |
| RHS assembly | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | magnetic source term | FEM CPU | source contracts |
| Boundary closure | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Dirichlet and Robin operators | FEM CPU | boundary contracts |
| CPU solve | `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | Hypre/MFEM solve and telemetry | FEM CPU | managed runtime evidence |
| Field recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | recovered field | FEM CPU | recovery contracts |
| GPU RHS | `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_rhs_csr_kernel` | device RHS | FEM GPU | CUDA/source contract |
