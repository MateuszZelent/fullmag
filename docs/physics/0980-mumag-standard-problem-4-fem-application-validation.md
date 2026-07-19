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

The initial state is obtained by zero-field overdamped-LLG relaxation from
`normalize(1, 0.1, 0)`. At dynamic time `t = 0`, one constant field is applied:

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
- A tetrahedral P1 mesh is used. In-plane refinement and through-thickness
  layers are independent convergence axes.
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

The explicit integrator matrix is:

| Scenario ID | Fullmag integrator | Main order | Step policy |
|---|---|---:|---|
| `heun_fixed` | `heun` | 2 | fixed |
| `rk23_fixed` | `rk23` | 3 | fixed |
| `rk4_fixed` | `rk4` | 4 | fixed |
| `rk45_fixed` | `rk45` | 5 | fixed |
| `rk23_adaptive` | `rk23` | 3 | embedded adaptive |
| `rk45_adaptive` | `rk45` | 5 | embedded adaptive |

Each policy is authored as two ordinary scripts, one per NIST field. The
script applies the same policy to overdamped-LLG S-state preparation and the
subsequent LLG trajectory, matching the user-visible MuMax-style workflow.

### 3.3 Hybrid

Hybrid execution is excluded. A strict request must not cross device lanes or
resolve to `hybrid_cpu_poisson`. Any fallback is an execution failure rather
than a degraded physics result.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No new Python API is introduced. Scenario scripts exercise only public calls,
including:

```python
study.tableautosave(
    1e-12,
    quantities=[
        "step", "t", "dt", "mx", "my", "mz",
        "e_ex", "e_demag", "e_ext", "e_total", "max_torque_T",
    ],
)
study.stages.add_relax(...)
study.stages.autosave("m", every=1e-12)
study.stages.add_run(until=5e-9)
```

Every physical and numerical value is written directly in the scenario file.
The scripts do not read solver, field, mesh, timestep, tolerance, or duration
from environment variables. CPU or GPU is selected by the ordinary launcher,
for example `just fullmag build=True fem gpu <script>`.

Each scenario contains exactly one public `study.solver(...)` declaration for
the reversal dynamics. `study.stages.add_relax(...)` carries only the explicit
per-stage relaxation policy required by the stage API; solver configuration is
not split across repeated `study.solver(...)` calls.

### 4.2 ProblemIR representation

No schema change is required. Tests inspect exported ProblemIR and ordered
study stages to prove that relaxation has zero external field, the reversal
stage has the correct field, table autosave uses the canonical quantity IDs,
the requested integrator and timestep policy survive lowering, and execution
mode is strict `double` FEM.

### 4.3 Planner and capability-matrix impact

Existing planner rules apply. Fixed stepping is legal for `heun`, `rk23`,
`rk4`, and `rk45`; adaptive stepping is legal only for `rk23` and `rk45`.
Capability status remains executable but not SP4-validated until the complete
NIST and convergence matrix passes. No OpenAPI or ProblemIR change is introduced
by these test scripts. The application launcher does enforce the ordinary
script-output convention described below.

## 5. Runtime, artifacts, and provenance

Launching `/path/x.py` without `--output-dir` creates the sibling Zarr v2 group
`/path/x.zarr`. The final stage lives under `x.zarr/artifacts/`; preceding and
interactive stages live under `x.zarr/stages/`. An existing default bundle is
never silently overwritten. An explicit `--output-dir` retains precedence and
the legacy session-workspace placement.

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
rows. Every ledger row includes scenario, case, integrator, timestep policy,
device, git revision, mesh and airbox provenance, status, wall time, trajectory
metrics, first crossing, final means, energy, torque, and failure category.

## 6. Validation strategy

### 6.1 Analytical and internal checks

- finite values and `|m| = 1` within the declared tolerance;
- monotone accepted-tail relaxation energy and explicit stop reason;
- observed temporal orders close to 2, 3, 4, and 5 on fixed-step sweeps;
- adaptive `rk23` and `rk45` error reduction with tighter `max_err`;
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

- exact scenario manifest and plain-Python AST constraints;
- exported stage sequence, fields, integrator, timestep policy, outputs, and
  runtime selection for all twelve scripts;
- append-only ledger behavior and deterministic CSV schema;
- plot generation from synthetic and real application artifacts;
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

- The first twelve scripts use one declared baseline mesh and airbox. Temporal,
  mesh, airbox, and tolerance variants are added as separate concrete scripts
  as their runs enter the ledger; they are not hidden parameter sweeps.
- Tangent-plane integration is excluded until it is an executable public
  Fullmag path.
- Direct minimizers remain a separate diagnostic lane and do not replace the
  explicit-RK qualification requested here.
- Production validation remains open until managed CPU/GPU runs and all NIST
  convergence gates pass.

## 9. References

- NIST µMAG Standard Problem 4 specification:
  `https://www.ctcms.nist.gov/~rdm/std4/spec4.html`
- NIST Standard Problem 4 results:
  `https://www.ctcms.nist.gov/~rdm/std4/results.html`
- OOMMF result archive:
  `https://www.ctcms.nist.gov/~rdm/std4/Donahue.html`
- `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`
- `docs/physics/0910-table-autosave-observables.md`
