# FEM demagnetization with P1 magnetization and P2 scalar potential

- Status: implemented for nonperiodic Poisson-Robin CPU/GPU code paths; CPU SP4
  fixed-mesh qualification complete; executed-device GPU and ST4 qualification pending
- Owners: Fullmag FEM demagnetization
- Last updated: 2026-08-02
- Related physics: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- Related validation: `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md`
- Related specs: `docs/specs/capability-matrix-v0.md`

(problem-statement)=
## 1. Problem statement

The common continuum physics of demagnetization remains owned by
`0430-fem-dipolar-demag-mfem-gpu-foundations.md`. This page owns one distinct
numerical realization: a first-order nodal magnetization field coupled to a
second-order scalar magnetostatic potential on the shared magnetic-plus-air
domain.

The former implementation reused the public first-order FEM order for the
potential. For the uniformly magnetized NIST SP4 film this under-resolved the
potential near thin-film edges: increasing the airbox did not remove the
energy deficit, and a converged linear solve still remained below the FDM
Newell reference. The approved realization therefore separates the order of
the physical magnetization state from the order of the auxiliary potential.

The user-facing `Demag` interaction does not change. The numerical order is a
resolved backend property recorded in provenance, not a second physical model
or a user-tuned correction factor.

(governing-equations)=
## 2. Governing equations

Let the reduced magnetization use a continuous first-order space
$V_h^1\subset H^1(\Omega_m)$ and let the scalar potential use a continuous
second-order space $W_h^2\subset H^1(D)$, where
$D=\Omega_m\cup\Omega_{\mathrm{air}}$. The discrete source is
$\mathbf M_h=M_s\mathbf m_h$.

For the Robin realization, find $u_h\in W_h^2$ such that

```{math}
:label: fem-demag-p1-p2-weak-form

\int_D \nabla u_h\cdot\nabla v_h\,\mathrm dV
+\int_{\partial D}\beta u_hv_h\,\mathrm dS
=\int_{\Omega_m}M_s\mathbf m_h\cdot\nabla v_h\,\mathrm dV
\qquad \forall v_h\in W_h^2.
```

Dirichlet execution uses the same volume form and enforces $u_h=0$ on the
selected outer boundary instead of the Robin term. With P1 magnetization
coefficients $\mathbf m$ and P2 potential coefficients $\mathbf u$, define

```{math}
:label: fem-demag-p1-p2-system

(\mathbf K_2+\beta\mathbf C_2)\mathbf u
=\mathbf B_{21}(M_s)\mathbf m=\mathbf b.
```

$\mathbf B_{21}$ is rectangular: its rows are P2 potential true DOFs and its
columns are the three components of P1 magnetization DOFs. Magnetization must
be evaluated from $V_h^1$ at the quadrature points of the P2 test functions;
P2 edge DOFs must never index the P1 magnetization array.

The physical field is recovered in the magnetic P1 representation through an
adjoint-consistent projection. For each component $c\in\{x,y,z\}$,

```{math}
:label: fem-demag-p1-p2-recovery

\mathbf W_M\mathbf h_c=-\mathbf G_{21,c}^{\mathsf T}\mathbf u,
```

where $\mathbf W_M$ is the same certified magnetic mass weighting used by the
LLG and energy contracts, and $\mathbf G_{21,c}$ is the geometric P1-to-P2
gradient coupling before multiplication by $M_s$. A separate full-domain P1
projection owns the visual `H_demag` artifact. Neither projection maps P2 edge
DOF numbers directly to mesh-node numbers.

The primary discrete energy is evaluated from the solved variational system:

```{math}
:label: fem-demag-p1-p2-energy

E_{\mathrm{demag},h}
=\frac{\mu_0}{2}\mathbf b^{\mathsf T}\mathbf u.
```

The independently evaluated field form must agree within the stated numerical
tolerance:

```{math}
:label: fem-demag-p1-p2-energy-field

E_{\mathrm{demag},h}
=-\frac{\mu_0}{2}
\int_{\Omega_m}M_s\mathbf m_h\cdot\mathbf H_{\mathrm{demag},h}\,\mathrm dV.
```

This equality is an executable reciprocity check. It prevents an apparently
accurate scalar energy from being paired with an inconsistent LLG field.

(symbols-and-si-units)=
## 3. Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $\Omega_{\mathrm{air}}$ | nonmagnetic air domain | $\mathrm{m^3}$ |
| $D$ | shared magnetic-plus-air domain | $\mathrm{m^3}$ |
| $V_h^1$ | continuous P1 scalar space used componentwise by magnetization | $1$ |
| $W_h^2$ | continuous P2 scalar-potential space | $1$ |
| $\mathbf m_h$ | reduced magnetization | $1$ |
| $\mathbf m$ | vector of P1 reduced-magnetization coefficients | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $u_h$ | magnetic scalar potential | $\mathrm A$ |
| $v_h$ | scalar-potential test function | $1$ |
| $\mathbf u$ | vector of P2 potential coefficients | $\mathrm A$ |
| $\mathbf b$ | scalar-potential right-hand side | $\mathrm{A\,m}$ |
| $\beta$ | Robin far-field coefficient | $\mathrm{m^{-1}}$ |
| $\mathbf K_2$ | P2 Laplace stiffness matrix | $\mathrm m$ |
| $\mathbf C_2$ | P2 outer-boundary mass matrix | $\mathrm{m^2}$ |
| $\mathbf B_{21}$ | P1-magnetization to P2-potential coupling | $\mathrm{A\,m}$ |
| $\mathbf G_{21,c}$ | geometric gradient coupling for component $c$ | $\mathrm{m^2}$ |
| $\mathbf W_M$ | certified magnetic mass weighting | $\mathrm{m^3}$ |
| $\mathbf h_c$ | P1 coefficients of demag-field component $c$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{demag},h}$ | recovered demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm{demag},h}$ | discrete demagnetization energy | $\mathrm J$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $c$ | Cartesian component index | $1$ |

(assumptions-and-validity)=
## 4. Assumptions and validity

- The magnetization, material nodal fields, exchange operator, LLG state, and
  public mesh order remain P1. P2 applies only to the auxiliary Poisson
  potential.
- The target open-boundary realizations are `poisson_robin` and
  `poisson_dirichlet` on a conforming shared domain.
- The Robin coefficient remains the documented far-field approximation; the
  P2 change does not retune it.
- Non-periodic open-boundary CPU and strict GPU execution must use the same
  P1/P2 algebra. `hybrid_cpu_poisson` is not an accepted GPU fallback.
- Existing static periodic-airbox demag remains a separately qualified P1
  realization until periodic edge-DOF equivalence classes receive their own
  validation. Provenance must expose this resolved order rather than silently
  presenting it as P2.
- Tetrahedra, prisms, and pyramids in the accepted shared-domain mesh require
  element-family quadrature and DOF handling supplied by MFEM. An all-tetra
  prototype is validation evidence for the method, not sufficient production
  qualification for mixed SP4 meshes.
- Thin-film edge and corner singularities require local mesh convergence.
  Increasing only the outer airbox cannot substitute for magnetic-edge
  resolution.

(python-api)=
## 5. Python API

No new public physics parameter is introduced. The current stage-first SP4
workflow remains valid; the backend resolves the auxiliary potential order.

```python
# %% Authoring and execution intent
from pathlib import Path

import fullmag as fm

study = fm.study("mumag_sp4_fem_p2_demag")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Shared domain and magnetic film
study.universe(
    mode="manual",
    size=(1200e-9, 600e-9, 550e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=8e-9,
    maximum_element_size=110e-9,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)
film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    edge_maximum_element_size=1e-9,
    edge_thickness=6e-9,
    edge_transition_distance=12e-9,
    corner_maximum_element_size=1e-9,
    corner_extent=8e-9,
    corner_transition_distance=16e-9,
    order=1,
)

# %% Interaction and numerical policy
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=600,
)
study.mesh.save_or_load(Path("mumag_sp4_fem_p2_demag.fullmag-mesh"))

# %% Equilibrium stage and observables
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=100_000,
    tolT=1e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=[
                "step", "mx", "my", "mz", "e_ex", "e_demag",
                "e_total", "max_torque_T",
            ],
        ),
        fields=[],
    )
)
study.stages.add_save_state(
    artifact_name="relaxed_m.zarr",
    format="zarr",
    dataset="m",
)
```

Interaction-specific public parameters are:

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `StudyBuilder.demag.realization` | `str | None` | resolved default | $1$ | planner-supported demag realization | requested numerical demag family | FEM CPU/GPU by capability | `interactions[].kind` and resolved FEM plan |
| `StudyBuilder.fem_demag_solver.solver` | `str` | `CG` | $1$ | `CG` or `GMRES` | linear solver | FEM CPU/GPU | resolved FEM demag solver policy |
| `StudyBuilder.fem_demag_solver.preconditioner` | `str` | `AMG` | $1$ | `AMG`, `JACOBI`, or `NONE` | linear preconditioner | FEM CPU/GPU | resolved FEM demag solver policy |
| `StudyBuilder.fem_demag_solver.rtol` | `float` | backend policy | $1$ | finite and positive | relative linear residual target | FEM CPU/GPU | resolved FEM demag solver policy |
| `StudyBuilder.fem_demag_solver.max_iterations` | `int` | backend policy | $1$ | positive integer | linear iteration cap | FEM CPU/GPU | resolved FEM demag solver policy |
| `GeometryMeshHandle.thin_film.order` | `int` | `1` | $1$ | exactly `1` for the physical state in this contract | magnetization and physical-field order | FEM CPU/GPU | `mesh_workflow.per_geometry[].order` |
| `GeometryMeshHandle.thin_film.edge_maximum_element_size` | `float | None` | `None` | $\mathrm m$ | finite positive and no larger than bulk maximum | magnetic edge size target | FEM meshing | `mesh_workflow.per_geometry[].edge_hmax` |
| `GeometryMeshHandle.thin_film.edge_thickness` | `float | None` | `None` | $\mathrm m$ | finite positive and paired with edge target | edge refinement width | FEM meshing | `mesh_workflow.per_geometry[].edge_thickness` |
| `GeometryMeshHandle.thin_film.corner_maximum_element_size` | `float | None` | `None` | $\mathrm m$ | finite positive and no larger than edge target | magnetic corner size target | FEM meshing | `mesh_workflow.per_geometry[].corner_hmax` |
| `GeometryMeshHandle.thin_film.corner_extent` | `float | None` | `None` | $\mathrm m$ | finite positive and paired with corner target | corner refinement extent | FEM meshing | `mesh_workflow.per_geometry[].corner_extent` |

(problem-ir)=
## 6. ProblemIR and resolved execution

The canonical `ProblemIR` continues to express one physical demagnetization
interaction. It does not expose `potential_order` as a physical parameter.
The authored mesh order remains `1`. Planning and runtime provenance add the
resolved numerical facts:

```json
{
  "requested_demag_realization": "poisson_robin",
  "resolved_demag_realization": "poisson_robin",
  "magnetization_order": 1,
  "potential_order": 2,
  "recovery": "adjoint_mass_projection_p2_to_p1",
  "energy_evaluation": "poisson_rhs_dot_solution",
  "outer_boundary": "robin",
  "qualified": false
}
```

`qualified` remains false until the managed CPU/GPU and SP4 gates in Section
10 pass. Static PBC provenance must report `potential_order: 1` while that
separate realization remains P1.

(round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

- Requested intent is the authored physical demag realization and mesh policy.
  Resolved execution records the state order, potential order, projection,
  boundary realization, solver, and device lane independently.
- Validation errors identify an illegal parameter or unavailable operator;
  they never rewrite the request.
- Unsupported combinations, including an unqualified P2 periodic map or a
  strict GPU runtime without P2 device operators, fail explicitly.
- Python and UI round-trip preserve the requested `Demag` realization and
  physical mesh controls; they do not serialize an internal P2 toggle.
- A strict non-periodic CPU/GPU open-airbox plan resolves P2 or fails. It must
  not silently execute P1 after advertising P2.
- A strict GPU request fails if P2 device buffers, rectangular RHS operators,
  recovery operators, or the device hypre solve are unavailable.
- Unsupported mixed-cell or periodic combinations fail capability validation
  or report their explicit separately qualified P1 realization.
- Table, telemetry, field artifacts, and solver diagnostics must report the
  same accepted state and the same `E_demag` contract.

(discrete-realization)=
## 8. Discrete realization

### 8.1 FDM CPU

FDM CPU does not use this mixed-order FEM discretization. Its exact
cell-averaged Newell tensor provides the accepted SP4 energy oracle after
matching geometry, material, magnetization direction, and SI units.

### 8.2 FDM GPU

FDM GPU does not use this mixed-order FEM discretization. It remains subject
to its own FDM CPU parity and executed-device qualification.

### 8.3 FEM CPU

MFEM owns separate P1 state and P2 potential spaces. The reusable P2
`LinearForm` evaluates P1 magnetization at quadrature points. Hypre solves the
P2 scalar system. Recovery projects the gradient into P1 magnetic and visual
fields without equating potential DOFs with nodes. The direct scalar energy
and field energy are checked independently.

### 8.4 FEM GPU

Setup constructs rectangular P1-to-P2 RHS CSR operators and P2-to-P1 recovery
CSR operators, uploads them once, and sizes scalar buffers by P2 true DOFs.
The stage hot loop keeps RHS, potential, recovery, and energy on device and
uses the existing exact hypre stream-ordering contract. There is no accepted
host round trip or P1 fallback for the strict non-periodic P2 realization.

### 8.5 Local edge and corner refinement

The SP4 thin-film convergence study requires refinement near magnetic edges
and corners plus a bounded adjacent air shell. Refinement fields must not
force the edge target throughout the complete airbox. Mesh reports record
magnetic and air element counts, realized size distributions, quality, and
the magnetic-submesh identity.

(implementation-mapping)=
## 9. Implementation mapping

| Contract | Path and stable symbol | Responsibility |
|---|---|---|
| P2 potential lifecycle | `backends/fem/cpu/mfem/interactions/demag_poisson_lifecycle.cpp` + `context_initialize_poisson` | own independent potential FE collection, space, operator, and vectors |
| P1 source evaluation | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` + `MagnetizationCoefficient` | evaluate P1 $M_s\mathbf m$ in P2 quadrature |
| CPU recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` + `recover_demag_poisson_field` | recover physical and visual P1 fields from P2 potential |
| CPU energy | `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` + `demag_poisson_energy_from_field` | provide independent field-energy parity check |
| GPU operators | `backends/fem/gpu/cuda/demag_poisson/operators.cpp` + `build_p1_demag_operators` | become mixed-order rectangular operator construction |
| GPU buffers | `backends/fem/gpu/cuda/state/gpu_state.cpp` + `gpu_state_initialize` | allocate by state-node and potential-DOF cardinalities |
| GPU stage | `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` + `gpu_demag_poisson_compute_stage` | execute device RHS, solve, recovery, and energy |
| Mesh refinement | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` + `_build_perimeter_refinement_fields` | scope magnetic and near-air edge/corner targets |
| SP4 scenario | `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py` + module | author the ordinary public qualification workload |

(validation)=
## 10. Validation

Required gates are cumulative:

1. Manufactured P1-to-P2 element assembly verifies signs, units, rectangular
   dimensions, and polynomial exactness.
2. Sphere refinement verifies P2 Poisson-Robin energy within $1\%$ of the
   analytical demagnetizing factor and improves over P1 on identical meshes.
3. Energy reciprocity verifies the relative difference between
   $\mu_0\mathbf b^{\mathsf T}\mathbf u/2$ and the projected-field energy is
   at most $10^{-10}$ for deterministic fixtures.
4. CPU/GPU parity verifies `H_demag`, `E_demag`, potential, iterations,
   residual, runtime identity, and absence of fallback on the same mesh.
5. The uniform SP4 initial state must satisfy
   $|E_{\mathrm{FEM}}/E_{\mathrm{FDM}}-1|\leq1\%$ on the accepted mesh.
   The independent all-tetra prototype reached $0.0526406\%$ error with P2
   and edge refinement, while P1 on the identical mesh remained at
   $5.15155\%$ error. These prototype values are diagnostic evidence, not
   managed production qualification.
6. Full SP4 relaxation compares the final volume-weighted magnetization,
   total and component energies, torque stop, table, telemetry, and saved
   fields. The FEM result is not accepted solely because the initial uniform
   energy passes.

(limitations)=
## 11. Limitations

- The Robin airbox remains a finite-domain approximation to free space.
- The current P2 prototype evidence covers tetrahedra; mixed
  prism/pyramid/tetra production evidence remains required.
- Static periodic-airbox P2 equivalence classes are outside this realization
  until independently implemented and qualified.
- Dense FEM/BEM is a validation-scale alternative and is not substituted for
  this production sparse Poisson path.

(scientific-bibliography)=
## 12. Scientific bibliography

1. W. F. Brown, *Micromagnetics*, Wiley, 1963.
2. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing
   demagnetizing fields,” *IEEE Transactions on Magnetics* 26(2), 415–417,
   1990, <https://doi.org/10.1109/20.106342>.
3. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the
   demagnetizing tensor for nonuniform magnetization,” *Journal of Geophysical
   Research* 98(B6), 9551–9555, 1993,
   <https://doi.org/10.1029/93JB00694>.
4. µMAG Standard Problem 4, NIST Micromagnetic Modeling Activity Group,
   <https://www.ctcms.nist.gov/~rdm/mumag.org.html>.

(source-code-index)=
## 13. Source-code index

| Equation or claim | Source identity | Lane | Evidence status |
|---|---|---|---|
| Weak P2 potential form | `backends/fem/cpu/mfem/interactions/demag_poisson_lifecycle.cpp` + `context_initialize_poisson` | FEM CPU/shared setup | implemented for nonperiodic Poisson-Robin; CPU SP4 fixed-mesh qualified |
| Outer boundary | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` + `initialize_demag_poisson_boundary_operator` | FEM CPU/shared setup | implemented shared P1/P2 boundary form |
| P1-to-P2 source | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` + `MagnetizationCoefficient` | FEM CPU/shared algebra | implemented rectangular P1-state to P2-potential coupling |
| P2-to-P1 field | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` + `recover_demag_poisson_field` | FEM CPU | implemented P2-gradient projection to the P1 physical field |
| Field energy | `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` + `demag_poisson_energy_from_field` | FEM CPU | implemented independent field form |
| Solve orchestration | `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` + `context_compute_demag_poisson` | FEM CPU | implemented direct variational and recovered-field energy telemetry |
| Device mixed-order operators | `backends/fem/gpu/cuda/demag_poisson/operators.hpp` + `build_p1_demag_operators` | FEM GPU | P2 nonperiodic operator implementation compiled; executed-device qualification pending |
| Device stage | `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` + `compute_device_demag_for_device_stage` | FEM GPU | P2 nonperiodic stage implementation compiled; executed-device qualification pending |
| Perimeter refinement | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` + `_build_perimeter_refinement_fields` | FEM meshing | implemented fields; near-air scoping correction pending |
| SP4 ordinary workflow | `packages/fullmag-py/src/fullmag/world.py` + `study` | FEM CPU/GPU | executable public stage-first authoring entrypoint |
