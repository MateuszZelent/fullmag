---
title: FEM Poisson Airbox
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md
---

(public-docs-physics-interactions-demagnetization-fem-poisson-airbox)=
# FEM Poisson airbox demagnetization

This chapter describes the shared-domain FEM realization of demagnetization. It is not a
generic statement that an airbox is present: the magnetic region, the air region, the outer
boundary marker, the boundary operator, the linear solver policy, the field recovery, and the
energy reduction are all part of the numerical problem. A run is only reproducible when these
choices and their resolved values are recorded.

The realization solves for a scalar potential on a conforming mesh containing the magnetic body
and an exterior airbox. It currently has two outer closures:

* Dirichlet: $u=0$ on the selected exterior boundary;
* Robin: $\partial_n u+\beta u=0$ on the selected exterior boundary.

The two closures are different discrete problems. They must not be compared as though they were
two names for the same solver setting.

(demag-poisson-problem-statement)=
## 1. Physical problem and domain decomposition

Let $\Omega_m$ denote the magnetic subdomain and $\Omega_a$ the complete FEM domain containing
$\Omega_m$ and the surrounding air. The outer boundary of the airbox is
$\Gamma_a=\partial\Omega_a$. The magnetization is $\mathbf M=M_s\mathbf m$ in $\Omega_m$ and is
zero in the air elements. The scalar potential $u$ has units of amperes and produces the
demagnetizing field

```{math}
:label: eq-fem-poisson-field
\mathbf H_{\mathrm d}=-\nabla u.
```

The airbox is a bounded approximation to the unbounded magnetostatic exterior. Its position,
shape, boundary marker, and mesh resolution therefore influence the computed field. The airbox
must be part of the shared conforming mesh for the Poisson realization; a body-only mesh is not a
valid input for this realization.

The physical magnetic problem is shared by FDM and FEM, but FEM replaces the non-local free-space
operator by a finite-element potential problem. The numerical boundary closure is documented here
because it changes the operator and the convergence error.

(demag-poisson-governing-equations)=
## 2. Governing equations

The magnetostatic equations in a source-free, quasistatic region are

```{math}
:label: eq-fem-poisson-maxwell
\nabla\times\mathbf H_{\mathrm d}=\mathbf 0,
\qquad
\nabla\cdot\left(\mathbf H_{\mathrm d}+\mathbf M\right)=0.
```

With $\mathbf H_{\mathrm d}=-\nabla u$, the potential equation used by the FEM right-hand-side
assembly is

```{math}
:label: eq-fem-poisson-strong
\Delta u=\nabla\cdot\mathbf M\quad\text{in }\Omega_a,
\qquad
\mathbf M=\mathbf0\quad\text{in }\Omega_a\setminus\Omega_m.
```

The weak problem is obtained by multiplying the strong equation by a test function $v$ and
integrating by parts. For a Robin airbox closure it is

```{math}
:label: eq-fem-poisson-robin-weak
\int_{\Omega_a}\nabla u\cdot\nabla v\,\mathrm dV
+\beta\int_{\Gamma_a}uv\,\mathrm dS
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV
\qquad\forall v\in V.
```

The Robin condition is

```{math}
:label: eq-fem-poisson-robin-boundary
\partial_n u+\beta u=0\quad\text{on }\Gamma_a,
\qquad
\partial_n u=\mathbf n\cdot\nabla u.
```

For a Dirichlet airbox closure, the trial and test spaces satisfy $u=0$ and $v=0$ on the
essential boundary $\Gamma_a$, and the weak form has no Robin surface term:

```{math}
:label: eq-fem-poisson-dirichlet-weak
\int_{\Omega_a}\nabla u\cdot\nabla v\,\mathrm dV
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV
\qquad\forall v\in V_0.
```

The implementation derives the effective Robin coefficient from a dimensionless coefficient $c$
and a mesh reference radius $R_\star$:

```{math}
:label: eq-fem-poisson-robin-beta
\beta=\frac{c}{R_\star},
\qquad
R_\star=\frac12\max_{d\in\mathcal A_{\mathrm open}}
\left(x_{d,\max}-x_{d,\min}\right).
```

The open-axis set excludes periodic axes. If no open axis is available, the implementation falls
back to the largest mesh extent for the reference scale. This is a solver-internal boundary
policy, not a user-provided SI coefficient in the current Python API.

The demagnetization energy is evaluated from the recovered magnetic field:

```{math}
:label: eq-fem-poisson-energy-field
E_{\mathrm d}
=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

For the converged Robin weak solution, testing the weak form with $v=u$ gives the equivalent
potential identity

```{math}
:label: eq-fem-poisson-energy-weak
E_{\mathrm d}
=\frac{\mu_0}{2}\left(
\int_{\Omega_a}|\nabla u|^2\,\mathrm dV
+\beta\int_{\Gamma_a}u^2\,\mathrm dS
\right).
```

FullMag reports the first expression from the magnetization and recovered field. It does not add a
second explicit Robin surface energy after that reduction. Adding the surface term again would
double-count the boundary contribution already represented by the Robin-conditioned solution.

(demag-poisson-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization field, $M_s\mathbf m$ in magnetic elements | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $u$ | magnetic scalar potential | $\mathrm{A}$ |
| $v$ | FEM test function | $1$ |
| $\Omega_a$ | complete magnetic-plus-air FEM domain | $\mathrm{m^3}$ |
| $\Omega_m$ | magnetic subdomain | $\mathrm{m^3}$ |
| $\Gamma_a$ | selected outer airbox boundary | $\mathrm{m^2}$ |
| $\mathbf n$ | outward unit normal on $\Gamma_a$ | $1$ |
| $\beta$ | Robin boundary coefficient | $\mathrm{m^{-1}}$ |
| $c$ | dimensionless Robin coefficient selected by runtime policy | $1$ |
| $R_\star$ | open-axis reference radius used for Robin scaling | $\mathrm{m}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $K$ | assembled volume stiffness matrix | $\mathrm{m}$ |
| $B_{\Gamma}$ | assembled boundary mass matrix on $\Gamma_a$ | $\mathrm{m^2}$ |
| $A_{\mathrm R}$ | Robin system matrix $K+\beta B_{\Gamma}$ | $\mathrm{m}$ |
| $b$ | assembled magnetic Poisson right-hand side | $\mathrm{A\,m}$ |
| $\widehat u$ | vector of FEM potential degrees of freedom | $\mathrm{A}$ |
| $\widehat{\mathbf H}_{\mathrm d}$ | recovered FEM field at stored magnetic locations | $\mathrm{A\,m^{-1}}$ |
| $i,j$ | matrix row and column indices | $1$ |
| $\mathcal A_{\mathrm open}$ | set of non-periodic coordinate axes | $1$ |

(demag-poisson-assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

The realization assumes quasistatic magnetostatics, a conforming shared-domain mesh, finite
magnetization, and a scalar-potential representation. The following distinctions are mandatory:

| Choice | Mathematical meaning | What it does not mean |
|---|---|---|
| Dirichlet | Prescribes $u=0$ on the selected airbox boundary. | It is not an exact infinite-domain condition; it is a finite-domain truncation. |
| Robin | Adds $\partial_n u+\beta u=0$ and the surface matrix $\beta B_{\Gamma}$. | It is not a user-independent universal value of $\beta$; $\beta$ is scaled from the mesh. |
| Airbox size | Controls distance between the magnetic body and $\Gamma_a$. | A larger airbox does not remove discretization error by itself. |
| Airbox mesh size | Controls resolution in the exterior field. | It is not the same as magnetic-region resolution. |
| Periodic boundary | Removes an axis from the open-axis reference and uses a separate reduced problem. | It is not equivalent to an open airbox. |

Convergence must vary at least airbox distance, airbox mesh size, magnetic mesh size, boundary
variant, and linear-solver residual independently. A low linear residual cannot compensate for an
airbox truncation error; conversely, a large residual can hide a mesh-converged physical result.

(demag-poisson-python-api)=
## 5. Python API and complete parameter reference

The interaction term selects the physical realization. The FEM hint selects the mesh and linear
solver policy. The study-universe mesh settings select the airbox geometry and grading. These are
separate objects and all three must be recorded.

### Executable stage workflow

This complete workflow declares the shared airbox domain, magnetic mesh, canonical airbox model,
Robin variant, FEM linear-solver policy, ordered relaxation stage, and scientific outputs. It is
directly copyable into a Python script or notebook with `# %%` cell support.

```python
# %% Imports and FEM Poisson study
import fullmag as fm

nm = 1.0e-9
study = fm.study("demag_fem_poisson_robin")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Shared magnetic-plus-air domain and graded airbox mesh
study.universe(
    mode="manual",
    size=(1200 * nm, 600 * nm, 550 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10 * nm,
    maximum_element_size=110 * nm,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)

# %% Magnetic film, material, initial state, and body mesh
film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=3 * nm,
    maximum_element_size=3 * nm,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)

# %% Poisson–Robin interaction and FEM linear solver
study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-12,
    max_iterations=600,
)

# %% Ordered stage and scientific outputs
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolT=5.0e-9,
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

### `Demag` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `str \| None` | `None` | $1$ | Allowed values are `airbox`, `bem`, `fredkin_koehler`, and `fmm`. | Selects the demagnetization realization family. | FEM planner; `airbox` is the Poisson family. | `energy[].realization` |
| `Demag.variant` | `str \| None` | `None` | $1$ | Only valid with `model="airbox"`; allowed values are `auto`, `robin`, and `dirichlet`. | Selects the airbox boundary closure. `auto` normalizes to Robin. | FEM Poisson CPU/GPU paths subject to qualification. | `energy[].realization` |
| `Demag.realization` | `str \| None` | `None` | $1$ | Legacy input; cannot be combined with `model`; aliases `poisson_airbox`, `airbox_robin`, and `airbox_dirichlet` are normalized. | Backward-compatible realization selector. | Normalized before planning. | `energy[].realization` |

### `FEM` parameters relevant to Poisson demagnetization

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FEM.order` | `int` | required | $1$ | Integer greater than or equal to $1$. | Polynomial order of the finite-element space. | FEM CPU/GPU; actual supported topology is planner-dependent. | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | Finite positive value; `hmax` is an exact alias. | Maximum target element size used by meshing. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float` | alias | $\mathrm{m}$ | Must equal `maximum_element_size` when both are supplied. | Short alias for the same mesh control. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `str \| None` | `None` | $1$ | Non-empty when present. | Explicit mesh source. | FEM planner; mesh must contain the required airbox for Poisson. | `backend_policy.discretization_hints.fem.mesh` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy \| None` | `None` | $1$ | Policy fields are validated individually below. | Native FEM linear-solver policy for Poisson and related demag systems. | FEM CPU/GPU implementation paths. | `backend_policy.discretization_hints.fem.demag_solver_policy` |

### `FemLinearSolverPolicy` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `"CG"` | $1$ | Must be `CG` or `GMRES`. | Krylov method applied to the assembled Poisson system. `CG` assumes the symmetric positive-definite operator expected by the selected boundary realization; `GMRES` is available for nonsymmetric or policy-specific cases. | FEM CPU/GPU Hypre paths. | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `"AMG"` | $1$ | Must be `AMG`, `JACOBI`, or `NONE`. | Hypre preconditioner: BoomerAMG, diagonal scaling, or identity. | FEM CPU/GPU; device AMG requires the compiled device Hypre stack. | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | Finite and strictly positive. | Relative linear-solver tolerance passed to Hypre/MFEM. It controls algebraic convergence, not mesh or airbox error. | FEM CPU/GPU. | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `float \| None` | `None` | $1$ | When supplied, finite and strictly positive. | Optional absolute stopping tolerance; it is enabled only when present and positive. | FEM CPU/GPU. | `demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | Integer greater than or equal to $1$. | Hard upper bound on Krylov iterations. Reaching it without convergence is a failed solve, not permission to accept the field silently. | FEM CPU/GPU. | `demag_solver_policy.max_iterations` |
| `FemLinearSolverPolicy.print_level` | `int` | `0` | $1$ | Integer greater than or equal to $0$. | Hypre/MFEM diagnostic verbosity. It does not change the requested physical problem. | FEM CPU/GPU. | `demag_solver_policy.print_level` |

### Study-universe airbox parameters

The following parameters are exposed by `study.universe.mesh(...)` in the Python world API and are
lowered into the study-universe metadata. They are not fields of `Demag`, but they directly define
the FEM Poisson domain and therefore belong to a reproducible demag configuration.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.universe.mesh(maximum_element_size)` | `float` | inherited/default | $\mathrm{m}$ | Finite positive value. | Airbox mesh maximum size; can override the FEM default for the universe. | FEM mesh generation. | `study_universe.airbox_hmax` |
| `study.universe.mesh(minimum_element_size)` | `float \| None` | `None` | $\mathrm{m}$ | Positive when supplied and not greater than the maximum. | Lower bound for airbox element size. | FEM mesh generation. | `study_universe.airbox_hmin` |
| `study.universe.mesh(growth_rate)` | `float \| None` | `None` | $1$ | Positive finite value. | Controls permitted element-size growth through the airbox. | FEM mesh generation. | `study_universe.airbox_growth_rate` |
| `study.universe.mesh(grading)` | `str \| None` | `None` | $1$ | `auto`, `geometric`, or `linear`. | Selects airbox grading policy. | FEM mesh generation. | `study_universe.airbox_grading` |

(demag-poisson-problem-ir)=
## 6. ProblemIR, normalization, and provenance

The interaction is normalized in Python before planning. For the example, the canonical
interaction record is

```json
{
  "kind": "demag",
  "realization": "poisson_robin"
}
```

The FEM discretization hint is a separate record:

```json
{
  "order": 1,
  "hmax": 2e-9,
  "mesh": null,
  "demag_solver_policy": {
    "solver": "CG",
    "preconditioner": "AMG",
    "rtol": 1e-8,
    "atol": 1e-12,
    "max_iterations": 500,
    "print_level": 0
  }
}
```

The mapping is exhaustive: `Demag.model` and `Demag.variant` select `energy[].realization`,
`FemLinearSolverPolicy` is copied to the FEM discretization hint, and study-universe mesh
parameters remain in `study_universe`. Normalization maps `airbox` plus omitted or `auto` variant
to `poisson_robin`, while explicit `dirichlet` maps to `poisson_dirichlet`. `bem` and `fmm` remain
distinct requests and are not silently rewritten as Poisson.

(demag-poisson-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

The **requested intent** is the authored model, boundary variant, mesh policy, and solver policy.
The **resolved execution** is the planner-selected FEM CPU or FEM GPU lane, the concrete boundary
operator, the mesh certificate, the actual solver kind, precision, iteration count, residual, and
runtime/device identity. These records must remain separate in provenance.

Constructor validation raises errors for an invalid model/variant pair, unsupported solver name,
unsupported preconditioner, non-positive `rtol` or `atol`, and invalid iteration or print limits.
Planner validation raises **validation errors** for a missing air region, missing outer boundary
marker, missing boundary degrees of freedom, incompatible mesh topology, or an illegal output.
Planner capability resolution reports **unsupported combinations** for a requested device or
Hypre/MFEM configuration that is not available. None of these cases authorizes a silent switch to
FDM, a boundary-variant substitution, or acceptance of a non-converged linear solve.

The runtime exposes solver telemetry including selected solver, relative and optional absolute
tolerances, maximum and actual iterations, residual, convergence flag, setup reuse, and phase
timings. A reported scalar energy is not evidence that the requested residual or device was
achieved unless those provenance fields are checked.

(demag-poisson-discrete-realization)=
## 8. Discrete realization and execution sequence

### 8.1 Assembly common to CPU and GPU

The FEM lifecycle is ordered and ownership-separated:

1. build or load a conforming magnetic-plus-air mesh;
2. create the scalar potential finite-element space;
3. assemble the volume stiffness matrix $K$;
4. assemble the magnetic right-hand side $b$ from $M_s\mathbf m$ only on magnetic elements;
5. apply the requested Dirichlet or Robin boundary operator;
6. solve the resulting linear system;
7. recover $\mathbf H_{\mathrm d}=-\nabla u$ at magnetic storage locations;
8. reduce $E_{\mathrm d}$ from the recovered field and magnetization;
9. publish field, energy, residual, iteration, and phase telemetry.

For Robin, the algebraic system is

```{math}
:label: eq-fem-poisson-robin-discrete
A_{\mathrm R}\widehat u=b,
\qquad
A_{\mathrm R}=K+\beta B_{\Gamma}.
```

For Dirichlet, essential true degrees of freedom are eliminated from $K\widehat u=b$ according
to the marked outer boundary. The code checks that the selected boundary marker resolves to actual
boundary degrees of freedom.

### 8.2 FEM CPU

The CPU lane assembles the RHS through an MFEM vector coefficient, constructs the selected boundary
operator, and uses a cached Hypre operator, preconditioner, and Krylov solver. The solution may be
warm-started between calls when the cached workspace remains valid. The orchestration keeps RHS
assembly, solve, recovery, and energy as separate phases. It records both solver-reported
convergence and an explicit residual check.

For an elementwise $M_s$ field, the CPU path uses the material runtime and its mass bilinear form
where supported. Non-magnetic air nodes are zeroed from the LLG field before publication. This is
not equivalent to evaluating the magnetic field over the entire airbox as though air had a
saturation magnetization.

### 8.3 FEM GPU

The strict GPU lane keeps RHS assembly, the Poisson system, solution, recovered field, material
$M_s$, and lumped mass on the device. CUDA CSR kernels assemble the RHS and recover the field;
device Hypre applies the configured solver and preconditioner; a device reduction computes the
demagnetization energy. The RK stage dispatch records separate assemble, solver-apply, recovery,
and energy timings.

GPU source presence or compilation is not runtime qualification. The current public status remains
partial until an executed-device proof demonstrates the same physical problem, precision, solver
policy, residual contract, and energy parity against an accepted reference.

(demag-poisson-implementation-mapping)=
## 9. Implementation mapping

| Responsibility | CPU owner | GPU owner |
|---|---|---|
| Magnetic RHS | `assemble_demag_poisson_rhs` | `demag_rhs_csr_kernel` |
| Boundary operator | `initialize_demag_poisson_boundary_operator` | device essential-DOF preparation in the Poisson workspace |
| Linear solve | `solve_demag_poisson_hypre` | `initialize_demag_poisson_hypre_device_solver` and device solver apply |
| Orchestration | `context_compute_demag_poisson` | `compute_device_demag_for_device_stage_impl` |
| Field recovery | `recover_demag_poisson_field` | `demag_recovery_csr_kernel` |
| Energy | `demag_poisson_energy_from_field` | `demag_energy_blocks_kernel` and `gpu_rk_reduce_final_demag_energy_terms` |

The boundary source computes the effective Robin coefficient, excludes periodic boundary markers
from the Robin mass, and rejects a missing Dirichlet boundary marker. The energy source explicitly
uses the negative $\mu_0/2$ magnetization-field product and does not add a second surface term.

(demag-poisson-validation)=
## 10. Validation and qualification

| Validation layer | Required check | Evidence required |
|---|---|---|
| Boundary construction | Dirichlet essential DOFs and Robin boundary mass use the selected marker. | FEM boundary contract and source-level ownership checks. |
| Algebraic solve | The reported residual satisfies the requested tolerance and does not exceed `max_iterations`. | Solver telemetry with solver kind, tolerances, iterations, residual, and convergence flag. |
| Field recovery | Recovered field has the correct sign and is zero on non-magnetic LLG nodes. | Field-recovery contract and field comparison. |
| Energy | The reported energy equals the negative half-$\mu_0$ magnetization-field product and is not surface-counted twice. | Energy contract and independent quadrature check. |
| Mesh convergence | Refine magnetic mesh and airbox mesh independently. | Field and energy convergence table. |
| Airbox convergence | Increase distance to $\Gamma_a$ independently of refinement. | Dirichlet and Robin curves reported separately. |
| CPU/GPU parity | Same mesh, boundary, precision, policy, and initial magnetization. | Executed CPU and executed-device GPU provenance; source compilation alone is insufficient. |

The current source and contract evidence supports a documented CPU implementation and a partial
GPU implementation. It does not justify claiming universal FEM GPU qualification.

(demag-poisson-limitations)=
## 11. Limitations and failure modes

The airbox is finite, so neither Dirichlet nor Robin is an exact unbounded-domain solution at a
finite distance. The correct error statement is therefore a convergence result, not a claim that
one boundary variant is exact.

The linear solver tolerances control algebraic error only. `rtol=1e-8` does not mean that the field
has a relative physical error of $10^{-8}$; geometry, element order, airbox truncation, material
projection, and reduction roundoff contribute independently. `max_iterations` is a fail-closed
limit. Increasing it can permit convergence but cannot repair a singular or incorrectly marked
boundary.

The FEM GPU lane additionally depends on a compiled MFEM MPI/Hypre device stack, device-resident
buffers, and executed-device evidence. A CPU fallback must be reported as a different resolved
execution, never hidden behind a GPU request.

(demag-poisson-scientific-bibliography)=
## 12. Scientific bibliography

1. D. R. Fredkin and T. R. Koehler, “A boundary-element method for computing the magnetostatic
   energy of domain walls,” *IEEE Transactions on Magnetics*, 26, 4154–4156 (1990).
2. W. F. Brown, *Micromagnetics*, Wiley, 1963.
3. FullMag implementation references: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
   and `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`.

(demag-poisson-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Model, variant, alias validation and IR normalization. | Public authoring |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | FEM mesh hint and solver-policy destination. | Public authoring |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | `CG/GMRES`, preconditioner, tolerances, iteration and print policy. | Public authoring |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseConfig` | Airbox mesh size, growth and grading metadata. | Public authoring |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM demag model, shared-domain mesh and capability resolution. | FEM CPU/GPU planning |
| `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | $M_s\mathbf m$ RHS assembly on magnetic elements. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Dirichlet/Robin operator construction and boundary-marker checks. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | Hypre solver and preconditioner configuration, solve and telemetry. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` | `context_compute_demag_poisson` | RHS, solve, recovery and energy orchestration. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | Potential gradient recovery, masking and energy handoff. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | Negative half-$\mu_0$ magnetization-field reduction. | FEM CPU |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_rhs_csr_kernel` | Device CSR RHS kernel. | FEM GPU |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_recovery_csr_kernel` | Device field recovery kernel. | FEM GPU |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_energy_blocks_kernel` | Device energy partials. | FEM GPU |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | Device Hypre solver and preconditioner setup. | FEM GPU |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `compute_device_demag_for_device_stage_impl` | Device-stage demag orchestration and timings. | FEM GPU |
| `backends/fem/gpu/cuda/integrators/rk/rk_demag_energy_reductions.cu` | `gpu_rk_reduce_final_demag_energy_terms` | Device demag energy reduction and ownership checks. | FEM GPU |
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Physics` when `PhysicsInteractionPanel` exposes the interaction. Status: `partial`. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.
## Source-code index

- Public Python and lowering sources are linked by the applicable terminal API page. Runtime realization is in the relevant `backends/fdm` or `backends/fem` lane; frontend ownership is `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` where a live control exists.

