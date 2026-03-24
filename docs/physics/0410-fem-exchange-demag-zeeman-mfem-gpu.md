# FEM foundations for exchange, demagnetization, and external field on MFEM/libCEED/hypre

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-23
- Related ADRs: `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/material-assignment-and-spatial-fields-v0.md`
  - `docs/specs/output-naming-policy-v0.md`
  - `docs/specs/exchange-bc-policy-v0.md`
  - `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Related physics notes:
  - `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/0200-llg-exchange-reference-engine.md`

## 1. Problem statement

This note defines the physical and numerical foundation for implementing the three core
micromagnetic interactions in the Fullmag FEM backend:

- exchange,
- demagnetization,
- external (Zeeman) field.

The intended FEM architecture remains:

- **MFEM** for mesh handling, FE spaces, forms, and operator ownership,
- **libCEED** for matrix-free / partial-assembly operator evaluation on GPUs,
- **hypre** for iterative solvers and preconditioning where global linear solves are needed.

This note therefore serves two purposes simultaneously:

1. freeze the continuum and weak-form semantics so FDM/FEM stay physically aligned,
2. define the *GPU-aware FEM implementation target* so future work does not drift into a
   CPU-only or mesh-library-specific dead end.

At the time of writing, FEM remains non-executable in the public product path.
This is therefore a design-frozen physics note, not a description of already shipped FEM behavior.

## 2. Physical model

### 2.1 Governing equations

The reduced magnetization is

$$
\mathbf{m}(\mathbf{x}, t) = \frac{\mathbf{M}(\mathbf{x}, t)}{M_s(\mathbf{x})},
\qquad
\|\mathbf{m}\| = 1,
$$

with

$$
\mathbf{M}(\mathbf{x}, t)=M_s(\mathbf{x})\,\mathbf{m}(\mathbf{x}, t).
$$

The effective field entering LLG is

$$
\mathbf{H}_{\mathrm{eff}}
=
\mathbf{H}_{\mathrm{ex}}
+
\mathbf{H}_{\mathrm{demag}}
+
\mathbf{H}_{\mathrm{ext}}
+\cdots
$$

and is related to the energy functional by

$$
\delta E[\mathbf{m};\boldsymbol\eta]
=
-\mu_0\int_\Omega M_s\,\mathbf{H}_{\mathrm{eff}}\cdot\boldsymbol\eta\,dV.
$$

#### 2.1.1 Exchange

The exchange energy is

$$
E_{\mathrm{ex}}[\mathbf{m}]
=
\int_\Omega A(\mathbf{x})\,|\nabla \mathbf{m}|^2\,dV.
$$

Its first variation is

$$
\delta E_{\mathrm{ex}}[\mathbf{m};\boldsymbol\eta]
=
2\int_\Omega A\,\nabla\mathbf{m}:\nabla\boldsymbol\eta\,dV.
$$

After integration by parts,

$$
\delta E_{\mathrm{ex}}
=
-2\int_\Omega \nabla\cdot(A\nabla\mathbf{m})\cdot\boldsymbol\eta\,dV
+
2\int_{\partial\Omega} A\,\partial_n\mathbf{m}\cdot\boldsymbol\eta\,dS.
$$

For the free-surface exchange BC frozen in the current project,

$$
\partial_n\mathbf{m}|_{\partial\Omega}=0,
$$

the boundary term vanishes and the strong-form field is

$$
\mathbf{H}_{\mathrm{ex}} = \frac{2}{\mu_0 M_s}\nabla\cdot(A\nabla\mathbf{m}).
$$

For constant $A$ this reduces to the familiar Laplacian form.

#### 2.1.2 Zeeman / external field

The Zeeman energy is

$$
E_{\mathrm{ext}}[\mathbf{m}]
=
-\mu_0\int_\Omega M_s\,\mathbf{m}\cdot\mathbf{H}_{\mathrm{ext}}\,dV.
$$

Therefore

$$
\delta E_{\mathrm{ext}}[\mathbf{m};\boldsymbol\eta]
=
-\mu_0\int_\Omega M_s\,\mathbf{H}_{\mathrm{ext}}\cdot\boldsymbol\eta\,dV,
$$

so the effective field contribution is simply

$$
\mathbf{H}_{\mathrm{ext}} = \mathbf{H}_{\mathrm{ext}}.
$$

As in FDM, this term is an injected field, not a PDE solve.

#### 2.1.3 Demagnetization

With no free current,

$$
\nabla\times\mathbf{H}_{\mathrm{demag}}=0,
\qquad
\nabla\cdot\mathbf{B}=0,
\qquad
\mathbf{B}=\mu_0(\mathbf{H}_{\mathrm{demag}}+\mathbf{M}).
$$

Set

$$
\mathbf{H}_{\mathrm{demag}} = -\nabla u.
$$

Then in all space,

$$
\Delta u = \nabla\cdot\mathbf{M}
\quad\text{in }\mathbb{R}^3,
\qquad
u(\mathbf{x})\to 0 \text{ as } |\mathbf{x}|\to\infty.
$$

Across the magnetic boundary, the transmission conditions are

$$
[u] = 0,
\qquad
[\partial_n u] = -\mathbf{M}\cdot\mathbf{n},
$$

where the jump is taken as outside minus inside.

The demag energy may be written as

$$
E_{\mathrm{demag}} = \frac{\mu_0}{2}\int_{\mathbb{R}^3}|\nabla u|^2\,dV
= -\frac{\mu_0}{2}\int_\Omega \mathbf{M}\cdot\mathbf{H}_{\mathrm{demag}}\,dV.
$$

These are the continuum identities that any FEM realization must respect.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|--------|---------|------|
| $\mathbf{m}$ | reduced magnetization | 1 |
| $\mathbf{M}$ | magnetization density | A/m |
| $M_s$ | saturation magnetization | A/m |
| $A$ | exchange stiffness | J/m |
| $\mathbf{H}_{\mathrm{ex}}$ | exchange field | A/m |
| $\mathbf{H}_{\mathrm{demag}}$ | demag field | A/m |
| $\mathbf{H}_{\mathrm{ext}}$ | external field | A/m |
| $u$ | magnetic scalar potential | A |
| $\mu_0$ | vacuum permeability | N/A$^2$ |
| $V_h$ | vector FE space for magnetization | — |
| $W_h$ | scalar FE space for demag potential | — |

### 2.3 Assumptions and approximations

- The first practical FEM magnetization representation should be low-order continuous vector-valued
  `H^1` fields with post-step renormalization.
- Exchange uses the natural Neumann boundary condition at free surfaces.
- The external field is injected in `A/m` and may be uniform, sampled, or later time-dependent.
- Demag requires an open-boundary treatment. The physically preferred target is a full-space
  realization; a truncated air-box solve may be used as a bootstrap approximation only if the
  approximation is explicit in provenance and validation.
- The intended GPU architecture is matrix-free or partial-assembly first, not sparse global
  matrix assembly first.
- Future eigenmode support must reuse the same operators and their linearizations.

## 3. Numerical interpretation

### 3.1 FDM

This note is FEM-specific.
For the regular-grid tensor-convolution realization, see:

- `0400-fdm-exchange-demag-zeeman.md`

The semantic invariant is shared: exchange, demag, and Zeeman must mean the same continuum terms in
both discretizations.

### 3.2 FEM

#### 3.2.1 Field spaces and discrete state

Let $\Omega_m$ be the magnetic region and $D$ the computational domain used for demag.
For a first production FEM backend, the recommended spaces are:

- magnetization space
  $$
  V_h \subset [H^1(\Omega_m)]^3,
  $$
- demag potential space
  $$
  W_h \subset H^1(D).
  $$

Write the discrete magnetization as

$$
\mathbf{m}_h(\mathbf{x}) = \sum_a \mathbf{m}_a\,\phi_a(\mathbf{x}),
$$

where $\phi_a$ are scalar nodal basis functions and $\mathbf{m}_a\in\mathbb{R}^3$ are vector DOFs.

This is not the final mathematically perfect constrained representation of micromagnetics,
but it is the most practical first GPU-capable choice for MFEM/libCEED and is compatible with
later tangent-plane and eigenmode work.

#### 3.2.2 Exchange weak form and operator realization

For all test functions $\boldsymbol\eta_h\in V_h$,

$$
\delta E_{\mathrm{ex}}[\mathbf{m}_h;\boldsymbol\eta_h]
=
2\int_{\Omega_m} A\,\nabla\mathbf{m}_h : \nabla\boldsymbol\eta_h\,dV.
$$

The exchange field is defined weakly by

$$
\int_{\Omega_m} \mu_0 M_s\,\mathbf{H}_{\mathrm{ex},h}\cdot\boldsymbol\eta_h\,dV
=
-2\int_{\Omega_m} A\,\nabla\mathbf{m}_h : \nabla\boldsymbol\eta_h\,dV.
$$

In matrix form,

$$
M_{\mu_0 M_s}\,\mathbf{h}_{\mathrm{ex}} = -K_A\,\mathbf{m},
$$

where

$$
(M_{\mu_0 M_s})_{ab} = \int_{\Omega_m} \mu_0 M_s\,\phi_a\phi_b\,dV,
$$

and

$$
(K_A)_{ab} = 2\int_{\Omega_m} A\,\nabla\phi_a\cdot\nabla\phi_b\,dV
$$

(componentwise for the vector field).

This identity is the correct FEM analogue of the FDM Laplacian-based exchange field.

##### Implementation recommendation

For Fullmag's first FEM backend:

- use **MFEM** `ParFiniteElementSpace` / `FiniteElementSpace` for $V_h$,
- build the diffusion-like operator with **partial assembly**,
- offload quadrature and basis actions to **libCEED**,
- recover the field with either
  - a lumped-mass inverse for an explicit baseline, or
  - a consistent mass solve when higher fidelity is needed.

For GPU-first execution, the preferred path is:

1. apply the vector diffusion operator matrix-free,
2. apply an inverse or approximate inverse of the weighted mass operator,
3. obtain `H_ex` in an FE field representation or at quadrature/sample points.

This keeps exchange evaluation bandwidth-efficient and avoids assembling large sparse matrices on
host memory by default.

##### Variable coefficients

If $A(\mathbf{x})$ or $M_s(\mathbf{x})$ vary, they should appear as FE coefficients or coefficient
fields, not as backend hacks.
That is exactly why the shared Fullmag architecture separates topology from coefficient variation.

#### 3.2.3 Zeeman weak form and implementation

The Zeeman term is the easiest FEM interaction.
For all test functions $\boldsymbol\eta_h\in V_h$,

$$
\int_{\Omega_m} \mu_0 M_s\,\mathbf{H}_{\mathrm{ext},h}\cdot\boldsymbol\eta_h\,dV
=
\int_{\Omega_m} \mu_0 M_s\,\mathbf{H}_{\mathrm{ext}}\cdot\boldsymbol\eta_h\,dV.
$$

So the discrete task is simply to realize or project $\mathbf{H}_{\mathrm{ext}}$ in the chosen FE
representation.

Implementation paths:

- **uniform field**: constant vector coefficient,
- **sampled field**: interpolate/project from sampled data,
- **time-dependent field**: update the coefficient once per time step,
- **future scripted field**: evaluate only at lowering or coefficient-update time, never inside a
  generic Python callback in the hot loop.

As in FDM, the present `Zeeman(B=...)` API is physically awkward.
The FEM backend should consume `H_ext` in `A/m`.
If the public surface remains `B`, the control plane must convert via

$$
\mathbf{H}_{\mathrm{ext}} = \frac{\mathbf{B}}{\mu_0}
$$

and store both the original input and the normalized field in provenance.

#### 3.2.4 Demag weak form: recommended realizations

Demag is the most important and most difficult FEM interaction.
There is no single universally best realization.
Fullmag should support the following hierarchy.

##### Option A — Bootstrap approximation: truncated air-box scalar potential

Let

$$
D = \Omega_m \cup \Omega_{\mathrm{air}}
$$

be a finite computational domain containing the magnetic body and a surrounding air region.
Seek $u_h\in W_h$ such that for all $v_h\in W_h$,

$$
\int_D \nabla u_h\cdot\nabla v_h\,dV
=
\int_{\Omega_m} \mathbf{M}_h\cdot\nabla v_h\,dV,
$$

with a chosen outer boundary condition on $\partial D$, for example

$$
u_h = 0 \quad \text{on } \partial D.
$$

Then recover

$$
\mathbf{H}_{\mathrm{demag},h} = -\nabla u_h.
$$

This formulation is straightforward in MFEM and maps well to hypre/libCEED, but it approximates the
open boundary by truncation. It is acceptable only as an explicit bootstrap path.

##### Option B — Preferred production target: full-space/open-boundary demag

The production-quality FEM demag realization should avoid relying solely on a large air box.
Recommended target families are:

- FEM–BEM coupling,
- transformation / infinite-domain methods,
- later hierarchical or fast-multipole boundary operators if scale demands it.

The key architectural rule is:

> open-boundary magnetostatics must be represented as a *demag operator choice in the execution
> plan*, not hidden inside the shared physics semantics.

##### Weak-form meaning

Regardless of which open-boundary method is chosen, the physical object being approximated is still

$$
\Delta u = \nabla\cdot\mathbf{M} \text{ in } \mathbb{R}^3,
\qquad
\mathbf{H}_{\mathrm{demag}}=-\nabla u.
$$

The field recovery and energy identity remain

$$
E_{\mathrm{demag}}
=
\frac{\mu_0}{2}\int_{\mathbb{R}^3}|\nabla u|^2\,dV
=
-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf{M}\cdot\mathbf{H}_{\mathrm{demag}}\,dV.
$$

##### Implementation recommendation for Fullmag

For the first GPU-capable FEM backend, the most realistic sequence is:

1. implement exchange and Zeeman first on $V_h$,
2. implement a scalar-potential demag solve on a magnet+air mesh using MFEM + hypre,
3. offload operator application to libCEED partial assembly where supported,
4. later upgrade the demag realization to a more faithful open-boundary method.

This path is not the mathematically final word, but it is the shortest route to a real FEM
backend that can already be profiled and compared.

##### GPU stack mapping

- **MFEM** owns the mesh, scalar/vector FE spaces, bilinear and linear forms, and operator
  composition.
- **libCEED** should handle partial-assembly evaluation for diffusion-like operators and gradients
  on GPUs.
- **hypre** should handle Krylov + AMG preconditioning for the scalar demag solve and later other
  global linear systems.

That means:

- exchange field evaluation can be mostly operator-application bound,
- Zeeman is coefficient/projection work,
- demag requires a real global solve and therefore a solver/preconditioner story.

#### 3.2.5 Field recovery and output semantics

For canonical outputs, the FEM backend must still publish the same field names as FDM:

- `H_ex`,
- `H_demag`,
- `H_ext`,
- later `H_eff`.

Because FE fields live in function spaces rather than cell arrays, the execution plan must define
how output snapshots are realized:

- nodal DOFs,
- element/quadrature samples,
- projected Cartesian samples for comparison,
- mesh-native exports.

This is not a mere IO issue; it is part of the scientific contract for cross-backend comparison.

#### 3.2.6 Future eigenmode support

You explicitly want future FEM eigenproblems.
That requirement affects the interaction design now.

For a linearized eigenmode solve around an equilibrium state $\mathbf{m}_0$,

- exchange contributes a stiffness-like linearized operator,
- Zeeman contributes a simple linear term,
- demag contributes a nonlocal linearized operator.

Therefore the FEM backend should implement these interactions as reusable operator objects,
not only as ad hoc time-stepping code.
That is another reason the MFEM/libCEED/hypre stack is appropriate: it supports operator-centric
assembly/application better than a pure monolithic sparse-matrix mindset.

### 3.3 Hybrid

A future hybrid path may use an FEM representation for local terms together with an auxiliary grid
for demag acceleration or comparison.
Nothing in the shared physics needs to change for that.
The hybrid choice belongs in the execution plan.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The shared Python API should remain backend-neutral:

- `Exchange`,
- `Demag`,
- `Zeeman`,
- FEM discretization hints such as order and mesh size,
- no exposure of MFEM spaces, libCEED handles, or hypre solver objects.

### 4.2 ProblemIR representation

The shared `ProblemIR` should continue to represent only the physics problem.
FEM-specific details belong in `FemPlanIR`, not in shared IR.

A future `FemPlanIR` for this interaction set should carry at least:

- mesh source / mesh identifier,
- FE space choice for magnetization,
- FE space for demag potential,
- coefficient realization strategy,
- demag realization choice (`air_box`, `transform`, `fem_bem`, later others),
- linear solver and preconditioner configuration,
- output projection policy,
- integrator choice and timestep policy.

### 4.3 Planner and capability-matrix impact

The planner should own:

- geometry to mesh / mesh-import lowering,
- region/domain marker realization,
- coefficient-field realization,
- FE-space selection,
- external-field projection policy,
- demag backend choice,
- GPU/CPU execution policy propagation.

The capability matrix should continue to distinguish clearly between shared semantics and real
FEM executability.
At present, these interactions are still semantic/planned on the FEM side.

## 5. Validation strategy

### 5.1 Analytical checks

#### Exchange

- Uniform magnetization must give zero exchange field.
- Sinusoidal states on simple meshes should converge to the expected Laplacian response.
- Natural Neumann BC should require no extra boundary term and should behave correctly at free
  surfaces.

#### Zeeman

- Constant external field projected into the FE space must remain constant up to projection error.
- Pure Zeeman relaxation should align magnetization with the field direction.
- `B -> H` conversion must be unit-tested if the public API remains `B`-based.

#### Demag

- For simple bodies with known demag factors, the recovered field should converge under mesh
  refinement.
- The scalar-potential solve should satisfy the energy identity within solver tolerance.
- If an air-box approximation is used, convergence with increasing air-box size must be measured
  and documented.

### 5.2 Cross-backend checks

- CPU FEM vs GPU FEM operator parity for exchange and demag solves.
- FDM/FEM comparison on common benchmark geometries after projection to common samples.
- Demag comparisons should separate discretization error from open-boundary approximation error.

### 5.3 Regression tests

- local exchange operator tests on tiny tetrahedral meshes,
- constant-field projection tests for Zeeman,
- scalar-potential Poisson tests for demag,
- demag energy identity tests,
- CPU vs GPU partial-assembly parity tests,
- artifact tests for `H_ex`, `H_demag`, `H_ext`, `E_ex`, `E_demag`, `E_ext`,
- projection tests for comparison tools.

## 6. Completeness checklist

- [x] Python API (shared semantics)
- [x] ProblemIR (shared semantics)
- [x] Planner-facing design
- [x] Capability-matrix implications documented
- [ ] FDM backend fully wired for this whole interaction set
- [ ] FEM backend implemented for this whole interaction set
- [ ] Hybrid backend
- [ ] Outputs / observables fully wired for this whole interaction set
- [ ] Tests / benchmarks complete
- [x] Documentation

## 7. Known limits and deferred work

- The current public product path does not yet execute FEM problems.
- The first FEM backend does not need to start with the final perfect constrained formulation.
- A truncated air-box demag solve may be useful as a bootstrap, but must not be mistaken for the
  final open-boundary solution strategy.
- Full FEM-BEM or transformed-domain demag is deferred.
- High-order spaces and adaptive mesh refinement are deferred.
- Public mixed precision and detailed GPU precision policy for FEM are deferred until the backend
  exists.
- Eigenmode support is future work, but the interaction operators should already be designed so it
  can be added without architectural surgery.

## 8. References

1. W. F. Brown, *Micromagnetics*, Interscience, 1963.
2. A. Hubert and R. Schäfer, *Magnetic Domains*, Springer, 1998.
3. A. Aharoni, *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University Press.
4. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
   with Applications* 81, 42–74 (2021).
5. A. Abdelfattah et al., “GPU algorithms for efficient exascale discretizations,” *Parallel
   Computing* 108, 102841 (2021).
6. C.-M. Pfeiler et al., “Computational micromagnetics with Commics,” *Computer Physics
   Communications* 248, 106965 (2020).
7. D. M. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,”
   *IEEE Trans. Magn.* 26(2), 415–417 (1990).
