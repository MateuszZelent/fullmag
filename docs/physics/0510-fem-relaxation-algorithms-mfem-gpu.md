
# Relaxation algorithms for FEM micromagnetics on MFEM/libCEED/hypre with GPU

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-24
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
  - `docs/physics/0500-fdm-relaxation-algorithms.md`

## 1. Problem statement

This note defines a roadmap for **better relaxation / energy-minimization algorithms**
for the FEM backend beyond explicit damped LLG alone.

Current repo status relevant to this note:

- the planner can now construct a bootstrap `FemPlanIR` from a precomputed `MeshIR`,
- `FemPlanIR` already carries mesh data, per-node initial magnetization, material payload,
  active term flags, precision, and LLG timing parameters,
- the runner now executes bootstrap FEM CPU-reference plans,
- `StudyIR::Relaxation` exists and three algorithms are FDM-executable:
  `llg_overdamped`, `projected_gradient_bb`, and `nonlinear_cg`
  (see `0500-fdm-relaxation-algorithms.md` for full specification),
- higher-order FEM relaxation methods remain defined but not yet public-executable.

For FEM, relaxation is especially important because:

- curved geometries and open-boundary demag often make static equilibria the main target,
- explicit dynamic integration can be severely stiffness-limited,
- FE operators admit strong preconditioning and tangent-space linearization strategies.

Recommended algorithm families:

1. overdamped LLG with adaptive explicit integrator (bootstrap),
2. projected gradient / Barzilai–Borwein on FE nodal spheres,
3. nonlinear conjugate gradient with FE-aware preconditioning,
4. tangent-plane linearly implicit relaxation (recommended production target),
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
- energy decrease,
- norm defect,
- optionally projected residual norm.

Do **not** stop on energy stagnation alone.

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

This is the easiest bootstrap because it reuses the dynamic RHS machinery.
Use adaptive DOPRI54 or similar once explicit RK support exists.

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

preferably with lumped mass for bootstrap speed.
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

Current executable subset (FEM backend):

- `algorithm = "llg_overdamped"`

FDM-only (see `0500-fdm-relaxation-algorithms.md`):

- `algorithm = "projected_gradient_bb"`
- `algorithm = "nonlinear_cg"`

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

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [ ] Capability matrix
- [x] FDM backend (`llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`)
- [x] FEM backend (`llg_overdamped` on CPU reference)
- [ ] FEM backend (`projected_gradient_bb`, `nonlinear_cg` — need mass-weighted inner products)
- [ ] FEM backend (`tangent_plane_implicit`)
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] Tests / benchmarks
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
