# µMAG Standard Problem 4 as an FEM application-validation contract

- Status: approved implementation basis
- Owners: Fullmag FEM validation
- Last updated: 2026-07-19
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/superpowers/specs/2026-07-18-mumag-standard-problem-4-fem-validation-design.md`, `docs/specs/capability-matrix-v0.md`

## 1. Problem statement

Fullmag must reproduce µMAG Standard Problem 4 through the same public Python
workflow used by an ordinary application user. Qualification therefore starts
from plain scripts built from `fm.study`, geometry, material, mesh, solver,
`tableautosave`, field autosave, `relax`, and `run`. A private test-only
problem builder is not accepted as the primary execution surface.

The suite validates strict production FEM CPU and FEM GPU in `double`. It
separates errors owned by spatial discretization, the open-boundary demag
model, S-state preparation, time integration, runtime selection, and artifact
publication. Tangent-plane integration is outside the present scope because
it is not an executable Fullmag application path.

## 2. Physical model

### 2.1 Governing equations

The magnetic body is a `500 nm x 125 nm x 3 nm` Permalloy film. Its normalized
magnetization `m = M / Ms` obeys the Gilbert form of the LLG equation

```text
dm/dt = -gamma_mu0/(1 + alpha^2)
        [m x H_eff + alpha m x (m x H_eff)],
|m| = 1.
```

The effective field contains exchange, demagnetizing, and Zeeman terms:

```text
H_eff = H_ex + H_demag + H_ext,
H_ex = 2 Aex / (mu0 Ms) Laplacian(m),
B_ext = mu0 H_ext.
```

The dynamic initial condition is the zero-field equilibrium S-state required
by NIST. Fullmag approaches that basin from `normalize(1, 0.1, 0)` and
qualifies the resulting state independently of the relaxation algorithm. At
dynamic time `t = 0`, one constant field is applied:

```text
case A: B_ext = (-24.6,  4.3, 0) mT,
case B: B_ext = (-35.5, -6.3, 0) mT.
```

### 2.2 Symbols and SI units

| Symbol or observable | Meaning | SI unit |
|---|---|---|
| `Ms` | saturation magnetization | `A/m` |
| `Aex` | exchange stiffness | `J/m` |
| `alpha` | Gilbert damping | `1` |
| `gamma_mu0` | gyromagnetic coefficient used by Fullmag | `m/(A s)` |
| `B_ext` | applied magnetic flux density | `T` |
| `t`, `dt` | simulation time and accepted step | `s` |
| `mx`, `my`, `mz` | volume-weighted mean reduced magnetization | `1` |
| `E_ex`, `E_demag`, `E_ext`, `E_total` | energy terms | `J` |
| `max_torque_T` | maximum torque proxy | `T` |

The material constants are `Ms = 8.0e5 A/m`, `Aex = 1.3e-11 J/m`, zero
magnetocrystalline anisotropy, `alpha = 0.02` in dynamics, and
`gamma_mu0 = 2.211e5 m/(A s)`.

### 2.3 Assumptions and approximations

- Temperature, crystalline anisotropy, DMI, and current torques are absent.
- Open-boundary magnetostatics is approximated by the selected FEM demag
  strategy and must be qualified through frozen-magnetic-mesh airbox
  convergence.
- A tetrahedral P1 mesh is used. The baseline uses the nominal NIST/OOMMF
  `hmax = 3 nm` without an explicit through-thickness layer count; Gmsh may
  subdivide the thickness as required by tetrahedral topology. Finer `hmax`
  levels refine it further. The scripts do not force a multi-layer thin-film
  preset because it creates degenerate conformal tetrahedra at the airbox
  interface.
- NIST reference results form an ensemble. No FDM result is treated as an
  exact pointwise oracle for FEM.
- A solver result is compared with NIST only after same-FEM temporal, mesh,
  airbox, and CPU/GPU convergence gates have passed.

## 3. Numerical interpretation

### 3.1 FDM

OOMMF and MuMax3 use finite-difference cells and remain reference data and
auxiliary implementation examples. Their cellwise demag and boundary
discretization are not a direct FEM parity oracle. FDM qualification will use
the same NIST observables but a separate realization under
`tests/standard_problems/mumag/sp4/fdm/`.

### 3.2 FEM

Production FEM uses MFEM/hypre/libCEED with distinct strict CPU and GPU lanes.
The magnetic film and air domain form one conforming shared-domain mesh.
Airbox sweeps must reuse an identical frozen magnetic submesh; otherwise an
observed difference cannot be assigned to the open boundary.

Relaxation and physical-time integration are independent qualification axes.
A dynamics integrator never prepares its own private S-state for a comparison
run.

#### 3.2.1 Exact MuMax3 reference behavior

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

The production relaxation matrix is:

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

The physical-time integrator matrix is:

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

### 3.3 Hybrid

Hybrid execution is excluded. A strict request must not cross device lanes or
resolve to `hybrid_cpu_poisson`. Any fallback is an execution failure rather
than a degraded physics result.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Scenario scripts exercise only public calls, including stage-local autosave:

```python
study.stages.add_relax(...).autosave(fm.StageAutosave(
    table=fm.TableAutosave(every_steps=10, quantities=["step", "mx", "my", "mz"]),
))
study.stages.add_run(until=5e-9).autosave(fm.StageAutosave(
    table=fm.TableAutosave(t_sampl=1e-12, quantities=["step", "t", "mx", "my", "mz"]),
    fields=[fm.FieldAutosave("m", every=1e-12)],
))
```

| Legacy persistent instruction | Canonical stage-local policy |
|---|---|
| `study.stages.tableautosave(...)` before Relax | `add_relax(...).autosave(StageAutosave(table=TableAutosave(every_steps=...)))` |
| `study.stages.tableautosave(...)` before Run | `add_run(...).autosave(StageAutosave(table=TableAutosave(t_sampl=...)))` |
| `study.stages.autosave("m", every=...)` before Run | `add_run(...).autosave(StageAutosave(fields=[FieldAutosave("m", every=...)]))` |

Persistent instructions remain readable for compatibility, but new SP4
scenarios bind storage to the owning Relax or Run stage so settings cannot leak
into later stages. Zarr with a continuous logical index is the default.

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

### 4.2 ProblemIR representation

Tests inspect exported ProblemIR and ordered
study stages to prove that relaxation has zero external field, the reversal
stage has the correct field, table autosave uses the canonical quantity IDs,
the requested integrator and timestep policy survive lowering, and execution
mode is strict `double` FEM.

### 4.3 Planner and capability-matrix impact

Existing planner rules apply. Fixed stepping is legal for `heun`, `rk23`,
`rk4`, and `rk45`; adaptive stepping is legal only for `rk23` and `rk45`.
Production relaxation covers `llg_overdamped`, `projected_gradient_bb`, and
`nonlinear_cg`. `tangent_plane_implicit` remains outside this strict suite.
Capability status remains executable but not SP4-validated until the complete
NIST and convergence matrix passes. Stage-local autosave uses the canonical
ProblemIR/OpenAPI storage policy; the application launcher also enforces the ordinary
script-output convention described below.

## 5. Runtime, artifacts, and provenance

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

## 6. Validation strategy

### 6.1 Analytical and internal checks

- finite values and `|m| = 1` within the declared tolerance;
- non-increasing accepted-state relaxation energy within the documented
  energy-evaluation budget, plus explicit stop reason;
- fresh final `max_torque_T <= 1e-5 T` and `converged=true` for every accepted
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

### 6.2 Cross-backend checks

CPU and GPU are compared inside FEM on identical scenario and mesh artifacts.
FDM codes contribute the NIST reference envelope only. Cross-discretization
differences are reported and are not relabelled as CPU/GPU parity.

### 6.3 NIST checks

For both fields, compare the full mean-magnetization trajectory, interpolated
time of first `mx = 0`, magnetization map at that event, equilibrium window,
mesh convergence, and airbox convergence. A final endpoint alone is
insufficient.

### 6.4 Regression tests

- exact relaxation and dynamics scenario manifests plus plain-Python AST
  constraints;
- direct minimizers reject RK/time controls by construction;
- exported stage sequence, zero-field relaxation, shared S-state contract,
  fields, dynamics integrator, timestep policy, outputs, and runtime selection;
- append-only ledger behavior and deterministic CSV schema;
- separate relaxation-convergence and NIST-dynamics PNG generation from
  synthetic and real application artifacts;
- managed CPU/GPU smoke before any physics-validation claim.

## 7. Completeness checklist

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

## 8. Known limits and deferred work

- User-facing scripts use one declared baseline mesh and airbox. The managed
  qualification enumerates the declared temporal, mesh, airbox, device, and
  relaxation matrices and records every resolved parameter in artifacts and
  the append-only ledger.
- Tangent-plane integration is excluded until it is an executable public
  Fullmag path.
- The adaptive-RK23 state used by the plain dynamics scripts becomes a
  qualifying dynamics source only after it agrees with PG-BB and NCG and
  passes the official S-state map gate. The selected managed artifact hash is
  required by every qualifying dynamics run.
- Production validation remains open until managed CPU/GPU runs and all NIST
  convergence gates pass.

## 9. References

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
