# µMAG Standard Problem 4 as an FEM and FDM application-validation contract

- Status: frozen application contract; FEM mixed-P1 qualification remains pending and FDM CPU dynamics scenarios are implemented for execution comparison
- Owners: Fullmag SP4 validation
- Last updated: 2026-08-02
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/superpowers/specs/2026-07-18-mumag-standard-problem-4-fem-validation-design.md`, `docs/specs/capability-matrix-v0.md`

(problem-statement)=
## 1. Problem statement

Fullmag must reproduce µMAG Standard Problem 4 through the same public Python
workflow used by an ordinary application user. Qualification therefore starts
from plain scripts built from `fm.study`, geometry, material, mesh or cell
discretization, solver, `tableautosave`, field autosave, `relax`, and `run`. A
private test-only problem builder is not accepted as the primary execution
surface.

The FEM suite is intended to validate strict production FEM CPU and FEM GPU in
`double`; that production-validation claim remains pending until the complete
managed matrix below passes. The FDM CPU lane now has two ordinary continuous
dynamics scenarios for MuMax3 comparison, but that execution comparison does
not promote the FDM lane to a NIST qualification claim. Current source
implements only a bounded, certificate-gated mixed-P1 relaxation scope. It
separates errors owned by spatial discretization, the open-boundary demag
model, S-state preparation, time integration, runtime selection, and artifact
publication. Tangent-plane integration is outside the present scope because
it is not an executable Fullmag application path.

## 2. Physical model

(governing-equations)=
### 2.1 Governing equations

The magnetic body is a `500 nm x 125 nm x 3 nm` Permalloy film. Its normalized
magnetization $\mathbf m=\mathbf M/M_s$ obeys the Gilbert form of the LLG
equation

```{math}
:label: sp4-gilbert-llg

\frac{\partial\mathbf m}{\partial t}
=-\frac{\gamma_0}{1+\alpha^2}
\left[
p\,\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times
\left(\mathbf m\times\mathbf H_{\mathrm{eff}}\right)
\right],
\qquad \lVert\mathbf m\rVert=1.
```

Here $p=1$ for physical-time dynamics and $p=0$ for overdamped relaxation.

The effective field contains exchange, demagnetizing, and Zeeman terms:

```{math}
:label: sp4-effective-field

\mathbf H_{\mathrm{eff}}
=\mathbf H_{\mathrm{ex}}+\mathbf H_{\mathrm{demag}}
+\mathbf H_{\mathrm{ext}},
\qquad
\mathbf H_{\mathrm{ex}}
=\frac{2A_{\mathrm{ex}}}{\mu_0M_s}\nabla^2\mathbf m,
\qquad
\mathbf B_{\mathrm{ext}}=\mu_0\mathbf H_{\mathrm{ext}}.
```

The dynamic initial condition is the zero-field equilibrium S-state required
by NIST. Fullmag approaches that basin from `normalize(1, 0.1, 0)` and
qualifies the resulting state independently of the relaxation algorithm. At
dynamic time `t = 0`, one constant field is applied:

```{math}
:label: sp4-applied-fields

\begin{aligned}
\mathbf B_{\mathrm{ext}}^{A}&=(-24.6,\ 4.3,\ 0)\,\mathrm{mT},\\
\mathbf B_{\mathrm{ext}}^{B}&=(-35.5,\ -6.3,\ 0)\,\mathrm{mT}.
\end{aligned}
```

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $\gamma_0$ | gyromagnetic coefficient used by Fullmag | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $p$ | precession selector: dynamics $1$, overdamped relaxation $0$ | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ex}}$ | exchange field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{demag}}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ext}}$ | applied magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_{\mathrm{ext}}$ | applied magnetic flux density | $\mathrm{T}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $t$ | physical time | $\mathrm{s}$ |
| $\Delta t$ | accepted or fixed time step | $\mathrm{s}$ |
| $m_x,m_y,m_z$ | volume-weighted mean reduced-magnetization components | $1$ |
| $E_{\mathrm{ex}}$ | exchange energy | $\mathrm{J}$ |
| $E_{\mathrm{demag}}$ | demagnetization energy | $\mathrm{J}$ |
| $E_{\mathrm{ext}}$ | Zeeman energy | $\mathrm{J}$ |
| $E_{\mathrm{total}}$ | total energy | $\mathrm{J}$ |
| $\tau_{\max}$ | maximum torque proxy published as `max_torque_T` | $\mathrm{T}$ |
| $\Delta_E$ | absolute energy difference | $\mathrm{J}$ |
| $a_E$ | absolute energy-comparison allowance | $\mathrm{J}$ |
| $r_E$ | relative energy-comparison allowance | $1$ |
| $E_a,E_b$ | the same energy observable from two compared runs | $\mathrm{J}$ |

The final-state restriction adds the following symbols:

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $q_C$ | magnetic fraction of Cartesian voxel $C$ | $1$ |
| $w_{C,i}$ | volume-normalized P1 weight of FEM node $i$ in voxel $C$ | $1$ |
| $\Omega_m$ | magnetic FEM domain | $\mathrm{m^3}$ |
| $C$ | one Cartesian FDM voxel | $\mathrm{m^3}$ |
| $N_i$ | affine P1 shape function for FEM node $i$ | $1$ |
| $\mathbf m_i$ | reduced magnetization at FEM node $i$ | $1$ |
| $\bar{\mathbf m}_C$ | restricted reduced magnetization in voxel $C$ | $1$ |

The material constants are $M_s=8.0\times10^5\,\mathrm{A\,m^{-1}}$,
$A_{\mathrm{ex}}=1.3\times10^{-11}\,\mathrm{J\,m^{-1}}$, zero
magnetocrystalline anisotropy, $\alpha=0.02$ in dynamics, and
$\gamma_0=2.211\times10^5\,\mathrm{m\,A^{-1}\,s^{-1}}$.

The mixed-P1 relaxation gate deliberately uses the stricter public threshold

```{math}
:label: sp4-mixed-relaxation-torque-threshold
T_{\mathrm{tol}}^{T}=10^{-6}\,\mathrm T,
\qquad
T_{\mathrm{tol}}^{A/m}=\frac{T_{\mathrm{tol}}^{T}}{\mu_0}
=0.7957747154594767\,\mathrm{A\,m^{-1}}.
```

The historical all-tetrahedral SP4 lane keeps its independently authored
$10^{-5}\,\mathrm T$ threshold; this mixed qualification does not rewrite it.

(assumptions-and-validity)=
### 2.3 Assumptions and approximations

- Temperature, crystalline anisotropy, DMI, and current torques are absent.
- Open-boundary magnetostatics is approximated by the selected FEM demag
  strategy and must be qualified through frozen-magnetic-mesh airbox
  convergence.
- The mixed-P1 baseline uses magnetic `prism6`, transition `pyramid5`, and air
  `tet4` cells with one exact prism layer through the $3\,\mathrm{nm}$ film.
  Exact two- and three-layer variants and an explicit all-tetrahedron
  comparator are independent spatial checks. No prism is silently split into
  tetrahedra in strict mode.
- NIST reference results form an ensemble. No FDM result is treated as an
  exact pointwise oracle for FEM.
- A solver result is compared with NIST only after same-FEM temporal, mesh,
  airbox, and CPU/GPU convergence gates have passed.

(discrete-realization)=
## 3. Discrete realization and backend interpretation

### 3.1 FDM CPU

OOMMF and MuMax3 use finite-difference cells. Fullmag's FDM CPU comparison
lane uses the same Cartesian film dimensions and `128 x 32 x 1` cells as the
MuMax3 input, with cellwise exchange and demagnetization. The public scenarios
under `tests/standard_problems/mumag/sp4/fdm/scenarios/` execute one continuous
zero-field relaxation followed by a constant-field physical-time run for each
NIST field. They write accepted scalar samples every `10 ps` and `m` field
samples every `50 ps`.

This is a reproducible cross-application comparison lane, not a direct FEM
parity oracle and not yet a complete NIST qualification. Its authoritative
outputs are the Fullmag stage `scalars.csv` and field bundle, compared with
MuMax3's `table.txt` and field outputs after unit normalization. The comparison
must preserve the distinction between reduced magnetization (dimensionless),
physical time (seconds), and energy (joules).

### 3.2 FDM GPU

Not implemented by this SP4 scenario set. A future Fullmag FDM GPU SP4
qualification requires its own Cartesian discretization, convergence matrix,
artifacts, and executed-device evidence; FDM CPU or FEM results cannot promote
that lane.

### 3.3 FEM shared discretization

The target FEM realization uses MFEM/hypre/libCEED with distinct strict CPU
and GPU lanes.
The magnetic film and air domain form one conforming shared-domain mesh.
Airbox sweeps must reuse an identical frozen magnetic submesh; otherwise an
observed difference cannot be assigned to the open boundary.

Relaxation and physical-time integration are independent qualification axes.
A dynamics integrator never prepares its own private S-state for a comparison
run.

#### 3.3.1 Exact MuMax3 reference behavior

The vendored MuMax3 reference is upstream commit
`f656494b29516bead825b444b1f0b38c6e6c7dbf` (`v3.12-2-gf656494b`). Its
`Relax()` implementation does not use the solver or fixed step selected for
the subsequent dynamics. It saves `solvertype`, `MaxErr`, `FixDt`, and
`Precess`, then forces Bogacki--Shampine RK23, `FixDt = 0`, and
`Precess = false`; it restores the saved values on return. The thermal field
is disabled through the internal `relaxing` flag and the relaxation clock is
reset after every batch of accepted steps.

MuMax3 relaxation has two internal phases. It first evaluates total energy
every three accepted RK23 steps and continues while energy decreases. It then
tightens `MaxErr` by `sqrt(2)` and advances in three-step batches while the
torque norm improves. With the default `RelaxTorqueThreshold <= 0`, this
continues until `MaxErr <= 1e-9`; with a positive threshold, the maximum
cellwise torque is also checked. `MinDt`, `MaxDt`, `Headroom`, and the current
adaptive step remain active because `Relax()` does not replace them. Therefore
MuMax3's analogue of the Fullmag stability ceiling is `MaxDt`, not `FixDt`.

The no-precession CUDA torque is exactly `-m x (m x B_eff)` and does not use
the material `alpha`. Fullmag's `llg_overdamped` has the same stationary
states, but retains the canonical Gilbert damping factor and explicit
stage-local policy. It is consequently a MuMax-inspired equilibrium
comparator, not a bitwise reproduction of MuMax3's artificial relaxation
clock or stop schedule.

MuMax3 `Minimize()` is a separate Exl/LaBonte steepest-descent method. Despite
the API text calling it conjugate gradient, the implementation alternates the
two Barzilai--Borwein secant steps and stops when the maximum nodal `|dm|`
over the last `MinimizerSamples=10` steps is at most
`MinimizerStop=1e-6`. Fullmag `projected_gradient_bb` is therefore the closer
algorithm-family cross-check; `nonlinear_cg` remains an independent third
family. Neither direct minimizer owns RK or seconds-valued `dt`.

This separation is visible in MuMax3's own `standardproblem4_rk56.mx3`:
`SetSolver(6)` occurs before `Relax()`, but the S-state is still prepared by
the internally forced RK23 and RK56 is restored only for the reversal run.

The intended production relaxation matrix is:

| Family | Algorithm | Integrator/time controls | Purpose |
|---|---|---|---|
| damping-only LLG | `llg_overdamped` | adaptive RK23, `dt_max=1e-14 s` | MuMax-inspired reference S-state candidate and observed stability ceiling |
| direct minimizer | `projected_gradient_bb` | none | Exl/BB-family equilibrium cross-check |
| direct minimizer | `nonlinear_cg` | none | independent equilibrium cross-check |
| damping-only LLG | `llg_overdamped` | fixed RK45 `dt={2e-13, 1e-13, 5e-14, 2e-14, 1e-14} s` | explicit stability and timestep convergence |
| damping-only LLG | `llg_overdamped` | Heun/RK23/RK4/RK45 at `dt=1e-14 s` | integrator independence in the stable regime |
| damping-only LLG | `llg_overdamped` | adaptive RK45, `dt_max=1e-14 s` | adaptive-integrator cross-check |

PG-BB and NCG own neither RK nor seconds-valued `dt`; creating an artificial
algorithm-by-RK cross-product for them is invalid. `dt=1e-14 s` is a
conservative reference point discovered by the stability sweep, not a
universal constant inferred from one run. Qualification retains the whole
sweep and fails if the finest states have not entered a timestep-independent
regime.

For the production three-family CPU/GPU matrix, every state must independently
pass the NIST S-state map gate. Relative to the selected GPU/adaptive-RK23
state on the identical topology, nodal vector RMS must not exceed `0.05`, the
99th percentile must not exceed `0.15`, and the absolute difference of every
mean-magnetization component must not exceed `0.02`. Failure never causes a
fallback to another relaxation artifact.

The intended physical-time integrator matrix is:

| Scenario ID | Fullmag integrator | Main order | Step policy |
|---|---|---:|---|
| `heun_fixed` | `heun` | 2 | fixed |
| `rk23_fixed` | `rk23` | 3 | fixed |
| `rk4_fixed` | `rk4` | 4 | fixed |
| `rk45_fixed` | `rk45` | 5 | fixed |
| `rk23_adaptive` | `rk23` | 3 | embedded adaptive |
| `rk45_adaptive` | `rk45` | 5 | embedded adaptive |

Each policy is authored as two ordinary scripts, one per NIST field. Every
script first executes the same MuMax-inspired adaptive-RK23 relaxation policy
with `dt_max=1e-14 s`, then applies its named policy only to the physical-time
LLG trajectory. The relaxation-stage RK23 is not the named reversal solver.
The plain dynamics scripts use `2e-13 s` as the fixed step or adaptive ceiling;
the separate temporal sweep determines whether that baseline is sufficiently
resolved.
The managed qualification additionally loads one content-addressed canonical
S-state into every dynamics run so that solver comparisons start from
identical nodal values, not merely independently converged states.

Fixed-step policies are checked at
`dt={2e-13, 1e-13, 5e-14, 2e-14, 1e-14} s`. Adaptive
RK23/RK45 are checked at `max_err={1e-5, 1e-6, 1e-7}` with
`dt_initial=1e-15 s`, `dt_min=1e-17 s`, and `dt_max=2e-13 s`; the cap is
tightened in an additional run if accepted-step telemetry shows cap-dominated
error. The finest converged fixed and adaptive configurations are the NIST
comparison runs. Coarser levels are convergence evidence and are never
substituted for the finest trajectory when they are unstable or outside
tolerance.

### 3.4 FEM CPU

The CPU lane uses the native MFEM/hypre FEM realization in double precision.
The planner accepts only the certificate-bound strict mixed-P1 scope described
in `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`. Source and
focused tests establish implemented scope, but they do not establish SP4
validation. Promotion requires the managed CPU matrix, frozen mesh/airbox
comparisons, and NIST trajectory checks in Section 6.

### 3.5 FEM GPU

The GPU lane uses the separate native MFEM/libCEED/CUDA realization in double
precision. A forced GPU request must retain the GPU engine, device identity,
device Poisson path, resident field/operator evaluation, bounded raw transfer
counters, and an empty fallback trail. Source presence, compilation, or a
skipped CUDA test is not runtime evidence. Current capability text reports the
bounded lane as implemented while managed public-runtime proof remains
pending; this page therefore does not claim GPU SP4 validation or parity.

### 3.6 Hybrid

Hybrid execution is excluded. A strict request must not cross device lanes or
resolve to `hybrid_cpu_poisson`. Any fallback is an execution failure rather
than a degraded physics result.

## 4. API, IR, and planner impact

(python-api)=
### 4.1 Python API surface

The following copyable script is the current one-layer mixed-P1 PG-BB
authoring path. It contains no hidden builder or environment-controlled
scientific parameter.

```python
# %% Imports and execution intent
import fullmag as fm

study = fm.study("mumag_sp4_fem_relax_projected_gradient_bb")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")
study.interactive(True)

# %% Shared domain and magnetic film
study.universe(
    mode="manual",
    size=(800e-9, 250e-9, 200e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=15e-9,
    maximum_element_size=100e-9,
    maximum_element_growth_rate=2.5,
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
    order=1,
)

# %% FEM interactions and solver policy
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=500,
)
study.build_domain_mesh()

# %% Zero-field relaxation and immutable outputs
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=50_000,
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

This checked-in script is the direct interactive authoring/runtime smoke used
by the user-facing command. Its $(800,250,200)\,\mathrm{nm}$ air domain is not
relabelled as a spatial-qualification point. The managed matrix uses the
separately frozen baseline and expanded airboxes in Section 7.5 through
`SP4RunRequest`/`build_study`; every report records which path produced it.

### 3.4 Final relaxed-state artifact and FEM-to-FDM comparison

The cross-solver comparison in this document is restricted to the final
zero-field state after `minimize()` in MuMax3 and `projected_gradient_bb` (or
another explicitly selected relaxation family) in Fullmag. It does not compare
time trajectories, reversal dynamics, or the first $m_x=0$ crossing.

Both solvers must publish one explicit, complete reduced-magnetization field:

- MuMax3 executes `minimize(); save(m); tablesave()`. The saved Zarr field is
  read as `(t,z,y,x,component)` and the final frame is retained only when the
  bundle declares one final state. `tablesave()` supplies the scalar endpoint
  and provenance row; it is not used to reconstruct the texture.
- Fullmag executes a relaxation stage followed by
  `study.stages.add_save_state(artifact_name="relaxed_m.zarr",
  format="zarr", dataset="m")`. This is a single final state action, not a
  periodic field autosave. The state contains every FEM node and all three
  reduced-magnetization components in the mesh node order.

The existing `film.save(...)` method is intentionally not used for this
workflow: it serializes the currently loaded Python-side state, whereas the
post-relaxation save-state stage serializes the state produced by the solver.

The FEM field is compared to MuMax3 on a declared Cartesian grid. For a
magnetic FEM cell $K$ and an FDM voxel $C$, define the magnetic coverage and
the nodal restriction weights

```{math}
:label: sp4-fem-cartesian-restriction

q_C=\frac{|C\cap\Omega_m|}{|C|},\qquad
w_{C,i}=\frac{1}{|C|}\int_{C\cap\Omega_m}N_i(\mathbf r)\,dV,
\qquad
\bar{\mathbf m}_C=\frac{1}{q_C}\sum_i w_{C,i}\mathbf m_i
\quad(q_C>0).
```

Here $N_i$ are the affine P1 shape functions and $\mathbf m_i$ are the FEM
nodal values. The production SP4 certificate requires one uniform `prism6`
layer aligned with the film's $z$ planes, so the intersection in the $x-y$
plane is clipped exactly against each Cartesian rectangle and the thickness
integral is analytic. The implementation must fail closed for non-prism cells,
ambiguous magnetic markers, missing node-order metadata, or a non-unit-layer
mesh; it must not silently nearest-neighbour sample FEM nodes. Cells with
$q_C=0$ are masked and excluded from texture metrics.

The comparison report records the grid bounds, `(z,y,x)` shape, component order,
mesh and Zarr fingerprints, magnetic coverage statistics, and the following
dimensionless metrics on the common valid mask:

1. per-component mean absolute error, RMS error, maximum error, and 99th
   percentile error;
2. vector RMS and maximum norm error;
3. cosine similarity and the fraction of voxels with norm error above the
   declared threshold;
4. volume-weighted mean vectors from both solvers and their difference;
5. conservation checks for projected volume and each component's weighted
   integral.

The report must separate discretization restriction error from solver-state
error: it publishes the raw FEM nodal state, the restricted FEM grid, and the
MuMax grid fingerprints, and never calls a pointwise grid comparison an exact
FEM/FDM equivalence proof.

The validation-specific public parameters are exhaustive below. Generic Box,
universe, material, demag, and autosave constructors retain their existing
contracts; their concrete values and lowered fields are nevertheless shown in
the example and canonical IR excerpt.

| Python parameter | Type | Default | SI unit | Validation domain and errors | Meaning | Backend support | Canonical `ProblemIR` destination |
|---|---|---|---|---|---|---|---|
| `StudyBuilder.problem_name` | `str \| None` | `None` | $1$ | non-empty string when supplied | canonical problem identity | all authoring lanes | `problem_meta.name` |
| `StudyBuilder.engine.backend` | `str` | required | $1$ | lower-cased authoring string; no immediate enum check; this contract is later rejected unless it resolves to `fem` | requested backend | FEM CPU/GPU | `problem_meta.runtime_metadata.runtime_selection.backend` |
| `StudyBuilder.device.spec` | `str` | required | $1$ | lower-cased; `cpu`, `gpu`, `cuda`, and `cuda:<integer>` receive structured handling, other strings survive authoring for late validation; a malformed CUDA index raises `ValueError`; qualifying execution resolves explicitly to `cpu` or `gpu` | requested device intent | FEM CPU/GPU; `auto` is authoring-only for this strict gate | `problem_meta.runtime_metadata.runtime_selection.device` |
| `StudyBuilder.device.precision` | `str \| None` | `None` | $1$ | non-`None` strings are lower-cased without immediate enum validation; the mixed-P1 planner later requires `double` | requested arithmetic precision | FEM CPU/GPU double only | `problem_meta.runtime_metadata.runtime_selection.execution_precision` |
| `StudyBuilder.mode.execution_mode` | `str` | required | $1$ | one of `strict`, `extended`, or `hybrid`; this contract requires `strict` | fallback policy | FEM CPU/GPU strict only | `problem_meta.runtime_metadata.runtime_selection.execution_mode` |
| `StudyBuilder.interactive.enabled` | `bool` | `True` | $1$ | converted with `bool`; this script supplies `True` | keep the launcher session open | FEM CPU/GPU authoring | `problem_meta.runtime_metadata.interactive_session_requested` |
| `StudyUniverseHandle.__call__.mode` | `str \| None` | `None` | $1$ | effective default `auto`; allowed values are `auto` and `manual`; `manual` requires `size` | declared-domain mode | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.mode` |
| `StudyUniverseHandle.__call__.size` | `Sequence[float] \| None` | `None` | $\mathrm m$ | exactly three finite positive components; required in manual mode | universe dimensions | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.size` |
| `StudyUniverseHandle.__call__.center` | `Sequence[float] \| None` | `None` | $\mathrm m$ | exactly three finite components; omitted value retains `(0,0,0)` | universe center | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.center` |
| `StudyUniverseHandle.__call__.padding` | `Sequence[float] \| None` | `None` | $\mathrm m$ | exactly three finite nonnegative components; omitted value retains `(0,0,0)` | automatic-domain padding | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.padding` |
| `StudyUniverseHandle.mesh.minimum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite positive and not greater than the maximum when both are supplied | airbox lower size target | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.airbox_hmin` |
| `StudyUniverseHandle.mesh.maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite positive and not smaller than the minimum when both are supplied | airbox upper size target | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.airbox_hmax` |
| `StudyUniverseHandle.mesh.maximum_element_growth_rate` | `float \| None` | `None` | $1$ | finite, positive, and at most `2.5` | airbox size-growth bound | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.airbox_growth_rate` |
| `StudyUniverseHandle.mesh.hmin` | `float \| None` | `None` | $\mathrm m$ | compatibility alias used only when `minimum_element_size` is omitted; same positive/order validation | airbox lower size alias | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.airbox_hmin` |
| `StudyUniverseHandle.mesh.hmax` | `float \| None` | `None` | $\mathrm m$ | compatibility alias used only when `maximum_element_size` is omitted; same positive/order validation | airbox upper size alias | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.airbox_hmax` |
| `StudyUniverseHandle.mesh.growth_rate` | `float \| None` | `None` | $1$ | compatibility alias used only when `maximum_element_growth_rate` is omitted; finite, positive, at most `2.5` | airbox growth alias | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.airbox_growth_rate` |
| `StudyUniverseHandle.mesh.grading` | `str \| None` | `None` | $1$ | one of `auto`, `geometric`, or `linear` after lower-casing | airbox grading policy | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.study_universe.airbox_grading` |
| `Box.size_or_x` | `tuple[float,float,float] \| float \| None` | `None` | $\mathrm m$ | either a three-vector or the first positive dimension paired with `y` and `z`; ignored when keyword `size` is supplied | positional box dimensions | all authoring lanes | `geometry.entries[].size` |
| `Box.y` | `float \| None` | `None` | $\mathrm m$ | finite positive and accepted only with scalar `size_or_x` and `z` | second positional dimension | all authoring lanes | `geometry.entries[].size[1]` |
| `Box.z` | `float \| None` | `None` | $\mathrm m$ | finite positive and accepted only with scalar `size_or_x` and `y` | third positional dimension | all authoring lanes | `geometry.entries[].size[2]` |
| `Box.size` | `tuple[float,float,float] \| None` | `None` | $\mathrm m$ | keyword form requires exactly three finite positive dimensions; one complete size form is required | magnetic-film dimensions | all authoring lanes | `geometry.entries[].size` |
| `Box.name` | `str` | `"box"` | $1$ | non-empty string; example supplies `"film"`, then geometry registration canonicalizes it to `film_geom` | shape identity | all authoring lanes | `geometry.entries[].name` |
| `StudyBuilder.geometry.shape` | `object` | required | $1$ | must lower as a supported geometry; example supplies `Box` | registered magnetic shape | all authoring lanes | `geometry.entries[]` |
| `StudyBuilder.geometry.name` | `str` | `"body"` | $1$ | non-empty at materialization; example supplies `"film"` | magnet, region, and material identity stem | all authoring lanes | `magnets[].name` and `regions[].name` |
| `MagnetHandle.Ms` | `float \| None` | `None` | $\mathrm{A\,m^{-1}}$ | required and finite positive when lowered | saturation magnetization | FEM CPU/GPU | `materials[].saturation_magnetisation` |
| `MagnetHandle.Aex` | `float \| None` | `None` | $\mathrm{J\,m^{-1}}$ | required and finite positive when lowered | exchange stiffness | FEM CPU/GPU | `materials[].exchange_stiffness` |
| `MagnetHandle.alpha` | `float` | `0.01` | $1$ | finite nonnegative when lowered; example supplies `0.02` | Gilbert damping | FEM CPU/GPU | `materials[].damping` |
| `MagnetHandle.m` | `InitialMagnetization` | unset | $1$ | must be a supported initializer at lowering | initial reduced magnetization | FEM CPU/GPU | `magnets[].initial_magnetization` |
| `UniformMagnetization.value` | `Sequence[float]` | required | $1$ | exactly three finite components; normalization is performed by the solver path, not this constructor | uniform initial direction | FEM CPU/GPU | `magnets[].initial_magnetization.value` |
| `GeometryMeshHandle.thin_film.hmax` | `float \| "auto" \| None` | `None` | $\mathrm m$ | compatibility alias used only when `maximum_element_size` is omitted | upper in-plane size alias | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].maximum_element_size` |
| `GeometryMeshHandle.thin_film.hmin` | `float \| None` | `None` | $\mathrm m$ | compatibility alias used only when `minimum_element_size` is omitted | lower in-plane size alias | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].minimum_element_size` |
| `GeometryMeshHandle.thin_film.minimum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite positive length or `None`; baseline supplies `3e-9` | lower authored in-plane target | FEM CPU/GPU mixed-P1 | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].minimum_element_size` |
| `GeometryMeshHandle.thin_film.maximum_element_size` | `float \| "auto" \| None` | `None` | $\mathrm m$ | finite positive length, `"auto"`, or `None`; baseline supplies `3e-9` | upper authored in-plane target | FEM CPU/GPU mixed-P1 | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].maximum_element_size` |
| `GeometryMeshHandle.thin_film.layers` | `int` | `1` | $1$ | strict mixed-P1 accepts exactly `1`, `2`, or `3` | prism cells through film thickness | FEM CPU/GPU mixed-P1 | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].through_thickness_elements` |
| `GeometryMeshHandle.thin_film.topology` | `"tetrahedral" \| "prismatic" \| None` | `None` | $1$ | mixed-P1 requires `"prismatic"` | requested volume-cell family | FEM CPU/GPU mixed-P1 | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].topology` |
| `GeometryMeshHandle.thin_film.exact_layers` | `bool \| None` | `None` | $1$ | strict prismatic execution resolves `None` to `True` and rejects `False` | require requested and realized layer equality | FEM CPU/GPU mixed-P1 | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].exact_layer_count` |
| `GeometryMeshHandle.thin_film.transition` | `"pyramid_to_tetrahedra" \| "reject" \| None` | `None` | $1$ | shared mixed domain requires `"pyramid_to_tetrahedra"` | conforming air transition | FEM CPU/GPU mixed-P1 | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].transition_policy` |
| `GeometryMeshHandle.thin_film.order` | `int \| None` | `None` | $1$ | mixed-P1 accepts only `None` or `1` | finite-element order | FEM CPU/GPU mixed-P1 | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].order` |
| `GeometryMeshHandle.thin_film.curvature_factor` | `float \| None` | `None` | $1$ | finite positive when supplied | curvature-based sizing factor | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].curvature_factor` |
| `GeometryMeshHandle.thin_film.narrow_region_resolution` | `float \| None` | `None` | $\mathrm m$ | finite positive when supplied | narrow-region target | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].narrow_region_resolution` |
| `GeometryMeshHandle.thin_film.interface_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite positive; overridden by `surface_maximum_element_size` | interface size target | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].interface_hmax` |
| `GeometryMeshHandle.thin_film.surface_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite positive; canonical alias with precedence over interface spelling | surface size target | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].interface_hmax` |
| `GeometryMeshHandle.thin_film.interface_thickness` | `float \| None` | `None` | $\mathrm m$ | finite positive; overridden by `surface_thickness` | interface refinement thickness | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].interface_thickness` |
| `GeometryMeshHandle.thin_film.surface_thickness` | `float \| None` | `None` | $\mathrm m$ | finite positive; canonical alias with precedence over interface spelling | surface refinement thickness | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].interface_thickness` |
| `GeometryMeshHandle.thin_film.transition_distance` | `float \| "airbox_boundary" \| None` | `None` | $\mathrm m$ | nonnegative finite length or accepted airbox-boundary alias; overridden by surface spelling | interface transition distance | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].transition_distance` |
| `GeometryMeshHandle.thin_film.surface_transition_distance` | `float \| "airbox_boundary" \| None` | `None` | $\mathrm m$ | nonnegative finite length or accepted airbox-boundary alias; has precedence | surface transition distance | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].transition_distance` |
| `GeometryMeshHandle.thin_film.edge_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite positive; requires an edge thickness after resolution | edge size target | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].edge_hmax` |
| `GeometryMeshHandle.thin_film.edge_thickness` | `float \| None` | `None` | $\mathrm m$ | finite positive, paired with edge size, and for boxes smaller than half the smaller in-plane dimension | edge refinement thickness | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].edge_thickness` |
| `GeometryMeshHandle.thin_film.edge_transition_distance` | `float \| "airbox_boundary" \| None` | `None` | $\mathrm m$ | nonnegative finite length or accepted alias; requires active edge refinement | edge transition distance | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].edge_transition_distance` |
| `GeometryMeshHandle.thin_film.corner_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite positive, paired with corner extent, and no larger than active edge size | corner size target | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].corner_hmax` |
| `GeometryMeshHandle.thin_film.corner_extent` | `float \| None` | `None` | $\mathrm m$ | finite positive, paired with corner size, and for boxes smaller than half the smaller in-plane dimension | corner refinement extent | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].corner_extent` |
| `GeometryMeshHandle.thin_film.corner_transition_distance` | `float \| "airbox_boundary" \| None` | `None` | $\mathrm m$ | nonnegative finite length or accepted alias; requires active corner refinement | corner transition distance | FEM CPU/GPU meshing | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].corner_transition_distance` |
| `StudyBuilder.demag.enabled` | `bool` | `True` | $1$ | converted with `bool` | enable demagnetization | FEM CPU/GPU | presence of `energy_terms[kind=demag]` |
| `StudyBuilder.demag.model` | `str \| None` | `None` | $1$ | supported canonical model; mutually exclusive with `realization` | demag model family | FEM CPU/GPU | normalized into `energy_terms[].realization` |
| `StudyBuilder.demag.variant` | `str \| None` | `None` | $1$ | requires a compatible `model`; airbox accepts its declared variants | model variant | FEM CPU/GPU | normalized into `energy_terms[].realization` |
| `StudyBuilder.demag.realization` | `str \| None` | `None` | $1$ | legacy realization must be an allowed demag identifier and cannot be mixed with `model`; example supplies `poisson_robin` | open-boundary demag realization | FEM CPU/GPU | `energy_terms[].realization` |
| `StudyBuilder.fem_demag_solver.solver` | `"CG" \| "GMRES"` | `"CG"` | $1$ | exactly `CG` or `GMRES` | Poisson linear solver | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.solver` |
| `StudyBuilder.fem_demag_solver.preconditioner` | `"AMG" \| "JACOBI" \| "NONE"` | `"AMG"` | $1$ | exactly one supported identifier | Poisson preconditioner | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.preconditioner` |
| `StudyBuilder.fem_demag_solver.rtol` | `float` | `1e-8` | $1$ | finite positive; example supplies `1e-12` | relative linear residual target | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.rtol` |
| `StudyBuilder.fem_demag_solver.atol` | `float \| None` | `None` | solver-residual unit | finite positive when supplied | absolute linear residual target | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.atol` |
| `StudyBuilder.fem_demag_solver.max_iterations` | `int` | `500` | $1$ | integer at least `1` | linear iteration ceiling | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.max_iterations` |
| `StudyBuilder.fem_demag_solver.print_level` | `int` | `0` | $1$ | nonnegative integer | native solver verbosity | FEM CPU/GPU | `backend_policy.discretization_hints.fem.demag_solver_policy.print_level` |
| `StudyBuilder.build_domain_mesh()` | `call` | `n/a` | $1$ | accepts no arguments; marks explicit shared-domain construction requested | materialize domain mesh | FEM CPU/GPU | `problem_meta.runtime_metadata.mesh_workflow.build_requested` and `.build_target` |
| `StudyStagesBuilder.add_relax.stage_id` | `str \| None` | `None` | $1$ | non-empty and unique when supplied | stage identity | FEM CPU/GPU | `problem_meta.runtime_metadata.active_stage_id` and `study_pipeline.nodes[].id` |
| `StudyStagesBuilder.add_relax.algorithm` | `str` | `"llg_overdamped"` | $1$ | bounded values are `llg_overdamped`, `projected_gradient_bb`, and `nonlinear_cg`; other algorithms are rejected by this scope | relaxation family | FEM CPU/GPU bounded scope | `study.algorithm` |
| `StudyStagesBuilder.add_relax.max_steps` | `int` | `50000` | $1$ | positive integer; production scenario explicitly supplies `50000` | accepted-step ceiling | FEM CPU/GPU | `study.stop.max_steps` |
| `StudyStagesBuilder.add_relax.tolT` | `float` | `1e-6` | $\mathrm T$ | finite positive torque threshold; mutually exclusive with `tolA`; production scenario supplies `1e-6` | public relaxation stop threshold | FEM CPU/GPU | converted to `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax.tolA` | `float` | unset | $\mathrm{A\,m^{-1}}$ | finite positive torque threshold; mutually exclusive with `tolT` | explicit A/m relaxation stop threshold | FEM CPU/GPU | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax.energy_tolerance` | `float \| None` | `None` | $\mathrm J$ | finite positive when supplied; must agree with explicit `stop` | energy stop threshold | FEM CPU/GPU | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax.max_relaxation_time_s` | `float \| None` | `None` | $\mathrm s$ | finite positive; LLG-overdamped only; aliases must agree | relaxation pseudotime ceiling | FEM CPU/GPU LLG relaxation | `study.stop.max_relaxation_time_s` |
| `StudyStagesBuilder.add_relax.max_pseudotime_s` | `float \| None` | `None` | $\mathrm s$ | compatibility alias for `max_relaxation_time_s`; conflicting aliases raise | relaxation pseudotime alias | FEM CPU/GPU LLG relaxation | `study.stop.max_relaxation_time_s` |
| `StudyStagesBuilder.add_relax.max_physical_time_s` | `float \| None` | `None` | $\mathrm s$ | compatibility alias despite historical name; conflicting aliases raise | relaxation-time alias | FEM CPU/GPU LLG relaxation | `study.stop.max_relaxation_time_s` |
| `StudyStagesBuilder.add_relax.relax_alpha` | `float \| None` | `1.0` for LLG, otherwise `None` | $1$ | numeric override accepted only by `llg_overdamped`; direct minimizers reject it | stage-local damping | FEM CPU/GPU LLG relaxation | `materials[].damping` in the relaxation-stage IR |
| `StudyStagesBuilder.add_relax.solver` | `str \| None` | `None` | $1$ | LLG-overdamped only; resolves a supported explicit RK integrator; direct minimizers reject it | relaxation integrator | FEM CPU/GPU LLG relaxation | `study.dynamics.integrator` |
| `StudyStagesBuilder.add_relax.dt` | `float \| "auto" \| None` | `None` | $\mathrm s$ | deprecated fixed/auto control; positive fixed value or `auto`; mutually exclusive with canonical adaptive controls | relaxation timestep policy | FEM CPU/GPU LLG relaxation | `study.dynamics.fixed_timestep` or adaptive policy |
| `StudyStagesBuilder.add_relax.max_error` | `float \| None` | `None` | state-error norm | deprecated positive alias for `max_err`; cannot be combined with `max_err` or `dt_initial` | adaptive error threshold alias | FEM CPU/GPU adaptive LLG | `study.dynamics.adaptive_timestep.atol` |
| `StudyStagesBuilder.add_relax.dt_min` | `float \| None` | `None` | $\mathrm s$ | positive; adaptive stepping only; executable adaptive stages require it explicitly | minimum adaptive step | FEM CPU/GPU adaptive LLG | `study.dynamics.adaptive_timestep.dt_min` |
| `StudyStagesBuilder.add_relax.dt_max` | `float \| None` | `None` | $\mathrm s$ | positive; adaptive stepping only; executable adaptive stages require it explicitly | maximum adaptive step | FEM CPU/GPU adaptive LLG | `study.dynamics.adaptive_timestep.dt_max` |
| `StudyStagesBuilder.add_relax.dt_initial` | `float \| None` | `None` | $\mathrm s$ | positive and requires `max_err`; cannot mix with deprecated `dt`/`max_error` | initial adaptive step | FEM CPU/GPU adaptive LLG | `study.dynamics.adaptive_timestep.dt_initial` |
| `StudyStagesBuilder.add_relax.max_err` | `float \| None` | `None` | state-error norm | positive; requires adaptive RK23/RK45 and explicit `dt_min`/`dt_max` | adaptive maximum error | FEM CPU/GPU adaptive LLG | `study.dynamics.adaptive_timestep.atol` with `tolerance_mode=max_error` |
| `StudyStagesBuilder.add_relax.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | mixed | exact object type; adaptive RK23/RK45 only; mutually exclusive with scalar timestep controls and must carry explicit limits for executable stages | canonical adaptive policy | FEM CPU/GPU adaptive LLG | `study.dynamics.adaptive_timestep` |
| `StudyStagesBuilder.add_relax.field_refresh` | `FieldRefreshPolicy \| None` | `None` | mixed | LLG-overdamped only; must satisfy `FieldRefreshPolicy` validation | interaction refresh policy | FEM CPU/GPU LLG relaxation | `study.dynamics.field_refresh` |
| `StudyStagesBuilder.add_relax.stop` | `RelaxStop \| None` | `None` | mixed | exact stop object; scalar aliases must agree and at least one criterion remains | canonical stopping policy | FEM CPU/GPU | `study.stop` |
| `RelaxStageBuilder.autosave.policy` | `StageAutosave` | required | $1$ | exact `StageAutosave`; one policy per relaxation stage; every cadence must be accepted-step based | bind outputs to relaxation stage | FEM CPU/GPU | `study.sampling.stage_autosave` |
| `StageAutosave.target` | `str` | `"main"` | $1$ | non-empty safe artifact identifier | output target | FEM CPU/GPU | `study.sampling.stage_autosave.target` |
| `StageAutosave.layout` | `str` | `"continuous"` | $1$ | `continuous` or `separate` | logical sample layout | FEM CPU/GPU | `study.sampling.stage_autosave.layout` |
| `StageAutosave.format` | `str` | `"zarr"` | $1$ | `zarr`, `hdf5`, or `txt`; `txt` rejects fields | artifact format | FEM CPU/GPU | `study.sampling.stage_autosave.format` |
| `StageAutosave.table` | `TableAutosave \| None` | `None` | $1$ | must be `TableAutosave`; at least a table or one field is required | scalar-output policy | FEM CPU/GPU | `study.sampling.stage_autosave.table` |
| `StageAutosave.fields` | `Sequence[FieldAutosave]` | `()` | $1$ | only `FieldAutosave`, without duplicate quantities | field-output policies | FEM CPU/GPU | `study.sampling.stage_autosave.fields` |
| `StudyStagesBuilder.add_save_state.artifact_name` | `str` | `"state_snapshot"` | $1$ | non-empty safe artifact name; `.zarr` is normalized to `.zarr.zip` on disk | explicit post-stage state artifact | FEM CPU/GPU | stage action `save_state.artifact_name` |
| `StudyStagesBuilder.add_save_state.format` | `str \| None` | `None` | $1$ | `zarr`, `h5`, or `json` after runtime normalization | state serialization format | FEM CPU/GPU | stage action `save_state.format` |
| `StudyStagesBuilder.add_save_state.dataset` | `str \| None` | `None` | $1$ | non-empty dataset path when supplied; SP4 requires `"m"` | state dataset identity | FEM CPU/GPU | stage action `save_state.dataset` |
| `TableAutosave.t_sampl` | `float \| "auto" \| None` | `None` | $\mathrm s$ | exactly one of `t_sampl` and `every_steps` is required; positive finite seconds or `auto` | physical-time table cadence | FEM CPU/GPU run stages | `study.sampling.stage_autosave.table.sample_period_s` or `.sample_period_policy` |
| `TableAutosave.every_steps` | `int \| None` | `None` | $1$ | exactly one of `every_steps` and `t_sampl` is required; positive non-boolean integer | accepted-step table cadence | FEM CPU/GPU relaxation stages | `study.sampling.stage_autosave.table.every_steps` |
| `TableAutosave.quantities` | `Sequence[str] \| None` | `None` | mixed | supported non-empty canonical quantity IDs; `None` uses the default set | scalar columns | FEM CPU/GPU | `study.sampling.stage_autosave.table.quantities` |
| `TableAutosave.extra_quantities` | `Sequence[str]` | `()` | mixed | every identifier must be supported; duplicates are removed stably | appended scalar columns | FEM CPU/GPU | merged into `study.sampling.stage_autosave.table.quantities` |
| `TableAutosave.table_id` | `str` | `"default"` | $1$ | non-empty string | table identity | FEM CPU/GPU | `study.sampling.stage_autosave.table.table_id` |
| `FieldAutosave.quantity` | `str` | required | quantity-defined | non-empty supported field identifier | field to save | FEM CPU/GPU | `study.sampling.stage_autosave.fields[].quantity` |
| `FieldAutosave.every` | `float \| "auto" \| None` | `None` | $\mathrm s$ | exactly one of `every` and `every_steps` is required; positive finite seconds or `auto` | physical-time field cadence | FEM CPU/GPU run stages | `study.sampling.stage_autosave.fields[].every_seconds` or `.sample_period_policy` |
| `FieldAutosave.every_steps` | `int \| None` | `None` | $1$ | exactly one of `every_steps` and `every` is required; positive non-boolean integer | accepted-step field cadence | FEM CPU/GPU relaxation stages | `study.sampling.stage_autosave.fields[].every_steps` |

| Legacy persistent instruction | Canonical stage-local policy |
|---|---|
| `study.stages.tableautosave(...)` before Relax | `add_relax(...).autosave(StageAutosave(table=TableAutosave(every_steps=...)))` |
| `study.stages.tableautosave(...)` before Run | `add_run(...).autosave(StageAutosave(table=TableAutosave(t_sampl=...)))` |
| `study.stages.autosave("m", every=...)` before Run | `add_run(...).autosave(StageAutosave(fields=[FieldAutosave("m", every=...)]))` |

Persistent instructions remain readable for compatibility, but new SP4
scenarios bind storage to the owning Relax or Run stage so settings cannot leak
into later stages. Zarr with a continuous logical index is the default.

The analysis entry point is `fullmag.analysis.compare_relaxed_states(...)`. It
requires the MuMax3 Zarr bundle, the Fullmag `relaxed_m.zarr.zip` state, and
the exact `.fullmag-mesh` artifact. It builds the restriction weights once,
checks the two grids and source fingerprints, and returns a JSON-serializable
report. `load_mumax_magnetization(..., require_single_frame=True)` is the
fail-closed guard against accidentally comparing the old MuMax trajectory
bundle.

Every physical and numerical value is written directly in the scenario file.
The scripts do not read solver, field, mesh, timestep, tolerance, or duration
from environment variables. CPU or GPU is selected by the ordinary launcher,
for example `just fullmag build=True fem gpu <script>`.

Each dynamics scenario contains exactly one public `study.solver(...)`
declaration for the reversal dynamics. Its separate
`study.stages.add_relax(...)` stage explicitly carries the common adaptive
RK23 relaxation policy, corresponding to MuMax3's internally selected
relaxation solver. Relaxation-only LLG scenarios contain no physical-time run
and put their complete RK policy on the relaxation stage. Direct-minimizer
scenarios contain neither `study.solver(...)` nor any time control.

(problem-ir)=
### 4.2 Canonical `ProblemIR`

The repository exporter produces `ir_version="0.3.0"`. The following is the
exact validation-relevant serialization emitted for the public one-layer
example; the complete object additionally retains script source, domain-frame,
model-builder, and UI-editability mirrors. The executable contract is not
reconstructed from this documentation: `test_projected_gradient_scenario_requests_one_exact_uniform_prism_layer`
executes current lowering and compares the fields shown here.

```json
{
  "problem_meta": {
    "runtime_metadata": {
      "interactive_session_requested": true,
      "runtime_selection": {
        "backend": "fem",
        "device": "auto",
        "execution_mode": "strict",
        "execution_precision": "double"
      },
      "mesh_workflow": {
        "build_requested": true,
        "build_target": "domain",
        "domain_mesh_mode": "generated_shared_domain_mesh",
        "per_geometry": [{
          "geometry": "film",
          "minimum_element_size": 3e-9,
          "maximum_element_size": 3e-9,
          "order": 1,
          "mesh_strategy": "swept_prism",
          "through_thickness_elements": 1,
          "topology": "prismatic",
          "element_family": "prism",
          "transition_policy": "pyramid_to_tetrahedra",
          "exact_layer_count": true
        }]
      }
    }
  },
  "materials": [{
    "name": "mat_film",
    "saturation_magnetisation": 800000.0,
    "exchange_stiffness": 1.3e-11,
    "damping": 0.02
  }],
  "energy_terms": [
    {"kind": "exchange"},
    {"kind": "demag", "realization": "poisson_robin"}
  ],
  "study": {
    "kind": "relaxation",
    "algorithm": "projected_gradient_bb",
    "stop": {
      "torque_tolerance_apm": 0.7957747154594767,
      "max_steps": 50000
    },
    "sampling": {
      "outputs": [],
      "stage_autosave": {
        "kind": "stage_autosave",
        "target": "main",
        "layout": "continuous",
        "format": "zarr",
        "table": {
          "kind": "table_autosave",
          "table_id": "default",
          "every_steps": 10,
          "quantities": ["step", "mx", "my", "mz", "e_ex", "e_demag", "e_total", "max_torque_T"]
        },
        "fields": []
      }
    }
  }
}
```

The ordered exported pipeline contains a following `flat_save_state` stage
with action `{ "kind": "save_state", "artifact_name": "relaxed_m.zarr",
"format": "zarr", "dataset": "m" }`. The runtime writes it as
`artifacts/states/relaxed_m.zarr.zip` and preserves the preceding relax result
as its continuation state.

Dynamics scripts lower an ordered `flat_relax`, `flat_autosave`, `flat_run`
pipeline. Their relaxation IR has no Zeeman term; the run IR has exactly one
case-A or case-B Zeeman field, the selected explicit RK policy, physical
$\alpha=0.02$, and `default_until_seconds=5e-9`. Direct minimizers contain no
`dynamics` member. These are current test assertions, not inferred schema.

(round-trip-and-failure-semantics)=
### 4.3 Round trip and failure semantics

The Python script preserves **requested intent** (`fem`, `auto`, `strict`,
`double`, mixed topology, exact layers, algorithms, outputs) separately from
**resolved execution** recorded by the launcher and runtime. UI canonical
rewrite must preserve the same per-geometry mesh entry and ordered stages; it
must not rewrite `prismatic` to tetrahedral or attach RK controls to PG-BB or
NCG.

Python validation errors reject invalid types, non-positive sizes or cadence,
invalid layer counts, and time controls on direct minimizers. Planner/runtime
unsupported combinations reject explicit FDM, `single`, extended/hybrid,
device `auto` after launcher resolution, missing or degraded certificates,
wider physics, and fallback before native operator startup. A strict GPU
request never becomes a CPU result. Requested values and resolved engine,
device, precision, topology/certificate fingerprints, source identity, and
fallback trail remain separate provenance fields.

### 4.4 Planner and capability-matrix impact

Existing planner rules apply. Fixed stepping is legal for `heun`, `rk23`,
`rk4`, and `rk45`; adaptive stepping is legal only for `rk23` and `rk45`.
Production relaxation covers `llg_overdamped`, `projected_gradient_bb`, and
`nonlinear_cg`. `tangent_plane_implicit` remains outside this strict suite.
Capability status remains `implemented`, not `production_executable` or
SP4-validated, until the complete managed NIST and convergence matrix passes.
Stage-local autosave uses the canonical
ProblemIR/OpenAPI storage policy; the application launcher also enforces the ordinary
script-output convention described below.

(implementation-mapping)=
## 5. Implementation mapping

This validation application spans public authoring, lowering, capability
gating, native CPU/GPU LLG kernels, mixed-matrix planning/execution, artifact
verification, and reference metrics. Stable path-plus-symbol identities are
listed in the final source-code index. The operator ownership and mixed-cell
shape-function mapping are delegated to
`docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`; this page owns
only the SP4 application and qualification contract.

## 6. Runtime, artifacts, and provenance

Launching `/path/x.py` without `--output-dir` creates the sibling Zarr v2 group
`/path/x.zarr`. The final stage lives under `x.zarr/artifacts/`; preceding and
interactive stages live under `x.zarr/stages/`. A repeated ordinary launch
removes the previous automatic `x.zarr` directory and creates a fresh bundle.
An explicit `--output-dir` is never removed automatically, retains precedence,
and keeps the legacy session-workspace placement.

`scalars.csv` under a stage artifact is the authoritative compatibility table
of accepted states produced by `tableautosave`; rejected solver attempts stay
in their dedicated diagnostic artifact. Periodic `m` autosave is stored as the
native field series `fields/m.zarr` and supplies states bracketing the first
`mx = 0` crossing. JSON/CSV files remain compatibility members inside the
versioned Zarr result bundle; they are not reconstructed from terminal logs.

Postprocessing is read-only with respect to simulation artifacts. It appends
one row per completed attempt to
`.fullmag/reports/standard-problems/mumag/sp4/fem/ledger/results.csv`, never
silently replaces a prior attempt, and generates PNG plots from the stored
rows. Every ledger row includes phase, relaxation algorithm and its applicable
integrator/timestep controls, dynamics integrator and timestep policy, device,
git revision, mesh and airbox provenance, status, wall time, convergence,
energy-descent diagnostics, trajectory metrics, first crossing, final means,
energy, torque, and failure category. Inapplicable fields remain empty rather
than being populated with invented values.

(validation)=
## 7. Validation strategy

### 7.1 Analytical and internal checks

- finite values and `|m| = 1` within the declared tolerance;
- non-increasing accepted-state relaxation energy within the documented
  energy-evaluation budget, plus explicit stop reason;
- fresh final `max_torque_T <= 1e-6 T` and `converged=true` for every accepted
  relaxation candidate;
- agreement of PG-BB, NCG, and stable LLG endpoints in energy, weighted mean
  magnetization, and projected vector field, preventing selection of a
  different local basin;
- relaxation fixed-`dt` convergence and rejection of unstable coarse steps;
- physical-time fixed-step self-convergence at `dt`, `dt/2`, `dt/4`; observed
  order is reported but cannot hide spatial or demag error;
- adaptive `rk23` and `rk45` convergence under tighter `max_err` and the fixed
  qualified `dt_max` ceiling;
- identical magnetic-mesh digest during an airbox sweep;
- strict requested/resolved CPU or GPU provenance with no fallback.

#### 7.1.1 Frozen energy and temporal self-convergence gates

The following tolerances are fixed before mixed-P1 production runs are
inspected. They are validation acceptance limits, not solver stopping
tolerances, and a failed comparison may not be made green by selecting a
different run after the fact.

For an energy term $E$ evaluated by two runs, define the symmetric energy
difference

```{math}
:label: sp4-fem-symmetric-energy-difference

\Delta_E(E_a,E_b) = |E_a-E_b|
```

and accept it when

```{math}
:label: sp4-fem-energy-acceptance

\Delta_E(E_a,E_b)
\leq
a_E + r_E\max\!\left(|E_a|,|E_b|\right).
```

The rule is applied independently to $E_{\mathrm{ex}}$,
$E_{\mathrm{demag}}$, and $E_{\mathrm{total}}$; cancellation in total energy
cannot hide a regression in one term. The frozen constants are:

| Comparison | $a_E$ | $r_E$ |
|---|---:|---:|
| mesh, prism-layer, or mixed/all-tet relaxed-state convergence | $2\times10^{-19}\,\mathrm{J}$ | $2\times10^{-2}$ |
| baseline/expanded-airbox relaxed-state convergence | $1\times10^{-19}\,\mathrm{J}$ | $1\times10^{-2}$ |
| identical-topology CPU/GPU same-state operator parity | $1\times10^{-30}\,\mathrm{J}$ | $1\times10^{-6}$ |

The operator-parity row applies to the same magnetization on the same
topology. Independently relaxed states use the spatial or device convergence
metrics and are not required to be bitwise identical.

Fixed-step temporal self-convergence is decided only from the two finest
declared levels, $2\times10^{-14}\,\mathrm{s}$ and
$1\times10^{-14}\,\mathrm{s}$. Adaptive self-convergence is decided only from
`max_err=1e-6` and `max_err=1e-7`. For each case and integrator, the finer
trajectory is selected only when all of the following pass on a common,
non-extrapolating time grid:

- componentwise RMS error of `mx`, `my`, and `mz` is at most `0.01`;
- componentwise 99th-percentile error is at most `0.03`;
- the absolute endpoint error of every component is at most `0.01`;
- the first positive-to-nonpositive `mx=0` crossing differs by at most
  $5\,\mathrm{ps}$;
- for each of $E_{\mathrm{ex}}$, $E_{\mathrm{demag}}$, and
  $E_{\mathrm{total}}$, the trajectory RMS of the pointwise symmetric
  relative difference is at most `0.01`, and the endpoint satisfies
  Equation {eq}`sp4-fem-energy-acceptance` with
  $a_E=1\times10^{-19}\,\mathrm{J}$ and $r_E=1\times10^{-2}$.

The remaining coarser fixed and adaptive levels must be finite and stable and
are used to report the error trend and observed order. They cannot replace a
failed finest-two comparison. If accepted-step telemetry shows that an
adaptive run is limited by `dt_max` rather than by its error controller, the
comparison is inconclusive and a predeclared tighter-cap run is required; it
is not a passing adaptive-convergence result.

`MixedP1QualificationContract` and `MIXED_P1_QUALIFICATION` own these frozen
constants and fail-closed comparison rules in executable form. The current
matrix executor consumes only its bounded same-topology subset; integration of
the spatial, airbox, full temporal, replay, and benchmark rules remains an
explicit promotion blocker rather than implied evidence.

### 7.2 Cross-backend checks

CPU and GPU are compared inside FEM on identical scenario and mesh artifacts.
The FDM CPU lane compares Fullmag against MuMax3 on a common time grid for
both fields. It reports component RMSE, endpoint deltas, and the interpolated
first positive-to-nonpositive `mx=0` crossing. FDM-vs-FEM and Fullmag-vs-MuMax3
differences are reported as discretization/application differences and are not
relabeled as CPU/GPU parity. MuMax3 remains an executed comparison reference,
not an exact oracle that can override the NIST reference ensemble.

### 7.3 NIST checks

For both fields, compare the full mean-magnetization trajectory, interpolated
time of first `mx = 0`, magnetization map at that event, equilibrium window,
mesh convergence, and airbox convergence. A final endpoint alone is
insufficient.

### 7.4 Regression tests

- exact relaxation and dynamics scenario manifests plus plain-Python AST
  constraints;
- FDM CPU A+B scenario lowering, continuous stage ordering, table/field
  cadence, and fail-closed MuMax3/Fullmag trajectory parsing;
- direct minimizers reject RK/time controls by construction;
- exported stage sequence, zero-field relaxation, shared S-state contract,
  fields, dynamics integrator, timestep policy, outputs, and runtime selection;
- append-only ledger behavior and deterministic CSV schema;
- separate relaxation-convergence and NIST-dynamics PNG generation from
  synthetic and real application artifacts;
- managed CPU/GPU smoke before any physics-validation claim.

### 7.5 Frozen mixed-P1 matrix and promotion order

All axes are declared before production results are inspected:

| Axis | Required values | Ownership |
|---|---|---|
| in-plane mesh | `coarse` $3\,\mathrm{nm}$, `medium` $2\,\mathrm{nm}$, `fine` $1.5\,\mathrm{nm}$ | spatial convergence |
| through-thickness topology | mixed `layers=1`, `2`, `3`; explicit `all_tet` with no layer value | layer convergence and topology comparator |
| airbox | baseline $(700,250,250)\,\mathrm{nm}$; expanded $(1000,500,500)\,\mathrm{nm}$ | open-boundary convergence |
| relaxation | `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg` | basin/algorithm independence |
| device | explicit `cpu`, explicit `gpu` | same-topology device parity |
| dynamics field | NIST case A and case B | physical validation |
| dynamics policy | four fixed explicit RK policies and two adaptive embedded policies | temporal convergence |

The current `matrix_specs` implementation covers only staged medium-mesh
relaxation subsets: one-to-three layers on CPU, baseline/expanded airbox for
one layer on CPU, and identical layer-one CPU/GPU pairs. The coarse/fine mesh,
all-tetrahedron, full dynamics, replay, and benchmark axes are mandatory
pending implementation, not silently deferred evidence. Promotion order is:

1. source-bound managed runtime and certificate proof;
2. converged relaxation across layer, mesh, airbox, algorithm, and device axes;
3. one content-addressed qualifying S-state shared by dynamics runs;
4. fixed/adaptive temporal self-convergence for both NIST fields;
5. NIST ensemble trajectories and crossing maps;
6. performance benchmark that cannot override a failed scientific gate;
7. capability promotion only after immutable reports prove every prior item.

## 8. Completeness checklist

- [x] Python API: existing public calls only
- [x] ProblemIR: existing schema, scenario-lowering tests required
- [x] Planner: existing explicit-RK legality rules
- [ ] Capability matrix: update only after full qualification
- [ ] FDM backend: deferred to the FDM SP4 lane
- [ ] FEM backend: qualification pending
- [x] Hybrid backend: explicitly excluded
- [x] Outputs / observables: table autosave plus magnetization autosave
- [ ] Tests / benchmarks: implementation and managed runs pending
- [x] Documentation: design and execution plan updated

(limitations)=
## 9. Limitations and deferred work

- User-facing scripts use one declared baseline mesh and airbox. The managed
  qualification enumerates the declared temporal, mesh, airbox, device, and
  relaxation matrices and records every resolved parameter in artifacts and
  the append-only ledger.
- Tangent-plane integration is excluded until it is an executable public
  Fullmag path.
- The FDM CPU A+B comparison uses the declared `128 x 32 x 1` grid and
  `10 ps`/`50 ps` output cadences; FDM mesh and timestep convergence, FDM GPU,
  and promotion to a standalone FDM qualification remain deferred.
- The adaptive-RK23 state used by the plain dynamics scripts becomes a
  qualifying dynamics source only after it agrees with PG-BB and NCG and
  passes the official S-state map gate. The selected managed artifact hash is
  required by every qualifying dynamics run.
- Production validation remains open until managed CPU/GPU runs and all NIST
  convergence gates pass.

(scientific-bibliography)=
## 10. Scientific bibliography

- T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic
  materials,” *IEEE Transactions on Magnetics* 40(6), 3443–3449 (2004),
  [doi:10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (1963), stable
  record: `https://catalog.hathitrust.org/Record/000614806`.
- NIST µMAG Standard Problem 4 specification:
  `https://www.ctcms.nist.gov/~rdm/std4/spec4.html`
- NIST Standard Problem 4 results:
  `https://www.ctcms.nist.gov/~rdm/std4/results.html`
- OOMMF result archive:
  `https://www.ctcms.nist.gov/~rdm/std4/Donahue.html`
- MuMax3 `Relax()` at the audited upstream revision:
  `https://github.com/mumax/3/blob/f656494b29516bead825b444b1f0b38c6e6c7dbf/engine/relax.go`
- MuMax3 `Minimize()` and SP4 RK56 regression:
  `https://github.com/mumax/3/blob/f656494b29516bead825b444b1f0b38c6e6c7dbf/engine/minimizer.go`,
  `https://github.com/mumax/3/blob/f656494b29516bead825b444b1f0b38c6e6c7dbf/test/standardproblem4_rk56.mx3`
- `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`
- `docs/physics/0910-table-autosave-observables.md`

(source-code-index)=
## 11. Source-code index

Generated immutable links remain absent until this frozen page is published
from a full commit SHA. Stable identity is always repository-relative path plus
unique declaration symbol; a moving branch or handwritten line number is not
evidence.

| Equation or claim | Path | Symbol | Responsibility | Lane | Test or evidence | Evidence status | Immutable link |
|---|---|---|---|---|---|---|---|
| SP4 constants and declared mesh/airbox levels | `tests/standard_problems/mumag/sp4/common/contract.py` | `class SP4Contract` | canonical SI application constants and validation | shared SP4 contract | `tests/standard_problems/mumag/sp4/fem/test_contract.py` | implemented and tested | pending publication SHA |
| Equations {eq}`sp4-fem-symmetric-energy-difference` and {eq}`sp4-fem-energy-acceptance` | `tests/standard_problems/mumag/sp4/common/contract.py` | `class EnergyComparisonTolerance` | fail-closed absolute-plus-relative energy acceptance | shared SP4 qualification | `test_mixed_p1_qualification_rules_are_executable_and_fail_closed` | implemented and tested | pending publication SHA |
| frozen mixed-P1 energy and temporal acceptance rules | `tests/standard_problems/mumag/sp4/common/contract.py` | `class MixedP1QualificationContract` | immutable tolerances, finest-level pairs, and fail-closed comparisons | shared SP4 qualification | `test_mixed_p1_qualification_contract_freezes_energy_and_temporal_gates`; `test_mixed_p1_qualification_rules_are_executable_and_fail_closed` | implemented and tested; executor integration pending for declared wider axes | pending publication SHA |
| Equation {eq}`sp4-mixed-relaxation-torque-threshold` | `tests/standard_problems/mumag/sp4/common/contract.py` | `class MixedP1QualificationContract` | own and validate the mixed-P1 acceptance contract, including the frozen T and canonical A/m thresholds | shared mixed-P1 qualification | `test_qualification_defaults_to_monotone_overdamped_llg_relaxation` | implemented and tested | pending publication SHA |
| public study DSL and requested runtime intent | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | public study authoring facade | FEM CPU/GPU authoring | scenario lowering tests | implemented and tested | pending publication SHA |
| exact-layer prism authoring | `packages/fullmag-py/src/fullmag/world.py` | `thin_film` | validate and lower prismatic thin-film controls | FEM CPU/GPU mixed-P1 | `test_projected_gradient_scenario_requests_one_exact_uniform_prism_layer` | implemented and tested | pending publication SHA |
| relaxation-stage authoring | `packages/fullmag-py/src/fullmag/world.py` | `add_relax` | validate algorithm, stopping, and stage-local controls | FEM CPU/GPU | relaxation scenario matrix tests | implemented and tested | pending publication SHA |
| stage-local autosave representation | `packages/fullmag-py/src/fullmag/model/study.py` | `class StageAutosave` | table and field output ownership | FEM CPU/GPU | public scenario lowering test | implemented and tested | pending publication SHA |
| final-state save action | `packages/fullmag-py/src/fullmag/world.py` | `def save_state_stage` | lower one post-relaxation `m` state artifact without periodic field sampling | FEM CPU/GPU | `test_projected_gradient_bb_requests_only_final_m_state_save` | implemented and tested | pending publication SHA |
| Cartesian grid definition | `packages/fullmag-py/src/fullmag/analysis/magnetization_comparison.py` | `class CartesianGrid` | define common bounds, `(z,y,x)` shape, and voxel volume | FEM-to-FDM analysis | `test_cartesian_restriction_is_exact_for_an_affine_prism_field` | implemented and tested | pending publication SHA |
| MuMax3 final-state loading | `packages/fullmag-py/src/fullmag/analysis/magnetization_comparison.py` | `load_mumax_magnetization` | preserve the MuMax `(t,z,y,x,component)` Zarr contract and reject stale multi-frame input for comparison | FDM GPU reference | `test_mumax_loader_preserves_tzyxc_contract_and_rejects_old_trajectory` | implemented and tested | pending publication SHA |
| Fullmag final-state loading | `packages/fullmag-py/src/fullmag/analysis/magnetization_comparison.py` | `load_fullmag_fem_magnetization` | bind the `(node,component)` state to the persisted FEM mesh and topology fingerprint | FEM CPU/GPU | `test_compare_relaxed_states_loads_fullmag_node_state_and_reports_provenance` | implemented and tested | pending publication SHA |
| Equation {eq}`sp4-fem-cartesian-restriction` | `packages/fullmag-py/src/fullmag/analysis/fem_cartesian_restriction.py` | `build_prism6_cartesian_restriction` | exact affine-P1 volume restriction from one aligned prism layer to a Cartesian grid | FEM-to-FDM analysis | `test_cartesian_restriction_is_exact_for_an_affine_prism_field`; `test_cartesian_restriction_masks_nonmagnetic_voxels` | implemented and tested | pending publication SHA |
| final relaxed-state comparison metrics | `packages/fullmag-py/src/fullmag/analysis/magnetization_comparison.py` | `compare_relaxed_states` | restrict FEM, compare only the final common masked grid, and emit provenance plus component/vector metrics | FEM-to-FDM analysis | `test_compare_relaxed_states_loads_fullmag_node_state_and_reports_provenance` | implemented and tested | pending publication SHA |
| comparison test fixture | `packages/fullmag-py/tests/test_magnetization_comparison.py` | `test_compare_relaxed_states_loads_fullmag_node_state_and_reports_provenance` | exercise loaders, restriction, metrics, and provenance on complete synthetic artifacts | FEM-to-FDM analysis | focused pytest | implemented and tested | pending publication SHA |
| exact public mixed script lowering | `tests/standard_problems/mumag/sp4/fem/test_scenarios.py` | `test_projected_gradient_scenario_requests_one_exact_uniform_prism_layer` | assert complete mesh entry and autosave IR | FEM CPU/GPU authoring | direct test execution | implemented and tested | pending publication SHA |
| public mixed-prism scenario threshold | `tests/standard_problems/mumag/sp4/fem/test_scenarios.py` | `test_relaxation_scenario_exports_only_its_physically_applicable_policy` | execute the checked-in projected-gradient scenario and prove its `tolT=1e-6` lowering without changing legacy scenarios | FEM CPU/GPU authoring | direct test execution | implemented and tested | pending publication SHA |
| dynamics pipeline lowering | `tests/standard_problems/mumag/sp4/fem/test_scenarios.py` | `test_dynamics_scenario_uses_common_mumax_like_relaxation_and_named_run_solver` | assert field, RK policy, stage order, outputs, and runtime intent | FEM CPU/GPU authoring | direct test execution | implemented and tested for all-tet scripts | pending publication SHA |
| bounded mixed-P1 planner gate | `crates/fullmag-plan/src/mesh.rs` | `validate_mixed_p1_execution_scope` | reject tuples outside strict certificate-bound scope | FEM CPU/GPU | planner mixed-P1 tests | implemented and tested | pending publication SHA |
| capability status without promotion | `crates/fullmag-runner/src/capabilities.rs` | `mixed_p1_feature_capabilities` | publish implemented scope and pending managed proof | FEM CPU/GPU | capability contract tests | implemented; production qualification pending | pending publication SHA |
| Equation {eq}`sp4-gilbert-llg`, CPU | `backends/fem/cpu/mfem/integrators/llg_rhs.cpp` | `llg_rhs_aos` | Gilbert RHS with precession selector | FEM CPU | native FEM LLG tests | implemented; SP4 managed validation pending | pending publication SHA |
| Equation {eq}`sp4-gilbert-llg`, GPU | `backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu` | `fullmag_cuda_llg_rhs_fused` | device-resident fused Gilbert RHS wrapper | FEM GPU | native source and managed telemetry gates | implemented; executed SP4 device proof pending | pending publication SHA |
| exchange part of Equation {eq}`sp4-effective-field` | `backends/fem/cpu/mfem/interactions/exchange_operator.cpp` | `initialize_exchange_operator_mfem` | topology-aware exchange operator assembly | FEM CPU/GPU shared operator contract | mixed-P1 operator tests | implemented; full matrix pending | pending publication SHA |
| demag part of Equation {eq}`sp4-effective-field` | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | magnetic-cell Poisson source assembly | FEM CPU/GPU shared operator contract | bounded same-state runtime comparison | implemented; managed proof pending | pending publication SHA |
| frozen run enumeration | `tests/standard_problems/mumag/sp4/fem/matrix_contract.py` | `matrix_specs` | deterministic staged relaxation run identities | FEM CPU/GPU | `test_matrix_contract.py` | only stages 1–3 implemented; wider matrix pending | pending publication SHA |
| topology-scoped relaxation threshold | `tests/standard_problems/mumag/sp4/fem/matrix_contract.py` | `class SP4MatrixRunSpec` | bind mixed-P1 and legacy all-tet thresholds to immutable run specifications | FEM CPU/GPU | `test_matrix_contract.py` | implemented and tested | pending publication SHA |
| topology-scoped managed study threshold | `tests/standard_problems/mumag/sp4/fem/problem.py` | `build_study` | lower the stricter threshold only for mixed-P1 runs while preserving all-tet history | FEM CPU/GPU | `test_managed_problem_scopes_stricter_torque_threshold_to_mixed_p1` | implemented and tested | pending publication SHA |
| energy acceptance formula implementation primitive | `scripts/run_fem_sp4_mixed_matrix.py` | `_parity_scalar` | fail-closed absolute-plus-relative scalar comparison | FEM CPU/GPU | `test_run_fem_sp4_mixed_matrix.py` | device-pair primitive implemented; spatial/temporal use pending | pending publication SHA |
| staged identical-topology device comparison | `scripts/run_fem_sp4_mixed_matrix.py` | `_compare_stage3_pairs` | compare certificate, state, energy, torque, and GPU provenance | FEM CPU/GPU | `test_run_fem_sp4_mixed_matrix.py` | implemented for stage 3; managed execution pending | pending publication SHA |
| source-bound managed execution | `scripts/run_fem_sp4_mixed_matrix.py` | `execute_matrix` | execute append-only staged evidence under durable storage | FEM CPU/GPU | executor tests | implemented for staged relaxation subset; managed run pending | pending publication SHA |
| mixed-P1 torque convergence evidence | `scripts/run_fem_sp4_mixed_matrix.py` | `_validate_case_artifacts` | require torque stop provenance, nonnegative unit-consistent residuals, and the planned `1e-6 T` limit | FEM CPU/GPU | `test_binds_every_runtime_artifact_to_planned_axes_and_step_budget` | implemented and tested | pending publication SHA |
| exact source identity | `scripts/capture_source_snapshot_identity.py` | `capture` | content-address committed, dirty, and untracked source state | build/runtime shared | source identity tests | implemented and tested | pending publication SHA |
| bounded runtime artifact validation | `scripts/verify_fem_mixed_prism_airbox_runtime.py` | `validate_runtime_artifacts` | verify fields, energies, topology, device, residency, and provenance | FEM CPU/GPU | verifier tests | implemented; managed public run pending | pending publication SHA |
| trajectory convergence primitive | `tests/standard_problems/mumag/sp4/common/metrics.py` | `trajectory_pair_metrics` | common-grid RMS, endpoint, and crossing differences | shared SP4 analysis | `test_contract.py` | base metrics implemented; frozen p99/energy extension pending | pending publication SHA |
| first $m_x=0$ crossing | `tests/standard_problems/mumag/sp4/common/metrics.py` | `find_first_zero_crossing` | non-extrapolating positive-to-nonpositive crossing interpolation | shared SP4 analysis | `test_contract.py` | implemented and tested | pending publication SHA |
| NIST vector-map comparison | `tests/standard_problems/mumag/sp4/common/metrics.py` | `vector_field_metrics` | component error and directional correlation | shared SP4 analysis | `test_contract.py` | implemented; managed crossing artifacts pending | pending publication SHA |
| three-family relaxed-state selection | `tests/standard_problems/mumag/sp4/fem/verify.py` | `relaxation_matrix_metrics` | require ready CPU/GPU artifacts and basin agreement | FEM CPU/GPU | verifier tests | legacy layout implemented; mixed full-matrix integration pending | pending publication SHA |
| append-only results ledger | `tests/standard_problems/mumag/sp4/fem/collect_results.py` | `collect_attempt` | persist run provenance and observables | shared SP4 artifacts | `test_collect_results.py` | implemented and tested | pending publication SHA |
