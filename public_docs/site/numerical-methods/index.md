---
title: Numerical Methods
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: terminal numerical-method pages, their source maps, and Fullmag source revision 88c7160080bc1e8519950df283d2dd02087cc3da
---

(public-docs-numerical-methods-root)=
# Numerical methods

:::{admonition} Documentation status and solver qualification
:class: important

This chapter is a code-backed description of the numerical methods represented in Fullmag at
source revision `88c7160080bc1e8519950df283d2dd02087cc3da`. A complete documentation page is **not**
a blanket claim that every solver/device/precision combination is production-qualified. The
terminal pages distinguish `implemented`, `source-backed`, `partial`, `unsupported`, and
`not-applicable` lanes and identify the source symbol that supports each statement.
:::

## Scope

Fullmag separates the physical model from its numerical realization. Exchange, demagnetization,
anisotropy, DMI, Zeeman terms, torques, and coupled transport modules define the continuous or
semi-continuous problem. The numerical-method layer decides how that problem is represented and
solved:

1. a Cartesian finite-difference grid or conforming finite-element mesh represents space;
2. field and energy operators turn the magnetization state into a semi-discrete right-hand side;
3. a time integrator or constrained minimizer advances the state;
4. optional modal and frequency-domain solvers linearize around an equilibrium;
5. continuation operators transfer accepted states between discretizations;
6. the planner resolves backend, device, precision, libraries, tolerances, and failure policy;
7. execution provenance records what actually ran.

The hierarchy below avoids duplicating the physical equations four times for FDM/FEM and CPU/GPU.
A terminal page owns one numerical realization and documents its equations, public API,
`ProblemIR` mapping, source symbols, validation evidence, and limitations.

## Canonical semi-discrete problem

The reduced magnetization is

```{math}
:label: eq-numerical-root-reduced-magnetization
\mathbf m(\mathbf x,t)=\frac{\mathbf M(\mathbf x,t)}{M_s(\mathbf x)},
\qquad |\mathbf m|=1.
```

For an energy functional $E[\mathbf m]$, Fullmag uses the SI effective-field convention

```{math}
:label: eq-numerical-root-effective-field
\mathbf H_{\mathrm{eff}}
=-\frac{1}{\mu_0M_s}\frac{\delta E}{\delta\mathbf m}
+\mathbf H_{\mathrm{nonconservative}},
```

where the last term denotes field-like contributions that are not represented by a conservative
energy. After FDM or FEM spatial discretization, the dynamic state $y(t)$ satisfies

```{math}
:label: eq-numerical-root-semidiscrete-llg
\frac{\mathrm d\mathbf m}{\mathrm dt}=F(\mathbf m,t)
=-\frac{\gamma}{1+\alpha^2}
\left[
\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times
\left(\mathbf m\times\mathbf H_{\mathrm{eff}}\right)
\right]
+\boldsymbol\tau_{\mathrm{nc}}.
```

Here $\gamma$ is expressed in the Fullmag convention
$\mathrm{m\,A^{-1}\,s^{-1}}$, $\alpha$ is dimensionless, and
$\boldsymbol\tau_{\mathrm{nc}}$ collects explicitly enabled nonconservative torques. The numerical
integrator acts on $F$; it does not redefine the interaction fields or their SI units.

Equilibrium calculations solve a different numerical problem. A stationary state obeys

```{math}
:label: eq-numerical-root-equilibrium
\mathbf m_i\times\mathbf H_{\mathrm{eff},i}=\mathbf 0,
\qquad |\mathbf m_i|=1,
```

at every active FDM cell or FEM magnetic degree of freedom. A step budget ending is not proof of
this condition. Fullmag therefore keeps convergence criteria, accepted-state metrics, and budget
termination separate in the relaxation provenance.

Linearized studies start from an equilibrium $\mathbf m_0$ and use tangent perturbations

```{math}
:label: eq-numerical-root-linearization
\mathbf m=\mathbf m_0+\delta\mathbf m,
\qquad
\mathbf m_0\cdot\delta\mathbf m=0.
```

The eigensolver and driven-response pages document the resulting complex tangent operators. They
are not interchangeable with integrating a large-amplitude transient and Fourier-transforming it.

## Numerical-method map

| Family | Mathematical object | Public workflow | Current native realization boundary | Detailed reference |
|---|---|---|---|---|
| Time integration | initial-value problem $\dot y=F(y,t)$ | physical-time stage and `LLG` solver policy | explicit FDM/FEM CPU lanes; CUDA implementations are lane- and precision-qualified separately | {doc}`time-integration/index` |
| Relaxation | constrained descent on $(S^2)^N$ or damping-only LLG | `study.stages.add_relax(...)` | FDM and FEM implementations exist; direct minimizers and multilayer/device paths have explicit restrictions | {doc}`relaxation/index` |
| Demagnetization solvers | nonlocal convolution or scalar-potential boundary-value problem | `Demag(...)`, mesh and solver policies | FDM Newell/FFT; FEM Poisson airbox; FEM/BEM CPU; periodic variants with separate qualification | {doc}`demag-solvers/index` |
| Eigensolvers | generalized complex tangent-space eigenproblem | `study.stages.add_eigenmodes(...)` | native production contract is FEM; FDM modal execution is not implied | {doc}`eigensolvers/index` |
| Frequency domain | complex shifted linear systems at prescribed frequencies | frequency-response stage | native production contract is FEM; Floquet and dynamic-demag combinations are explicitly gated | {doc}`frequency-domain/index` |
| Meshing | discrete spatial trial/test space and geometry approximation | object, universe, FDM, and FEM mesh policies | Cartesian cells for FDM; conforming shared-domain meshes and airboxes for FEM | {doc}`meshing/index` |
| State transfer | point location, interpolation, normalization, continuation metadata | automatic continuation between ordered stages | FEM $\leftrightarrow$ FDM transfers are source-backed; target execution is qualified independently | {doc}`interpolation-and-state-transfer/index` |

## Spatial discretization contract

### Finite differences

The FDM state is cell-centred on a Cartesian grid. For origin $\mathbf x_0$, spacings
$(h_x,h_y,h_z)$, and cell indices $(i,j,k)$,

```{math}
:label: eq-numerical-root-fdm-centres
\mathbf x_{ijk}=\mathbf x_0+
\left((i+\tfrac12)h_x,(j+\tfrac12)h_y,(k+\tfrac12)h_z\right),
\qquad
V_{\mathrm{cell}}=h_xh_yh_z.
```

Local terms use finite-difference stencils or pointwise kernels. The open-boundary demagnetizing
field is a cell-averaged tensor convolution accelerated by FFTs. Consequently, a grid request fixes
more than visualization resolution: it fixes cell volume, stencil spacing, FFT embedding,
periodicity, material sampling, and the discrete energy.

For an open convolution grid with $N$ active/padded cells, the asymptotic transform cost is
$O(N\log N)$ and the dominant storage is $O(N)$ complex spectra. Constant factors depend on padding,
precision, batched transforms, plan reuse, and whether the execution lane keeps spectra resident on
the device.

### Finite elements

The FEM state is represented in a conforming finite-element space on a shared geometric domain.
For a scalar P1 basis $\{\phi_a\}$, one Cartesian magnetization component is

```{math}
:label: eq-numerical-root-fem-expansion
m_q^h(\mathbf x)=\sum_a m_{q,a}\phi_a(\mathbf x),
\qquad q\in\{x,y,z\}.
```

Weak forms generate mass, stiffness, boundary, and coupling operators. Magnetic elements and
nonmagnetic air elements may share the same mesh, but they do not share every unknown or material
coefficient. The magnetic mask, element attributes, trace spaces, periodic equivalence classes,
and airbox boundary attributes therefore belong to numerical provenance.

FEM accuracy depends simultaneously on geometry approximation, element size, element order,
quadrature, coefficient representation, linear-solver tolerance, and field-recovery policy. A
single `hmax` value is not a complete mesh description.

## Time integration

Fullmag exposes fixed-step Heun and classical RK4 together with embedded RK23 and RK45 families.
For an explicit $s$-stage Runge--Kutta method,

```{math}
:label: eq-numerical-root-rk
Y_j=y_n+\Delta t\sum_{\ell<j}a_{j\ell}K_\ell,
\qquad
K_j=F(Y_j,t_n+c_j\Delta t),
\qquad
y_{n+1}=y_n+\Delta t\sum_j b_jK_j.
```

Embedded pairs form a second estimate with coefficients $\widetilde b_j$ and accept or reject the
trial according to a normalized error. Rejected trials do not advance physical time, accepted-step
counters, output sampling, or continuation state. Exact controller norms, safety factors, step
bounds, aliases (`bs23`, `dp54`), and backend-specific field-refresh behavior are documented under
{doc}`time-integration/index`.

Explicit order does not remove stiffness. Exchange-dominated meshes can impose a severe stability
limit proportional to the square of the smallest cell/element length. A high-order accepted step
can therefore be accurate but still inefficient when the semi-discrete spectrum is stiff.

## Relaxation and constrained minimization

The relaxation family contains three distinct public algorithms:

- `llg_overdamped`: integrates a precession-disabled damping equation and retains a relaxation-time
  coordinate;
- `projected_gradient_bb`: projects the energy gradient onto the tangent plane, uses alternating
  Barzilai--Borwein trial steps, and applies Armijo backtracking;
- `nonlinear_cg`: uses a transported Polak--Ribière+ tangent direction, descent safeguards,
  restarts, and Armijo backtracking.

All accepted states lie on the product of unit spheres. With
$P_i=I-\mathbf m_i\mathbf m_i^{\mathsf T}$, a generic tangent gradient is

```{math}
:label: eq-numerical-root-tangent-gradient
\mathbf g_i=P_i\nabla_{\mathbf m_i}E,
\qquad
\mathbf m_i^{+}=\frac{\mathbf m_i-\lambda\mathbf g_i}
{\lVert\mathbf m_i-\lambda\mathbf g_i\rVert_2}.
```

The exact line-search constants, rollback semantics, energy window, torque confirmation, CPU/GPU
state ownership, and unsupported combinations are documented in {doc}`relaxation/index`. In
particular, `max_steps` and any time ceiling are budgets; only the declared torque/energy conditions
can establish equilibrium.

## Demagnetization realizations

Demagnetization is one physical interaction with several mathematically different numerical
closures.

### FDM cell-averaged tensor convolution

For destination cell $p$, source cell $q$, and Cartesian components $i,j$,

```{math}
:label: eq-numerical-root-fdm-demag
H_{\mathrm d,p,i}
=-\sum_q\sum_jN^{\mathrm{cell}}_{pq,ij}M_{q,j},
\qquad
\widehat{\mathbf H}_{\mathrm d}
=-\widehat{\mathbf N}^{\mathrm{cell}}\,\widehat{\mathbf M}.
```

Fullmag builds the cell-averaged Newell tensor, embeds it according to the boundary policy, caches
its spectra, and applies the convolution on CPU or CUDA lanes. Periodic image sums are a separate
operator policy, not an unlabelled change to open-boundary padding.

### FEM Poisson airbox

With scalar potential $u$,

```{math}
:label: eq-numerical-root-fem-demag
\mathbf H_{\mathrm d}=-\nabla u,
\qquad
-\Delta u=-\nabla\cdot\mathbf M
```

is solved on a magnetic-plus-air domain with an explicit outer closure. Dirichlet and Robin
boundaries approximate open space differently, and convergence requires an airbox-extent study in
addition to mesh refinement and algebraic residual control.

### FEM/BEM Fredkin--Koehler

The body-only hybrid route decomposes the scalar potential into an interior Poisson solution and a
harmonic correction whose boundary values are produced by a dense boundary-integral operator. It
avoids volumetric air cells but introduces boundary-operator storage and apply cost. The current
production claim is CPU FEM/BEM; no GPU fallback is implied.

The complete realization matrix, gauge handling, periodic zero-mode policy, energy formulas,
source symbols, and validation requirements are in {doc}`demag-solvers/index`.

## Linearized eigensolvers

A local orthonormal basis $(\mathbf e_{1,i},\mathbf e_{2,i})$ represents tangent perturbations as
$\delta\mathbf m_i=\mathbf e_{1,i}q_{1,i}+\mathbf e_{2,i}q_{2,i}$. Fullmag's modal contract is
expressed as a generalized complex pencil

```{math}
:label: eq-numerical-root-eigenproblem
\mathsf K\mathbf q=\lambda\mathsf G\mathbf q,
\qquad
\lambda=\sigma+\mathrm i\omega,
\qquad
f=\frac{|\omega|}{2\pi}.
```

A valid modal result requires more than a finite eigenvalue: the equilibrium torque, tangent
constraint, generalized residual, target selection, normalization, phase convention, damping
policy, demagnetizing operator, boundary policy, and mesh convergence must all be reported. The
native production contract documented here is FEM. Dependency availability and actual GPU
execution remain resolved runtime facts. See {doc}`eigensolvers/index`.

## Frequency-domain response

For harmonic perturbations proportional to $\exp(\mathrm i\omega t)$, the driven response reduces
to a complex shifted system of the form

```{math}
:label: eq-numerical-root-frequency-system
\left(\mathsf K+\mathrm i\omega\mathsf G\right)\widehat{\mathbf q}
=\widehat{\mathbf b}.
```

The exact sign is tied to the recorded Fourier convention. Each requested frequency therefore
requires a converged algebraic solve or a validated reduced/modal evaluation. Frequency sweeps must
record the solver, preconditioner, tolerances, iteration history, residual, excitation convention,
and response observable. Floquet response additionally requires consistent phase constraints for
all periodic state and operator components. See {doc}`frequency-domain/index`.

## Meshing and refinement

Mesh selection is part of the mathematical model. At minimum, a reproducible result records:

| FDM | FEM |
|---|---|
| origin, dimensions, cell counts and spacings | mesh digest, dimension, element family/order and attributes |
| object-to-cell material sampling | geometry approximation and material subdomains |
| active mask and optional volume/face fractions | magnetic mask, air region and boundary attributes |
| FFT padding, common convolution grid and periodic axes | airbox extent, trace mesh, periodic equivalence classes |
| precision and cell-volume convention | quadrature, mass projection and field-recovery policy |

Refinement must target an observable rather than only a nominal mesh size. Examples include total
energy, maximum torque, switching time, resonance frequency, modal overlap, demagnetizing-field
norm, or topological charge. At least three refinement levels are recommended when estimating an
observed convergence rate, provided all other numerical policies remain fixed. See
{doc}`meshing/index`.

## Interpolation and continuation

Cross-backend continuation is a pointwise state-transfer operation. FEM-to-FDM transfer locates
each target cell centre in the source mesh, evaluates the P1 field with barycentric weights, and
renormalizes the resulting magnetization. FDM-to-FEM transfer evaluates the Cartesian source state
at target FEM points using trilinear interpolation.

These transfers preserve neither discrete energy nor volume integrals by construction. They are
therefore initialization operators, not conservative projections. Production provenance must
record source and target mesh identities, point-location failures, outside-domain policy,
normalization corrections, and transfer error. The exact source symbols and validation cases are
in {doc}`interpolation-and-state-transfer/index`.

## Python authoring, canonical IR, and resolved execution

The public workflow is stage-first:

```python
# %% Model, discretization, and ordered execution stages
import fullmag as fm

nm = 1.0e-9
study = fm.study("numerical_method_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(300 * nm, 160 * nm, 120 * nm))

film = study.geometry(
    fm.Box(size=(200 * nm, 80 * nm, 5 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.05, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
study.stages.add_run(stage_id="transient", until=1.0e-9)
```

Python captures requested intent. `ProblemIR` stores canonical SI parameters and ordered stages.
The planner then resolves a concrete lane. Execution provenance must distinguish at least:

- requested and resolved discretization;
- requested and resolved backend, device, precision, and library dependencies;
- mesh/grid digest and material/geometry digest;
- interaction list and discrete realization variants;
- integrator/minimizer/eigensolver/linear-solver policy;
- requested tolerances and achieved residuals;
- accepted/rejected steps or nonlinear/Krylov iterations;
- completion or failure reason;
- output and continuation artifact digests.

A Python constructor, serialized IR, source file, or available CUDA symbol alone does not prove that
a specific device lane executed.

## Qualification vocabulary

| Status | Meaning in this documentation |
|---|---|
| `implemented` | The code path and public contract are present and the page identifies their source owners. Qualification may still be limited to named lanes. |
| `source-backed` | The relevant implementation symbols exist and support the stated algorithm, but current-revision executed evidence is not claimed universally. |
| `partial` | Only a constrained subset is executable or qualified; the page states the boundary explicitly. |
| `unsupported` | The planner/runtime must reject the combination. Silent substitution is not allowed. |
| `not-applicable` | The realization belongs to a different discretization or mathematical formulation. |

## Verification and validation ladder

A production numerical claim should be supported at several independent levels:

1. **Contract tests:** Python validation, SI normalization, exact `ProblemIR` lowering, and
   fail-closed capability checks.
2. **Operator tests:** symmetry/skew-symmetry where expected, nullspaces, energy--field directional
   derivatives, boundary conditions, and manufactured solutions.
3. **Algorithm tests:** formal order for time integrators, monotonic accepted energy for direct
   minimizers, algebraic residual reduction, rollback after rejected trials, and deterministic
   stopping semantics.
4. **Discretization convergence:** FDM cell or FEM mesh/order studies against analytical,
   manufactured, or independently converged references.
5. **Cross-lane parity:** compare CPU/GPU only with identical physics, discretization, precision
   policy, tolerances, and resolved provenance. Bitwise identity is not generally expected.
6. **Scientific benchmarks:** standard micromagnetic switching, equilibrium, demagnetizing,
   eigenmode, and response cases with declared observables and acceptance thresholds.

The validation section of each terminal page states which of these levels is presently evidenced
and which remain qualification work.

## Choosing a method

| Scientific objective | Recommended starting point | Principal numerical risk |
|---|---|---|
| Regular Cartesian film or multilayer transient | FDM with RK23/RK45 or fixed RK where justified | exchange stiffness, FFT memory, multilayer capability boundaries |
| Curved geometry or body/air conforming model | FEM with explicit RK or qualified tangent-plane path | mesh quality, mass projection, sparse-solver tolerance |
| Static equilibrium | nonlinear CG or projected gradient; overdamped LLG as a robust alternative | false convergence from budget termination or stale fields |
| Open-boundary FDM demag | Newell tensor plus zero-padded FFT convolution | padding, self-term convention, insufficient cell refinement |
| Open-boundary FEM demag | Poisson airbox for sparse scalable solve; FEM/BEM when avoiding air volume is decisive | airbox truncation versus dense boundary cost |
| Small-amplitude resonances | FEM linearized-LLG eigensolver | unconverged equilibrium, spectral targeting, dynamic demag |
| Driven susceptibility | FEM frequency-domain response | shifted-system conditioning and preconditioner quality |
| Continue between solver families | explicit FEM/FDM state transfer | outside-domain samples and nonconservative interpolation |

## Implementation source index

Stable documentation identity is repository path plus source symbol. The terminal source maps add
parameter- and equation-level ownership.

| Responsibility | Repository path | Stable symbol or owner |
|---|---|---|
| Public LLG and adaptive policy | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG`, `class AdaptiveTimestep` |
| Ordered stage authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder`, `class StudyStagesBuilder` |
| Relaxation semantic model | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` |
| FDM Newell tensor | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` |
| FDM tensor convolution | `crates/fullmag-fdm-demag/src/multiply.rs` | `accumulate_tensor_convolution` |
| FDM CPU spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_newell_kernel_spectra`, `compute_periodic_newell_kernel_spectra` |
| FDM CUDA demag | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` |
| FEM explicit-RK stage RHS | `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp` | `evaluate_rk_stage_rhs` |
| FEM explicit-RK accepted step | `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` | `context_step_explicit_rk_mfem` |
| FEM Poisson demag solve | `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` |
| FEM/BEM orchestration | `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` | `context_compute_demag_fem_bem` |
| Periodic FEM demag | `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` | `solve_demag_periodic_poisson_reduced` |
| Modal and driven-response contract | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_modal_eigen_contract`, `solve_driven_response_contract` |
| Cross-discretization transfer | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_fem_field_to_grid`, `transfer_vector_field` |
| Continuation orchestration | `crates/fullmag-cli/src/step_utils.rs` | `resample_continuation_if_cross_backend` |

## Limitations of this chapter

This chapter describes the implemented contracts and known realization boundaries. It does not
claim a posteriori error estimation, adaptive mesh refinement, unconditional stability of explicit
LLG integration, conservative cross-mesh projection, universal GPU residency, or FDM support for
native modal/frequency-domain studies unless a terminal page explicitly documents such a lane.

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
2. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
3. J. L. Dormand and P. J. Prince, “A family of embedded Runge--Kutta formulae,” *Journal of
   Computational and Applied Mathematics* **6**, 19--26 (1980),
   [doi:10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).
4. P. Bogacki and L. F. Shampine, “A 3(2) pair of Runge--Kutta formulas,” *Applied Mathematics
   Letters* **2**, 321--325 (1989),
   [doi:10.1016/0893-9659(89)90079-7](https://doi.org/10.1016/0893-9659(89)90079-7).
5. J. Barzilai and J. M. Borwein, “Two-point step size gradient methods,” *IMA Journal of Numerical
   Analysis* **8**, 141--148 (1988),
   [doi:10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141).
6. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research* **98**, 9551--9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
7. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE
   Transactions on Magnetics* **26**, 415--417 (1990),
   [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
8. S. Bartels and A. Prohl, “Convergence of an implicit finite element method for the
   Landau--Lifshitz--Gilbert equation,” *SIAM Journal on Numerical Analysis* **44**, 1405--1419
   (2006), [doi:10.1137/050631070](https://doi.org/10.1137/050631070).
9. L. Baňas, S. Bartels, and A. Prohl, “A convergent implicit finite element discretization of the
   Maxwell--Landau--Lifshitz--Gilbert equation,” *SIAM Journal on Numerical Analysis* **46**,
   1399--1422 (2008), [doi:10.1137/070683064](https://doi.org/10.1137/070683064).
10. Y. Saad and M. H. Schultz, “GMRES: A generalized minimal residual algorithm for solving
    nonsymmetric linear systems,” *SIAM Journal on Scientific and Statistical Computing* **7**,
    856--869 (1986), [doi:10.1137/0907058](https://doi.org/10.1137/0907058).
11. V. Hernández, J. E. Román, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the
    solution of eigenvalue problems,” *ACM Transactions on Mathematical Software* **31**, 351--362
    (2005), [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
12. C. Geuzaine and J.-F. Remacle, “Gmsh: A three-dimensional finite element mesh generator with
    built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
    Engineering* **79**, 1309--1331 (2009),
    [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
13. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
    with Applications* **81**, 42--74 (2021),
    [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

```{toctree}
:maxdepth: 1

time-integration/index
relaxation/index
demag-solvers/index
eigensolvers/index
frequency-domain/index
meshing/index
interpolation-and-state-transfer/index
```
