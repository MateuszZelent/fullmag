# FEM demag solver policy and runtime CPU threading contract

- Status: implemented
- Owners: Fullmag FEM/runtime
- Last updated: 2026-11-07
- Related ADRs: `docs/adr/` (execution-selection + canonical IR contract)
- Related specs: `docs/specs/capability-matrix-v0.md`

(problem-statement)=
## 1. Problem statement

Fullmag needs two explicit contracts around native FEM Poisson demagnetization:

1. an authorable FEM-native linear solver policy for the Poisson demag solve,
2. an explicit requested-vs-resolved CPU threading story for live sessions.

Without those contracts, the UI can only show opaque defaults and users cannot
reproduce numerically relevant solver choices from Python or session metadata.

## 2. Physical model

(governing-equations)=
### 2.1 Governing equations

The physical demagnetization model remains unchanged:

- `H_demag = -grad(u)`
- `div(grad(u)) = div(M)` in the shared FEM domain

With magnetization supported on the magnetic region and zero in the surrounding
air part of the shared domain, the scalar-potential formulation is

```{math}
:label: eq-fem-demag-scalar-potential
\mathbf{H}_{\mathrm{demag}}=-\nabla u,
\qquad
\nabla\cdot\nabla u=\nabla\cdot\mathbf{M}
\quad\text{in }D.
```

This note concerns the linear solve used to realize this equation. The chosen
finite computational domain and its Dirichlet, Robin, or periodic boundary
realization remain owned by the corresponding FEM demag path.

The added contract in this note changes only the numerical realization policy,
not the governing micromagnetic equations.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

The nodal finite-element system for the unscaled Poisson operator and its
residual are

```{math}
:label: eq-fem-demag-linear-system
\mathbf{K}\mathbf{u}=\mathbf{b},
\qquad
\mathbf{r}=\mathbf{b}-\mathbf{K}\mathbf{u}.
```

For dimensionless nodal basis functions, the stiffness entries have units of
metres, the potential coefficients have units of amperes, and the right-hand
side and residual have units of ampere-metres. Thus `atol` is an absolute
algebraic residual threshold in A·m for this unscaled system. If the assembled
system or basis is rescaled, the numerical value of `atol` must be interpreted
in that scaled system; `rtol` remains dimensionless. With `atol=None`, no
absolute threshold is serialized or requested.

| LaTeX token | Meaning | SI unit |
|---|---|---|
| `D` | Shared computational FEM domain (volume) | $\mathrm{m^3}$ |
| `\mathbf{M}` | Magnetization field | `$\mathrm{A/m}$` |
| `\mathbf{H}_{\mathrm{demag}}` | Demagnetizing field | `$\mathrm{A/m}$` |
| `u` | Scalar magnetic potential and nodal coefficients | `$\mathrm{A}$` |
| `\nabla` | Spatial gradient operator | `$\mathrm{m^{-1}}$` |
| `\nabla\cdot` | Spatial divergence operator | `$\mathrm{m^{-1}}$` |
| `\mathbf{K}` | Unscaled Poisson stiffness matrix | `$\mathrm{m}$` |
| `\mathbf{u}` | Vector of scalar-potential coefficients | `$\mathrm{A}$` |
| `\mathbf{b}` | Assembled Poisson right-hand side | `$\mathrm{A\,m}$` |
| `\mathbf{r}` | Algebraic residual vector | `$\mathrm{A\,m}$` |
| `\lVert\cdot\rVert_2` | Euclidean norm over algebraic coefficients | $\mathrm{A\,m}$; preserves its operand unit |
| `\mathrm{rtol}` | Relative linear-solver tolerance | `$1$` |
| `\mathrm{atol}` | Absolute residual tolerance for the unscaled system | `$\mathrm{A\,m}$` |

All user-visible physical quantities remain SI-clean.

The A·m unit describes the unscaled Euclidean residual and the intended
independent acceptance threshold. The pinned MFEM `HyprePCG` defaults do not
enable HYPRE's `two_norm` option, so its internal CG criterion uses a
preconditioned norm. Its absolute threshold is not generally the Euclidean
threshold in this table. GMRES uses the Euclidean residual norm. Native CPU
Poisson independently checks `||Ax-b||2`. The corrected device-HYPRE GPU
path also computes that certificate after every solve, including a reported
CG success. A successful CG report alone is not an independent Euclidean
certificate. The historical 50 fs SP4 transport experiments use `atol=None`
and predate this correction; see the qualification boundary in section 5.1.

(assumptions-and-validity)=
### 2.3 Assumptions and approximations

- The solver policy applies only to native FEM Poisson demag realizations.
- It is a backend hint, not a new physical model term.
- The solver policy is defined for the native FEM Poisson demag hint. It is not
  a shared FDM/FEM physics parameter, and choosing it does not select a
  boundary realization or guarantee that every solver/preconditioner tuple is
  supported by every native lane.
- CPU thread selection is resolved per run start and may differ between:
  - requested study/runtime threads,
  - resolved Rayon/control-plane threads,
  - effective native FEM OpenMP threads.

(discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM

No change. FDM demag remains governed by FDM-specific solver policy surfaces.

### 3.2 FEM

Native FEM Poisson demag may now carry an explicit linear-solver policy:

- solver: `CG | GMRES`
- preconditioner: `AMG | JACOBI | NONE`
- `rtol`
- optional `atol`
- `max_iterations`
- `print_level`

When omitted, the canonical default remains:

- solver: `CG`
- preconditioner: `AMG`
- `rtol = 1e-8`
- `atol = None`
- `max_iterations = 500`
- `print_level = 0`

For strict native FEM GPU Poisson demag, an omitted solver policy is resolved at
runtime while preserving the same tolerance and iteration defaults. The general
strict GPU fallback remains `CG/JACOBI`, but `projected_gradient_bb` resolves to
`CG/AMG` because the current PGBB demag-policy smoke shows materially lower
strict-GPU apply time for the AMG row than for the Jacobi row. This is a runtime
policy selection, not a public authoring default: explicit user-provided
`FemLinearSolverPolicy` values are not rewritten, and CPU native FEM continues
to resolve the omitted policy to `CG/AMG`.

### 3.3 Hybrid

No hybrid-specific semantics are introduced. Hybrid work must not reinterpret
this as a common physics setting.

### 3.4 Backend lane matrix

| Solver family | Device | Contract in this note | Evidence boundary |
|---|---|---|---|
| FEM | CPU | Native FEM Poisson solver policy and CPU host-thread setup are source-visible. The public policy default is CG/AMG; an omitted policy resolves to that default on the CPU lane. | This page documents source contracts and tests; it does not claim a new CPU runtime qualification. |
| FEM | GPU | The same explicit FEM policy is passed to native execution. If omitted, runtime resolution selects CG/JACOBI for the general strict GPU path and CG/AMG for `projected_gradient_bb`; explicit values are not rewritten. | [A separate 50 fs diagnostic observed coarse relaxation type 18 through the native getter](0913-fem-gpu-amg-coarse-residency.md). That narrow result does not qualify FEM CPU, all FEM GPU workloads, or full SP4. |
| FDM | CPU | Not applicable: `FemLinearSolverPolicy` belongs to FEM discretization hints; FDM uses its own demag solver surfaces. | No cross-backend fallback is implied. |
| FDM | GPU | Not applicable for the same reason; this policy does not configure FDM GPU demag. | No cross-backend fallback is implied. |

## 4. API, IR, and planner impact

(python-api)=
### 4.1 Python API surface

This contract lives in explicit FEM backend hints, not in the common `Demag`
physics term.

Canonical Python authoring surfaces:

- class-based:
  - `fm.FemLinearSolverPolicy(...)`
  - `fm.FEM(..., demag_solver_policy=...)`
- flat/study DSL:
  - `fm.fem_demag_solver(...)`
  - `study.fem_demag_solver(...)`

The public dataclass defaults and validation come from
`fullmag.model.discretization.FemLinearSolverPolicy`. Its six policy fields are
the complete authored solver policy:

| Python parameter | Type | Default | SI unit | Validation and rejection | Meaning | Backend support |
|---|---|---|---|---|---|---|
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `"CG"` | `1` | Must be `CG` or `GMRES`; other values raise `ValueError`. | Outer Krylov solver. | Native FEM CPU/GPU; selected tuple remains backend-validated. |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `"AMG"` | `1` | Must be `AMG`, `JACOBI`, or `NONE`; other values raise `ValueError`. | Preconditioner for the Poisson solve. | Native FEM CPU/GPU; selected tuple remains backend-validated. |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | `1` | Converts with `float`; the converted value must be finite and greater than zero, otherwise `ValueError`. Conversion can raise `TypeError`, `ValueError`, or `OverflowError`. The dataclass retains the original field value rather than coercing it. | Relative residual tolerance. | Native FEM CPU/GPU; `rtol` is dimensionless. |
| `FemLinearSolverPolicy.atol` | `float or None` | `None` | $\mathrm{A\,m}$ | `None` or converts with `float` to a finite value greater than zero; nonfinite/nonpositive values raise `ValueError`, conversion can raise `TypeError`, `ValueError`, or `OverflowError`. The dataclass retains the original value. | Optional absolute residual threshold for the unscaled Poisson system. | Native FEM CPU/GPU; backend applies it only when present and positive. |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | `1` | Only checks `< 1`; values below 1 raise `ValueError`, incomparable values raise `TypeError`. The annotation is not enforced; a non-int comparable value can pass and is serialized unchanged. The IR field is unsigned 32-bit. | Maximum outer solver iterations. | Native FEM CPU/GPU; IR representation uses an unsigned 32-bit field. |
| `FemLinearSolverPolicy.print_level` | `int` | `0` | `1` | Only checks `< 0`; negative values raise `ValueError`, incomparable values raise `TypeError`. The annotation is not enforced; a non-int comparable value can pass and is serialized unchanged. The IR field is unsigned 32-bit. | Native linear-solver diagnostic verbosity. | Native FEM CPU/GPU; IR representation uses an unsigned 32-bit field. |

The containing FEM hint is optional:

| Python parameter | Type | Default | SI unit | Validation and rejection | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy or None` | `None` | `1` | Type annotation is optional; constructor stores the value without an `isinstance` check, so a wrong non-None object raises `AttributeError` when `to_ir()` is called. | Explicit FEM Poisson solver request. | Native FEM CPU/GPU only; not an FDM setting. | `backend_policy.discretization_hints.fem.demag_solver_policy` |

The flat and study calls use the same six keyword names, types, defaults, and
validation as the dataclass. They construct the same policy and place it at the
same FEM `ProblemIR` destination; they do not create a second policy schema.

`fm.threads(cpu_threads)` and `study.threads(cpu_threads)` set a requested
thread count for the next run. The argument is converted with `int()` and the
result must be at least one. It is requested intent, not a promise that Rayon,
native FEM OpenMP, and the device host runtime will all use that same count.

CPU thread selection remains a runtime selection concern:

- `fm.threads(...)`
- `study.threads(...)`

(problem-ir)=
### 4.2 ProblemIR representation

- `FemHintsIR` carries optional `demag_solver_policy`
- `FemPlanIR.demag_solver_policy` is populated from canonical FEM hints
- session/runtime metadata expose:
  - requested CPU threads
  - resolved Rayon/control-plane threads
  - effective native FEM OpenMP threads when available

The Python-to-IR boundary is:

| Python surface | Canonical serialized value | ProblemIR / plan destination |
|---|---|---|
| `FemLinearSolverPolicy.to_ir()` | Mapping with `solver`, `preconditioner`, `rtol`, `max_iterations`, and `print_level`; includes `atol` only when non-`None`. | Policy fragment; not a complete `ProblemIR`. |
| `FEM.demag_solver_policy` | The `to_ir()` mapping nested under the FEM hint. | `backend_policy.discretization_hints.fem.demag_solver_policy` → `FemHintsIR.demag_solver_policy` → `FemPlanIR.demag_solver_policy` |
| `fm.fem_demag_solver(...)` / `study.fem_demag_solver(...)` | Same six fields and normalization as `FemLinearSolverPolicy`. | Same FEM hint path above. |
| `fm.threads(cpu_threads)` / `study.threads(cpu_threads)` | Requested count in runtime selection metadata. | `problem_meta.runtime_metadata.runtime_selection.cpu_threads`; runner provenance separately reports resolved CPU and observed native FEM OpenMP counts when available. |

Each policy field maps to the corresponding nested IR key:

| Python parameter | ProblemIR field |
|---|---|
| `FemLinearSolverPolicy.solver` | `backend_policy.discretization_hints.fem.demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `backend_policy.discretization_hints.fem.demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `backend_policy.discretization_hints.fem.demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `backend_policy.discretization_hints.fem.demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `backend_policy.discretization_hints.fem.demag_solver_policy.max_iterations` |
| `FemLinearSolverPolicy.print_level` | `backend_policy.discretization_hints.fem.demag_solver_policy.print_level` |

### 4.3 Planner and capability-matrix impact

- Planner propagates `FemHintsIR.demag_solver_policy` into executable FEM plans
- Unsupported native FEM solver/preconditioner combinations remain explicit
  planning/runtime errors
- Capability reporting remains public-executable for Poisson FEM demag

(round-trip-and-failure-semantics)=
### 4.4 Round-trip and failure semantics

The following copyable fragment constructs only the public policy object and
prints its canonical `to_ir()` value. It creates no problem, mesh, study, or
solver execution:

```python
# %% Import the public API
import fullmag as fm

# %% Construct one FEM Poisson solver policy
policy = fm.FemLinearSolverPolicy(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-8,
    atol=None,
    max_iterations=500,
    print_level=0,
)

# %% Inspect this object's canonical IR fragment; no solver is run
print(policy.to_ir())
```

The output is the actual policy fragment produced by the example above:

```json
{"solver": "CG", "preconditioner": "AMG", "rtol": 1e-08, "max_iterations": 500, "print_level": 0}
```

`atol=None` is omitted by `to_ir()`. A positive value is serialized under
`atol`; its unit is the unscaled system's A·m residual unit described above.
`FEM` nests the fragment under its FEM discretization hints. The Python
script-export path reconstructs the same policy call and the normal Python
validation runs again on reload.

Requested intent consists of the authored backend/device/precision/mode and
any explicitly authored policy fields. Resolved execution is selected later:
an explicit policy is preserved, while an omitted policy starts from the
public CG/AMG defaults and can resolve differently for strict FEM GPU. The
current native resolver uses CG/JACOBI for the general GPU path and CG/AMG for
`projected_gradient_bb`; this is runtime selection, not a change to Python
defaults. Runtime telemetry must identify the solver, preconditioner, and
observed solve state rather than inferring them from the request.

Validation errors are raised when the policy fields fail their Python domain
checks; typed planning or runtime errors reject unsupported combinations,
failed native setup, or a solve that fails the convergence contract. Unsupported
combinations do not fall back silently to FDM or another native FEM policy.
The fail-closed publication rule in section 5.1 also applies: a candidate field
is not current state until convergence and residual/iteration checks succeed.

### 4.5 Runtime thread selection and provenance

The requested study thread count is recorded separately from its resolved
control-pool allocation. Native FEM configures its OpenMP team when the native
context starts. Its requested and effective counts can differ from the runner's
Rayon/control-pool count; for automatic selection, native FEM can apply
mesh-aware CPU caps. The CPU auto count is the minimum of detected host
capacity, the positive external allocation ceiling in
`FULLMAG_NATIVE_THREADS_AUTO_RESOLVED` (or its legacy fallback), and the mesh
limit. Small contexts (at most 10,000 nodes or 75,000 elements) cap at 8
threads; medium contexts (at most 50,000 nodes or 400,000 elements) cap at 16;
larger contexts have no additional mesh cap. The external value is an
allocation ceiling and cannot bypass the mesh limit. Telemetry reports the
external-allocation reason when that ceiling is strictly tighter than both
detected capacity and the mesh limit, and reports the small/medium mesh reason
when the mesh limit is tighter. Explicit manual counts keep their existing
environment precedence and are not auto-capped. Automatic GPU host
initialization remains at one thread regardless of CPU allocation hints.
Native FEM disables dynamic and nested OpenMP teams. Thread-pool changes made
after a run starts do not retune that active run.

Runtime metadata records requested/resolved CPU counts. Requested/effective
native FEM OpenMP counts are filled from native step statistics when the lane
reports them; a missing observation remains unavailable rather than being
inferred from `fm.threads(...)`. The source-level CPU thread contract is tested
independently from the narrow GPU coarse-relaxation diagnostic linked above.

(implementation-mapping)=
### 4.6 Implementation mapping

The public class validates and serializes the policy. `FemHintsIR` carries the
optional value from the canonical `ProblemIR`; `FemPlanIR` carries it to the
runner. The native FEM policy resolver returns explicit values unchanged and
chooses backend/algorithm-dependent defaults only when the hint is omitted.
CPU and GPU Poisson implementations then configure their native solver and
validate solve results in their own lane. CPU thread requests likewise travel
through runtime selection, runner allocation/provenance, and native FEM OpenMP
initialization; those values are reported as separate requested, resolved, and
observed quantities.

## 5. Runtime/session/artifact/provenance impact

- Session/runtime views must preserve:
  - requested CPU threads,
  - resolved Rayon thread count,
  - requested/effective native FEM OpenMP threads when the native path reports them
- Native FEM Poisson demag provenance must not use FFT labels. In particular,
  `fft_backend` is reserved for FDM/tensor-FFT demag paths and must remain
  absent for FEM Poisson realizations.
- FEM Poisson demag runtime metadata must preserve the numerical solve policy
  and observed solve result:
  - solver and preconditioner,
  - relative tolerance,
  - maximum iterations,
  - number of Poisson solves performed for the reported step/snapshot,
  - actual iterations,
  - final residual,
  - boundary variant,
  - Robin beta policy when applicable.
- Native FEM runtime metadata must also report the resolved FEM operator
  assembly mode. Until exchange/mass/DMI move to partial assembly or
  matrix-free libCEED operators, the current native time-domain path must be
  labeled as `legacy_sparse` rather than presented as a production
  partial-assembly implementation.
- Script export and SceneDocument round-trip must preserve:
  - requested CPU threads,
  - FEM demag solver policy
- Logs and UI must not pretend that live thread-pool changes apply to an already
  running solve

### 5.1 Fail-closed linear-solve publication

Every production FEM demagnetization realization (non-periodic Poisson,
periodic reduced Poisson, strict CUDA Poisson, and Fredkin--Koehler FEM/BEM)
must treat the linear solve as an attempted result until convergence has been
validated. A candidate scalar potential may be published, cached, lifted,
recovered into `H_demag`, used in `H_eff`/energy, or exposed as an observable
only when all of the following hold:

- convergence is established by a concrete solver report or by an independent
  residual certificate; termination alone is insufficient,
- the reported residual is finite and non-negative,
- the reported residual satisfies the configured relative tolerance, or the
  solver explicitly reports convergence through the configured positive
  absolute tolerance,
- the iteration count is non-negative and does not exceed `max_iterations`.

An independent certificate must also satisfy the configured residual threshold
and iteration cap. The shared validator explicitly permits such a certificate
when HYPRE does not report convergence, including a valid zero-iteration
solution; it does not accept a small unverified reported value by itself.
Exhausting `max_iterations` without either convergence evidence is not
convergence. On failure, the runtime must
invalidate any warm-start/current marker for the attempted candidate and
return a typed diagnostic containing the demag solver realization, linear
solver kind, iteration count, residual, relative/absolute tolerance, and
maximum iterations. Last-attempt iteration/residual telemetry remains
available for diagnosis, but the failed field is never current solver state.

#### Independent GPU residual check and qualification boundary

At source revision `53a5d5171e06db3c4950511d4523f872f58317f1`, a reported
GPU CG success can skip the independent residual calculation. With a positive
`atol`, that path multiplies the reported relative residual by `||b||2`;
for preconditioned CG this is not generally `||Ax-b||2`. This historical
validation gap does not by itself establish an error in the retained SP4 fields.

The corrected path computes `||Ax-b||2` and `||b||2` on the GPU after every
device-HYPRE Poisson solve, before publishing its candidate field, irrespective
of HYPRE's success report. It preserves authored tolerances, the iteration cap,
the internal CG norm choice, and the existing shared acceptance rule. Only two
scalar norms return to the host; full vectors stay on the device for this check.

The paired-readback optimization keeps the same independently formed residual
and scaled Euclidean norms. For at least two local rows,
`fullmag_cuda_demag_validation_norm_pair` reduces both inputs before reusing
the first two entries of the private residual scratch, then returns two doubles
in one readback and stream fence. A one-row problem retains the single-norm
device implementation. The RHS diagnosis still precedes the residual diagnosis
for nonfinite inputs. This changes neither the stopping tolerance nor the
physical operator. The managed `fem-demag-poisson` native contract passed at
attempt `c1321d9442c641bd910f25b1b67a4a0e`, source snapshot
`49e15a11671533dd16b06b2ce09ee838630427abc4523affa484edf5e621cae0`, and
library `c078a75a57a5655c1f0fbd9965c52745711f1fb6771de8c99f97e23d7053e785`
(compile 13.122 s, test 5.200 s, exit 0). The gate includes the paired-norm
regression, true-residual corruption check, accepted-energy overlay, and queue
property fixtures. It does not establish SP4 timing or parity; the historical
evidence below qualifies the earlier two-readback implementation only.

The native regression starts with a real successful GPU CG solve, zeros only
the test-owned potential after its final use, and requires the production
validator to reject that potential despite the stale success report. Managed
RED compiled successfully and failed at that assertion on the old path. Managed
GREEN passed `fem-demag-poisson`, emitted
`gpu_independent_residual_corruption_rejected rows=8 residual=1`, and retained
the packed-field GPU runtime check. The mixed-P1 audit requires exactly four
scalar readbacks (32 bytes) across two solves and excludes full-vector hot-loop
transfers.

This native proof is scoped to source snapshot
`53ca91e871dea24376153412b2dbe7c8b7e70647e20cc71db5887893c45cc8ea`,
FEM library `62a74c4969ac6d6e0971e9d4eacd3c4c7ab4e146e8c48aaa2d5cedb1e5778f59`,
and contract attempt `0b53c886a43f4bd5a60b925fdcee754f` (compile/test exit 0).
The subsequent strict-GPU SP4 OFF probe completed seven accepted steps to
50 fs with full Zarr. All 15 table columns and both frames of all four fields
were bitwise equal to the earlier packed-field OFF result; accepted time,
time step, and iteration counts were unchanged. Independently certified
relative residuals were between `2.16e-13` and `2.86e-13`, within the authored
`1e-12` bound. Run `run-live-05242fe02997994db4f8b2ba8b37b716d1ae553a4f475a238a3fd63bc6993923`
is pinned by report SHA-256
`1824aec5a08a0aa5cf05a22608c45fd532ee9f4b385d844cbade2c897ccb8ebf`.
Its single OFF solver timing was 4.211 s versus the earlier 3.836 s; neither
this difference nor a total speedup is qualified by repeated timing. Full
1 ns SP4, MuMax3 GPU parity, and a corrected-source CUPTI ON/OFF pair remain
separate qualification gates.

(validation)=
## 6. Validation strategy

### 6.1 Analytical checks

- No new physical observable is introduced; solver policy changes must preserve
  validated demag behavior for canonical benchmarks.

### 6.2 Cross-backend checks

- FEM default policy must match prior default native execution behavior
- Explicit non-default policies must serialize and lower reproducibly

### 6.3 Regression tests

- Python:
  - `FemLinearSolverPolicy.to_ir()`
  - `FEM(..., demag_solver_policy=...)` serialization
  - flat/study script export and re-import preserve the policy
- Planner:
  - `FemHintsIR.demag_solver_policy -> FemPlanIR.demag_solver_policy`
- Frontend:
  - requested vs resolved CPU-thread display stays typed and round-trippable

## 7. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [x] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

(limitations)=
## 8. Known limits and deferred work

- Independent GPU certification passed the native RED/GREEN contract in
  section 5.1 and its seven-step full-Zarr probe. Full 1 ns SP4 qualification
  with that correction remains pending;
  historical stored field/energy/torque parity does not qualify the new path.
- Live mid-run thread-pool retuning is still unsupported.
- Native FEM currently reports OpenMP thread resolution through runtime/log
  diagnostics and FFI step stats; richer direct UI telemetry can replace
  artifact-derived display in a later pass.
- This contract does not yet expose separate linear-solver policies for future
  FEM mechanics or eigen operators.

Update 2026-05-15: native FEM CPU now carries `atol` and `print_level` across
the C ABI and uses them when configuring the non-PBC Hypre AMG/CG/GMRES Poisson
demag solve. Benchmark entrypoints can now set demag solver, preconditioner,
`rtol`, optional `atol`, `max_iterations`, and Hypre `print_level` without
editing scripts, and `metadata.json` / CSV rows preserve the requested policy.

Update 2026-05-15 non-PBC hot path: the native FEM Poisson path now keeps a
context-owned true-DOF solution vector for non-PBC demag and skips repeated
`GridFunction::GetTrueDofs` warm-start extraction once the persistent Hypre
solution vector is valid. This preserves the same Poisson equation, BCs,
solver policy, and recovered `H_demag`; it only removes allocation/copy churn
from adaptive RK demag solves.

Update 2026-05-15 benchmark validation: the FEM benchmark harness can now
require demag convergence telemetry and fail rows whose final residual norm or
actual iteration count exceed explicit thresholds. This is a validation gate
for solver-policy tuning; it does not change the public physics contract.

Update 2026-05-15 policy sweeps: the FEM benchmark harness can now sweep
multiple demag solvers and preconditioners in one run. The sweep expands only
for demag scenarios, so non-demag baselines are not duplicated by irrelevant
Poisson policy settings.

Update 2026-05-15/2026-06-05 policy selection: the benchmark harness can emit a
best-policy summary for each logical demag case, selecting the fastest completed
row that satisfies the configured convergence residual and iteration gates.
Selection uses an explicit metric configured by
`--best-demag-policy-metric` / `FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC`; the
managed production and demag-performance recipes default it to
`demag_solver_apply_wall_time_ms` because the current runtime bottleneck is the
single Hypre apply. Broader `demag_wall_time_ms` remains available for total
demag-policy comparisons. Runtime policy changes must still be made explicitly
in the runner and reflected in provenance.

Update 2026-06-05 GPU control-readback budget: the production FEM relaxation
benchmark now gates FEM GPU hot-loop control-scalar readbacks separately from
compute host/device transfers. Strict GPU RK still requires zero compute
readbacks; direct minimizers (`projected_gradient_bb`, `nonlinear_cg`) are
temporarily allowed a bounded control-readback budget until their line-search
and curvature decisions move fully device-side. This is a performance
regression gate only; it does not change solver physics, units, demag boundary
conditions, or CPU/GPU parity tolerances.

Update 2026-06-05 algorithm-specific control budgets: the production gate now
uses algorithm-specific per-step limits instead of only the global fallback:
`llg_overdamped = 0`, `projected_gradient_bb = 4`, and `nonlinear_cg = 3`.
This prevents projected-gradient BB from regressing up to the looser nonlinear
CG budget while preserving the current verified direct-minimizer behavior.
Nonlinear CG reaches the same per-step budget by batching current energy,
tangent-gradient norm, direction-gradient dot product, and direction norm into
one control readback on the common descent-direction path.
When the existing nonlinear-CG direction is non-descent, the GPU reset fallback
now keeps the reset itself device-side and reuses the already-read tangent
gradient norm: after setting `p = -g`, `p·g = -||g||²` and `||p||² = ||g||²`.
This removes the extra reset-direction scalar readback without changing the
Armijo condition, PR+ update, tangent projection, or metric definition.
The accepted-step nonlinear-CG PR+ numerator and accepted tangent-gradient norm
now stay in reserved scalar-result tail slots until the existing final stats
control readback. The next direction beta is computed from those reduced values
on the GPU, then the same final control readback validates the accepted
gradient norm and PR+ numerator on the host. This removes the standalone
accepted-gradient/PR+ synchronization without dropping the rollback checks.

Update 2026-07-10 cumulative line-search accounting: the four PG-BB control
phases per accepted step are the batched current energy/gradient metrics, the
first Armijo trial energy, accepted BB curvature, and final observable stats.
The three nonlinear-CG phases are the batched current energy/gradient/direction
metrics, the first Armijo trial energy, and the accepted final-stats/PR+ batch.
Every further Armijo trial adds exactly one energy-scalar synchronization. The
benchmark therefore publishes `total_rhs_evals`, the sum over all returned step
records, without changing the existing last-step `rhs_evals` field name. For
direct minimizers these are logical evaluation records rather than a claim that
cached endpoint fields were physically recomputed: every executed step records
one current state and its first trial, then one record for every additional
normal or forced-recovery Armijo trial and every refinement RHS evaluation. An
ordinary step without forced recovery therefore reports `2 + backtracks`; a
forced-recovery trial is counted even when it does not increment the rejected
backtrack counter. Their exact gate is

`base + per_step * executed_steps + max(0, total_rhs_evals - 2 * executed_steps)`.

This uses executed work rather than the last step's rejection count. Missing
cumulative telemetry fails closed when the production control-readback gate is
requested; old benchmark payloads remain readable when that gate is not used.
When nonlinear-CG enters forced Armijo recovery, the CUDA direction kernel
writes the exact restart `p = -g`. The host therefore reuses the already
validated `p dot g = -||g||_E^2` and `||p||_V^2 = ||g||_V^2` scalars instead of
re-reducing and synchronizing them. This keeps each additional recovery trial
represented by its energy evaluation in `total_rhs_evals`.

Update 2026-07-23 canonical nonlinear-CG three-sync accounting: each accepted
step has three control-scalar host synchronizations: the current
energy/gradient/direction batch, the first direct Armijo energy batch, and the
accepted final-stats/PR+ batch. Trial effective-field and final energy-term
computation remains device-side; nonlinear-CG takes the trial total energy from
`GpuDirectArmijoResult::trial_snapshot` instead of performing a separate total
energy readback before the Armijo batch. Each Armijo trial after the first adds
exactly one synchronization, including forced-restart recovery trials. The
matching `rhs_evals` telemetry publishes two nominal logical records per
executed step even when the accepted current endpoint is reused, plus exactly
one record for every additional normal or recovery trial. The exact cumulative
limit is therefore

`initial_syncs + 3 * executed_steps + max(0, total_rhs_evals - 2 * executed_steps)`.

No separate direction-recovery allowance is part of this budget. This changes
only control-readback accounting and diagnostic reuse; fresh-zero demag,
direct-energy refinement, finite checks, rollback, PR+, energy definitions,
and accepted trajectories retain their existing contracts.

Update 2026-07-23 canonical PG-BB four-sync accounting: each accepted PG-BB
step has four baseline control-scalar host synchronizations. The first is one
packed `GpuPgbbCurrentMetrics` readback containing the current energy-term
snapshot, volume-metric tangent-gradient norm, energy-metric projected-gradient
norm, and device-produced finite/nonnegative flags. The second is the direct
Armijo difference batch, which also owns the trial energy snapshot; PG-BB does
not read a standalone trial total before this batch. Accepted BB curvature is
the third synchronization and final observable statistics are the fourth.
Every Armijo trial after the first adds exactly one direct-difference batch.
The benchmark script owns this formula once for both direct minimizers:

`initial_syncs + per_step * executed_steps + max(0, total_rhs_evals - 2 * executed_steps)`,

with `per_step = 4` for PG-BB and `per_step = 3` for nonlinear-CG. PG-BB
`rhs_evals` uses the same logical-record semantics: one current record, every
normal Armijo trial exactly once, and any direct-energy refinement evaluations
additively. The packed readback and trial-snapshot reuse do not change Armijo,
BB1/BB2 reset policy, fresh-zero demag, rollback, energy monotonicity, ABI, or
opt-in profiler ownership.

Update 2026-11-10 accepted-field reuse candidates (runtime unqualified):
`gpu_relax_pgbb_field_reuse_key` and CPU `take_pgbb_accepted_stats` qualify
single-use reuse of an already certified static endpoint. The GPU candidate
starts with Poisson, exchange and constant Zeeman; the CPU candidate is limited
to static Robin Poisson and exchange. Other source families, projections,
refined-Armijo endpoints and pending torque confirmations retain fresh
evaluation. Ordinary physical solve counts can decrease while logical RHS
record semantics remain unchanged. Source tests do not establish trajectory
parity or a performance improvement; both require managed full-Zarr runs.

The CPU direct-minimizer profile also accumulates linear iterations from each
sample (current field, rejected/accepted trial and explicit refinement) before
publishing the accepted row. Its accepted-field cache contributes zero physical
iterations on reuse. The bounded ABI counter saturates rather than wrapping;
the residual continues to describe the accepted endpoint certificate. This
does not turn the Poisson runtime's last-solve diagnostic into a lifetime work
counter. The managed regression is
`relaxation_profile_accumulates_all_trial_iterations`; execution is pending.

Native CPU/GPU Poisson and FEM/BEM reporting now also uses a separate
`linear_iterations_current_step` aggregate, alongside `solves_current_step`.
Only successful, certified and recovered evaluations contribute; FEM/BEM adds
both sparse systems. Reset, observation and rollback boundaries follow the
existing solve counter. `last_iterations` and the reported residual retain
their last-evaluation meaning. The aggregate is not a lifetime counter and
does not include failed certification or recovery. Source-level numeric and
rollback regressions are present; managed execution remains pending.

The published `985df3521e2f5eb3c17588007cfc604203dfbf8e` package exposed a
separate CPU execution defect: its Fullmag shared library had no OpenMP runtime
imports and retained the `std::thread::hardware_concurrency` branch, although
the selected MFEM and HYPRE libraries used OpenMP. MFEM's imported target linked
the OpenMP runtime without propagating its C++ compilation flag. The build
owner is `backends/fem/CMakeLists.txt`. When the
selected MFEM configuration declares OpenMP, Fullmag must explicitly compile
and link its C++ target with the matching CMake OpenMP target. This enables
Fullmag's existing parallel regions and runtime setters; it introduces no new
thread-count, wait or binding default. Parallel reductions can change rounding,
so same-input energy/torque parity and a one-build thread matrix remain required.
The former package's environment could still constrain MFEM/HYPRE threads;
missing Fullmag flags are not proof that dependency thread teams were uncapped.

Enabling OpenMP also requires respecting the selected provider's scratch
ownership. The inspected MFEM providers have `MFEM_THREAD_SAFE` disabled:
finite-element evaluators and the integration-rule cache may mutate shared
buffers. `mfem_shared_element_evaluation_parallel_safe` therefore permits
element-level parallelism only when Fullmag OpenMP, MFEM OpenMP and MFEM thread
safety are all enabled. Nodal array normalization and independent energy
reductions retain their separate parallel paths. DMI uses caller-owned
transformations and prepared integration rules; geometry with `Mesh.Nodes`
retains a serial element path until its evaluator ownership is qualified.
Requests for 1, 2 and 4 threads on this provider qualify that serial safety
guard and numerical parity, not parallel finite-element throughput. No physical
operator, quadrature order, solver tolerance or CPU/GPU lane is changed.

The required five-repeat production preset on 2026-07-23 produced 110 rows:
95 completed and 15 failed before a benchmark result. Every one of the 50
completed GPU PG-BB rows satisfied the canonical bound with a margin of three
syncs; representative cumulative records were 32 steps / 71 RHS / 135 syncs
(bound 138), 32 / 91 / 155 (bound 158), and 32 / 64 / 128 (bound 131).
The preset did not provide complete CPU/GPU-consistency evidence because CPU
exchange-only and CPU exchange-plus-uniaxial, and GPU exchange-plus-Zeeman,
each exhausted their unchanged PG-BB Armijo search in all five repeats. A
one-repeat comparison against the immutable pre-Task-8 managed runtime
reproduced the same three failure classes. In particular, GPU Zeeman failed
both before and after Task 8 with finite current metrics and a positive direct
energy increment after 20 backtracks, not through the new finite-flag check.
Consequently the four-sync implementation is production-executed for the 50
completed GPU rows, but the full preset remains unvalidated until those
pre-existing Armijo cases are qualified separately. The Task 8 constraint to
preserve Armijo, BB, and restart semantics forbids treating a tolerance or
fixture change as part of this synchronization remediation.

Update 2026-07-23 direct-increment remediation decision: the failed cases were
traced to cancellation-prone endpoint-energy composition, not to a need for a
looser line search. CPU exchange receives a polarized direct discrete
increment, while CUDA classifies each final energy slot exactly once as direct
or explicit endpoint residual. Residual uncertainty is derived from endpoint
operand magnitudes. The strict Armijo inequality and four-sync PG-BB contract
remain unchanged. The full preset must be rerun against an identity-pinned
final native library; the earlier 95/110 artifact is diagnostic evidence only,
not final qualification.

Update 2026-06-05 direct-minimizer effective-field path: GPU
`projected_gradient_bb` and `nonlinear_cg` now call the device-resident
effective-field pipeline directly instead of the full RK RHS helper. This
preserves exchange, DMI, demag, local-field, and `H_eff` accumulation semantics
while skipping the LLG RHS kernel that direct minimizers do not consume. With
native phase timing enabled, exchange and demag remain attributable; `RHS
total` may remain zero for these minimizers because no LLG RHS is evaluated.
The phase-profiling env gate is refreshed during GPU RK preflight and tears
down event pools when disabled, so ordinary disabled runs do not retain timing
events and direct-minimizer runs can enable/disable profiling without rebuilding
the runtime.

Update 2026-07-20 GPU demag stream boundary: the managed HYPRE 3.1.0 runtime
exposes the exact compute stream as
`hypre_HandleComputeStream(hypre_handle())`. Strict FEM GPU demag records a
Fullmag-ready event on the Fullmag compute stream, makes that exact HYPRE
stream wait, records HYPRE-done on the HYPRE stream after `Mult`, and makes the
Fullmag stream wait before recovery and energy reduction. Ordering through the
legacy/default stream or a device-wide synchronization is not proof of this
contract and is forbidden in strict GPU mode.

The compatible Poisson matrix, Krylov object, and AMG hierarchy are set up once
per demag workspace. A fresh magnetization RHS resets the solution vector to
zero but does not recreate the solver or preconditioner. Matrix topology,
boundary realization, solver/preconditioner policy, tolerance, AMG settings,
device, or workspace changes invalidate the setup and rebuild it explicitly.
Profiler setup time therefore reports real rebuild work rather than a
hard-coded zero.

Current native GPU setup requires the shared process-wide HYPRE device policy.
Its sole owner enables device memory/execution and vendor SpTrans, SpMV, and
SpGEMM through checked setters, retaining the first failure. Availability requires
all flags and successful configuration. The owner attempts configuration once
under a mutex and shares the resulting snapshot with its native GPU consumers;
it is not a per-solver switch that can be changed after matrix setup. This policy
does not change the Poisson weak form, boundary condition, tolerance, or residual
contract, and setter success alone does not qualify whole-execution GPU residency.

Update 2026-05-15 readiness preset: the benchmark harness exposes
`--fem-cpu-no-pbc-adaptive-ready-preset` as a shorthand for the existing FEM CPU
no-PBC adaptive exchange+demag+anisotropy readiness sweep and gates. The preset
runs both `exchange_demag_anis_uniaxial` and `exchange_demag_anis_cubic` under
RK23 and RK45 with thread-count tokens `1`, `physical_cores/2`,
`physical_cores`, and `auto` under the same adaptive CPU gate. It does not
change solver physics or runtime defaults.
The readiness gate now also checks requested mesh/scenario/integrator/thread
coverage, so a partial CSV cannot pass the preset when one of the requested
meshes, phase-10 anisotropy cases, adaptive integrators, or thread-count cases
is missing.
Every benchmark run emits a `FEM_PASS_FAIL_SUMMARY` JSON line grouped by
`solver_mesh_signature`, including row counts, pass/fail status, demag residual
and iteration maxima, thread-count coverage, and gate failure counts. This makes
the phase-10 CSV inspectable without inferring pass/fail from process exit alone.
When supplied with `--accepted-baseline`, the harness compares matching
`solver_mesh_signature` benchmark cases against the last accepted CSV and fails
rows whose wall-clock or demag timing metrics regress beyond the configured
percentage threshold, defaulting to 10%.

Update 2026-05-15 phase-10 scenario matrix: benchmark naming now distinguishes
uniaxial and cubic anisotropy cases explicitly:
`exchange_anis_uniaxial`, `exchange_anis_cubic`,
`exchange_demag_anis_uniaxial`, and `exchange_demag_anis_cubic`. These names
select existing material anisotropy parameters for qualification runs and keep
`exchange_demag_anisotropy` as a compatibility alias.

Update 2026-05-15 qualification artifacts: `metadata.json` now carries a
`fem_cpu_relaxation_qualification` block for native FEM CPU runs. It records the
qualified physics terms, solver mesh signature, demag policy, assembly mode,
relaxation algorithm, stop reason, final energy terms, final torque, norm
defect, executed steps, and benchmark gate version so downstream tooling does
not need to infer these values from logs.
`--require-best-demag-policy` turns missing converged policy summaries into a
benchmark failure, so Hypre/AMG tuning sweeps cannot silently produce no
actionable policy. It requires at least two converged policy candidates per
logical case before a "best" policy can be selected; a single successful row is
only a smoke proof, not a policy optimization result. If all candidate rows
fail before convergence telemetry is available, the missing-policy error
includes their `error_kind` values.

Update 2026-06-05 production benchmark policy gate: the managed
`verify-fem-relaxation-production-benchmark` recipe passes
`FULLMAG_BENCH_DEMAG_SOLVERS` and `FULLMAG_BENCH_DEMAG_PRECONDITIONERS` into
the FEM GPU container. Its default policy matrix compares `CG/AMG` and
`CG/JACOBI` and runs with `--require-best-demag-policy`, so the production
benchmark cannot pass demag qualification from a single converged policy row.

Update 2026-06-05 GPU phase timing benchmark gate: when
`FULLMAG_FEM_STEP_PROFILE=1`, the managed
`verify-fem-relaxation-production-benchmark` recipe now passes
`--require-gpu-phase-timings`. Executed `fem_gpu` rows must report positive
`exchange_wall_time_ms`; LLG rows must also report positive `rhs_wall_time_ms`;
and rows using strict GPU Poisson demag must report positive
`demag_wall_time_ms`. Direct minimizers intentionally skip the LLG RHS kernel,
so their `rhs_wall_time_ms == 0` remains valid when exchange and demag phase
timings are present.

Update 2026-06-05 pinned scalar readback staging: GPU RK and relaxation scalar
readbacks now copy device scalar slots into a preallocated pinned host staging
buffer owned by the CUDA reductions workspace before publishing values to the
caller. This does not remove the required host wait for RK/adaptive/Armijo
control decisions, but it removes pageable host destinations from the scalar
D2H path and keeps the transfer-audit accounting unchanged.

Update 2026-08-03 pinned-host allocation fallback: the pinned scalar staging
buffer remains the primary GPU readback path. If the CUDA driver rejects only
the 256-byte `cudaHostAlloc` request with `cudaErrorMemoryAllocation`, the
reductions workspace binds the same fixed 32-slot host array as a pageable
fallback and emits an explicit runtime warning. Scalar copies still use
`cudaMemcpyAsync` followed by the existing stream synchronization, so the
device result, precision, ordering, transfer-audit byte counts, and all
demag/RK control decisions are unchanged; only overlap between copy and host
execution may be lost. Any other CUDA allocation error remains fatal. The
fallback is therefore a resource-degraded transfer realization, never a demag
solver or physics fallback, and it must be reported as such in runtime logs.
For deterministic managed qualification, the CUDA-only test hook
`FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1` selects the same branch without
spoofing a solver result; it is unset in production and is not a capability
fallback. The executable contract verifies allocation, asynchronous device to
host copy, synchronization, numerical value preservation, and cleanup without
calling `cudaFreeHost` on the pageable array. Readback diagnostics therefore
refer to generic scalar host staging, not exclusively to pinned memory.

Update 2026-06-05 solver-mesh size gate: the managed production relaxation
benchmark now requires completed rows to report at least
`FULLMAG_BENCH_MIN_SOLVER_NODES` solver nodes. The default managed threshold is
50 nodes, which is a smoke-floor guard against trivial mesh regressions, not a
claim that the benchmark covers production-scale GPU performance. Larger
performance qualification runs should raise this environment variable together
with tighter `FULLMAG_BENCH_DOMAIN_HMAX` / `FULLMAG_BENCH_AIRBOX_HMAX`.

Update 2026-06-05 demag performance gate: strict FEM GPU Poisson demag now has
an opt-in managed performance recipe,
`just verify-fem-gpu-demag-performance-benchmark`. It narrows the sweep to
demag-bearing Box500 airbox cases, enables native GPU phase timing by default,
uses tighter default mesh targets (`FULLMAG_BENCH_DOMAIN_HMAX=50e-9`,
`FULLMAG_BENCH_AIRBOX_HMAX=100e-9`), and requires at least
`FULLMAG_BENCH_MIN_SOLVER_NODES=800`. It also requires the completed demag
CPU/GPU pairs to reach `FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP=2` on full
`demag_wall_time_ms`, not only on the narrower
`demag_solver_apply_wall_time_ms` phase. The recipe accepts
`FULLMAG_BENCH_ACCEPTED_BASELINE` and
`FULLMAG_BENCH_REQUIRE_ACCEPTED_BASELINE=1` for regression-qualified runs. The
recipe runs one unrecorded FEM GPU warmup case before measured rows, so CUDA and
Hypre cold-start cost does not contaminate first-policy timing comparisons. The
standard production relaxation benchmark remains the broader correctness and
contract smoke; this demag recipe is the preferred gate before claiming GPU
Poisson demag performance progress.

Update 2026-06-14 setup-reuse gate: the production and demag-performance
benchmark recipes now pass `--require-demag-setup-reused`. Multi-step demag rows
must report `demag_solver_setup_reused=true`; missing telemetry or repeated
setup is a benchmark failure. This is a runtime performance contract only. It
does not change the demag weak form, solver residual tolerance, boundary model,
or accepted physical observables.

Update 2026-06-14 BoomerAMG profile sweeps: native CPU and strict GPU Poisson
demag setup now read benchmark/runtime environment overrides for the Hypre
BoomerAMG profile:
`FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE`,
`FULLMAG_FEM_DEMAG_AMG_COARSENING`,
`FULLMAG_FEM_DEMAG_AMG_INTERPOLATION`, and
`FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING`. Optional expert overrides
`FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD` and
`FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS` are applied only when set; otherwise MFEM /
Hypre defaults are preserved. When unset, the core profile remains the current
`18/8/6/1` configuration. The benchmark harness exposes comma-list sweeps
through `FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES`,
`FULLMAG_BENCH_DEMAG_AMG_COARSENINGS`,
`FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS`, and
`FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS`, plus optional
`FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS` and
`FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS`; best-policy grouping includes these
profile fields so tuning cannot merge different AMG configurations. This
changes only the linear-solver preconditioner profile used to reach the same
configured residual tolerance.
`just bench-fem-gpu-demag-amg-profile-sweep` is the exploratory managed-runtime
entrypoint for these BoomerAMG profile sweeps. It emits CSV, JSON, Markdown, and
best-policy rows without requiring every candidate profile to pass the
production convergence/best-policy gates. Use the stricter
`just verify-fem-gpu-demag-performance-benchmark` before claiming a production
demag performance improvement.

Update 2026-06-05 strict GPU resolved default: the runner now resolves an
omitted strict native FEM GPU Poisson demag solver policy to `CG/JACOBI`.
Managed demag performance qualification on the 258-node Box500 airbox smoke
showed the warmed strict GPU `CG/JACOBI` path materially faster than `CG/AMG`
for the current qualification scale while preserving convergence gates. This
does not change the public Python/IR default and does not override explicit
authoring choices; runtime logs, provenance, and demag metadata must report the
resolved policy actually used by the native solver.
The dedicated demag performance recipe now includes an `OMIT` policy sentinel
alongside explicit `AMG` and `JACOBI` rows, so the benchmark protects the
runtime-resolved default path instead of only explicit solver-policy authoring.

Update 2026-06-14 PGBB strict GPU resolved default: the runner now resolves an
omitted strict native FEM GPU Poisson demag solver policy to `CG/AMG` when the
active relaxation algorithm is `projected_gradient_bb`. A managed PGBB
demag-policy smoke on the Box500 airbox case completed `CG/AMG` and
`CG/JACOBI` rows and showed strict GPU `CG/AMG` with lower apply time and fewer
iterations for that direct-minimizer path. This does not change explicit user
policies and does not change the non-PGBB strict GPU fallback documented above.
The managed `OMIT` smoke after rebuilding the runtime bundle confirms that an
omitted PGBB demag policy now reports resolved `AMG` in runtime metadata for
both CPU and strict GPU rows.

Update 2026-05-15 recovery scratch: non-PBC Poisson demag recovery now keeps
serial and per-thread element scratch buffers in the context-owned recovery
workspace. This removes repeated MFEM element scratch construction during
adaptive RK demag recovery while preserving the same gradient recovery,
magnetic-node zeroing, and energy evaluation.

Update 2026-05-15 Robin energy scratch: the Robin boundary-energy correction
now reuses a context-owned boundary temporary vector from the demag recovery
workspace instead of constructing it for every recovery call. The boundary
energy formula and cached frozen-field correction are unchanged.

Update 2026-05-15 essential-DOF zeroing: non-PBC Poisson demag now zeros
essential true DOFs by iterating the context-owned `poisson_ess_tdof_list`
directly instead of constructing an `mfem::Array` wrapper in the solve hot
path. The eliminated operator and boundary condition semantics are unchanged.

Update 2026-05-15 RHS coefficient scratch: the Poisson RHS magnetization
coefficient now reuses thread-local DOF and shape scratch during coefficient
evaluation. This removes repeated element scratch construction during RHS
assembly while preserving the same `M_s m` interpolation on magnetic elements
and zero contribution on air elements.

Update 2026-05-15 FSAL field publish: accepted RK23/RK45 FSAL steps now publish
the cached final `H_ex`, `H_demag`, and `H_eff` buffers by swapping the stepper
workspace buffers into the context instead of copying full field arrays. This
preserves the same accepted state and final field values; it only removes an
O(N) copy from the adaptive RK accept path.

Update 2026-11-10 adaptive retry candidate (runtime unqualified): after the GPU
transaction restores the accepted magnetization, time and stage-zero derivative,
`gpu_rk_retain_restored_fsal_on_retry` preserves an already valid derivative
under `gpu_rk_rhs_allows_fsal_reuse`. It never promotes an invalid derivative.
Brown thermal noise, callback-driven sources, frozen spins and periodic reduced
nodes continue to disable reuse. Derived-field endpoint tokens remain invalid;
Poisson still requires a fresh initial guess for every executed fresh solve.
This changes neither the adaptive error criterion nor authored tolerances.
The CUDA guard contract exercises checkpoint derivative preservation and
stochastic rejection. Rejected-step runtime parity and performance qualification
for the supported explicit integrators remain required before promotion.

Update 2026-05-15 non-FSAL final refresh: Heun/RK4 final effective-field refresh
now reuses the same stepper field workspace and swaps the final buffers into the
context. The post-step `max_dm_dt` RHS also reuses a stage derivative buffer
instead of constructing a local full-size RHS vector. This preserves the final
field refresh and reported RHS count while removing per-step buffer churn from
the non-FSAL explicit-RK path.

Update 2026-05-15 disabled local terms: interfacial DMI, cubic anisotropy, and
bulk DMI observable buffers are now zero-initialized once during context setup
when those terms are absent. The effective-field hot path no longer clears those
full-size buffers on every `exchange + demag + uniaxial anisotropy` evaluation.
Readback still sees zero fields for disabled terms; active terms still overwrite
their buffers during evaluation.

Update 2026-05-15 active buffer pre-zeroing: active exchange/demag output
buffers now use size-only `resize` before evaluator calls, and `H_eff` uses
`resize` because it is overwritten component-wise after all terms are assembled.
The disabled exchange/demag fallbacks still produce explicit zero fields. This
removes another full-buffer clear from each adaptive RHS evaluation without
changing published fields or energies.

Update 2026-05-15 demag frozen-cache copy: fresh Poisson demag solves now copy
`H_demag` into the frozen-field cache only when `field_refresh.demag_interval_s`
is active. Default time-domain relaxation refreshes demag every RHS evaluation,
so the frozen cache is unused there and no longer pays a full-field copy per
solve. Runs that explicitly enable frozen-field refresh keep the same cached
field and Robin-boundary energy semantics.

Update 2026-05-15 FEM CPU no-PBC adaptive gate: the benchmark harness now has a
`--require-fem-cpu-no-pbc-adaptive-ready` gate for the targeted release slice:
`fem_cpu`, `exchange_demag_anis_uniaxial` and `exchange_demag_anis_cubic`
(with `exchange_demag_anisotropy` as a compatibility alias), RK23/RK45
adaptive stepping, double
precision, zero periodic mesh pairs, at least 100 executed steps unless the
stage stopped by torque tolerance, positive adaptive-step/demag-solve counts,
Poisson-airbox demag with Robin boundary conditions, shared-domain mesh with
air, completion of the requested benchmark step count, final exchange/demag/
anisotropy energies for the active terms, demag convergence telemetry, and
assemble/solve/setup/apply/recover/energy timings. The gate
requires the reported benchmark payload to confirm the same scenario,
integrator family, and adaptive timestep policy; it also requires runtime
provenance to confirm `execution_engine=fem_cpu_native`, `cpu_native`,
`mfem_device=cpu`, host-source-of-truth data residency, and no CUDA kernels or
GPU Poisson.
For multi-step readiness runs, the final row must also confirm demag solver
setup reuse, because a warmed Hypre/AMG setup is part of the optimized CPU
no-PBC path rather than optional telemetry.
The readiness gate rejects positive `demag_refresh_interval_s`, because this
targeted benchmark must measure the normal Poisson demag evaluation path rather
than a frozen demag cache policy.
Benchmark payloads that expose the final anisotropy energy as `e_ani` are
normalized into the gate's `final_e_ani_j` row field. This is a validation gate
for small and medium no-PBC CPU runs, not a claim that the bootstrap
`llg_overdamped` relaxation is a final FE-metric tangent-plane minimizer.
Benchmark failures whose stderr/stdout contains MPI initialization or PMIx
startup errors are classified as `error_kind=mpi_init_or_pmix_startup` in the
CSV so sandbox/runtime-launcher failures are distinguishable from demag
convergence failures. Gate failure messages include the same `error_kind` when
the row failed before convergence/readiness checks could inspect solver
telemetry.

## 9. References

- `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`

(scientific-bibliography)=
### Scientific bibliography

- L. Exl and T. Schrefl, “Non-uniform FFT for the finite element computation
  of the micromagnetic scalar potential,” *Journal of Computational Physics*,
  270 (2014), 490–505. [doi:10.1016/j.jcp.2014.04.013](https://doi.org/10.1016/j.jcp.2014.04.013).
  The paper states the scalar-potential stray-field equation and describes a
  P1 finite-element realization; this page does not claim that its open-boundary
  method is the boundary implementation used by every Fullmag lane.
- V. E. Henson and U. M. Yang, “BoomerAMG: A Parallel Algebraic Multigrid
  Solver and Preconditioner,” *Applied Numerical Mathematics*, 41(1) (2002),
  155–177. [doi:10.1016/S0168-9274(01)00115-5](https://doi.org/10.1016/S0168-9274(01)00115-5).
  This is background for the AMG option; it does not qualify a particular
  Fullmag CPU or GPU runtime.

- [Pinned MFEM HyprePCG default options](https://github.com/mfem/mfem/blob/d964264cdb9a13e94a201b6c236c7721e0c8765f/linalg/hypre.cpp#L3958) and [pinned HYPRE PCG stopping rule](https://github.com/hypre-space/hypre/blob/9dc9e18aed6a945a95f966e57daacfb1c269f6ec/src/krylov/pcg.c#L390) support the distinction between internal and independently checked norms; [GMRES uses the Euclidean norm](https://github.com/hypre-space/hypre/blob/9dc9e18aed6a945a95f966e57daacfb1c269f6ec/src/krylov/gmres.c#L469).

(source-code-index)=
## 10. Source-code index

The links below are immutable links at the reviewed source revision
`53a5d5171e06db3c4950511d4523f872f58317f1`. Runtime statements are bounded by
the evidence column; source presence and tests do not replace scientific or
managed-runtime qualification.

| Claim | Repository path | Symbol | Responsibility | Lane | Test or evidence status | Immutable source |
|---|---|---|---|---|---|---|
| Paired scalar certificate readback | `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `fullmag_cuda_demag_validation_norm_pair` | Both scaled norms complete before aliased scratch output; one 16-byte readback for at least two rows. | FEM GPU | Managed `fem-demag-poisson` native contract passed at attempt `c1321d9442c641bd910f25b1b67a4a0e`; SP4 timing/parity NOT VERIFIED. | [source](https://github.com/MateuszZelent/fullmag/blob/b8f6f0ff3141645f872c84f172e33a1720ea264d/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L116) |
| Public policy defaults, validation, and object IR | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Defines the six policy fields and omits `atol` when `None`. | FEM CPU/GPU API | Source and object lowering checked for this page. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/packages/fullmag-py/src/fullmag/model/discretization.py#L160) |
| Positive tolerance validation | `packages/fullmag-py/src/fullmag/_validation.py` | `require_positive` | Converts a numeric value and rejects nonfinite or nonpositive tolerances. | FEM CPU/GPU API | Source-visible. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/packages/fullmag-py/src/fullmag/_validation.py#L261) |
| FEM policy container | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | Places the optional policy in FEM discretization hints. | FEM CPU/GPU API | Source-visible; no runtime claim. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/packages/fullmag-py/src/fullmag/model/discretization.py#L476) |
| Study-level authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Provides `study.threads(...)` and `study.fem_demag_solver(...)` wrappers. | FEM authoring/runtime intent | Source-visible; no run is constructed by the policy example. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/packages/fullmag-py/src/fullmag/world.py#L5989) |
| Runtime selection | `packages/fullmag-py/src/fullmag/model/problem.py` | `class RuntimeSelection` | Carries optional `cpu_threads` into runtime metadata and validates positive counts. | CPU runtime selection | Source-visible. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/packages/fullmag-py/src/fullmag/model/problem.py#L1884) |
| Canonical FEM hints | `crates/fullmag-ir/src/mesh_hints.rs` | `FemHintsIR` | Carries optional `demag_solver_policy` in `ProblemIR`. | FEM CPU/GPU planning | Source-visible. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-ir/src/mesh_hints.rs#L1074) |
| FEM execution plan | `crates/fullmag-ir/src/plan.rs` | `FemPlanIR` | Carries the selected policy into the executable plan. | FEM CPU/GPU planning | Source-visible. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-ir/src/plan.rs#L1424) |
| Omitted-policy resolution | `crates/fullmag-runner/src/native_fem/plan.rs` | `resolved_native_fem_demag_solver_policy` | Preserves explicit values; resolves omitted CPU/GPU values. | FEM CPU/GPU | Resolver tests cover CPU default, GPU non-PGBB/PGBB defaults, and explicit preservation. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-runner/src/native_fem/plan.rs#L63) |
| General strict GPU default test | `crates/fullmag-runner/src/native_fem.rs` | `unresolved_gpu_demag_policy_prefers_jacobi_preconditioner_for_non_pgbb` | Checks the omitted-policy non-PGBB strict GPU default. | FEM GPU | Existing resolver regression test; not run for this documentation change. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-runner/src/native_fem.rs#L8641) |
| PGBB strict GPU default test | `crates/fullmag-runner/src/native_fem.rs` | `unresolved_gpu_demag_policy_prefers_amg_preconditioner_for_pgbb` | Checks the omitted-policy PGBB strict GPU default. | FEM GPU | Existing resolver regression test; not run for this documentation change. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-runner/src/native_fem.rs#L8654) |
| CPU Poisson solver | `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | Configures Hypre solver/preconditioner and validates the attempted solve. | FEM CPU | Source-visible; this page does not claim a fresh CPU runtime qualification. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) |
| GPU Poisson residual validation | `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `validate_demag_poisson_hypre_device_solve` | Independently certifies Euclidean RHS and residual norms after every device-HYPRE solve. | FEM GPU | Native RED/GREEN and seven-step full-Zarr OFF parity passed; see section 5.1. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp#L452) |
| Shared GPU HYPRE policy owner | `backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp` | `configure_hypre_cuda_device_policy` | Configures checked device/vendor setters once per process and shares a snapshot. | Native FEM GPU consumers | Source contract; not a new runtime or speedup qualification. | [source](https://github.com/MateuszZelent/fullmag/blob/70d35b84dae4e840e8cc881c35ef45014c604284/backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp#L151) |
| Shared GPU HYPRE readiness | `backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp` | `hypre_cuda_device_policy_is_available` | Requires configured device memory/execution and all vendor sparse flags without an error. | Native FEM GPU consumers | Source contract; setter success does not prove full GPU residency. | [source](https://github.com/MateuszZelent/fullmag/blob/70d35b84dae4e840e8cc881c35ef45014c604284/backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp#L103) |
| Potential RHS | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | Assembles the magnetization source for the finite-element Poisson equation. | FEM CPU; shared equation contract | Source-visible; see `fem_demag_poisson_contract`. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) |
| Field recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | Recovers `H_demag` from the potential gradient. | FEM CPU; shared equation contract | Source-visible; manufactured-potential check is described in `docs/physics/fem_demag_poisson.md`. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L709) |
| Native FEM host threads | `backends/fem/cpu/mfem/runtime/cpu_threads.cpp` | `configure_fem_host_runtime_threads` | Applies the minimum of detected capacity, external allocation, and the CPU mesh cap in auto mode; preserves manual counts and the one-thread GPU host policy. | FEM CPU; GPU host initialization | Updated source contract covers both limiting reasons; managed native test not yet run. No device-residency claim. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/cpu/mfem/runtime/cpu_threads.cpp#L137) |
| Requested runner threads | `crates/fullmag-runner/src/lib.rs` | `requested_cpu_threads` | Reads the typed compute-resource request or legacy runtime metadata. | CPU runtime selection | Source-visible; runner thread tests cover precedence. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-runner/src/lib.rs#L6716) |
| Runtime thread summary | `crates/fullmag-runner/src/artifacts.rs` | `runtime_threading_summary` | Publishes requested/resolved counts and leaves native OpenMP fields unavailable until observed. | CPU runtime provenance | Source-visible. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-runner/src/artifacts.rs#L472) |
| Observed native thread provenance | `crates/fullmag-runner/src/artifacts.rs` | `provenance_with_runtime_threading` | Enriches provenance from native FEM step statistics when present. | FEM CPU/GPU runtime metadata | Source-visible; values remain unavailable if the native lane does not report them. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/crates/fullmag-runner/src/artifacts.rs#L1008) |
| Policy script export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_export_fem_demag_solver_policy` | Exports the authored policy for script round-trip. | FEM authoring round-trip | Source-visible; export/re-import does not execute a solver. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/packages/fullmag-py/src/fullmag/runtime/script_builder.py#L3869) |
| Policy acceptance regression | `packages/fullmag-py/tests/test_standard_problem_4_fem.py` | `test_sp4_requests_qualified_demag_linear_solver_policy` | Checks the SP4 policy request in the authored script. | FEM API | Existing repository test; not run as part of this documentation change. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/packages/fullmag-py/tests/test_standard_problem_4_fem.py#L10) |
| Native CPU thread contract | `backends/fem/tests/cpu_threads_contract.cpp` | `main` | Covers external allocation versus mesh limits, the reported limiting reason, manual counts, and GPU host initialization. | FEM CPU | Regression source added; managed native test not yet run. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/tests/cpu_threads_contract.cpp#L315) |
| Shared validation rule | `backends/fem/core/demag_linear_solve_validation.cpp` | `validate_demag_linear_solve_result` | Accepts finite in-tolerance residuals within the iteration cap when the solver or an independent certificate establishes convergence. | FEM CPU/GPU | Existing shared contract; the device-HYPRE corrupted-potential regression passed managed RED/GREEN with the correction described in section 5.1. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/core/demag_linear_solve_validation.cpp#L9) |
| Shared validation regression | `backends/fem/tests/demag_poisson_contract.cpp` | `demag_linear_solve_validation_rejects_invalid_results` | Exercises rejection of unverified false convergence and acceptance of an independently certified result. | FEM CPU/GPU | Existing shared contract; the device-HYPRE corrupted-potential regression passed managed RED/GREEN with the correction described in section 5.1. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/tests/demag_poisson_contract.cpp#L151) |
| Independent GPU residual regression | `backends/fem/tests/demag_poisson_contract.cpp` | `mixed_p1_gpu_robin_and_dirichlet_device_hypre_match_cpu_one_step` | Corrupts a successfully solved GPU potential and requires independent rejection despite the stale HYPRE success report. | FEM GPU | Managed RED compiled and failed at the intended assertion; GREEN passed with the actual corruption-rejection marker. | [source](https://github.com/MateuszZelent/fullmag/blob/51466dfe5d97738859ed8db47fe0c1293845bd30/backends/fem/tests/demag_poisson_contract.cpp#L2711) |
| gpu-pgbb-accepted-field-reuse | `backends/fem/gpu/cuda/relaxation/pgbb.hpp` | `gpu_relax_pgbb_field_reuse_key` | Qualifies exact static endpoint reuse. | FEM GPU | Policy tests added; runtime parity pending. | Unpublished task candidate. |
| cpu-pgbb-accepted-field-reuse | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `take_pgbb_accepted_stats` | Qualifies endpoint buffers and both operator keys. | FEM CPU | Policy tests added; runtime parity pending. | Unpublished task candidate. |
| gpu-fsal-adaptive-retry | `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` | `gpu_rk_retain_restored_fsal_on_retry` | Preserve only an eligible restored derivative after rejection. | FEM GPU | CUDA guard extended; runtime qualification pending. | Unpublished task candidate. |
| cpu-relaxation-iteration-profile | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `accumulate_relaxation_profile_sample` | Sum linear iterations across evaluated trials before accepted-row publication. | FEM CPU | Regression added; execution pending. | Unpublished task candidate. |
| native-linear-iteration-work | `backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp` | `note_successful_demag_linear_iterations` | Saturating sum of successfully certified/recovered linear work. | FEM CPU/GPU | Numeric and rollback regressions added; execution pending. | Unpublished task candidate. |
| native-openmp-runtime | `backends/fem/tests/cpu_threads_contract.cpp` | `class ScopedOpenMpRuntimeState` | Probe the library runtime setters after seeding distinct OpenMP control values. | FEM CPU/GPU host control | Existing package defect confirmed; corrected runtime test pending. | Unpublished task candidate. |
| mfem-element-parallel-policy | `backends/fem/cpu/mfem/runtime/element_parallel_policy.hpp` | `mfem_shared_element_evaluation_parallel_safe` | Require thread-safe MFEM scratch before parallel element evaluation. | FEM CPU host element kernels | Provider flags inspected; runtime parity pending. | Unpublished task candidate. |


(device-scalar-poisson-pcg)=
## Device-scalar PCG with the retained GPU AMG hierarchy (candidate)

The strict FEM GPU `CG/AMG` implementation retains the existing MFEM matrix
and BoomerAMG hierarchy. It caps the first batch at five iterations and later
batches at eight, always limited by the remaining iteration cap.
This is an internal realization of the same requested policy, not a new Python,
ProblemIR, or native ABI selector. CPU, GPU Jacobi and GMRES are unchanged.
No failed device-PCG solve may retry through another engine or CPU fallback.
Managed native and selected-point SP4 evidence is recorded below. These
measurements do not qualify all four solver lanes or FEM against MuMax3.

With the existing `two_norm=0` convention, let $C$ denote one fixed AMG V-cycle,
$b$ the Poisson RHS, $x$ its potential, $r=b-Ax$, and $p$ the CG direction.
The quantities $D=b^T Cb$ and $\rho=r^T Cr$ use the same discrete units as the
existing preconditioned inner products; their ratio and the relative tolerance
are dimensionless. The absolute tolerance retains HYPRE's preconditioned-norm
convention. The production stopping comparison is strictly
$\rho/D < \max(\tau_{\mathrm{inner}}^2,a_{\mathrm{tol}}^2/D)$.
For warm starts $D$ is computed from $b$, never from the initial residual.
For a declared fresh zero guess, $x_0=0$ and $r_0=b$: the implementation
reuses the first $z=C b$ and copies $D$ to $\rho$ on the borrowed device
stream. This avoids a second initial AMG application, the $A x_0$ matvec
and the repeated initial dot product. Warm guesses retain both initial AMG
applications and the $b^T Cb$ denominator. The eight-byte device-to-device
copy is included in the existing transfer counters; no host scalar or new
allocation is introduced. The independent true-residual certificate, inner
tolerance, terminal-latch policy and iteration cap are unchanged. Native
regression and three same-input profiler-off SP4 runs passed on library
`0bd7e6f1…`, with bitwise-identical numeric Zarr arrays. The worker median
changed from 44.611956 to 42.858635 s, while the inclusive Poisson phase
median increased from 19.719933 to 20.276239 s. This is not an isolated AMG
speedup or an alternating paired benchmark; the earlier device-PCG
measurements belong to a different binary cohort.
The recurrence is $q=Ap$, $\alpha=\rho/(p^Tq)$,
$x\leftarrow x+\alpha p$, $r\leftarrow r-\alpha q$,
$z=Cr$, $\beta=(r^Tz)/\rho$, and $p\leftarrow z+\beta p$.
The existing inner tolerance factor, configured iteration limit, and independent
true-residual certificate remain unchanged.

The GPU latches the first converged iteration and freezes the candidate before
host status collection. Remaining queued calls receive zero preconditioner
inputs. True zero RHS returns zero potential; a zero preconditioned product
with nonzero RHS, nonfinite data, nonpositive curvature or unsafe division
fails closed. A final short batch never exceeds the configured iteration cap.
`HyprePCG` statistics cannot describe the unexecuted outer solver: the workspace
reports the actual device-PCG iteration count and recurrence residual instead.

The owned workspace preallocates device vectors and CUB scratch. All recurrence,
matvec and AMG work uses the borrowed HYPRE stream; Fullmag producer/consumer
events retain their existing ordering. Raw `HYPRE_BoomerAMGSolve` preserves
explicit library status checking, and its output is zeroed for every apply.
Debug AMG norm logging is suppressed for this internal fixed preconditioner;
setup and final Fullmag certificate still validate the unchanged operator.

Acceptance requires native zero-RHS/exact-warm/Nonfinite/breakdown/batch-boundary
oracles, no per-iteration D2H or allocation, one retained hierarchy setup, and
the same SP4 torque, independent certificate, full Zarr and 2 ppm component-energy
gates. The first five-iteration batch and later eight-iteration batches preserve
the configured cap. After a device terminal latch, at most seven additional
AMG API calls can be issued across the remainder of the apply, including up to
two pre-loop applies and the first queued batch. This counts HYPRE API calls,
not measured GPU cycles; no speedup is claimed.
A history-based first batch is not qualified by the cumulative readback bound
alone: after a previous solve of 66 iterations, a first batch of 65 would issue
64 post-latch AMG calls if the next solve converges after one iteration. Any
future adaptive schedule or graph replay must preserve both bounds for sudden
early convergence, zero RHS and nonfinite input, as well as ordinary SP4 steps.
The no-inner-norm claim applies to the qualified l1-Jacobi AMG smoother
(relax type 18 and coarse type 18). The engine explicitly requires `MPI_COMM_SELF`, relax/coarse type 18 and
`print_level=0`; explicit verbose requests keep the existing HYPRE GPU engine
and its diagnostics. Positive row/iteration counts and finite positive relative
and finite nonnegative active absolute tolerances are checked before enqueue
or any pinned host-status read.
Other previously legal AMG smoothers keep the existing GPU HYPRE implementation.
This setup-time selection changes neither the requested parameters nor CPU/GPU
placement. Once device PCG is selected, errors cannot retry the old solver.
An additive native getter reports the actual initialized engine;
`fem_poisson_demag.resolved_linear_engine` preserves that result in provenance
without changing existing ABI structures. CPU or uninitialized contexts return
not applicable; the runner does not infer an engine from requests.

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| Device-scalar outer PCG | `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `apply_demag_poisson_device_pcg` | First batch capped at five, later batches at eight; API-call diagnostics are internal; managed tests required |
| Initial terminal-batch regression | `backends/fem/tests/demag_poisson_contract.cpp` | `mixed_p1_gpu_robin_and_dirichlet_device_hypre_match_cpu_one_step` | Counts actual AMG calls for fresh/warm/zero/Nonfinite states, including fresh reuse and its D2D bytes; managed gate `2a6aa743…` passed |
| Actual engine provenance | `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_poisson_linear_engine_v1` | Candidate source; managed tests required |
| GPU recurrence and stopping | `backends/fem/gpu/cuda/demag_poisson/pcg_device_scalar_kernels.cu` | `pcg_finish_rho_kernel` | Candidate source; managed tests required |


```{math}
:label: eq-fem-poisson-device-pcg-recurrence
\begin{aligned}
 D &= b^T C b, & r &= b-Ax, & z &= Cr, & \rho &= r^Tz, \\
 q &= Ap, & \alpha &= \rho/(p^Tq), & x^+ &= x+\alpha p, & r^+ &= r-\alpha q, \\
 z^+ &= Cr^+, & \rho^+ &= (r^+)^Tz^+, & \beta &= \rho^+/\rho, & p^+ &= z^++\beta p, \\
 \rho/D &< \max(\tau_{\mathrm{inner}}^2,a_{\mathrm{tol}}^2/D).
\end{aligned}
```

| Symbol | Meaning | SI unit |
|---|---|---|
| $A$ | FE Poisson stiffness operator | $\mathrm{m}$ |
| $C$ | Fixed AMG approximation to inverse stiffness | $\mathrm{m}^{-1}$ |
| $b$, $r$, $q$ | Load, residual, and stiffness applied to direction | $\mathrm{A}\,\mathrm{m}$ |
| $x$, $z$, $p$ | Scalar potential, preconditioned residual, and direction | $\mathrm{A}$ |
| $D$, $\rho$ | Preconditioned squared products | $\mathrm{A}^2\,\mathrm{m}$ |
| $\alpha$, $\beta$, $\tau_{\mathrm{inner}}$ | Recurrence scalars and inner relative tolerance | $1$ |
| $a_{\mathrm{tol}}$ | Preconditioned absolute tolerance | $\mathrm{A}\,\mathrm{m}^{1/2}$ |

The superscript $+$ denotes the next CG iterate. The equation applies to the
same constrained SPD FE system and fixed preconditioner as the existing CG
realization; it changes no magnetic field, energy, or boundary operator.


(device-scalar-poisson-pcg-accounting)=
### Scoped PCG control-transfer subaccounting (candidate)

The additive `fullmag_fem_backend_get_poisson_device_pcg_counters_v1` getter
accepts a scope enum (`Physical=0`, `HotLoop=1`) and returns a new record of
five `uint64_t` fields: `status_readbacks`, `status_record_bytes`,
`control_d2h_bytes`, `solves`, and `active_iterations`. Unknown scopes fail;
existing ABI structure sizes and requested CG/AMG policy remain unchanged.
`status_record_bytes` is `sizeof(DemagPcgState)`.

Physical counters belong to `GpuPerformanceCounterState.physical_lifetime`,
updated through the same `gpu_performance_note` as aggregate physical control
fences/bytes. Active outer attempts remain excluded until commit/reject/fail;
rejected/failed work survives rollback. The existing GPU lifecycle reset resets
these totals, while rebuilding the Poisson workspace does not.

HotLoop counters belong to `TransferAudit.device_pcg_hot_loop` and use exactly
the existing audit predicate `audit.hot_loop_depth>0`. They share the existing
audit's immediate visibility, value-copy/reset and rollback boundaries. A solve
records its scoped start before first enqueue; every completed status readback
records scoped bytes and active-iteration delta under that same condition.
The solve scope cannot change during an apply. Each readback remains in the
existing aggregate transfer audit and performance counters; no transfer is
hidden or reclassified as bulk.

`solves` counts valid invocations starting enqueue. `active_iterations` adds
differences of the GPU first-stop iteration counter after each completed
readback, including a terminal numerical rejection. Neither scope is inferred
from last-step or accepted-row solve/iteration statistics. A CUDA failure before
the first readback may leave `solves>0` and zero readbacks; this is not a
qualified complete-run claim.

The runner preserves distinct `StepStats.demag_device_pcg_physical` and
`StepStats.demag_device_pcg_hot_loop` observations. The corresponding provenance
and `demag_runtime` fields are `device_pcg_physical` and `device_pcg_hot_loop`,
each containing the same five keys. Adjacent `resolved_linear_engine` comes
from the context getter; `runtime_preconditioner=HypreBoomerAMG` remains.
Historical and unchanged HYPRE engines may omit the additive observations.

For either consistent scope of a completed converged run, let $R$ denote its
cumulative status readbacks, $N$ the record size in bytes, $T$ PCG control
bytes, $S$ started solves, and $I$ cumulative active iterations. For one solve,
$R(I)$ has the bound shown below; summing it across $S$ solves gives the
cumulative bound:

```{math}
:label: eq-fem-poisson-device-pcg-transfer-bound
\begin{aligned}
 R(I) &= 1+\lfloor (I+2)/8\rfloor && (S=1), \\
 T &= RN, \\
 R_{\max} &=
 \begin{cases}
 0, & S=0\quad (I=0),\\
 S, & S>0\quad (I=0),\\
 S+\lfloor (I+2S)/8\rfloor, & I>0,
 \end{cases} \\
 S &\le R \le R_{\max}.
\end{aligned}
```

| Symbol | Meaning | Unit |
|---|---|---|
| $R$ | Cumulative completed PCG status readbacks | $1$ |
| $N$ | Size of one PCG status record | $\mathrm{byte}$ |
| $T$ | Cumulative PCG control bytes | $\mathrm{byte}$ |
| $S$ | Cumulative valid PCG invocations starting enqueue | $1$ |
| $I$ | Cumulative GPU-reported active iterations | $1$ |
| $R_{\max}$ | Cumulative readback upper bound for the selected batch sizes | $1$ |

Status is still read once at each batch boundary: the initial boundary is now
five iterations, while later boundaries are at most eight. This can add an
ordinary batch-status read for a solve that continues beyond iteration five;
there is no per-iteration or separate terminal-status D2H readback. The counter
fixture covers $S=4,I=0$ and $I=0,5,6,13,14,500$, and rejects arithmetic
overflow in its fixed-width native helper. The Python validator uses
arbitrary-precision integers and enforces $R\le R_{\max}$ before subtracting exact status bytes.
This bound does not relax the existing compute, exchange, row-parity, or
independent residual gates.

The existing HotLoop validators subtract **only** the exact $R$ and $T$ from
`device_pcg_hot_loop`, never `device_pcg_physical`, from HotLoop aggregate
control fences/bytes. They first require nonnegative subtraction, $T=RN$ and
the cumulative PCG bound. The unchanged prior PGBB budget applies to the
remainder: `B=3+4*steps+max(0,rhs_evals-2*steps)` fences and `256*B` bytes.
Physical-only evidence cannot qualify this subtraction. Unchanged HYPRE PCG
paths retain their existing validation route and budgets.

For a completed observation, additive PhysicalLifetime includes setup outside
attempts and every completed accepted, rejected or failed attempt. Direct GPU
minimizers must open the performance lifecycle alongside their execution
receipt; an accepted step commits, a terminal observation without a step
rejects, and an unclosed error path fails. In-flight attempt deltas stay private.
This lifecycle is independent of the profiler setting. Legacy 480-byte
`physical_control_*` aggregates remain attempt-scoped: setup counted by additive
Physical must not be subtracted from those legacy aggregates. Only matching
HotLoop scopes justify the core-budget subtraction.
The physical D2D-byte field also includes the eight-byte denominator-to-rho
initialization copy before the first attempt. Accepted D2D bytes retain their
accepted-step transaction semantics; this correction does not change the
legacy control-fence or control-byte subtraction rules.

Completed-run validation requires both PCG scopes, identical status-record size,
valid cumulative bounds, and Physical counters at least as large as HotLoop.
Mandatory-control lifetime counts must likewise contain the completed HotLoop
counts. Persisted summaries retain both records for revalidation. A live active
attempt is intentionally not a completed-run certificate.

The first full-Zarr device-PCG SP4 pilot passed all component-energy, torque and
true-residual checks, but failed this lifetime gate: its direct-minimizer path
had not opened a performance attempt. Its 45.124280 s single-run measurement
does not establish a speedup. The lifecycle fix and real direct-path regression
remain candidates until the managed native gate and a new SP4 cohort pass.


| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| Physical subaccounting owner | `backends/fem/gpu/cuda/runtime/performance_counters.cpp` | `gpu_performance_device_pcg_snapshot` | Source candidate; managed gate pending |
| HotLoop subaccounting owner | `backends/fem/gpu/cuda/transfer/transfer_audit.cpp` | `record_device_pcg_status_to_host` | Source candidate; managed gate pending |
| Scope/subtraction regression | `backends/fem/tests/poisson_device_pcg_counter_fixture.hpp` | `device_pcg_physical_subaccounting_survives_rollback` | Source candidate; managed gate pending |
| Direct minimizer lifecycle | `backends/fem/cpu/mfem/runtime/backend_step.cpp` | `run_backend_relaxation_step` | Source candidate; new managed gate pending |
| Attempt guard | `backends/fem/gpu/cuda/runtime/performance_counters.hpp` | `class GpuPerformanceAttemptScope` | Source candidate; active exclusion and exactly one terminal boundary |
| Real direct-path regression | `backends/fem/tests/demag_poisson_contract.cpp` | `void direct_pgbb_performance_lifecycle_contract` | Source candidate; profiler OFF/ON and two confirmations; managed execution pending |

The shared fixture proves outside-HotLoop physical growth with zero HotLoop
counts, inside-HotLoop accounting, reject/fail/copy/reset/rollback behavior and
exact subtraction only from the matching aggregate. It runs in the existing
`fem-demag-poisson` gate (`device_pcg_scope_accounting_contract`) and the
existing performance unit; no extra gate selector is required.


(mandatory-gpu-controls)=
## Mandatory GPU controls and unchanged core readback budget (candidate)

Typed source attribution separates BB certificate/descent, independent Poisson
certificate and same-step torque-confirmation metrics from the legacy core
PG-BB budget. This changes no readback, tolerance, field, energy, step count or
stopping rule. New telemetry is source-only until managed regression/runtime
qualification. Physical counters share the performance owner; HotLoop counters
share TransferAudit and exactly its depth/copy/reset/rollback semantics.

Generic provenance fields `gpu_mandatory_controls_physical` and
`gpu_mandatory_controls_hot_loop` publish through `fem_gpu_solver_controls`
(`physical`, `hot_loop`), including BB without demag. A new versioned getter
returns ten uint64 counters, scope0 Physical/scope1 HotLoop; old ABI layouts
are unchanged. Legacy null/missing records earn no attribution credit.

For the saved SP4 observation, accepted callbacks end at792 fences/70128B;
two same-step torque confirmations add8 fences/688B, yielding800/70816.
Exclusive source buckets are BB184/9568B, Poisson certificate226/1808B and
confirmation metrics4/656B. Confirmation excludes BOTH certificate and device
PCG status subcounts. The remainder386/58784 satisfies unchangedB389 and256B
per allowed fence. Confirmation observations never become accepted steps or
CSV RHS evaluations. Rejected-attempt counts must declare whether they include
confirmations before RHS minima can exclude those observations.


The additive record fields have type `uint64_t`, default zero, no ProblemIR
or authoring destination, and support FEM GPU controls independently of demag.
CPU counters remain zero; FDM has no realization of this native FEM getter.

| Record field | Meaning | Unit |
|---|---|---|
| `bb_certificate_record_bytes` | Actual size of one terminal BB result | $\mathrm{byte}$ |
| `bb_certificate_readbacks` | Completed BB certificate reads | $1$ |
| `bb_certificate_bytes` | BB certificate data transferred | $\mathrm{byte}$ |
| `bb_descent_readbacks` | Completed projected-direction descent reads | $1$ |
| `bb_descent_bytes` | Descent data transferred | $\mathrm{byte}$ |
| `poisson_certificate_readbacks` | Independent RHS/residual norm reads | $1$ |
| `poisson_certificate_bytes` | Independent certificate data transferred | $\mathrm{byte}$ |
| `confirmation_observations` | Same-step torque observations, not accepted steps | $1$ |
| `confirmation_metric_readbacks` | Exclusive current/final confirmation reads | $1$ |
| `confirmation_metric_bytes` | Exclusive confirmation data, excluding Poisson certificate and PCG status | $\mathrm{byte}$ |

Physical BB certificate reads previously existed in TransferAudit but lacked
a performance aggregate note; the new source note also closes that accounting
gap without adding a readback. Descent and Poisson certificate aggregate notes
are retained exactly once. Confirmation only attributes previously recorded
reads; it does not increment aggregate counts again.

Accepted-CSV rejection counts remain line-search trials. An explicit
`execution_attempts` rejection scope may exclude only the typed confirmation
count from the RHS minimum and must agree with the native execution receipt.
Neither case changesB: `3+4*steps+max(0,rhs_evals-2*steps)` or the256B allowance.

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| Physical mandatory controls | `backends/fem/gpu/cuda/runtime/performance_counters.cpp` | `gpu_performance_mandatory_controls_snapshot` | Source candidate; native gate pending |
| HotLoop mandatory controls | `backends/fem/gpu/cuda/transfer/transfer_audit.cpp` | `note_hot_loop_mandatory_controls` | Source candidate; native gate pending |
| Exclusive confirmation attribution | `backends/fem/gpu/cuda/runtime/performance_counters.cpp` | `resolve_confirmation_control_delta` | Source candidate; native gate pending |
| Additive C ABI scopes | `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_mandatory_control_counters_v1` | Source candidate; ABI/native gate pending |
| Real SP4 and scope regression | `backends/fem/tests/mandatory_control_counter_fixture.hpp` | `mandatory_control_accounting_contract` | Source candidate; native gate pending |

Pure Python source tests preserve the existing95 guard cases and add9 cases for
actual800/70816 accounting, combined PCG statuses, bad scopes/missing records,
underflow/double attribution and explicit rejection domains. These are mocked
transport/source tests, not managed runtime or scientific qualification.
