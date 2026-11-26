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
boundary marker, the boundary operator, the scalar-potential polynomial order (`P1` vs `P2`),
the linear-solver strategy (`auto`, `cg_amg`, or `cudss`), the field recovery, and the energy
reduction are all part of the numerical problem. A run is only reproducible when these choices and
their resolved values are recorded. For GPU solver throughput, VRAM scaling, and A/B benchmarks,
see {ref}`numerical-methods-performance-fem-gpu-demag`.

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
operator by a finite-element potential problem. On non-periodic all-tetrahedral (`tet4`) and
extruded pyramid-free pure-prism (`pure_prism_p2`, 100% `prism6`) shared domains, Fullmag separates
the polynomial orders: magnetization stays nodal P1 in $(V_h^1)^3$ while the auxiliary scalar
potential automatically resolves to continuous P2 in $W_h^2$ (`H1_WedgeElement(2)` on pure-prism
wedges). Mixed `prism6 + pyramid5 + tet4` meshes (`mixed_p1`) remain P1 for the potential because
MFEM pyramids force order 1.

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
\mathbf M=\mathbf 0\quad\text{in }\Omega_a\setminus\Omega_m.
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
R_\star=\frac12\max_{d\in\mathcal A_{\mathrm{open}}}
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
\int_{\Omega_a}\lvert\nabla u\rvert^2\,\mathrm dV
+\beta\int_{\Gamma_a}u^2\,\mathrm dS
\right).
```

Fullmag reports the first expression from the magnetization and recovered field (and cross-checks
the variational form $\frac{\mu_0}{2} b^{\mathsf T}\widehat u$ in mixed P1/P2 telemetry). It does
not add a second explicit Robin surface energy after that reduction; adding the surface term again
would double-count the boundary contribution already represented by the Robin-conditioned solution.

### GPU VRAM preflight and Krylov potential predictor

On FEM GPU, the linear operator $A_{\mathrm R}$ (or essential-eliminated Dirichlet $K$) depends
only on the mesh and boundary conditions. Under `gpu_strategy="auto"` or `"cudss"`, cuDSS factors
the SPD matrix once via $P A_{\mathrm R} P^{\mathsf T} = L L^{\mathsf T}$ only after its
post-analysis peak memory estimate $\hat{M}_{\mathrm{peak}}$ passes the device budget:

```{math}
:label: eq-fem-poisson-cudss-budget
M_{\mathrm{margin}} = \max\!\left(512\,\mathrm{MiB},\; \frac{M_{\mathrm{total}}}{20}\right),
\qquad
B = \min\!\left(M_{\mathrm{free}} - M_{\mathrm{margin}},\; B_{\mathrm{cap}}\right),
\qquad
\hat{M}_{\mathrm{peak}} \le B.
```

When executing via `hypre_krylov` (under `gpu_strategy="cg_amg"` or after an `"auto"` VRAM
fallback) on strictly advancing explicit RK stages ($t_{\mathrm{eval}} > t_{\mathrm{last}}$ and
$\Delta t_n / \Delta t_{n-1} \le 2$), Fullmag constructs a two-step linear initial iterate before
PCG/GMRES:

```{math}
:label: eq-fem-poisson-linear-predictor
\phi^{(0)}\!\left(t_{\mathrm{eval}}\right)
= \phi_n + \alpha\left(\phi_n - \phi_{n-1}\right),
\qquad
\alpha = \frac{t_{\mathrm{eval}} - t_n}{t_n - t_{n-1}}.
```

Every direct and Krylov solve is independently certified in the Euclidean norm:

```{math}
:label: eq-fem-poisson-residual-cert
\rho = \frac{\lVert A_{\mathrm R}\widehat u - b \rVert_2}{\lVert b \rVert_2} \le \tau_{\mathrm{rel}}.
```

```{figure} /_static/diagrams/demag-fem-poisson-airbox-closures.svg
:alt: Two-panel diagram of FEM Poisson airbox demagnetization: (a) conforming shared-domain tetrahedral topology Omega_m subset Omega_a with geometrically graded airbox layers, outer boundary marker Gamma_a, and Robin versus Dirichlet weak-form closures; (b) numerically computed normalized potential u(r)/(M_s a) for a uniformly magnetized sphere in a finite airbox R_box = 2.4 a comparing exact 1/r^2 open decay with Dirichlet u=0 and first-order Robin closures.
:width: 100%
:name: fig-demag-fem-poisson-airbox-closures
:figclass: fm-physics-figure

Conforming graded shared-domain airbox mesh ($\Omega_m \subset \Omega_a$) with outer marker $\Gamma_a$ in panel (a) and analytical truncation behavior of Dirichlet ($u=0$) versus first-order Robin ($\partial_n u + \beta u = 0$, $\beta = c/R_\star$) closures in panel (b) (Fredkin & Koehler 1990; Exl & Schrefl 2014; Abert *et al.* 2013).
```

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
| $\mathcal A_{\mathrm{open}}$ | set of non-periodic coordinate axes | $1$ |
| $M_{\mathrm{free}}, M_{\mathrm{total}}$ | free and total CUDA device memory queried after cuDSS analysis | $\mathrm{B}$ |
| $M_{\mathrm{margin}}$ | safety VRAM reserve $\max(512\,\mathrm{MiB}, M_{\mathrm{total}}/20)$ | $\mathrm{B}$ |
| $B, B_{\mathrm{cap}}$ | effective device VRAM budget and optional environment cap | $\mathrm{B}$ |
| $\hat{M}_{\mathrm{peak}}$ | cuDSS post-analysis peak device memory estimate | $\mathrm{B}$ |
| $\phi_n, \phi_{n-1}, \phi^{(0)}$ | accepted and two-step linearly predicted scalar-potential vectors | $\mathrm{A}$ |
| $\alpha$ | dimensionless linear extrapolation weight | $1$ |
| $\rho, \tau_{\mathrm{rel}}$ | certified relative Euclidean residual and requested tolerance | $1$ |

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
| `pure_prism` vs `pyramid_to_tetrahedra` | Extruded 100% `prism6` shared domains resolve P2 `H1_WedgeElement(2)` potential; pyramid transitions force P1 potential (`mixed_p1`). | A P1 mixed-pyramid mesh does not share the thin-film Aharoni accuracy of P2 `tet4` or `pure_prism_p2`. |
| Periodic boundary | Removes an axis from the open-axis reference and uses a separate reduced problem. | It is not equivalent to an open airbox; periodic `pure_prism_p2` fails closed. |

Convergence must vary at least airbox distance, airbox mesh size, magnetic mesh size, boundary
variant, potential order, and linear-solver residual independently. A low linear residual cannot
compensate for an airbox truncation error; conversely, a large residual can hide a mesh-converged
physical result.

(demag-poisson-python-api)=
## 5. Python API and complete parameter reference

The interaction term selects the physical realization. The FEM hint selects the mesh and linear
solver policy (including `gpu_strategy`). The study-universe mesh settings select the airbox
geometry and grading, and `film.mesh.thin_film(transition=...)` selects `pyramid_to_tetrahedra`
versus pyramid-free `pure_prism` (`pure_prism_p2`).

### Executable stage workflow

This complete workflow declares the shared airbox domain, a pyramid-free `pure_prism` thin-film
mesh (resolving P2 scalar potential automatically), canonical airbox model, Robin variant,
three-state GPU linear-solver policy, ordered relaxation stage, and scientific outputs.

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

# %% Magnetic film, material, initial state, and pure-prism P2 body mesh
film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=5 * nm,
    maximum_element_size=5 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pure_prism",
    order=1,
)

# %% Poisson–Robin interaction and FEM linear solver
study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-12,
    max_iterations=600,
    gpu_strategy="auto",
)

# %% Ordered stage and scientific outputs
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
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
| `Demag.variant` | `str \| None` | `None` | $1$ | Only valid with `model="airbox"`; allowed values are `auto`, `robin`, and `dirichlet`. | Selects the airbox boundary closure. `auto` normalizes to Robin. | FEM Poisson CPU/GPU. | `energy[].realization` |
| `Demag.realization` | `str \| None` | `None` | $1$ | Legacy input; cannot be combined with `model`; aliases `poisson_airbox`, `airbox_robin`, and `airbox_dirichlet` are normalized. | Backward-compatible realization selector. | Normalized before planning. | `energy[].realization` |

### `FEM` and thin-film mesh parameters relevant to Poisson demagnetization

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FEM.order` | `int` | required | $1$ | Integer greater than or equal to $1$. | Polynomial order of the physical magnetization space; auxiliary non-periodic Poisson potential resolves P2 on `tet4` and `pure_prism_p2`. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | Finite positive value; `hmax` is an exact alias. | Maximum target element size used by meshing. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float` | alias | $\mathrm{m}$ | Must equal `maximum_element_size` when both are supplied. | Short alias for the same mesh control. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `str \| None` | `None` | $1$ | Non-empty when present. | Explicit mesh source. | FEM planner; mesh must contain the required airbox for Poisson. | `backend_policy.discretization_hints.fem.mesh` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy \| None` | `None` | $1$ | Policy fields are validated individually below. | Native FEM linear-solver policy for Poisson and related demag systems. | FEM CPU/GPU implementation paths. | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `GeometryMeshHandle.thin_film.transition` | `str \| None` | `None` | $1$ | `pyramid_to_tetrahedra`, `pure_prism`, or `reject` for prismatic films. | Selects mixed pyramid/tetra airbox (`mixed_p1`) vs 100% `prism6` P2-capable shared domain (`pure_prism_p2`). | FEM CPU/GPU. | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].transition_policy` |

### `FemLinearSolverPolicy` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `"CG"` | $1$ | Must be `CG` or `GMRES`. | Krylov method applied on FEM CPU and GPU HYPRE fallback solves. | FEM CPU/GPU Hypre paths. | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `"AMG"` | $1$ | Must be `AMG`, `JACOBI`, or `NONE`. | Hypre preconditioner: BoomerAMG (default; GPU sets `coarse_relax_type=18`), diagonal scaling, or identity. | FEM CPU/GPU. | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | Finite and strictly positive. | Relative Euclidean linear-solver tolerance certifying every direct and Krylov solve. | FEM CPU/GPU. | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `float \| None` | `None` | $1$ | When supplied, finite and strictly positive. | Optional absolute stopping tolerance; enabled only when present and positive. | FEM CPU/GPU. | `demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | Integer greater than or equal to $1$. | Hard upper bound on Krylov iterations (`cudss_direct` reports 1 iteration). | FEM CPU/GPU. | `demag_solver_policy.max_iterations` |
| `FemLinearSolverPolicy.print_level` | `int` | `0` | $1$ | Integer greater than or equal to $0$. | Hypre/MFEM diagnostic verbosity. Does not change the requested physical problem. | FEM CPU/GPU. | `demag_solver_policy.print_level` |
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto", "cg_amg", "cudss"]` | `"auto"` | $1$ | Must be `auto`, `cg_amg`, or `cudss`. | Three-state GPU linear-solver strategy delivered at backend creation time via `fullmag_fem_backend_create_v6`. | FEM GPU (ignored on FEM CPU). | `demag_solver_policy.gpu_strategy` |

### Study-universe airbox parameters

The following parameters are exposed by `study.universe.mesh(...)` in the Python world API and are
lowered into the study-universe metadata.

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
  "hmax": 5e-9,
  "mesh": null,
  "demag_solver_policy": {
    "solver": "CG",
    "preconditioner": "AMG",
    "rtol": 1e-12,
    "max_iterations": 600,
    "print_level": 0,
    "gpu_strategy": "auto"
  }
}
```

Legacy `ProblemIR` JSON payloads omitting `"gpu_strategy"` deserialize cleanly to `"auto"`.
For `transition="pure_prism"`, the mesh build attaches `PurePrismTopologyCertificateV1IR`
(`schema_version = "pure_prism_topology_certificate.v1"`, `v3` topology fingerprint), which is
mutually exclusive with mixed-layer V1/V2 certificates.

On FEM GPU, `execution_provenance.fem_poisson_demag` (`FemPoissonDemagProvenance`) records:
- `requested_linear_solver_strategy` (`"auto"`, `"cg_amg"`, or `"cudss"`);
- `resolved_linear_solver` (`"cudss_direct"` or `"hypre_krylov"`, queried via
  `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1`);
- `linear_solver_fallback_reason` (`"cudss_unavailable"`, `"cudss_factor_exceeds_vram_budget"`, or
  `"cudss_memory_estimate_unavailable"`, populated only on `"auto"` fallback);
- `factor_nnz` and `estimated_device_peak_bytes` (zero under `hypre_krylov`), together with the
  mutually exclusive operator receipt bits `FULLMAG_FEM_GPU_OPERATOR_DIRECT_SOLVE` (bit 12) vs
  `PRECONDITIONER`.

(demag-poisson-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

The **requested intent** is the authored model, boundary variant, mesh transition policy, and
solver policy (`solver`, `preconditioner`, `rtol`, `atol`, `max_iterations`, `gpu_strategy`).
The **resolved execution** is the planner-selected FEM CPU or FEM GPU lane, the concrete boundary
operator, the mesh certificate and resolved potential order (`1` or `2`), `resolved_linear_solver`,
`linear_solver_fallback_reason`, iteration count, certified Euclidean residual, and runtime/device
identity.

Environment overrides are strictly fail-closed: `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER` overrides
the plan strategy (`auto`, `cudss`, or `cg_amg`/`hypre`/`off`), while
`FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` and
`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` combine via $\min$ to form
$B_{\mathrm{cap}}$. Any malformed or overflowing cap value (`"0"`, negative, non-numeric) raises a
hard error even under `gpu_strategy="auto"` or `"cg_amg"`.

Constructor and planner **validation errors** reject invalid model/variant pairs, unsupported
solver/preconditioner/`gpu_strategy` names, non-positive tolerances, missing airbox regions or
boundary markers, missing `pure_prism` certificates, or singular non-SPD matrices
(`CUDSS_DATA_INFO != 0`, which fails closed even under `"auto"`). **Unsupported combinations** —
including forced `gpu_strategy="cudss"` exceeding the VRAM budget (exits hard before factorization
starts, zero fallback), periodic `pure_prism_p2`, or unavailable device Hypre/MFEM stacks — fail
closed without silently substituting FDM, a different boundary closure, or CPU execution.

(demag-poisson-discrete-realization)=
## 8. Discrete realization and execution sequence

### Four-lane support and qualification matrix

| Solver | Device | Status | Realization summary | Qualification boundary |
|---|---|---|---|---|
| FDM | CPU | `not-applicable` | FDM uses Cartesian Newell tensor FFT convolution, not a shared-domain FEM Poisson solve. | Use {doc}`fdm-convolution`. |
| FDM | GPU | `not-applicable` | FDM CUDA uses Hermitian cuFFT convolution, not a shared-domain FEM Poisson solve. | Use {doc}`fdm-convolution`. |
| FEM | CPU | `implemented` | MFEM shared-domain Poisson Robin/Dirichlet (`tet4` P2, `mixed_p1`, `pure_prism_p2` P2) with Hypre CG/GMRES + BoomerAMG and fixed-coupling transfer cache. | Verified CPU reference across SP4, sphere, and `pure_prism_p2` contracts. |
| FEM | GPU | `implemented` | Strict device-resident CSR RHS/recovery, three-state `auto`/`cg_amg`/`cudss` (`create_v6`), VRAM-guarded `cuDSS` Cholesky, `hypre_krylov` (`coarse_relax_type=18`) with 2-step predictor $\phi^{(0)}$, Heun/RK4 FSAL `k0` reuse, and 1-barrier CUB residual certification. | Verified on RTX 4080 SUPER (`19.1×–218.4×` speedup under `auto`/`cuDSS`, `1.24×–2.19×` under `cg_amg`, `pure_prism_p2` `L=2` `-0.60%` vs Aharoni); periodic `pure_prism_p2` fails closed. |

### 8.1 Assembly common to CPU and GPU

The FEM lifecycle is ordered and ownership-separated:

1. build or load a conforming magnetic-plus-air mesh (all-`tet4`, `mixed_p1`, or `pure_prism_p2`;
   for `layers >= 2` on `pyramid_to_tetrahedra`, `_untangle_same_side_mixed_tetrahedra` repairs
   inverted transition-slab `tet4` cavities deterministically via Chebyshev-center relocation);
2. create the P1 magnetization space $V_h^1$ and scalar potential space $W_h^2$ (P2 on non-periodic
   `tet4` and `pure_prism_p2` wedges, P1 on `mixed_p1` pyramids and periodic meshes);
3. assemble the volume stiffness matrix $K$;
4. assemble the magnetic right-hand side $b$ from $M_s\mathbf m$ only on magnetic elements;
5. apply the requested Dirichlet or Robin boundary operator;
6. solve the resulting linear system;
7. recover $\mathbf H_{\mathrm d}=-\nabla u$ at magnetic storage locations via adjoint mass
   projection;
8. reduce $E_{\mathrm d}$ from the recovered field and magnetization;
9. publish field, energy, certified Euclidean residual, iteration, and provenance telemetry.

For Robin, the algebraic system is

```{math}
:label: eq-fem-poisson-robin-discrete
A_{\mathrm R}\widehat u=b,
\qquad
A_{\mathrm R}=K+\beta B_{\Gamma}.
```

For Dirichlet, essential true degrees of freedom are eliminated from $K\widehat u=b$ according
to the marked outer boundary.

### 8.2 FEM CPU

The CPU lane assembles the RHS through an MFEM vector coefficient (with optional cached fixed
coupling transfer operators), constructs the selected boundary operator, and uses a cached Hypre
operator, preconditioner, and Krylov solver. Non-magnetic air nodes are zeroed from the LLG field
before publication while full-domain visual recovery remains separate.

### 8.3 FEM GPU

The strict GPU lane keeps RHS assembly, the Poisson linear solve, potential recovery, material
$M_s$, and lumped mass on the device:

- **Creation-time strategy (`fullmag_fem_backend_create_v6`):** passes `gpu_demag_solver_strategy`
  before `gpu_demag_poisson_initialize`. Under `"auto"` or `"cudss"`,
  `try_initialize_demag_cudss_direct` uploads the sorted lower triangle once as 32-bit CSR, runs
  `CUDSS_PHASE_ANALYSIS`, checks {eq}`eq-fem-poisson-cudss-budget`, and either factors $L L^{\mathsf T}$
  once (`DIRECT_SOLVE` bit 12) or releases all analysis handles cleanly without factorizing.
- **Krylov fallback & acceleration (`hypre_krylov`):** under `"cg_amg"` (zero cuDSS allocation) or
  `"auto"` budget fallback, `configure_demag_amg` configures device BoomerAMG with
  `coarse_relax_type=18` (`HYPRE_BoomerAMGSetCycleRelaxType(..., 18, 3)`), eliminating 24 B host
  coarse-level staging transfers. On strictly advancing RK stages, `gpu_demag_predictor_apply_warm_start`
  applies {eq}`eq-fem-poisson-linear-predictor` (reducing PCG iterations/solve by `22.0%` on Heun
  and `42.3%` on RK4 at 49,600 nodes while acting as an unallocated no-op under `cuDSS`).
- **FSAL `k0` reuse and 1-barrier certification:** deterministic Heun and RK4 steps reuse the
  endpoint derivative (`3 -> 2` and `5 -> 4` demag solves/step from step 2 onward), and
  `certify_gpu_hypre_demag_residual` + `fullmag_cuda_demag_validation_norm_pair` (256-block CUB
  `ScaledNormPair`) certifies {eq}`eq-fem-poisson-residual-cert` with one stream barrier and `16 B`
  D2H readback per solve (`3.0` barriers/step for Heun, `5.0` for RK4 including the step scalar
  readback).
- **Pure-prism P2 thin films (`pure_prism_p2`):** 100% `prism6` shared domains resolve conforming
  P2 `H1_WedgeElement(2)` potential on both CPU and GPU (`cg_amg` and `cuDSS`), avoiding both the
  `-30.11%` Aharoni energy deficit of `mixed_p1` pyramids and the `59.4 GiB` Cholesky VRAM blowup
  of all-tetrahedral `tet P2` thin-film meshes.

(demag-poisson-implementation-mapping)=
## 9. Implementation mapping

| Responsibility | CPU owner | GPU owner |
|---|---|---|
| Magnetic RHS | `assemble_demag_poisson_rhs` | `demag_rhs_csr_kernel` |
| Boundary operator | `initialize_demag_poisson_boundary_operator` | `upload_demag_poisson_operators` / `build_p1_demag_operators` |
| Linear solve (`cuDSS` & Hypre) | `solve_demag_poisson_hypre` | `try_initialize_demag_cudss_direct`, `solve_demag_cudss_direct`, `initialize_demag_poisson_hypre_device_solver`, `configure_demag_amg` |
| Residual certification & predictor | `solve_demag_poisson_hypre` | `certify_gpu_hypre_demag_residual`, `fullmag_cuda_demag_validation_norm_pair`, `gpu_demag_predictor_apply_warm_start` |
| Creation-time ABI & provenance | `plan_fem` | `fullmag_fem_backend_create_v6`, `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1`, `apply_native_fem_gpu_demag_linear_solver_provenance` |
| Orchestration & FSAL policy | `context_compute_demag_poisson` | `compute_device_demag_for_device_stage_impl`, `gpu_rk_rhs_allows_fsal_k0_reuse` |
| Field recovery | `recover_demag_poisson_field` | `demag_recovery_csr_kernel` |
| Energy | `demag_poisson_energy_from_field` | `demag_energy_blocks_kernel` and `gpu_rk_reduce_final_demag_energy_terms` |
| Pure-prism P2 & mixed untangler | `generate_pure_prism_box_airbox_mesh`, `_untangle_same_side_mixed_tetrahedra` | `validate_supported_physics_topology`, `validate_pure_prism_topology_certificate_against_mesh` |

### Control Room support

FEM airbox demagnetization controls are exposed under
`Model Explorer -> Objects -> <object> -> Physics` by `ObjectPhysicsInspectorPanel`
(`apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx`).
Browser exposure is partial: solver policy fields (including `gpu_strategy`) and airbox grading
controls without a UI widget must be configured via the Python API or `ProblemIR`. See
{doc}`/frontend/capability-register` for current Control Room coverage.

(demag-poisson-validation)=
## 10. Validation and qualification

### Executed RTX 4080 SUPER A/B benchmarks (open Poisson and `pure_prism_p2`)

Measured on an **NVIDIA GeForce RTX 4080 SUPER** (16 GiB VRAM, SM 8.9, CUDA 12.6.85,
`cuDSS 0.8.0.10`, `precision="double"`):

| Scenario | Integrator / workflow | Baseline / Krylov | Candidate `cg_amg` | Candidate `auto` (`cudss_direct`) | Parity / accuracy |
|---|---|---|---|---|---|
| Open Poisson SP4 (`8,208` nodes, `60,791` P2 DOFs, `rtol=1e-8`) | Heun (50 steps) | `813.13 ms/step` | `655.94 ms/step` (**1.24×**) | `3.72 ms/step` (**218.4×**) | `max \|Δm\| = 5.65e-12`, `rel \|ΔE_d\| = 1.66e-12` |
| Open Poisson SP4 (`8,208` nodes, `60,791` P2 DOFs, `rtol=1e-8`) | RK4 (50 steps) | `1215.01 ms/step` | `923.61 ms/step` (**1.32×**) | `8.06 ms/step` (**150.8×**) | `max \|Δm\| = 5.97e-12`, `rel \|ΔE_d\| = 4.48e-11` |
| Open Poisson medium (`49,600` nodes, `380,701` P2 DOFs, `rtol=1e-8`) | Heun (50 steps) | `477.30 ms/step` | `254.83 ms/step` (**1.87×**, −22.0% PCG iters/solve) | `23.45 ms/step` (**20.36×**, `3.13 GiB`) | `max \|Δm\| = 2.51e-11`, `rel \|ΔE_d\| = 1.81e-11` |
| Open Poisson medium (`49,600` nodes, `380,701` P2 DOFs, `rtol=1e-8`) | RK4 (50 steps) | `874.73 ms/step` | `400.22 ms/step` (**2.19×**, −42.3% PCG iters/solve) | `45.87 ms/step` (**19.07×**) | `max \|Δm\| = 2.39e-11`, `rel \|ΔE_d\| = 1.89e-11` |
| Tight VRAM cap (`MAX_VRAM_MIB=32`, `49,600` nodes) | Heun | `477.30 ms/step` | `auto -> hypre_krylov` `255.93 ms/step` (**1.86×**) | `cudss` forced: hard fail `rc=2` (0 fallback) | Bit-exact `0.0` vs `cg_amg` |
| `pure_prism_p2` `300×300×5 nm` film (`L=1, h=5 nm`, `594,239` P2 DOFs) | PGBB relax (`7,807` steps, `tolT=1e-7 T`) | `cg_amg`: `5,579.74 ms/step` | — | `cuDSS`: `38.53 ms/step` (**144.8×**, `5.14 GiB`, mesh `0.50 s`) | `−0.80%` vs Aharoni; `−0.50%` vs FDM, `+0.22%` vs MuMax3 |
| `pure_prism_p2` `300×300×5 nm` film (`L=2, h=5 nm`, `709,253` P2 DOFs) | PGBB relax (`8,153` steps, `tolT=1e-7 T`) | `tet P2` (`4.08M` DOFs, `123 s` mesh, `59.4 GiB`) | — | `cuDSS`: `51.88 ms/step` (**246×** faster mesh `0.51 s`, `6.73 GiB`) | `−0.60%` vs Aharoni; `−0.43%` vs FDM, `+0.30%` vs MuMax3 |

On the `layers=2`, $h=2.5\,\mathrm{nm}$ mixed-pyramid fixture (`300×300×5 nm`),
`_untangle_same_side_mixed_tetrahedra` reduced `same_side_two_owner_face` from `6 -> 0`
(`reoriented_tets = 2`, `p05(prism6) = 0.8616`) and executed on GPU `cuDSS` at `7.52 ms/step`.

| Validation layer | Required check | Evidence required |
|---|---|---|
| Boundary construction | Dirichlet essential DOFs and Robin boundary mass use the selected marker. | FEM boundary contract and source-level ownership checks. |
| Algebraic solve & certification | Independent CUB Euclidean residual satisfies `rtol` with `1` barrier / `16 B` per solve. | Solver telemetry and `FemPoissonDemagProvenance` (`resolved_linear_solver`, `fallback_reason`). |
| Field recovery | Recovered field has the correct sign and is zero on non-magnetic LLG nodes. | Field-recovery contract and field comparison. |
| Energy | The reported energy equals the negative half-$\mu_0$ magnetization-field product and matches the variational form. | Energy contract and independent quadrature / Aharoni checks. |
| Mesh & airbox convergence | Refine magnetic mesh, airbox mesh, and airbox distance independently. | Dirichlet/Robin and P1/P2 convergence tables. |
| CPU/GPU parity | Same mesh, boundary, precision, policy, and initial magnetization. | Executed RTX 4080 SUPER A/B provenance (`max \|Δm\| <= 2.51e-11`). |

(demag-poisson-limitations)=
## 11. Limitations and failure modes

The airbox is finite, so neither Dirichlet nor Robin is an exact unbounded-domain solution at a
finite distance. The linear solver tolerance `rtol` controls algebraic error only; airbox
truncation, mesh resolution, and potential order contribute independently.

For `cuDSS`, factor fill-in grows superlinearly with 3-D DOF count; on a 16 GiB GPU, fine
columnar `pure_prism_p2` meshes (such as $h = 2.5\,\mathrm{nm}$ on `300×300×5 nm`, `2.21M` P2 DOFs,
`21.18 GiB` estimated peak) trigger the VRAM preflight guard cleanly (`auto` falls back to
`hypre_krylov`; `cudss` fails hard before factorization). For Permalloy ($l_{\mathrm{ex}} \approx 5.69\,\mathrm{nm}$)
on 16 GiB GPUs, $h \approx 5.0\,\mathrm{nm}$ is the recommended `pure_prism_p2` + `cuDSS` operating
point. `pure_prism_p2` currently targets single-box open-boundary domains; periodic `pure_prism_p2`
and CUDA Graph capture for RK+`cuDSS` remain outside current scope and fail closed.

(demag-poisson-scientific-bibliography)=
## 12. Scientific bibliography

1. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* **26**(2), 415–417 (1990), [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
2. L. Exl and T. Schrefl, “Non-uniform FFT for the finite element computation of the micromagnetic scalar potential,” *Journal of Computational Physics* **270**, 490–505 (2014), [doi:10.1016/j.jcp.2014.04.013](https://doi.org/10.1016/j.jcp.2014.04.013), [arXiv:1305.3162](https://arxiv.org/abs/1305.3162).
3. C. Abert, L. Exl, F. Bruckner, A. Drews, and D. Suess, “magnum.fe: A micromagnetic finite-element simulation code based on FEniCS,” *Journal of Magnetism and Magnetic Materials* **345**, 29–35 (2013), [doi:10.1016/j.jmmm.2013.05.051](https://doi.org/10.1016/j.jmmm.2013.05.051), [arXiv:1301.3061](https://arxiv.org/abs/1301.3061).
4. A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied Physics* **83**(6), 3432–3434 (1998), [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
5. T. A. Davis, *Direct Methods for Sparse Linear Systems*, SIAM (2006), [doi:10.1137/1.9780898718881](https://doi.org/10.1137/1.9780898718881).
6. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York, 1963 ([WorldCat record](https://search.worldcat.org/title/536451)).

(demag-poisson-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility | Lane | Immutable link |
|---|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Model, variant, alias validation, and IR normalization. | Public authoring | [`energy.py#L51`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | FEM mesh hint and solver-policy destination. | Public authoring | [`discretization.py#L484`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | `CG/GMRES`, preconditioner, tolerances, iteration, print, and `gpu_strategy` policy. | Public authoring | [`discretization.py#L161`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseConfig` | Airbox mesh size, growth, and grading metadata. | Public authoring | [`world.py#L2591`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2591) |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_pure_prism_box_airbox_mesh` | Three-stage extruded 100% `prism6` shared-domain mesher for `pure_prism_p2`. | FEM meshing | [`_gmsh_swept.py#L6669`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6669) |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_untangle_same_side_mixed_tetrahedra` | Chebyshev-center conformity repair for `layers >= 2` mixed-tet cavities. | FEM meshing | [`_gmsh_swept.py#L2503`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2503) |
| `crates/fullmag-ir/src/mixed_certificate.rs` | `validate_pure_prism_topology_certificate_against_mesh` | Verifies `v3` fingerprint, `prism6` conformity, and Jacobians for `pure_prism_p2`. | IR | [`mixed_certificate.rs#L1855`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855) |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM demag model, `gpu_strategy`, shared-domain mesh, and capability resolution. | FEM CPU/GPU planning | [`fem.rs#L4288`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4288) |
| `crates/fullmag-runner/src/types.rs` | `FemPoissonDemagProvenance` | Requested strategy, resolved linear solver, fallback reason, and factor telemetry. | FEM provenance | [`types.rs#L4350`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/types.rs#L4350) |
| `crates/fullmag-runner/src/dispatch.rs` | `apply_native_fem_gpu_demag_linear_solver_provenance` | Populates `FemPoissonDemagProvenance` from native GPU provenance query. | FEM provenance | [`dispatch.rs#L3934`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/dispatch.rs#L3934) |
| `backends/fem/core/fem_mesh.cpp` | `validate_supported_physics_topology` | Admits `pure_prism_p2` and `mixed_p1` on CPU/CUDA; keeps unsupported extensions fail-closed. | FEM core | [`fem_mesh.cpp#L766`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/core/fem_mesh.cpp#L766) |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_create_v6` | Creation-time C ABI delivering `gpu_demag_solver_strategy` before demag init. | FEM GPU ABI | [`api.cpp#L5921`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L5921) |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1` | Queries requested strategy, resolved linear solver, fallback reason, and VRAM metrics. | FEM GPU ABI | [`api.cpp#L7676`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L7676) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | $M_s\mathbf m$ RHS assembly on magnetic elements (P1/P2 quadrature and cached transfer). | FEM CPU | [`demag_poisson_rhs.cpp#L359`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Dirichlet/Robin operator construction and boundary-marker checks. | FEM CPU | [`demag_poisson_boundary.cpp#L124`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | CPU Hypre solver and preconditioner configuration, solve, and telemetry. | FEM CPU | [`demag_poisson_hypre.cpp#L211`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` | `context_compute_demag_poisson` | RHS, solve, recovery, and energy orchestration. | FEM CPU | [`demag_poisson_solve.cpp#L50`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp#L50) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | Potential gradient recovery, masking, and energy handoff. | FEM CPU | [`demag_poisson_recovery.cpp#L745`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` | `demag_poisson_energy_from_field` | Negative half-$\mu_0$ magnetization-field reduction. | FEM CPU | [`demag_poisson_energy.cpp#L25`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_rhs_csr_kernel` | Device CSR RHS kernel (P1 and mixed P1-to-P2). | FEM GPU | [`demag_kernels.cu#L350`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L350) |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_recovery_csr_kernel` | Device field recovery kernel (P1 and P2-to-P1). | FEM GPU | [`demag_kernels.cu#L380`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L380) |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_energy_blocks_kernel` | Device energy partials. | FEM GPU | [`demag_kernels.cu#L462`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L462) |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `fullmag_cuda_demag_validation_norm_pair` | 256-block CUB `ScaledNormPair` reduction (`1` barrier, `16 B` D2H). | FEM GPU | [`demag_kernels.cu#L265`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L265) |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_demag_cudss_direct` | Three-state VRAM-guarded `cuDSS` direct Cholesky resolver for open and PBC Poisson. | FEM GPU | [`cudss_direct_solver.cpp#L653`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `solve_demag_cudss_direct` | Stream-bound `cuDSS` triangular solve on device-resident buffers. | FEM GPU | [`cudss_direct_solver.cpp#L939`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L939) |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | Device `cuDSS`/Hypre solver dispatch and BoomerAMG setup (`coarse_relax_type=18`). | FEM GPU | [`hypre_device_solver.cpp#L257`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp#L257) |
| `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp` | `certify_gpu_hypre_demag_residual` | Shared independent Euclidean residual certification on `hypre_stream`. | FEM GPU | [`hypre_residual_certification.cpp#L25`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp#L25) |
| `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu` | `gpu_demag_predictor_apply_warm_start` | Two-step linear scalar-potential predictor with equal-stage and step-ratio guards. | FEM GPU | [`demag_predictor.cu#L69`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu#L69) |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `compute_device_demag_for_device_stage_impl` | Device-stage demag orchestration, predictor wiring, and timings. | FEM GPU | [`stage_compute.cpp#L160`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp#L160) |
| `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` | `gpu_rk_rhs_allows_fsal_k0_reuse` | FSAL `k0` reuse eligibility gate for Heun, RK4, RK23, and RK45. | FEM GPU | [`rk_fsal_policy.cpp#L80`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp#L80) |
| `backends/fem/gpu/cuda/integrators/rk/rk_demag_energy_reductions.cu` | `gpu_rk_reduce_final_demag_energy_terms` | Device demag energy reduction and ownership checks. | FEM GPU | [`rk_demag_energy_reductions.cu#L42`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_demag_energy_reductions.cu#L42) |
| `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` | `ObjectPhysicsInspectorPanel` | Object-level physics inspector exposing demagnetization controls. | Control Room | [`ObjectPhysicsSpec.tsx#L78`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx#L78) |
