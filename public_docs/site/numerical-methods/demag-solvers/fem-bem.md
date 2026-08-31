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
## Physical and numerical problem

The canonical interaction is owned by {doc}`../../physics/interactions/demagnetization/index`.
Fredkin–Koehler is a body-only FEM realization: the magnetic volume is meshed with FEM, while the
open exterior is represented by a dense boundary operator on the closed magnetic surface. It is
not the airbox Poisson problem and it has no production GPU BEM lane in the current public contract.

(numerical-methods-demag-bem-governing-equations)=
## Governing equations

The total potential is decomposed into an interior source potential and a harmonic correction:

```{math}
:label: eq-numerical-demag-bem-decomposition
u=u_1+u_2,
\qquad
\int_{\Omega_m}\nabla u_1\cdot\nabla v\,\mathrm dV
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV.
```

The boundary trace of $u_2$ is supplied by the dense Fredkin–Koehler map:

```{math}
:label: eq-numerical-demag-bem-boundary-map
g_2=\mathcal B\left(\gamma u_1\right),
\qquad
\mathbf H_{\mathrm d}=-\nabla(u_1+u_2).
```

The scalar Neumann problem has an additive gauge. The implementation removes it by pinning a
gauge degree of freedom before solving the sparse system. Boundary triangles contribute the dense
operator, including the oriented solid-angle self term:

```{math}
:label: eq-numerical-demag-bem-solid-angle
\mathcal B_{ii}\propto\omega_{T_i},
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

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
| $\mathcal B$ | dense boundary-integral map | $1$ |
| $g_2$ | boundary values for $u_2$ | $\mathrm{A}$ |
| $\omega_T$ | oriented solid angle of triangle $T$ | $1$ |
| $T$ | oriented boundary triangle | $\mathrm{m^2}$ |
| $i$ | boundary-node index | $1$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |

(numerical-methods-demag-bem-assumptions-and-validity)=
## Assumptions and validity

- The magnetic surface is closed and consistently oriented. Open or self-intersecting surface
  topology invalidates the dense operator.
- The interior Neumann solve requires an explicit gauge treatment; a singular matrix is not a
  converged solve.
- The dense boundary operator and sparse FEM solves have separate discretization and algebraic
  errors. `rtol` applies to sparse solves, not to the boundary quadrature.
- The method is body-only FEM/BEM. An airbox is not implicitly added.
- Current public support is FEM CPU/reference. FEM GPU is unsupported here and must not be inferred
  from other GPU Poisson sources.

(numerical-methods-demag-bem-python-api)=
## Python API

```python
# %% Configure the body-only FEM/BEM demag stage
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_bem_demag")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.demag(model="fredkin_koehler")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
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
| `Demag.model` | `str \| None` | `None` | $1$ | `fredkin_koehler` selects body-only FEM/BEM | realization family | FEM CPU; GPU unsupported | `energy[].realization` |
| `Demag.variant` | `str \| None` | `None` | $1$ | omitted for non-airbox models | airbox-only selector, not BEM policy | not applicable | `energy[].realization` |
| `FEM.order` | `int` | required | $1$ | integer greater than or equal to $1$ | interior FE order | FEM CPU | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | finite positive; `hmax` alias | body mesh size | FEM CPU | `backend_policy.discretization_hints.fem.hmax` |
| `FemLinearSolverPolicy.solver` | `Literal["CG","GMRES"]` | `"CG"` | $1$ | `CG` or `GMRES` | sparse solver for $u_1$ and $u_2$ | FEM CPU | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG","JACOBI","NONE"]` | `"AMG"` | $1$ | `AMG`, `JACOBI`, or `NONE` | sparse preconditioner | FEM CPU | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | finite and positive | algebraic tolerance for each sparse solve | FEM CPU | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | integer greater than or equal to $1$ | solve iteration ceiling | FEM CPU | `demag_solver_policy.max_iterations` |

(numerical-methods-demag-bem-problem-ir)=
## ProblemIR and provenance

The canonical request is a demag interaction with a body-only FEM/BEM realization:

```json
{
  "energy_terms": [{"kind": "demag", "realization": "fredkin_koehler"}],
  "backend_policy": {
    "discretization_hints": {
      "fem": {"order": 1, "hmax": 2e-8,
        "demag_solver_policy": {"solver": "CG", "preconditioner": "AMG", "rtol": 1e-10, "max_iterations": 500}}
    }
  }
}
```

Requested realization and resolved FEM CPU path remain separate. Provenance records the closed
surface topology, triangle quadrature, gauge DOF, both sparse solves, residuals, iteration counts,
precision and energy reduction.

(numerical-methods-demag-bem-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves the stage-first study and BEM realization. Validation errors include an
unsupported model, non-airbox variant, invalid surface topology, gauge failure, invalid sparse
solver policy and non-positive tolerances. Unsupported combinations are explicit: FEM GPU is
unsupported for this page and cannot silently fall back from an explicit GPU request to CPU.
Requested intent and resolved execution are recorded separately; `rtol` success does not prove
surface quadrature or physical open-boundary convergence.

(numerical-methods-demag-bem-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | partial/source-backed | interior FEM $u_1$, dense surface map, harmonic $u_2$, two sparse solves and field recovery |
| FEM | GPU | unsupported | no production GPU FEM/BEM lane is claimed |
| FDM | CPU | not applicable | use FDM convolution |
| FDM | GPU | not applicable | use FDM convolution CUDA |

(numerical-methods-demag-bem-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| BEM RHS/gauge | `backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp` | `prepare_demag_fem_bem_neumann_rhs` | Neumann RHS and gauge pin | FEM CPU |
| Dense operator | `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp` | `DenseDemagBemOperator::build` | surface map and solid angles | FEM CPU |
| Sparse solve | `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp` | `solve_demag_fem_bem_sparse_system` | policy-controlled solves | FEM CPU |
| Boundary values | `backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp` | `prepare_demag_fem_bem_dirichlet_rhs` | injects $g_2$ | FEM CPU |
| Orchestration | `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` | `context_compute_demag_fem_bem` | full sequence and telemetry | FEM CPU |
| Potential | `backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp` | `combine_demag_fem_bem_total_potential` | forms $u_1+u_2$ | FEM CPU |
| Field recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | recovers $\mathbf H_{\mathrm d}$ from the total potential | FEM CPU |
| Energy reduction | `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | reduces $E_{\mathrm d}$ from $\mathbf M$ and $\mathbf H_{\mathrm d}$ | FEM CPU |

(numerical-methods-demag-bem-validation)=
## Validation

Validate closed-surface topology, solid-angle diagonal/self term, gauge removal, $u_1/u_2$ solver
residuals, sphere/ellipsoid demag factors, field/energy identity and CPU artifact provenance. No
GPU parity claim follows from a CPU BEM result.

(numerical-methods-demag-bem-limitations)=
## Limitations

The dense surface operator scales with boundary complexity and is not a production GPU path. The
page does not claim equivalence with an airbox truncation or universal geometry convergence.

(numerical-methods-demag-bem-scientific-bibliography)=
## Scientific bibliography

- A. J. Fredkin and T. R. Koehler, “A quasi-magnetostatic finite-element method,” *IEEE Transactions on Magnetics* 26 (1990), DOI: [10.1109/20.106342](https://doi.org/10.1109/20.106342).
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/fem-bem`.

(numerical-methods-demag-bem-source-code-index)=

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public realization | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | model and IR | public API | Python tests |
| Gauge RHS | `backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp` | `prepare_demag_fem_bem_neumann_rhs` | gauge-pinned source | FEM CPU | source contracts |
| Dense operator | `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp` | `DenseDemagBemOperator::build` | boundary map | FEM CPU | source contracts |
| Sparse solves | `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp` | `solve_demag_fem_bem_sparse_system` | $u_1/u_2$ solves | FEM CPU | runtime telemetry |
| Orchestration | `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` | `context_compute_demag_fem_bem` | sequence and artifacts | FEM CPU | runtime tests |
| Potential | `backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp` | `combine_demag_fem_bem_total_potential` | total potential | FEM CPU | source contracts |
| Field recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | field recovery | FEM CPU | source contracts |
| Energy reduction | `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | energy reduction | FEM CPU | source contracts |
