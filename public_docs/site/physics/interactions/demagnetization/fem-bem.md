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
exterior by a boundary integral. It therefore differs fundamentally from the finite airbox
realization: there is no exterior air volume in the body-only mesh, and no Dirichlet or Robin
condition is imposed on an artificial outer airbox boundary.

The current implementation is a dense CPU reference path. The page documents the full algorithm,
including the two potential solves, surface extraction, solid-angle diagonal, dense operator,
linear-solver policy, potential combination, field recovery, energy reduction, and current
qualification boundary. It does not promote the generic `bem` or `fmm` vocabulary to an executable
implementation when the planner has not resolved it to Fredkin–Koehler.

(demag-bem-problem-statement)=
## 1. Physical problem and domain

Let $\Omega_m$ be a closed tetrahedral magnetic body with boundary $\Gamma_m$. The exterior is
magnetostatic free space. The magnetic source is the volume magnetization
$\mathbf M=M_s\mathbf m$; the exterior contribution is represented through the trace of the
potential on $\Gamma_m$.

The body-only requirement is strict. A mesh with an airbox is a different FEM realization and must
use the Poisson-airbox chapter. A non-closed surface cannot define the exterior boundary integral
used here and must fail during workspace construction rather than being silently filled with air.

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

The first solve is a Neumann problem and has a constant-potential nullspace. The implementation
copies the source right-hand side and pins the first true degree of freedom to zero before the
first solve:

```{math}
:label: eq-fem-bem-gauge
b_{1,0}=0,
\qquad
u_1\leftarrow u_1+C\ \text{is fixed by the gauge choice }C=0.
```

Let $\gamma u_1$ be the FEM trace on $\Gamma_m$. The dense boundary operator maps this trace to
the Dirichlet data for the harmonic correction:

```{math}
:label: eq-fem-bem-boundary-map
g_2=\mathcal B\,\gamma u_1,
\qquad
\Delta u_2=0\ \text{in }\Omega_m,
\qquad
\gamma u_2=g_2\ \text{on }\Gamma_m.
```

The dense diagonal contains the solid-angle contribution. For a boundary node $x_i$ and adjacent
surface triangles $T$, the diagonal contribution has the implemented form

```{math}
:label: eq-fem-bem-solid-angle
\mathcal B_{ii}=\frac{\sum_{T\ni x_i}\omega_T(x_i)}{4\pi}-1.
```

Off-diagonal entries use the linear-triangle boundary weights, including triangle area, oriented
unit normal, edge logarithms, and solid angle. Vertex-coincident terms are excluded by the source
coincidence guard; this is a singular/self-term treatment, not a general-purpose quadrature
approximation that may be removed without changing the operator.

The final field and energy use the combined potential:

```{math}
:label: eq-fem-bem-total-field-energy
\mathbf H_{\mathrm d}=-\nabla(u_1+u_2),
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}
\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

No separate airbox Robin surface energy is added because this realization has no Robin airbox
operator. The reported energy is the same magnetic-field functional used by the Poisson path,
evaluated with the Fredkin–Koehler recovered field.

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
| $\mathcal B$ | dense boundary-integral map | $1$ |
| $g_2$ | boundary values for $u_2$ | $\mathrm{A}$ |
| $\omega_T$ | oriented solid angle of surface triangle $T$ | $1$ |
| $T$ | oriented boundary triangle | $\mathrm{m^2}$ |
| $x_i$ | boundary node location | $\mathrm{m}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $b_1$ | Neumann right-hand-side vector for $u_1$ | $\mathrm{A\,m}$ |
| $C$ | additive potential gauge constant | $\mathrm{A}$ |
| $i$ | boundary-node index | $1$ |

(demag-bem-assumptions-and-validity)=
## 4. Assumptions and validity limits

The implementation assumes a closed, consistently oriented triangular surface extracted from a
tetrahedral magnetic body. It uses a dense reference boundary operator; no FMM, hierarchical
matrix, fast multipole, or periodic acceleration is implied by the API vocabulary.

The two sparse solves are not interchangeable:

| Stage | Problem | Boundary data | Numerical consequence |
|---|---|---|---|
| $u_1$ | Interior Poisson/Neumann problem | Magnetic RHS plus gauge pin | Constant nullspace must be removed. |
| $u_2$ | Interior harmonic/Dirichlet problem | Dense BEM trace $g_2$ | Boundary values are injected into the FEM RHS before solve. |

The dense operator is sensitive to surface orientation, degenerate triangles, node coincidence,
solid-angle convention, and boundary-node indexing. A body-only mesh with an open or inconsistent
surface is not a lower-accuracy input; it changes or invalidates the mathematical problem.

(demag-bem-python-api)=
## 5. Python API and complete solver parameters

The Fredkin–Koehler path uses a closed body-only mesh. The following complete CPU scenario does
not declare an airbox: the exterior problem is represented by the boundary operator built from
the sphere surface.

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
| `Demag.model` | `optional str` | `None` | $1$ | `fredkin_koehler` selects the executable body-only FEM/BEM path; `bem` and `fmm` remain separate planner requests. | Selects the FEM/BEM realization family. | FEM CPU reference path; GPU is unsupported. | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | Must be omitted for non-airbox models; otherwise constructor validation fails. | Airbox-only boundary selector, not a BEM parameter. | Not applicable to Fredkin–Koehler. | `energy[].realization` |
| `FEM.order` | `int` | required | $1$ | Integer greater than or equal to $1$. | Polynomial order of the interior FEM space. | FEM CPU body-only path subject to mesh support. | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | Finite positive value; `hmax` is an alias. | Target maximum element size for the magnetic body. | FEM CPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy \| None` | `None` | $1$ | Policy fields are validated individually. | Linear-solver policy for the $u_1$ and $u_2$ sparse solves. | FEM CPU; no GPU BEM lane. | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `"CG"` | $1$ | Must be `CG` or `GMRES`. | Krylov solver used for each sparse FEM solve. | FEM CPU; both solves use the selected policy. | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `"AMG"` | $1$ | Must be `AMG`, `JACOBI`, or `NONE`. | Preconditioner for each sparse solve. | FEM CPU; Hypre path depends on runtime. | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | Finite and strictly positive. | Relative tolerance applied to both $u_1$ and $u_2$ solves; it is algebraic, not a physical discretization tolerance. | FEM CPU. | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `float \| None` | `None` | $1$ | When supplied, finite and strictly positive. | Optional absolute stopping tolerance for each sparse solve. | FEM CPU. | `demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | Integer greater than or equal to $1$. | Maximum iterations for each sparse solve; telemetry reports $u_1$ and $u_2$ separately. | FEM CPU. | `demag_solver_policy.max_iterations` |
| `FemLinearSolverPolicy.print_level` | `int` | `0` | $1$ | Integer greater than or equal to $0$. | Solver diagnostic verbosity. | FEM CPU. | `demag_solver_policy.print_level` |

(demag-bem-problem-ir)=
## 6. ProblemIR and normalization

The example lowers the interaction to

```json
{
  "kind": "demag",
  "realization": "fredkin_koehler"
}
```

The FEM hint carries the solver policy separately. `Demag.model` does not carry `rtol` or
`max_iterations`; those values belong to `FEM.demag_solver_policy` because they govern the sparse
FEM systems, not the physical demagnetization term. The planner additionally resolves body-only
mesh legality, surface closure, available dense operator support, and the requested CPU/GPU lane.

(demag-bem-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

**Requested intent** contains `fredkin_koehler`, the body-only FEM hint, and the complete solver
policy. **Resolved execution** contains the actual surface topology, dense matrix size, solver kind,
preconditioner, tolerances, $u_1$ and $u_2$ iterations/residuals, total field, energy, and runtime
identity.

Invalid model/variant combinations, non-positive tolerances, invalid iteration limits, missing
closed surface, degenerate surface triangles, and a failed gauge preparation are validation errors.
An unavailable GPU BEM implementation, unsupported generic `bem`, and unresolved `fmm` are
unsupported combinations. The planner must never silently substitute a Poisson airbox, FDM
convolution, or a CPU run for a GPU request.

(demag-bem-discrete-realization)=
## 8. Discrete realization and CPU/GPU separation

### FEM CPU

The CPU sequence is:

1. assemble the magnetic Poisson RHS;
2. copy it to the Neumann RHS and pin its first true degree of freedom;
3. solve for $u_1$ using the selected sparse solver policy;
4. extract the boundary trace of $u_1$;
5. apply the dense boundary operator to obtain $g_2$;
6. prepare the Dirichlet RHS and boundary values for $u_2$;
7. solve the harmonic correction problem;
8. add $u_1$ and $u_2$ pointwise;
9. recover $\mathbf H_{\mathrm d}$ and reduce energy.

The dense operator build uses oriented triangles, solid-angle diagonal terms, linear-triangle
weights, and an explicit node-to-boundary map. The sparse solver may use a cached Hypre operator,
preconditioner, and solver. Telemetry records the two solve residuals and iteration counts rather
than collapsing them into one number.

### FEM GPU

No production GPU FEM/BEM lane is claimed. The CUDA Poisson airbox path is a different realization
and cannot be described as GPU FEM/BEM. A future GPU BEM implementation would require separate
device ownership, dense-operator storage, surface-kernel execution, two-solve residual telemetry,
and executed-device validation.

(demag-bem-implementation-mapping)=
## 9. Implementation mapping

| Stage | Stable source owner | Exact responsibility |
|---|---|---|
| Source RHS | `assemble_demag_poisson_rhs` | Volume magnetic RHS used by $u_1$. |
| Gauge | `prepare_demag_fem_bem_neumann_rhs` | Copies Neumann RHS and pins the gauge DOF. |
| Dense operator | `DenseDemagBemOperator::build` | Surface matrix, solid-angle diagonal and triangle weights. |
| Sparse solves | `solve_demag_fem_bem_sparse_system` | Policy-controlled $u_1$ and $u_2$ solves. |
| Boundary values | `prepare_demag_fem_bem_dirichlet_rhs` | Injects dense BEM boundary values into the second solve. |
| Potential | `combine_demag_fem_bem_total_potential` | Forms $u=u_1+u_2$. |
| Orchestration | `context_compute_demag_fem_bem` | Orders all stages and publishes solve telemetry. |
| Field and energy | `recover_demag_poisson_field` and `demag_poisson_energy_from_field` | Reuses the common field recovery and energy contract. |

(demag-bem-validation)=
## 10. Validation and qualification

| Test | What it proves | What it does not prove |
|---|---|---|
| Closed-body surface extraction | Boundary-node and triangle topology are valid. | Physical convergence of the dense operator. |
| Solid-angle/self-term contract | Diagonal convention and singular guard are stable. | GPU parity. |
| Uniform sphere or ellipsoid | Demag factors and energy against an independent open-boundary result. | Arbitrary geometry accuracy. |
| $u_1/u_2$ residual telemetry | Both sparse solves satisfy their policies. | Airbox or surface-discretization error. |
| Energy parity | Combined-potential field and negative half-$\mu_0$ reduction agree. | Runtime qualification on an untested device. |
| CPU qualification | Executed CPU result with mesh and policy provenance. | Any GPU implementation. |

(demag-bem-limitations)=
## 11. Limitations

The current reference path is dense in the number of boundary nodes and is therefore not a
large-scale FMM implementation. `rtol` and `max_iterations` affect only the sparse interior solves;
they do not control dense boundary quadrature error, surface orientation error, or mesh error. A
converged sparse solve on an open surface is still an invalid physical result.

The current page deliberately reports GPU FEM/BEM as unsupported. Source files for GPU Poisson
demag do not constitute a GPU BEM implementation or executed-device proof.

(demag-bem-scientific-bibliography)=
## 12. Scientific bibliography

1. D. R. Fredkin and T. R. Koehler, “A boundary-element method for computing the magnetostatic
   energy of domain walls,” *IEEE Transactions on Magnetics*, 26, 4154–4156 (1990).
2. W. F. Brown, *Micromagnetics*, Wiley, 1963.
3. FullMag internal reference: `docs/physics/0870-fem-bem-demag-open-boundary.md`.

(demag-bem-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | BEM model validation and IR normalization. | Public authoring |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | Body-only mesh and solver-policy hint. | Public authoring |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | `rtol`, `atol`, iteration and solver controls. | Public authoring |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp` | `prepare_demag_fem_bem_neumann_rhs` | Gauge-pinned Neumann RHS. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp` | `DenseDemagBemOperator::build` | Dense surface operator and solid-angle terms. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp` | `solve_demag_fem_bem_sparse_system` | Policy-controlled sparse solves. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp` | `prepare_demag_fem_bem_dirichlet_rhs` | Boundary-value injection for $u_2$. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` | `context_compute_demag_fem_bem` | Full Fredkin–Koehler sequence and telemetry. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp` | `combine_demag_fem_bem_total_potential` | Potential sum. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | Common field recovery and energy handoff. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | Common demagnetization energy reduction. | FEM CPU |
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Physics` when `PhysicsInteractionPanel` exposes the interaction. Status: `partial`. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.
## Source-code index

- Public Python and lowering sources are linked by the applicable terminal API page. Runtime realization is in the relevant `backends/fdm` or `backends/fem` lane; frontend ownership is `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` where a live control exists.

