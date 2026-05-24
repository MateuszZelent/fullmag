# FEM magnetoelastic small-strain (MFEM GPU)

- Status: draft
- Owners: fullmag-core
- Last updated: 2026-03-31
- Parent note: `docs/physics/0700-shared-magnetoelastic-semantics.md`
- Related specs: `docs/specs/mechanical-bc-policy-v0.md`
- Related physics notes: `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`

## 1. Problem statement

This note specifies the FEM discretization of small-strain magnetoelastic interactions using
the MFEM + libCEED + hypre stack. The FEM elasticity solver reuses the same technology stack
that FullMag already deploys for FEM exchange/demag, adding displacement as an additional FE
field variable.

## 2. Physical model

See parent note `0700-shared-magnetoelastic-semantics.md` for the continuum formulation.

Prescribed-strain FEM/GPU inputs use Voigt engineering-shear order
`[e11, e22, e33, 2e23, 2e13, 2e12]`. CPU and GPU evaluators convert the last
three entries to tensor shear before applying the B1/B2 energy and field
formula, so the factor `2 B2` in the tensor-strain expression is not silently
absorbed into the public input convention.

## 3. Numerical interpretation — FEM

### 3.1 Finite element spaces

| Field | Space | Order | Notes |
|-------|-------|-------|-------|
| Magnetization $\mathbf{m}$ | $V_h \subset [H^1(\Omega_m)]^3$ | P1 | Existing FEM framework |
| Displacement $\mathbf{u}$ | $U_h \subset [H^1(\Omega_s)]^d$ | P1 (V1), P2 (future) | New |
| Demag potential $\phi$ | $W_h \subset H^1(D)$ | P1 | Existing |

**Important**: $\Omega_m$ (magnetic domain), $\Omega_s$ (elastic domain), and $D$ (demag
domain including air) may be **different meshes**. In the simplest case $\Omega_m = \Omega_s$
(same body is both magnetic and elastic). In general, $\Omega_s$ may be larger (e.g., a
substrate + ferromagnetic film).

### 3.2 Weak form — quasistatic elasticity

Find $\mathbf{u}_h \in U_h$ such that for all $\mathbf{v}_h \in U_h$:

$$
\int_{\Omega_s} \boldsymbol{\sigma}(\mathbf{u}_h) : \boldsymbol{\varepsilon}(\mathbf{v}_h) \, dV =
\int_{\Omega_s} (\mathbf{C} : \boldsymbol{\varepsilon}^{\text{mag}}) : \boldsymbol{\varepsilon}(\mathbf{v}_h) \, dV +
\int_{\partial\Omega_s^N} \mathbf{t} \cdot \mathbf{v}_h \, dS
$$

where $\mathbf{t}$ is the prescribed traction on Neumann boundaries.

The LHS bilinear form is:

$$
a(\mathbf{u}, \mathbf{v}) = \int_{\Omega_s} C_{ijkl} \varepsilon_{kl}(\mathbf{u}) \varepsilon_{ij}(\mathbf{v}) \, dV
$$

which is symmetric, positive-definite (with Dirichlet BC on part of boundary or constrained
rigid-body motions).

### 3.3 Boundary conditions

- **Traction-free** (natural BC): no surface integral term. This is the default.
- **Clamped** (essential BC): $\mathbf{u} = 0$ enforced on boundary DOFs.
- **Prescribed displacement**: essential BC $\mathbf{u} = \mathbf{u}_0$ on boundary.
- **Prescribed traction**: Neumann BC adds surface integral $\int \mathbf{t} \cdot \mathbf{v} \, dS$.

### 3.4 MFEM / libCEED / hypre realization

| Component | Role |
|-----------|------|
| MFEM | Mesh, FE spaces, bilinear forms, boundary markers |
| libCEED | Partial assembly / element kernels for elasticity operator |
| hypre (BoomerAMG) | Preconditioned CG solve |

This is the same technology stack used for exchange, demag, and DMI operators in the existing
FEM framework.

### 3.5 Transfer operators

When $\Omega_m \neq \Omega_s$ (magnetic and elastic domains are on different meshes), the
planner must build transfer operators:

1. **$\mathbf{m} \to \boldsymbol{\varepsilon}^{\text{mag}}$** source on the elastic mesh:
   - If same mesh: direct evaluation.
   - If different meshes: L2 projection or nearest-point interpolation.

2. **$\mathbf{u}/\boldsymbol{\varepsilon} \to \mathbf{H}_{\text{mel}}$** on magnetization
   quadrature points:
   - Direct if same mesh; transfer operator if different.

3. **Mesh-native output**: FEM outputs preserve coordinates, connectivity, and FE metadata.
   OVF-compatible sampled exports use the existing grid projection contract.

### 3.6 Dynamic coupling (deferred)

Decoupled energy-aware scheme:

1. Mechanical step: implicit Newmark-β or HHT-α.
2. Magnetic step: tangent-plane or midpoint-stabilized LLG.
3. Discrete energy monitoring.
4. Operator / Jacobian hooks from the start.

Based on the scheme in Pfeiler et al. (2023): linear, decoupled, with discrete energy law.

## 4. API, IR, and planner impact

### 4.1 FemPlanIR extensions

```rust
pub struct FemMechanicalPlanIR {
    pub displacement_order: u32,
    pub elastic_material: ElasticMaterialIR,
    pub magnetostriction_law: MagnetostrictionLawIR,
    pub mechanical_bcs: Vec<MechanicalBoundaryConditionIR>,
    pub mechanical_mesh_asset: Option<String>,  // if different from magnetic mesh
}
```

### 4.2 Capability matrix impact

| Phase | Status |
|-------|--------|
| Prescribed strain (Mode 1) | internal-reference |
| Quasistatic FEM (Mode 2) | internal-reference → public-executable |
| Dynamic FEM (Mode 3) | semantic-only |

## 5. Validation strategy

### 5.1 Analytical checks

Same as FDM note `0710`, plus:
- Convergence rate study: P1 elements should show O(h) convergence in H1 seminorm, O(h²) in L2 for smooth solutions.
- Patch test: uniform stress state recovered exactly by P1 elements on affine meshes.

### 5.2 Cross-backend checks

- FDM vs FEM parity for Box geometry with identical material and initial conditions.
- Compare $E_{\text{mel}}$, $E_{\text{el}}$, $\langle\mathbf{u}\rangle$, $\langle\sigma_{\text{VM}}\rangle$.

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FEM backend — Mode 1
- [ ] FEM backend — Mode 2
- [ ] FEM backend — Mode 3
- [ ] Transfer operators
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [ ] Documentation

## 7. Known limits and deferred work

1. Only P1 displacement elements in V1.
2. Transfer operators between different meshes not yet implemented.
3. Dynamic decoupled scheme not yet implemented.
4. GPU-native libCEED elasticity kernel not yet profiled.

## 8. References

See parent note `0700-shared-magnetoelastic-semantics.md`, plus:

1. Pfeiler, C.M., Ruggeri, M., Stiftner, B., et al. "A decoupled, convergent and fully linear
   algorithm for the Landau–Lifshitz–Gilbert equation with magnetoelastic effects."
   arXiv:2309.00605, 2023.
2. Anderson, R., et al. "MFEM: A modular finite element methods library." *Computers &
   Mathematics with Applications*, 81, 42–74, 2021.
