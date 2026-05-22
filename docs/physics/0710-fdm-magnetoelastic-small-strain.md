# FDM magnetoelastic small-strain

- Status: draft
- Owners: fullmag-core
- Last updated: 2026-03-31
- Parent note: `docs/physics/0700-shared-magnetoelastic-semantics.md`
- Related specs: `docs/specs/mechanical-bc-policy-v0.md`

## 1. Problem statement

This note specifies the FDM discretization of small-strain magnetoelastic interactions on a
regular Cartesian grid. It covers both the prescribed-strain inverse mode and the full
quasistatic bidirectional coupling. Full elastodynamics is also described but deferred to a
later execution phase.

## 2. Physical model

See parent note `0700-shared-magnetoelastic-semantics.md` for the continuum formulation.

This note adds only FDM-specific discretization choices.

## 3. Numerical interpretation — FDM

### 3.1 Grid layout

**V1 (collocated)**:

Displacement $\mathbf{u}$ is stored at cell centers, collocated with $\mathbf{m}$.
This is the simplest choice and avoids interpolation between staggered grids.

Mechanical DOFs per cell: 3 (displacement components $u_x, u_y, u_z$).

**V2 (deferred — staggered)**:

Face-staggered layout with $u_x$ on $x$-faces, $u_y$ on $y$-faces, $u_z$ on $z$-faces.
Better avoids odd-even decoupling in the stress-equilibrium system but increases implementation
complexity. Planned as a hidden `FdmPlanIR` switch:

```
mechanical_layout = "collocated" | "staggered"
```

### 3.2 Strain operator

For collocated layout, strain components are computed via central differences:

$$
\varepsilon_{xx,i} = \frac{u_{x,i+1} - u_{x,i-1}}{2 \Delta x}
$$

$$
\varepsilon_{xy,i} = \frac{1}{2}\left(\frac{u_{x,j+1} - u_{x,j-1}}{2 \Delta y} + \frac{u_{y,i+1} - u_{y,i-1}}{2 \Delta x}\right)
$$

where index $i$ varies along $x$ and $j$ along $y$. All six independent Voigt components
($\varepsilon_{11}, \varepsilon_{22}, \varepsilon_{33}, \varepsilon_{23}, \varepsilon_{13}, \varepsilon_{12}$)
are computed this way.

### 3.3 Mechanical boundary conditions

Default: **traction-free** (Neumann) on all free surfaces.

FDM realization via ghost cells:

- For $\nabla \cdot \boldsymbol{\sigma} = 0$ solve: ghost displacement values are set
  such that the outward traction vanishes:
  $\sigma_{ij} n_j = 0$ on $\partial\Omega$.
- For axis-aligned box geometry, this reduces to:
  - $\sigma_{xx} = 0$ at $x$-boundaries: $u_{x,-1} = u_{x,1}$ (symmetric extension when no
    shear coupling), or computed from the constitutive law closure.
  - Analogous for other faces.

Clamped (Dirichlet): $\mathbf{u} = \mathbf{u}_0$ enforced directly at boundary cells.

See `docs/specs/mechanical-bc-policy-v0.md` for the full BC policy.

### 3.4 Mode 1 — Prescribed strain/stress

No mechanical solve. User provides $\boldsymbol{\varepsilon}$ or $\boldsymbol{\sigma}$ directly.

Algorithm per step:

1. Compute $\boldsymbol{\varepsilon}^{\text{mag}}(\mathbf{m})$ from magnetostriction law.
2. Compute $E_{\text{mel}}$ from prescribed $\boldsymbol{\varepsilon}$ and $\boldsymbol{\varepsilon}^{\text{mag}}$.
3. Compute $\mathbf{H}_{\text{mel}}$ as variational derivative.
4. Add $\mathbf{H}_{\text{mel}}$ to $\mathbf{H}_{\text{eff}}$.
5. Proceed with LLG step.

Published observables: $\mathbf{H}_{\text{mel}}$, $E_{\text{mel}}$.

Current FDM implementation status for Mode 1:

- CPU AoS reference path evaluates uniform and per-cell prescribed strain through the shared
  magnetoelastic single-cell formula.
- CPU SoA hot path produces bitwise-equivalent effective-field contributions for the same
  prescribed-strain configurations while preserving the public AoS state boundary.
- This slice does not add new Python API, ProblemIR, planner, runtime resource, or workspace
  semantics; it only changes the CPU FDM execution layout for an already lowered term.

### 3.5 Mode 2 — Quasistatic bidirectional coupling

State: $(\mathbf{m}, \mathbf{u})$.

Algorithm per LLG step:

1. From $\mathbf{m}$: compute $\boldsymbol{\varepsilon}^{\text{mag}}(\mathbf{m})$.
2. Solve quasistatic equilibrium $\nabla \cdot \boldsymbol{\sigma} = 0$ for $\mathbf{u}$:
   - Build RHS from divergence of $\mathbf{C} : \boldsymbol{\varepsilon}^{\text{mag}}$.
   - Solve with CG (preconditioned with diagonal or Jacobi).
   - BC: traction-free on free surfaces (default).
3. Compute $\boldsymbol{\varepsilon}(\mathbf{u})$ via central differences.
4. Compute $\boldsymbol{\sigma} = \mathbf{C}:(\boldsymbol{\varepsilon} - \boldsymbol{\varepsilon}^{\text{mag}})$.
5. Compute $E_{\text{mel}}$, $E_{\text{el}}$.
6. Compute $\mathbf{H}_{\text{mel}}$ from $\boldsymbol{\varepsilon}$ and $\mathbf{m}$.
7. Add $\mathbf{H}_{\text{mel}}$ to $\mathbf{H}_{\text{eff}}$.
8. Perform LLG step for $\mathbf{m}$.
9. (Optional) Picard sweep: repeat steps 1–8 for $N_{\text{picard}} \leq 3$ iterations
   if $|\mathbf{u}^{(k)} - \mathbf{u}^{(k-1)}| > \text{tol}$.

Published observables: $\mathbf{u}$, $\boldsymbol{\varepsilon}$, $\boldsymbol{\sigma}$,
$\mathbf{H}_{\text{mel}}$, $E_{\text{mel}}$, $E_{\text{el}}$, `elastic_residual_norm`.

### 3.6 Mode 3 — Full elastodynamics (deferred)

State: $(\mathbf{m}, \mathbf{u}, \mathbf{v})$.

Equations:
- LLG for $\mathbf{m}$,
- $\dot{\mathbf{u}} = \mathbf{v}$,
- $\rho \dot{\mathbf{v}} = \nabla \cdot \boldsymbol{\sigma} + \mathbf{f}$.

Time integration: explicit (Verlet or Newmark-β) for mechanics, with CFL constraint:

$$
\Delta t_{\text{mech}} \leq \frac{\Delta x}{\sqrt{C_{11}/\rho}}
$$

Additional observables: $\dot{\mathbf{u}}$, $E_{\text{kin,el}}$.

**Not implemented in Phase C/D.** Deferred to Phase E.

## 4. API, IR, and planner impact

### 4.1 FdmPlanIR extensions

```rust
pub struct FdmMechanicalPlanIR {
    pub mechanical_layout: String,          // "collocated" | "staggered"
    pub elastic_material: ElasticMaterialIR,
    pub magnetostriction_law: MagnetostrictionLawIR,
    pub mechanical_bcs: Vec<MechanicalBoundaryConditionIR>,
    pub solver: MechanicalSolverIR,         // CG tolerance, max iter
}
```

### 4.2 Capability matrix impact

| Phase | Status |
|-------|--------|
| Prescribed strain (Mode 1) | internal-reference |
| Quasistatic (Mode 2) | public-executable (FDM) |
| Elastodynamics (Mode 3) | semantic-only |

## 5. Validation strategy

### 5.1 Analytical checks

1. Uniform $\mathbf{m} = (1,0,0)$ in cubic material: $\boldsymbol{\varepsilon}^{\text{mag}}$ matches analytical expression.
2. Zero coupling: $B_1 = B_2 = 0 \Rightarrow \mathbf{H}_{\text{mel}} = 0$, mechanical solve gives $\mathbf{u} = 0$.
3. Finite-difference gradient check: $-\delta E_{\text{mel}}/\delta m_i \approx H_{\text{mel},i}$.
4. Clamped bar: known strain profile under uniform magnetization.
5. Convergence with grid refinement: 2nd order for collocated central differences.

### 5.2 Cross-backend checks

- FDM vs FEM parity for Box geometry (Phase D vs Phase E).

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [x] FDM backend — Mode 1 CPU AoS reference prescribed strain
- [x] FDM backend — Mode 1 CPU SoA hot path parity
- [ ] FDM backend — Mode 1 GPU
- [ ] FDM backend — Mode 2
- [ ] FDM backend — Mode 3
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [ ] Documentation

## 7. Known limits and deferred work

1. Collocated grid may exhibit odd-even decoupling for certain BC configurations; staggered layout is the long-term fix.
2. CG solver without preconditioning may be slow for large grids; AMG preconditioning is deferred.
3. Elastodynamics stability (CFL) is not yet analyzed for coupled LLG+mechanics.
4. CUDA GPU implementation deferred to Phase 3A.

## 8. References

See parent note `0700-shared-magnetoelastic-semantics.md`.
