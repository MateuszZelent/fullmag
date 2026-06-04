
# Relaxation algorithms for FEM micromagnetics on MFEM/libCEED/hypre with GPU

- Status: production-executable for LLG/PG-BB/NCG; TPI under development
- Owners: Fullmag core
- Last updated: 2026-06-04
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
  - `docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md`
  - `docs/physics/0500-fdm-relaxation-algorithms.md`

## 1. Problem statement

This note defines the current FEM relaxation / energy-minimization algorithms
and the remaining roadmap beyond explicit damped LLG alone.

Current repo status relevant to this note:

- the planner can construct a `FemPlanIR` from a precomputed `MeshIR`,
- `FemPlanIR` already carries mesh data, per-node initial magnetization, material payload,
  active term flags, precision, and LLG timing parameters,
- the runner executes FEM relaxation through the maintained native FEM lanes,
- `StudyIR::Relaxation` exists and four FEM relaxation algorithms are
  production-executable in maintained runtime lanes: `llg_overdamped`,
  `projected_gradient_bb`, `nonlinear_cg`, and `tangent_plane_implicit` on
  CPU/MFEM (see `0500-fdm-relaxation-algorithms.md` for the shared stop
  semantics). TPI GPU/libCEED remains under development and is deliberately
  excluded from the GPU runtime gate,
- native CPU/MFEM owns executable FEM `projected_gradient_bb` and
  `nonlinear_cg` steps through the `fullmag_fem_backend_relax_step` ABI, using
  tangent gradients, Armijo line search, sphere retraction, FEM lumped-mass
  inner products, and exchange-plus-mass preconditioned gradient directions
  with serial MFEM CG as the production default. HyprePCG/BoomerAMG remains an
  explicit opt-in qualification path via
  `FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER=hypre`,
- native CPU/MFEM carries the production-executable FEM
  `tangent_plane_implicit` path through the same ABI; it solves a global tangent-plane linear system with
  `mass + step * exchange` plus local uniaxial/cubic anisotropy, Zeeman tangent
  curvature, and matrix-free DMI weak-residual and demag fresh-solve actions,
  while other time-dependent supplied terms remain explicit from the current
  native snapshot,
- GPU/libCEED residual kernels, broader preconditioning policy, and
  full-device-resident tangent-plane solves are under development, not
  runner-owned fallback paths.
- native CUDA `projected_gradient_bb` building-block kernels now live under
  `backends/fem/gpu/cuda/relaxation/`: tangent-gradient projection from
  `H_eff`, FEM lumped-mass metric reductions, and normalized nodal retraction.
  `pgbb.cpp` also owns the native GPU PG-BB preflight/step boundary reached
  from `run_backend_relaxation_step` when a GPU state is allocated. The CUDA
  branch contains the device-resident Armijo accepted-step loop and BB1/BB2
  step-size update. Public runner capability now advertises PG-BB on
  `fem_native_gpu`; runtime provenance keeps controlled compute scalar
  readbacks for Armijo/BB decisions distinct from rejected exchange hot-loop
  host sync.
- native CUDA `nonlinear_cg` now lives under
  `backends/fem/gpu/cuda/relaxation/`: it owns device-resident tangent-gradient
  reduction, FEM mass-metric dot products, normalized retraction, Armijo
  accepted-step loop, persistent search-direction state, PR+ update, rollback,
  and the native GPU NCG preflight/step boundary reached from
  `run_backend_relaxation_step` when a GPU state is allocated.
- runner capability checks keep only `tangent_plane_implicit` on the CPU/MFEM
  lane. In automatic runtime selection, TPI falls back to the CPU/MFEM lane with
  explicit provenance; forced GPU selection remains a clear under-development
  error while its full GPU/libCEED device-resident tangent-plane solve is under
  development.

Shared stop/refresh semantics now live in
`0530-shared-relaxation-stop-and-field-refresh-semantics.md`. This note focuses
on how those shared controls are interpreted by the FEM stack.

For FEM, relaxation is especially important because:

- curved geometries and open-boundary demag often make static equilibria the main target,
- explicit dynamic integration can be severely stiffness-limited,
- FE operators admit strong preconditioning and tangent-space linearization strategies.

Recommended algorithm families:

1. overdamped LLG with adaptive explicit integrator,
2. projected gradient / Barzilai–Borwein on FE nodal spheres,
3. nonlinear conjugate gradient with FE-aware preconditioning,
4. tangent-plane linearly implicit relaxation on CPU/MFEM,
5. later: manifold L-BFGS or Newton-like methods.

## 2. Physical model

### 2.1 Constrained minimization

The equilibrium problem is

\[
\min_{m_h \in V_h^3,\ |m_h(\mathbf{x})| \approx 1} E[m_h].
\]

In discrete DOFs, the tangent gradient is represented by the FE residual projected through the mass operator.

For a discrete state `u`, define the FE gradient `g(u)` through

\[
M g(u) = -G(u),
\]

where `G(u)` is the assembled energy residual and `M` is the vector mass operator.

The tangent projection at nodal/DOF level is

\[
g_T = P_u g,
\qquad
P_u = I - uu^\top
\]

interpreted cellwise / nodewise according to the chosen DOF layout.

### 2.2 Torque and stopping criteria

Use physically meaningful stopping criteria:

- max torque norm,
- total-energy plateau range over a sufficiently long accepted-step window,
- norm defect,
- optionally projected residual norm.

Do **not** treat one small step-to-step energy delta as relaxation. The native
FEM energy stop uses the shared 50 accepted-step plateau rule from
`0530-shared-relaxation-stop-and-field-refresh-semantics.md`: stop with
`reason=energy` only when `max(E)-min(E)` across the last 50 accepted relax
steps is below `energy_tolerance_j`, and when any configured torque tolerance is
also satisfied.

For shared product semantics with the current FDM runner, the public
`torque_tolerance` control is expressed in `A/m` as
`max |m × H_eff|`. A derived `max_torque_T = μ0 * max_torque_Apm` observable may
still be surfaced for mumax-style comparability, but it is auxiliary and must
not replace the canonical stop threshold.
The fallback `dm/dt` → torque reconstruction uses the reduced `gamma_mu0` in
`m/(A s)`, so the expected scale is about `2.211e5`, not `1.76e11`.

### 2.3 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `u` | FE DOF vector for magnetization | 1 |
| `G(u)` | assembled energy residual | — |
| `M` | vector mass operator | — |
| `g(u)` | FE gradient after mass projection | A/m-equivalent |
| `\tau` | torque residual | A/m-equivalent |

### 2.4 Assumptions and approximations

This note targets deterministic equilibrium search only.
Deferred:

- thermal annealing,
- string / NEB methods,
- saddle search,
- full Newton methods with exact Hessians.

## 3. Numerical interpretation

### 3.1 FDM

See:

- `0500-fdm-relaxation-algorithms.md`

### 3.2 FEM

#### 3.2.1 Algorithm A — overdamped LLG with adaptive explicit RK

This is the easiest baseline because it reuses the dynamic RHS machinery.
Use adaptive DOPRI54 or similar once explicit RK support exists.

When a relaxation stage needs a pseudo-time execution budget for scheduling,
preview cadence, or stage materialization, that budget should be seeded from
the same rule as FDM:

1. `fixed_timestep` when explicitly provided,
2. otherwise `adaptive_timestep.dt_initial` when explicitly provided by the
   authoring surface,
3. otherwise fallback `1e-13 s`.

This pseudo-time is a runtime-control quantity only; convergence remains driven
by torque and optional energy criteria rather than physical simulation time.

Current authoring note: the embedded Python DSL currently serializes omitted
adaptive seeds as `dt_initial = dt_min`. The CLI/runtime layer must therefore
interpret `dt_initial == dt_min` as "no explicit seed supplied" for relaxation
pseudo-time budgeting, rather than as a request to use the minimum adaptive
step as the whole stage budget.

Canonical authoring defaults must also remain aligned across Python and UI.
For `Relaxation`, the public default `torque_tolerance` is `1e-4 A/m`; UI and
script-builder defaults are product debt if they diverge from that value.

Pros:

- minimal new architecture,
- easy user mental model.

Cons:

- can be very stiffness-limited on fine meshes,
- not the best final FEM relaxation strategy.

#### 3.2.2 Algorithm B — projected gradient / BB in FE space

Compute a mass-projected gradient

\[
M_L g = -G(u),
\]

preferably with lumped mass for efficient diagonal-mass updates.
Take a projected step

\[
u^{trial} = u - \lambda g_T,
\]

then retract to the nodal sphere constraint.

Use BB step-length formulas with line search exactly as in FDM, but with FE-aware inner products:

\[
\langle a,b\rangle_M = a^\top M a
\]

or a lumped approximation thereof.

This is a clean first direct-minimization method for FEM.

#### 3.2.3 Algorithm C — nonlinear CG with FE-aware preconditioning

Use projected gradient plus a conjugate search direction.
Recommended enhancements over the FDM version:

- use FE mass-weighted inner products,
- allow simple preconditioning, e.g. exchange-plus-mass preconditioners,
- include restart logic when conjugacy deteriorates.

This can substantially reduce iteration counts on mesh-based problems.

#### 3.2.4 Algorithm D — tangent-plane linearly implicit relaxation

This is the most important production-target FEM relaxation method.

At state `m_n`, solve for an update `v_n` in the tangent space:

\[
v_n \in \mathcal{T}_{m_n},
\qquad
m_n \cdot v_n = 0,
\]

using a linearized or semi-implicit system built from the exchange, demag, DMI, and Zeeman operators.
The current CPU/MFEM implementation includes exchange, local uniaxial/cubic
anisotropy, Zeeman curvature, DMI weak-residual action, and demag fresh-solve
linear response in that implicit tangent operator. The remaining production gap
is the full GPU/libCEED/device-resident tangent-plane solve path, not the
CPU/MFEM demag operator action.
Then update via

\[
m_{n+1} = \mathcal{R}_{m_n}(v_n),
\]

with a norm-preserving retraction.

Why this is the right production direction for FEM:

- better stiffness handling,
- natural compatibility with sparse / matrix-free FE solvers,
- preconditioning via hypre becomes meaningful,
- geometry of `|m|=1` is handled more honestly than by raw explicit RK.

Recommended software stack:

- MFEM for operator blocks and tangent-space constraints,
- libCEED for local operator application,
- hypre CG / GMRES + preconditioners for linear solves.

#### 3.2.5 Algorithm E — manifold L-BFGS / quasi-Newton (later)

A strong later option once gradient and tangent-space infrastructure are stable.
Likely very effective near equilibrium, but implementation is more involved.

#### 3.2.6 Recommended rollout order

1. Overdamped LLG + adaptive explicit RK.
2. Projected gradient + BB.
3. Nonlinear CG.
4. Tangent-plane linearly implicit relaxation.
5. Later: manifold L-BFGS.

If the project prioritizes serious FEM equilibrium quality over quick parity with FDM,
swap steps 3 and 4.

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Recommended study object shared with FDM:

```python
fm.Relaxation(
    algorithm="tangent_plane_implicit",   # or "llg_overdamped", "projected_gradient_bb", "nonlinear_cg"
    torque_tolerance=1e-4,
    energy_tolerance=1e-10,
    max_steps=50000,
    outputs=[...],
)
```

Backend-neutral user API; FE-specific solver/preconditioner knobs belong in
execution hints or backend policy, not in the top-level public object.

Current production-executable subset (FEM backend):

- `algorithm = "llg_overdamped"`
- `algorithm = "projected_gradient_bb"`
- `algorithm = "nonlinear_cg"`

`algorithm = "tangent_plane_implicit"` remains under development. It has a
native CPU/MFEM implementation path for development and compatibility checks,
but it is not part of the production-qualified relaxation set and its
GPU/libCEED device-resident tangent-plane solve remains under development.

Status 2026-06-04: native CPU/MFEM direct-relaxation runs publish
`requested_energy_minimizer`, `resolved_energy_minimizer`, and
`energy_minimizer_realization = "native_mfem_backend_relax_step"`, and clear
`resolved_integrator` so metadata does not imply that Heun/RK time integration
executed the stage. The Rust runner selects the native ABI and owns stage
orchestration, artifacts, provenance, and live updates; it does not own FEM
line-search or tangent-plane algorithms.

For FEM/MFEM/CUDA/hypre/libCEED runtime proof, host-side `cargo`, `cmake`, and
direct native binaries are only smoke checks. Managed container-backed `just`
recipes are the authoritative gate; use `just ensure-managed-fem-runtime` for
runtime freshness and `just fem-gpu-headless ...` for executable GPU relaxation
smoke coverage. The production relaxation smoke validator requires monotone
`E_total`, finite final energy, valid magnetization norm defect, matching
runtime provenance/qualification metadata, and at least `1.0e-3` relative
energy decrease across the smoke trajectory. It also rejects runs where final
`max_torque_T` grows beyond `1.25x` the initial value, allowing short-line-search
torque fluctuations while catching non-relaxing or unstable trajectories.
Use `just verify-fem-relaxation-convergence` for the longer managed
container-backed LLG/PG-BB/NCG convergence gate; it raises the default run to 16
steps and requires at least `1.0e-2` relative energy decrease. Set
`FULLMAG_FEM_RELAXATION_KEEP_LOGS=1` when the runtime logs need to be preserved
as audit evidence for a local verification run.
Use `just verify-fem-relaxation-cpu-gpu-consistency-smoke` for the focused
Box500 exchange-only CPU/GPU consistency slice. It exercises the existing FEM
benchmark runner with a deterministic heun relaxation case across the active
production algorithms `llg_overdamped`, `projected_gradient_bb`,
and `nonlinear_cg`. The smoke requires a separate CPU/GPU pair for each active
production algorithm and intentionally excludes `tangent_plane_implicit`
because that method remains under development. It is a parity smoke, not a
replacement for the broader benchmark matrix.
Use `just verify-fem-relaxation-production-benchmark` for the broader managed
container-backed interaction-matrix gate. It runs the deterministic Box500
airbox CPU/GPU consistency preset across exchange, Zeeman, demag, anisotropy,
DMI, and STT/Oersted scenario families for the current production algorithms.
It requires per-algorithm CPU/GPU pairs for the active production algorithms
and strict managed FEM runtime availability.

Current FEM caveat: `projected_gradient_bb` and `nonlinear_cg` use FEM
lumped-mass inner products and native Armijo line search on both maintained
lanes. The CPU/MFEM lane uses exchange-plus-mass preconditioned gradients; the
preconditioner uses serial MFEM CG with a Gauss-Seidel smoother by default.
HyprePCG/BoomerAMG is kept as an explicit opt-in qualification path via
`FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER=hypre`. The native CUDA lane
publishes `gradient_policy = "device_tangent_gradient"` in
`fem_gpu_relaxation_qualification`, because it uses device-resident tangent
gradient kernels rather than the CPU/MFEM preconditioner. `tangent_plane_implicit` is executable on the
native CPU/MFEM lane through a global tangent-plane `mass + step * exchange`
solve; it includes local anisotropy, Zeeman curvature, DMI weak-residual
action, and demag fresh-solve linear response in the implicit operator, but is
not yet a GPU/libCEED-resident tangent-plane solver.
CPU/MFEM relaxation qualification artifacts carry an `algorithm_policy` block
with the resolved native realization, FEM mass metric, line-search policy, and
preconditioner/linear-solver contract. They intentionally do not report an
actual per-step Hypre-vs-serial preconditioner selection until the native ABI
exports that runtime measurement.

### 4.2 ProblemIR representation

Use a shared `StudyIR::Relaxation` shape across backends.
Backend-specific items such as:

- mass-lumped vs consistent,
- preconditioner family,
- tangent-plane linear solver options,

belong in `ExecutionPlanIR`.

### 4.3 Planner and capability-matrix impact

Planner must:

- reject unsupported relaxation algorithms on unsupported FE realizations,
- estimate whether a method requires:
  - only field evaluations,
  - line searches,
  - or linear solves,
- record stop reason and convergence metrics in provenance.

Capability matrix should separate explicit relaxation support from tangent-plane implicit support.

## 5. Validation strategy

### 5.1 Analytical checks

- energy descent on smooth convex-like test cases,
- torque-to-zero convergence on uniform-field equilibria,
- norm-defect control.

### 5.2 Cross-backend checks

- same initial condition on box geometry,
- compare final energies and average magnetization,
- compare final domain-wall / skyrmion chirality once DMI is available.

### 5.3 Regression tests

- projected-gradient FE relaxation benchmark,
- NCG restart/preconditioner benchmark,
- tangent-plane linear solve convergence benchmark,
- CPU fallback vs GPU partial-assembly parity.

### 5.4 GPU/libCEED implementation entry point

GPU/libCEED relaxation production units belong under
`backends/fem/gpu/cuda/relaxation/`, not in a Rust-side solver. The executable
device-resident direct-minimizer slice currently covers projected-gradient BB
and nonlinear CG:

- reuse the existing GPU effective-field pipeline for exchange, local fields,
  DMI, demag, and energy reductions,
- use the native CUDA tangent-gradient, FEM metric-reduction, and normalized
  retraction kernels from `pgbb_kernels.cu`,
- keep Armijo/BB step control inside `pgbb.cpp` without host field copies in
  the hot loop beyond scalar energy/curvature decisions,
- publish through the existing `fullmag_fem_backend_relax_step` ABI only after
  CUDA parity and transfer-audit gates prove that the accepted-step loop has no
  hidden device-host synchronization beyond scalar convergence decisions.

The tangent-plane implicit GPU/libCEED solve is under development and remains
outside the active GPU solver set for now. Automatic FEM GPU selection falls
back to the under-development CPU/MFEM TPI path; forced GPU TPI selection fails
with a clear under-development diagnostic.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend (`llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`)
- [x] FEM backend (`llg_overdamped` on native CPU/MFEM and supported native GPU time-integration lanes)
- [x] FEM backend (`projected_gradient_bb`, `nonlinear_cg` native mass-weighted minimizers)
- [x] FEM backend (`projected_gradient_bb`, `nonlinear_cg` exchange-plus-mass preconditioned minimizers with serial MFEM CG as the production default and explicit Hypre/AMG opt-in for qualification)
- [x] FEM backend (`tangent_plane_implicit` native CPU/MFEM tangent-plane solve with exchange, local anisotropy, Zeeman, DMI, and demag linear-response actions)
- [x] FEM GPU backend (`projected_gradient_bb` native CUDA tangent-gradient, mass-metric reduction, normalized-retraction kernels, Armijo/BB step source, native preflight/step boundary, and runner availability)
- [x] FEM GPU backend (`nonlinear_cg` native CUDA tangent-gradient, mass-metric dot products, normalized retraction, Armijo/PR+ step source, persistent direction state, native preflight/step boundary, and runner availability)
- [ ] FEM backend (`tangent_plane_implicit` full GPU/libCEED device-resident tangent-plane solve; under development)
- [ ] Hybrid backend
- [ ] Outputs / observables
- [x] Targeted source-contract and managed runtime smoke coverage for current LLG/PG-BB/NCG production lanes
- [x] Broader interaction-matrix CPU/GPU benchmark gate is wired for current LLG/PG-BB/NCG production lanes
- [ ] Broader interaction-matrix CPU/GPU benchmark pass for current LLG/PG-BB/NCG production lanes
- [ ] Extended benchmark campaign across mesh refinements, adaptive timesteps, and publication-scale physics cases
- [x] Documentation (this note + `0500-fdm-relaxation-algorithms.md`)

## 7. Known limits and deferred work

- no full Newton/Hessian methods,
- no NEB or saddle search,
- no thermal annealing,
- explicit relaxation can still be stiff on fine meshes,
- tangent-plane implicit design needs careful linear algebra ownership.

## 8. References

Internal references:

- `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- `docs/physics/0500-fdm-relaxation-algorithms.md`
