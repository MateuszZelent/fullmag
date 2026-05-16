# FEM foundations for dipolar self-interaction (demagnetization) on MFEM/libCEED/hypre with GPU execution

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/material-assignment-and-spatial-fields-v0.md`
  - `docs/specs/output-naming-policy-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`

## 1. Problem statement

This note freezes the physical and numerical contract for the **dipolar self-interaction** in the
Fullmag FEM backend.

In micromagnetics, the long-range dipole-dipole interaction of the magnetization field is the same
physics that solver APIs typically expose as `Demag()`.
For FEM this interaction is not naturally implemented as a tensor-product convolution.
It is instead realized through a magnetostatic potential problem on a mesh, with open-boundary
behavior approximated or coupled through a dedicated magnetostatics strategy.

This note defines:

- the continuum dipolar interaction,
- the exact full-space weak formulation,
- the recommended first GPU-capable FEM implementation on **MFEM + libCEED + hypre**,
- the architecture seam required for later higher-fidelity open-boundary magnetostatics,
- the validation and provenance obligations for a serious FEM demag backend.

## 2. Physical model

### 2.1 Governing equations

Let

$$
\mathbf{M}(\mathbf{x},t)=M_s(\mathbf{x})\,\mathbf{m}(\mathbf{x},t),
\qquad
\|\mathbf{m}(\mathbf{x},t)\|=1.
$$

The dipolar self-interaction is described by magnetostatics in the absence of free current:

$$
\nabla\times\mathbf{H}_{\mathrm{d}}=0,
\qquad
\nabla\cdot\mathbf{B}=0,
\qquad
\mathbf{B}=\mu_0(\mathbf{H}_{\mathrm{d}}+\mathbf{M}).
$$

Introduce a scalar potential $u$ such that

$$
\mathbf{H}_{\mathrm{d}}=-\nabla u.
$$

Then in all space,

$$
\Delta u = \nabla\cdot\mathbf{M}
\quad\text{in }\mathbb{R}^3,
\qquad
u(\mathbf{x})\to 0 \text{ as } |\mathbf{x}|\to\infty.
$$

The magnetostatic energy is

$$
E_{\mathrm{d}}
=
\frac{\mu_0}{2}\int_{\mathbb{R}^3}|\nabla u|^2\,dV
=
-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf{M}\cdot\mathbf{H}_{\mathrm{d}}\,dV.
$$

As in FDM, Fullmag should treat user-facing `Demag()` and the physics phrase
"dipolar self-interaction" as exact synonyms.

### 2.2 Charge formulation and transmission conditions

Define magnetic charges

$$
\rho_m = -\nabla\cdot\mathbf{M},
\qquad
\sigma_m = \mathbf{M}\cdot\mathbf{n}.
$$

Then

$$
u(\mathbf{x})
=
\frac{1}{4\pi}\int_{\Omega_m}\frac{\rho_m(\mathbf{x}')}{|\mathbf{x}-\mathbf{x}'|}\,dV'
+
\frac{1}{4\pi}\int_{\partial\Omega_m}\frac{\sigma_m(\mathbf{x}')}{|\mathbf{x}-\mathbf{x}'|}\,dS'.
$$

Across the magnetic boundary $\partial\Omega_m$, the potential formulation satisfies

$$
[u] = 0,
\qquad
[\partial_n u] = -\mathbf{M}\cdot\mathbf{n},
$$

where the jump is taken as exterior minus interior.

These interface conditions are the FEM manifestation of the dipolar surface charges.

### 2.3 Full-space weak formulation

The clean full-space variational problem is:

Find $u\in \dot H^1(\mathbb{R}^3)$ such that

$$
\int_{\mathbb{R}^3} \nabla u\cdot\nabla v\,dV
=
\int_{\Omega_m} \mathbf{M}\cdot\nabla v\,dV
\qquad
\forall v\in \dot H^1(\mathbb{R}^3).
$$

Then

$$
\mathbf{H}_{\mathrm{d}} = -\nabla u \quad \text{in } \Omega_m.
$$

This is the formulation that the discrete FEM backend should approximate.

### 2.4 Tensor-kernel view

The same field can be written with the continuum dipolar kernel

$$
\mathcal{N}_{ij}(\mathbf{r}) = -\partial_i\partial_j\frac{1}{4\pi |\mathbf{r}|},
$$

through

$$
\mathbf{H}_{\mathrm{d}}(\mathbf{x})
=
-\int_{\Omega_m}\mathcal{N}(\mathbf{x}-\mathbf{x}')\,\mathbf{M}(\mathbf{x}')\,dV'.
$$

The FEM backend does not evaluate this as a regular-grid convolution.
But this identity is still important, because it is the common continuum operator shared with FDM.

### 2.5 Symbols and SI units

| Symbol | Meaning | Unit |
|--------|---------|------|
| $\mathbf{m}$ | reduced magnetization | 1 |
| $\mathbf{M}$ | magnetization density | A/m |
| $M_s$ | saturation magnetization | A/m |
| $\mathbf{H}_{\mathrm{d}}$ | dipolar/demag field | A/m |
| $u$ | magnetic scalar potential | A |
| $\mu_0$ | vacuum permeability | N/A$^2$ |
| $\rho_m$ | volume magnetic charge | A/m$^2$ |
| $\sigma_m$ | surface magnetic charge | A/m |
| $\Omega_m$ | magnetic region | — |
| $D$ | truncated FEM computational domain | — |
| $V_h$ | vector FE space for magnetization | — |
| $W_h$ | scalar FE space for potential | — |

### 2.6 Assumptions and approximations

- The first production FEM backend uses low-order continuous vector-valued $H^1$ magnetization.
- The dipolar solve is magnetostatic and open-boundary in physics.
- The first GPU-capable FEM implementation may approximate open boundaries by a truncated air box.
- Higher-fidelity open-boundary strategies must remain possible behind the same operator seam.
- The intended FEM/GPU stack is **MFEM for spaces/forms**, **libCEED for GPU operator action**,
  and **hypre for iterative solvers/preconditioning**.

## 3. Numerical interpretation

### 3.1 FDM interpretation

In FDM, the same dipolar physics is realized as an exact cell-averaged tensor convolution on a
regular grid, typically accelerated with FFTs.
See:

- `0420-fdm-dipolar-demag-foundations.md`

### 3.2 FEM interpretation

#### 3.2.1 Discrete spaces

Let the magnetization live on the magnetic domain $\Omega_m$ and the magnetostatic potential on a
computational domain $D \supset \Omega_m$.
For the first FEM implementation, use

$$
V_h \subset [H^1(\Omega_m)]^3,
\qquad
W_h \subset H^1(D).
$$

Write

$$
\mathbf{m}_h(\mathbf{x}) = \sum_a \mathbf{m}_a\,\phi_a(\mathbf{x}),
\qquad
\mathbf{M}_h(\mathbf{x}) = M_s(\mathbf{x})\,\mathbf{m}_h(\mathbf{x}).
$$

#### 3.2.2 First GPU-capable realization: truncated air-box solve

The recommended first executable FEM demag implementation is a **truncated air-box potential
solve**, because it maps cleanly to MFEM/libCEED/hypre and therefore to GPUs.

Choose a computational domain

$$
D = \Omega_m \cup \Omega_{\mathrm{air}}
$$

with the magnetic body inside an air region extending sufficiently far outward.
Then solve:

Find $u_h\in W_h$ such that

$$
\int_D \nabla u_h\cdot\nabla v_h\,dV
+
\int_{\partial D} \beta\,u_h v_h\,dS
=
\int_{\Omega_m} \mathbf{M}_h\cdot\nabla v_h\,dV
\qquad
\forall v_h\in W_h.
$$

Special cases:

- $\beta=0$ with strong Dirichlet $u_h=0$ on $\partial D$,
- a Robin boundary with $\beta \approx 1/R$ as a better far-field approximation,
- later shell-transformation variants that mimic infinite domains more accurately.

Once $u_h$ is known,

$$
\mathbf{H}_{\mathrm{d},h} = -\nabla u_h \quad \text{in } \Omega_m.
$$

To feed LLG, Fullmag should either:

1. evaluate $-\nabla u_h$ directly at quadrature points inside the micromagnetic residual/operator,
   or
2. perform an $L^2$ projection into a vector field representation used by the time integrator.

The first option is usually better for a matrix-free GPU path because it avoids extra global field
projection unless artifacts require it.

#### 3.2.3 Why this is the right first FEM/GPU implementation

A truncated-air-box Poisson solve has three important properties:

- it is already the correct dipolar physics except for the outer-boundary approximation,
- it is compatible with **MFEM + libCEED partial assembly** on GPUs,
- it can be solved with **hypre** iterative methods and AMG-style preconditioners.

This is therefore the best first production target for a GPU-aware FEM backend.
It is much more realistic than trying to ship a full FEM-BEM or FMM magnetostatics backend on day
one.

#### 3.2.4 Architecture seam for later higher-fidelity magnetostatics

Although the first executable FEM demag path should be the truncated air-box solve, the code must
not hard-wire "demag = air box forever".

The magnetostatic operator should sit behind a realization seam such as:

- `fem_demag_airbox`,
- `fem_demag_shell_transform`,
- later `fem_demag_bem_fmm` or `fem_demag_hmatrix`.

All of these must publish the same physical observable names:

- `H_demag`,
- `E_demag`.

This keeps future exact/open-boundary methods from requiring public-API surgery.

#### 3.2.5 MFEM/libCEED/hypre execution model

The intended implementation pattern is:

- **MFEM** owns the mesh, finite element collections, spaces, grid functions, and bilinear forms,
- **libCEED** evaluates the Laplace operator and related local actions with partial assembly on GPU,
- **hypre** solves the resulting global linear system with CG/GMRES + suitable preconditioning,
- the LLG operator consumes the resulting demag field in the magnetic domain.

In practice:

- the left-hand side is a scalar $H^1$ Laplacian-like operator on $D$,
- the right-hand side is the coupling term
  $$
  \int_{\Omega_m} \mathbf{M}_h\cdot\nabla v_h\,dV,
  $$
- the field fed to LLG is the negative gradient on $\Omega_m$,
- artifact export may later project this field into a user-facing vector field representation.

This decomposition is GPU-friendly because the expensive local operator applications are handled by
partial assembly and device-resident quadrature kernels.

#### 3.2.6 Reusable Poisson RHS workspace

The time-domain Poisson demag path evaluates the same right-hand side at every
effective-field evaluation:

$$
b(v_h) = \int_{\Omega_m} \mathbf{M}_h\cdot\nabla v_h\,dV.
$$

Reusing the MFEM right-hand-side assembly object is a numerical implementation
optimization only.  It must not change:

- the magnetic source, $\mathbf{M}_h=M_s\mathbf{m}_h$,
- the magnetic-domain restriction of the source term,
- the air-domain zero source,
- Dirichlet, Robin, or periodic demag boundary semantics,
- the recovered observable $\mathbf{H}_{\mathrm{d},h}=-\nabla u_h$,
- the demag energy observable.

For a reusable `LinearForm`, the coefficient supplying $\mathbf{M}_h$ must have
a lifetime at least as long as the integrator that stores it.  A coefficient may
update its pointer to the current magnetization before each assembly, but it
must not retain a reference to a temporary per-call vector after assembly
returns.  This lifetime rule is part of the physical correctness contract,
because a stale magnetization source would assemble the Poisson equation for
the wrong state even if the weak form is unchanged.

The first production optimization for this path is therefore:

- allocate the Poisson RHS `LinearForm`, its `DomainLFGradIntegrator`, and the
  true-DOF RHS vector during Poisson initialization,
- update only the current magnetization source before each RHS assembly,
- zero and reassemble the reusable form for each effective-field evaluation,
- keep `demag_solve_count`, iterations, residuals, `H_demag`, and `E_demag`
  reporting unchanged.

This does not replace the later GPU target: a libCEED/MFEM device-side
right-hand-side QFunction remains the intended follow-up once host/device
transfer and field-recovery bottlenecks are addressed.

#### 3.2.7 Multi-material interfaces and curved boundaries

In FEM, curved boundaries and material interfaces are represented by the mesh itself rather than by
staircasing.
The magnetic charges generated by normal jumps are naturally captured by the weak formulation.
For piecewise materials,

$$
\mathbf{M}_h = M_s(\mathbf{x})\,\mathbf{m}_h
$$

must be evaluated region-wise.
If $M_s$ is discontinuous, the weak form remains valid as a region-integrated source term.

### 3.3 Hybrid interpretation

Hybrid dipolar execution is deferred.
A future hybrid backend may couple a mesh region to a regular-grid magnetostatic solve, but no such
scheme belongs in the first contract freeze.

### 3.4 Semantic differences between backends

Shared invariant:

- both backends implement the same continuum dipolar interaction,
- both publish `H_demag` and `E_demag`,
- both act on $\mathbf{M}=M_s\mathbf{m}$, not on raw reduced magnetization alone.

Numerical difference:

- **FDM** uses exact cell-averaged tensor convolution,
- **FEM** uses a potential solve on a mesh,
- the first FEM/GPU path approximates open boundaries with an air-box or shell-like realization,
- higher-fidelity FEM magnetostatics is a later backend realization, not a new public physics term.

## 4. API and IR impact

### 4.1 Python API objects

The public object remains:

```python
fm.Demag()
```

Its documentation should explicitly call this the dipolar self-interaction / demagnetizing field.
No FEM-specific user object is required for v1.

### 4.2 `ProblemIR` fields

`EnergyTermIR::Demag` remains the semantic marker.
The FEM execution plan should record realization-specific metadata such as:

- `operator_kind = "fem_demag_airbox"`,
- `outer_domain_kind`,
- `outer_boundary_condition`,
- `solver_kind`,
- `preconditioner_kind`,
- `assembly_mode = "partial" | "matrix_free" | "assembled"`,
- `field_realization = "quadrature" | "projected_vector_field"`.

### 4.3 Planner impact

The planner must:

- reject executable FEM demag unless a legal realization is available,
- derive or validate the outer air-box/shell domain,
- choose a scalar FE space for the potential solve,
- ensure output legality for `H_demag` and `E_demag`,
- record the boundary approximation explicitly in provenance.

### 4.4 Capability-matrix impact

The capability matrix should distinguish at least:

- semantic support for `Demag`,
- internal-reference FEM dipolar operator,
- public-executable FEM air-box demag,
- deferred higher-fidelity open-boundary realizations.

## 5. Validation strategy

### 5.1 Analytical checks

- positivity of $E_{\mathrm{d}}$,
- convergence of average demag field for uniformly magnetized ellipsoidal/spheroidal cases,
- air-box size convergence toward the full-space solution,
- symmetry and consistency of the scalar-potential solve.

### 5.2 Cross-backend checks

- FDM vs FEM comparison for a box geometry that both can represent,
- projected `H_demag` comparison at matched times,
- `E_demag` convergence under mesh/grid refinement.

### 5.3 Regression cases

- uniformly magnetized sphere or near-sphere mesh,
- thin film and long strip geometries exhibiting strong shape anisotropy,
- multi-material mesh with piecewise $M_s$,
- air-box radius refinement studies.

### 5.4 Observables and tolerances

Required observables:

- `H_demag`,
- `E_demag`,
- `time`,
- `step`,
- `solver_stats.linear_iterations`,
- `solver_stats.demag_residual_norm`.

FEM tolerances must separate:

- discretization error in the magnetic mesh,
- outer-boundary truncation error,
- linear-solver tolerance.

## 6. Completeness checklist

- [ ] Python docs describe `Demag()` as dipolar self-interaction
- [ ] `ProblemIR` semantics frozen for dipolar interaction
- [ ] FEM planner emits demag realization metadata
- [ ] capability matrix distinguishes semantic vs executable FEM demag
- [ ] first FEM realization uses MFEM/libCEED/hypre-compatible air-box solve
- [ ] `H_demag` can be consumed by the LLG operator without ad hoc copies
- [ ] `E_demag` is published in physical units
- [ ] validation suite includes air-box refinement and FDM/FEM comparison
- [ ] provenance records boundary approximation and solver configuration
- [ ] documentation explains that better open-boundary methods are realizations, not new physics terms

## 7. Known limits and deferred work

- exact full-space FEM magnetostatics is not required for the first executable GPU FEM path,
- full FEM-BEM / H-matrix / FMM magnetostatics is deferred,
- hybrid FDM/FEM dipolar coupling is deferred,
- high-order FE spaces are deferred,
- periodic magnetostatics is out of scope for the current contract,
- eigenmode workflows should reuse the same dipolar operator later but are not defined here in full.
