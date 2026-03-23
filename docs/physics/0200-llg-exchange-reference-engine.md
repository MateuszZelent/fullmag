# LLG and exchange reference engine

- Status: draft (internal-reference; Phase 1 target: public-executable)
- Owners: Fullmag core
- Last updated: 2026-03-23
- Related ADRs: `docs/adr/0001-physics-first-python-api.md`
- Related specs: `docs/specs/problem-ir-v0.md`, `docs/specs/capability-matrix-v0.md`, `docs/specs/exchange-only-full-solver-architecture-v1.md`, `docs/specs/phase-0-1-implementation-plan.md`

## 1. Problem statement

Fullmag needs a first numerical engine slice that exercises real micromagnetic time integration
without pretending that the full FDM/FEM/hybrid stack already exists.

The first implementation target is therefore intentionally narrow:

- Landau-Lifshitz-Gilbert dynamics,
- ordinary ferromagnetic exchange,
- Cartesian finite differences,
- a reference CPU implementation,
- explicit time stepping for validation and future backend parity work.

This slice is not the production FDM backend. It is the canonical numerical baseline for:

- validating sign conventions and SI units,
- testing magnetization normalization logic,
- fixing the first backend-neutral semantics for `LLG` and `Exchange`,
- providing a trustworthy reference against future CUDA kernels.

## 2. Physical model

### 2.1 Governing equations

The state variable is the reduced magnetization

\[
\mathbf{m}(\mathbf{r}, t) = \frac{\mathbf{M}(\mathbf{r}, t)}{M_s},
\qquad
\lVert \mathbf{m} \rVert = 1.
\]

The first engine slice uses the Gilbert form of LLG with effective field limited to exchange:

\[
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma}{1 + \alpha^2}
\left(
\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}
+
\alpha \, \mathbf{m} \times
\left(\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}\right)
\right),
\]

with

\[
\mathbf{H}_{\mathrm{eff}} = \mathbf{H}_{\mathrm{ex}},
\qquad
\mathbf{H}_{\mathrm{ex}} =
\frac{2 A}{\mu_0 M_s} \nabla^2 \mathbf{m}.
\]

The corresponding exchange energy density is

\[
e_{\mathrm{ex}} = A
\left(
\left\lVert \partial_x \mathbf{m} \right\rVert^2 +
\left\lVert \partial_y \mathbf{m} \right\rVert^2 +
\left\lVert \partial_z \mathbf{m} \right\rVert^2
\right).
\]

### 2.2 Symbols and SI units

- `m`: reduced magnetization, dimensionless.
- `M_s`: saturation magnetization, `A/m`.
- `A`: exchange stiffness, `J/m`.
- `alpha`: Gilbert damping, dimensionless.
- `gamma`: gyromagnetic ratio used in the reduced LLG form, `m / (A s)`.
- `mu0`: vacuum permeability, `N / A^2 = T m / A`.
- `H_ex`, `H_eff`: effective field, `A/m`.
- `t`: time, `s`.

### 2.3 Assumptions and approximations

- Single-phase ferromagnet only.
- Spatially local `M_s`, `A`, and `alpha` per reference problem.
- Exchange is the only active interaction term.
- No demagnetization, anisotropy, DMI, Zeeman, spin torque, temperature, or elastic coupling.
- Zero-normal-derivative boundary treatment for the first FDM reference implementation.
- Magnetization is renormalized after predictor and corrector updates to control explicit-step drift.

## 3. Numerical interpretation

### 3.1 FDM

The implemented reference discretization is a Cartesian grid with cell sizes
`\Delta x`, `\Delta y`, `\Delta z`.

For each cell, the Laplacian is approximated with second-order central differences:

\[
\nabla^2 \mathbf{m}_{i,j,k}
\approx
\frac{\mathbf{m}_{i+1,j,k} - 2 \mathbf{m}_{i,j,k} + \mathbf{m}_{i-1,j,k}}{\Delta x^2}
+
\frac{\mathbf{m}_{i,j+1,k} - 2 \mathbf{m}_{i,j,k} + \mathbf{m}_{i,j-1,k}}{\Delta y^2}
+
\frac{\mathbf{m}_{i,j,k+1} - 2 \mathbf{m}_{i,j,k} + \mathbf{m}_{i,j,k-1}}{\Delta z^2}.
\]

At external boundaries, the first slice uses mirrored ghost values, equivalent to a homogeneous
Neumann boundary condition `\partial_n m = 0`.

Time integration uses explicit Heun:

1. evaluate `k1 = f(m_n)`,
2. predict `m* = normalize(m_n + dt * k1)`,
3. evaluate `k2 = f(m*)`,
4. correct `m_{n+1} = normalize(m_n + 0.5 * dt * (k1 + k2))`.

This is good enough for a trusted baseline, while remaining simple to compare against future GPU
implementations.

### 3.2 FEM

The continuous exchange model is identical, but the reference engine added in this milestone does
not implement FEM assembly or time stepping yet.

The future FEM form should remain consistent with the same `e_ex` and `H_ex` definitions.

### 3.3 Hybrid

Hybrid execution is out of scope for this slice.
The important invariant is semantic, not numerical: `Exchange` means the same continuum term in
all backends, even though only the FDM reference implementation exists today.

## 4. API, IR, and planner impact

### 4.1 Python API surface

`LLG` needs the first execution-relevant semantics:

- `gamma`,
- `integrator`,
- optional fixed time step.

`Exchange` remains a backend-neutral energy term with parameters sourced from material data.

### 4.2 ProblemIR representation

`DynamicsIR::Llg` should carry at least:

- `gyromagnetic_ratio`,
- `integrator`,
- optional `fixed_timestep`.

`MaterialIR` already carries:

- `exchange_stiffness`,
- `damping`,
- `saturation_magnetisation`.

No grid-centric indexing should leak into shared `ProblemIR`.
Reference-engine-only grid shape and field storage stay below the IR boundary for now.

### 4.3 Planner and capability-matrix impact

- `Exchange` and `LLG` remain legal shared terms in `strict` mode.
- End-to-end execution from public Python scripts is still planner-first because voxelizers and
  richer initial conditions are not implemented yet.
- A reference FDM engine may exist before public `ProblemIR -> backend` lowering is complete.
  That is acceptable as long as the docs are explicit.

## 5. Validation strategy

### 5.1 Analytical checks

- Uniform magnetization must give zero exchange field and zero LLG right-hand side.
- The discrete exchange field must match the expected second-difference stencil on small 1D/3D
  toy problems.
- The gyromagnetic sign convention must agree with the chosen Gilbert-form equation above.

### 5.2 Cross-backend checks

- Not applicable yet for production backends.
- The reference engine becomes the baseline for future CUDA/FDM parity tests.
- The same physical sign conventions will later be checked against FEM exchange operators.

### 5.3 Regression tests

- unit test for zero-field uniform state,
- unit test for a non-uniform exchange stencil,
- unit test that explicit stepping preserves `|m| = 1` after normalization,
- unit test that exchange energy does not increase for a damped relaxation step with sufficiently
  small `dt`,
- CLI smoke/demo for a tiny deterministic exchange-only run.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [ ] Planner
- [x] Capability matrix
- [x] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

For this note, `FDM backend` means a reference CPU implementation, not the future production CUDA
backend.

## 7. Known limits and deferred work

- No voxelizer or geometry-to-grid lowering yet.
- No non-uniform initial magnetization in the public Python API yet.
- No adaptive time stepping yet.
- No demag, DMI, anisotropy, Zeeman, torque terms, or thermal noise.
- No FEM or hybrid execution path.
- No public Python `Simulation.run()` wiring into the reference engine yet.

## 8. References

1. T. L. Gilbert, "A phenomenological theory of damping in ferromagnetic materials," IEEE Trans.
   Magn. 40, 3443-3449 (2004 reprint).
2. A. Aharoni, *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University Press.
3. μMAG standard problem conventions for micromagnetic validation.
