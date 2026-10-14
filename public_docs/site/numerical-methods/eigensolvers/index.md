---
title: Eigensolvers
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: linearized-llg, modal-validation, their source maps, and source revision 5e99782acbb7fb3f65d0cad872e102bf67733103
---

(public-docs-numerical-methods-eigensolvers-root)=
# Linearized-LLG eigensolvers

:::{admonition} Native lane boundary
:class: important

The public eigenmode request is not a promise of universal backend support. At the reviewed
revision (`5e99782acbb7fb3f65d0cad872e102bf67733103`), the native production modal contract is FEM.
FDM CPU and FDM CUDA modal execution are not claimed and fail closed during planning. FEM CPU
provides the broadest production coverage (including shared-domain Poisson-airbox Schur-complement
shift-and-invert, Bloch/Floquet $\mathbf k$-paths, 2.5D waveguide dispersion, and dense/LOBPCG
reference paths). FEM GPU modal execution is supported for qualified $\Gamma$-point ($\mathbf k=0$)
and device-resident PETSc/SLEPc/CUDA Krylov configurations and must be demonstrated by resolved
runtime provenance.
:::

## Scope and purpose

The Fullmag eigensolver computes small-amplitude spin-wave normal modes, complex eigenfrequencies,
spatial eigenmode profiles, and $\mathbf k$-resolved or field-swept dispersion branches around a
declared static magnetic equilibrium $\mathbf m_0(\mathbf r)$. It addresses a fundamentally
different physical and numerical problem from time integration:

- **Time integration** evolves a finite-amplitude initial condition $\mathbf m(\mathbf r, t)$ under
  the full nonlinear Landau–Lifshitz–Gilbert (LLG) equation and captures transient ringdown,
  nonlinear mode coupling, and switching, followed by discrete Fourier post-processing;
- **Modal eigensolving** linearizes the complete enabled effective-field operator at a certified
  equilibrium $\mathbf m_0(\mathbf r)$, projects the dynamics onto the local two-component tangent
  bundle $T_{\mathbf m_0}\mathbb S^2$, and directly solves the resulting generalized operator
  eigenproblem for complex eigenvalues $\lambda = \sigma + \mathrm i\omega$ and spatial mode
  shapes $\delta\mathbf m(\mathbf r)$.

The modal spectrum is well-defined only for the exact equilibrium state, material parameters,
demagnetization realization, boundary conditions, spatial representation (`full_3d` vs
`waveguide_2p5d`), damping policy (`ignore` vs `include`), operator family (`linearized_llg` vs
`full_2x2`), mesh topology, and normalization convention recorded in the study provenance.

---

## End-to-end software and runtime architecture

Fullmag's eigensolve subsystem is structured as a strict seven-layer pipeline that separates
user-authored physical intent (`ProblemIR`), capability and solver planning (`FemEigenPlanIR`),
multi-process execution orchestration (`EigenKProcessPool`), native C++ operator assembly and
spectral solving, branch tracking, and binary/JSON publication to the Control Room UI.

```text
[1. Python Authoring DSL]
   study.stages.add_eigenmodes / EigenmodesStageSpec
   FemEigenSolverPolicy, KPath, BiasFieldSweep, ModeTracking
        |
        v
[2. Canonical Lowering (ProblemIR)]
   StudyIR::Eigenmodes, EigenOperatorIR, EigenTargetIR
   KSamplingIR, SpatialRepresentationIR, ParallelExecutionPolicyIR
        |
        v
[3. Planner & Capability Gate (fullmag-plan)]
   plan_fem_eigen -> FemEigenPlanIR
   Gamma-point classification, BC/airbox compatibility, output legality
        |
        v
[4. Stage Handoff & R4 Equilibrium Certificate]
   accepted_relax_handoff_for_eigen_stage / materialize_equilibrium
   Immutable m0 digest & torque verification across k/H sweeps
        |
        v
[5. Runner Orchestration & Process Pool (fullmag-runner)]
   run_path_or_single_controlled / EigenKProcessPool
   Multi-process k-point parallelism & thread budget isolation
        |
        v
[6. Native C++ FEM Modal Engine (backends/fem)]
   petsc_slepc_process_mutex -> solve_modal_eigen_contract
   Shared-domain Schur complement, Real-split rotated SLEPc pencil, GPU Krylov
        |
        v
[7. Mode Tracking & Publication]
   track_branches / mass_weighted_subspace_transport
   spectrum.v2.json, branches.v2.json, dispersion.csv, binary mode fields
```

### 1. Python authoring DSL (`packages/fullmag-py`)

In the stage-first Python API (`fm.study(...)`), modal stages are appended to `study.stages` via
`StudyStagesBuilder.add_eigenmodes(...)` (or constructed via `eigenmodes_stage(...)`), which
validates and normalizes `EigenmodesStageSpec` before lowering to `Eigenmodes`. Supporting
domain-specific types include:

- **Spectral & operator policy**: `FemEigenSolverPolicy` (`backend`, `subspace_dimension`,
  `max_iterations`, `tolerance`, `shift_Hz`, `target_spectrum`), operator family
  (`"linearized_llg"` or `"full_2x2"`), and damping policy (`"ignore"` or `"include"`);
- **Wave-vector & spatial representation**: `KPoint`, `KPath` (piecewise-linear Brillouin-zone path
  with named symmetry labels), `PeriodicBC`, `FloquetBC`, and `spatial_representation`
  (`"full_3d"` or `"waveguide_2p5d"`);
- **Bias-field sweeps & branch tracking**: `BiasFieldSweep` (`values`, `equilibrium_policy`) and
  `ModeTracking` (`enabled`, `method="overlap_hungarian"`, `min_overlap`, `degeneracy_tolerance`);
- **Validation & outputs**: `ThinFilmDEBVDispersionValidation`, `K0KittelFieldSweepValidation`,
  `SaveSpectrum`, `SaveMode`, `SaveDispersion`, and `SaveEigenDiagnostics`.

### 2. Canonical `ProblemIR` representation (`crates/fullmag-ir`)

Python lowering produces a self-contained `StudyIR::Eigenmodes` variant inside `ProblemIR`
(`crates/fullmag-ir/src/study.rs`). All physical quantities are normalized to strict SI units:
frequencies in $\mathrm{Hz}$, wave vectors in $\mathrm{rad\,m^{-1}}$, magnetic fields in
$\mathrm{A\,m^{-1}}$, and lengths in $\mathrm{m}$. Parallel execution hints are normalized into
`ParallelExecutionPolicyIR` (`crates/fullmag-ir/src/parallel_execution.rs`) with explicit mode
selection (`Auto`, `Serial`, or `ProcessPool`) and thread-oversubscription guards.

### 3. Capability resolution and `FemEigenPlanIR` (`crates/fullmag-plan`)

Before any mesh or matrix is allocated, `plan_fem_eigen` (`crates/fullmag-plan/src/fem.rs`)
validates the request against the capability matrix and constructs `FemEigenPlanIR`
(`crates/fullmag-ir/src/plan.rs`):

- **Backend and device gating**: Rejects FDM modal requests and unqualified FEM GPU combinations
  with explicit validation errors rather than silently falling back to FEM CPU.
- **Componentwise $\Gamma$-point classification**: Classifies a wave vector $\mathbf k$ as the
  $\Gamma$ point if and only if every Cartesian component satisfies
  $|k_\alpha| \le \varepsilon_{\Gamma,\mathrm{comp}} = 10^{-12}\,\mathrm{rad\,m^{-1}}$
  (`FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M`), preventing floating-point underflow from
  misrouting a finite-$\mathbf k$ Floquet solve to a real $\Gamma$-point path.
- **Output and boundary legality**: `validate_eigen_outputs` (`crates/fullmag-plan/src/validate.rs`)
  verifies that `SaveDispersion` is paired with a multi-point `KPath` or `BiasFieldSweep`, that
  Floquet/periodic boundary pairs match the mesh topology, and that airbox demagnetization models
  use compatible boundary truncations.

### 4. Stage handoff and R4 equilibrium certification (`crates/fullmag-cli` & `crates/fullmag-runner`)

A linearized modal solve is physically meaningless if expanded around an unconverged transient
state. Fullmag enforces the **R4 equilibrium handoff contract**:

- When `equilibrium_source="relax"`, `accepted_relax_handoff_for_eigen_stage`
  (`crates/fullmag-cli/src/orchestrator.rs`) verifies that the preceding `relax` stage terminated on
  an accepted equilibrium gate (`tolT` or energy/torque convergence), not merely `max_steps`
  exhaustion.
- `materialize_equilibrium` (`crates/fullmag-runner/src/fem/eigen_equilibrium.rs`) and
  `build_owned_modal_certificate_v6_binding` (`crates/fullmag-runner/src/fem/eigen_certificate.rs`)
  bind the nodal equilibrium $\mathbf m_0$, maximum dimensionless torque
  $\max_i \|\mathbf m_{0,i}\times\mathbf H_{\mathrm{eff},i}\| / M_s$, mesh topology digest, and
  periodic equivalence-class maps into an immutable certificate.
- Across an entire $\mathbf k$-path (`KPath`) or fixed-equilibrium sweep, the certified
  $\mathbf m_0$ is frozen and reused across all samples, guaranteeing that dispersion branches
  $\omega_n(\mathbf k)$ are evaluated at the exact same static state.

### 5. Multi-process $\mathbf k$-path orchestration (`EigenKProcessPool`)

Because PETSc and SLEPc maintain process-global state (`PetscInitialize`, global MPI communicators,
signal handlers, and options tables), concurrent in-process PETSc/SLEPc calls from multiple OS
threads are unsafe (governed by ADR-0055). Fullmag solves this at two levels:

1. **In-process mutex guard**: `petsc_slepc_process_mutex()`
   (`backends/fem/core/petsc_slepc_runtime.cpp`) serializes any in-process PETSc/SLEPc lifecycle and
   solve operations.
2. **Multi-process $\mathbf k$-point pool**: For multi-sample `KPath` dispersion solves,
   `EigenKProcessPool` (`crates/fullmag-runner/src/eigen/k_process_pool.rs`) spawns isolated worker
   processes (`fullmag.eigen_k_worker.v2` in `crates/fullmag-runner/src/fem/eigen_k_worker.rs`).
   Each worker has its own private PETSc/SLEPc address space, a deterministic thread budget
   (`EigenKWorkerThreadBudgetV1` controlling `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, and
   `MKL_NUM_THREADS`), and cryptographic SHA-256 verification of the executable, `FemEigenPlanIR`,
   and equilibrium artifact before solving assigned $\mathbf k$-points and streaming progress back
   to `ProcessPoolReportV1`.

### 6. Native C++ FEM modal solver family (`backends/fem`)

Inside each native solve (`solve_modal_eigen_contract` in
`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`), Fullmag dispatches to specialized
operator and eigensolver realizations:

- **Shared-domain Poisson-airbox Schur complement (`slepc_shift_invert_schur`)**: Assembles the
  coupled magnetostatic block system $(q, \phi)$ over the shared magnetic + airbox mesh
  (`assemble_poisson_airbox_shared_domain` in
  `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`) and eliminates the
  quasi-static scalar potential $\phi = -P^{-1}A_{\phi q}q$ via a matrix-free PETSc `MATSHELL`
  Schur complement (`solve_poisson_airbox_modal_eigen_cpu_schur` in
  `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`).
- **Real-split rotated SLEPc pencil**: Because production Linux containers link real-scalar
  `libpetsc-real-dev` and `libslepc-real-dev`, complex Floquet and damped operators are embedded into
  a real $2\times 2$ block representation and rotated by $-\mathrm i$
  (`assemble_real_frequency_rotated_pencil` in
  `backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp`) so that positive real
  circular frequencies $\omega > 0$ map directly to the real shift-and-invert target
  $\tau = \omega_{\mathrm{target}}$.
- **True residual convergence gate**: Shift-and-invert Krylov inner solves are guarded by an
  explicit true-residual check (`floquet_shifted_true_convergence_test` in
  `backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`), preventing
  ill-conditioned preconditioned residuals from admitting spurious eigenpairs.
- **FEM GPU modal engines**: `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` and
  `solve_poisson_airbox_modal_eigen_gpu_device_krylov`
  (`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`) execute device-resident CUDA
  Krylov/SLEPc iterations with hypre BoomerAMG / cuSPARSE Poisson elimination.

### 7. Mode tracking, artifacts, and Control Room data plane

After individual $\mathbf k$-point or bias-field spectra are solved, `track_branches`
(`crates/fullmag-runner/src/eigen/tracking.rs`) and `mass_weighted_subspace_transport`
(`crates/fullmag-runner/src/eigen/tracking_subspace.rs`) connect modes across parameter steps using
the consistent $P_1$ finite-element mass inner product (`ConsistentP1TrackingMetric` in
`crates/fullmag-runner/src/eigen/tracking_mass.rs`), Hungarian maximum-weight bipartite matching,
and SVD principal-angle subspace transport across degenerate crossings. The runner publishes:

- `eigen/spectrum.v2.json`, `eigen/branches.v2.json`, `eigen/dispersion.csv`, and
  `frequency_domain/manifest.v1.json`;
- Binary spatial mode tensors $\delta\mathbf m(\mathbf r) \in \mathbb C^3$ and dynamic magnetostatic
  potential $\delta\phi(\mathbf r) \in \mathbb C$ streamed to the Control Room 3D viewport
  (`modeCompositionViewportProjection.ts`) and interactive spectrum/dispersion charts
  (`frequencyDomainChartModels.ts`).

---

## Physical and mathematical formulation

### Static equilibrium prerequisite

The linearization point $\mathbf m_0(\mathbf r)$ must satisfy the static micromagnetic equilibrium
equations pointwise on the magnetic domain $\Omega_m$:

```{math}
:label: eq-eigen-root-equilibrium
|\mathbf m_0(\mathbf r)| = 1,
\qquad
\mathbf m_0(\mathbf r)\times\mathbf H_{\mathrm{eff}}[\mathbf m_0](\mathbf r) = \mathbf 0.
```

Expanding around a non-equilibrium state introduces a zeroth-order torque residual that violates the
symmetry of the conservative Hessian and corrupts mode frequencies and linewidths.

### Local tangent-plane projection and basis-rotation gauge

Write a small-amplitude time-harmonic perturbation around $\mathbf m_0(\mathbf r)$ under the
canonical Fullmag temporal phase convention $\exp(+\mathrm i\omega t)$:

```{math}
:label: eq-eigen-root-perturbation
\mathbf m(\mathbf r, t)
= \mathbf m_0(\mathbf r)
+ \operatorname{Re}\!\left[\delta\mathbf m(\mathbf r)\,\mathrm e^{\mathrm i\omega t}\right]
+ \mathcal O\!\left(\|\delta\mathbf m\|^2\right).
```

Preserving $|\mathbf m(\mathbf r, t)| = 1$ to first order requires orthogonality to the static
magnetization:

```{math}
:label: eq-eigen-root-tangent-constraint
\mathbf m_0(\mathbf r)\cdot\delta\mathbf m(\mathbf r) = 0.
```

At every magnetic node $i \in \{1,\dots,N_{\mathrm{mag}}\}$, `build_tangent_frame` constructs a
right-handed orthonormal triad $(\mathbf e_{1,i}, \mathbf e_{2,i}, \mathbf m_{0,i})$ satisfying
$\mathbf e_{1,i}\times\mathbf e_{2,i} = \mathbf m_{0,i}$. Assembling the nodal $3\times 2$ blocks
into the global prolongation operator $T \in \mathbb R^{3N_{\mathrm{mag}}\times 2N_{\mathrm{mag}}}$
($T^{\mathsf T}T = I_{2N_{\mathrm{mag}}}$) expresses the constrained 3D perturbation in terms of two
unconstrained tangent coordinates $q_i = (q_{1,i}, q_{2,i})^{\mathsf T} \in \mathbb C^2$:

```{math}
:label: eq-eigen-root-tangent-basis
\delta\mathbf m_i
= \mathbf e_{1,i} q_{1,i} + \mathbf e_{2,i} q_{2,i},
\qquad
\delta\mathbf m = T q.
```

Rotating $(\mathbf e_{1,i}, \mathbf e_{2,i})$ by an angle $\theta_i$ in the tangent plane applies a
local $SO(2)$ gauge transformation $q_i \mapsto R(\theta_i) q_i$ that leaves the physical spectrum
$\{\lambda_n\}$ and reconstructed 3D spatial modes $\delta\mathbf m = T q$ invariant.

### Linearized LLG operator and canonical generalized pencils

Let $\mathcal D\mathbf H_{\mathrm{eff}}[\mathbf m_0]$ denote the Fréchet derivative of the complete
enabled effective field (exchange, magnetocrystalline anisotropy, bulk/interfacial DMI, static and
dynamic demagnetization, and Zeeman field):

```{math}
:label: eq-eigen-root-effective-field-jacobian
\delta\mathbf H_{\mathrm{eff}}
= \mathcal D\mathbf H_{\mathrm{eff}}[\mathbf m_0]\,\delta\mathbf m.
```

Linearizing the Gilbert form of the LLG equation around $\mathbf m_0$ yields

```{math}
:label: eq-eigen-root-linearized-precession
\partial_t\delta\mathbf m
+ \alpha\,\mathbf m_0\times\partial_t\delta\mathbf m
= -\gamma_0\left(
\mathbf m_0\times\delta\mathbf H_{\mathrm{eff}}
+ \delta\mathbf m\times\mathbf H_{\mathrm{eff}}[\mathbf m_0]
\right),
```

where $\gamma_0 = \mu_0|\gamma|$ and $\alpha \ge 0$ is the Gilbert damping parameter. Projecting
onto the tangent basis $T$ yields two equivalent canonical generalized eigenproblem representations
(documented in detail in {doc}`linearized-llg`):

1. **State-space / gyrotropic pencil**:

   ```{math}
   :label: eq-eigen-root-pencil
   \mathsf K\mathbf q = \lambda\mathsf G\mathbf q,
   \qquad
   \lambda = \sigma + \mathrm i\omega,
   \qquad
   f = \frac{|\omega|}{2\pi},
   ```

   or in operator-pencil form $L q = \lambda B_\alpha q$ where $B_\alpha = I + \alpha J$ encodes the
   tangent symplectic matrix $J = \mathrm{diag}_{i}\!\begin{bsmallmatrix}0 & -1\\ 1 & 0\end{bsmallmatrix}$
   and $L$ is the projected linearized torque operator.
2. **Real-split rotated SLEPc pencil**: To target positive real oscillation frequencies
   $\omega_{\mathrm{target}} = 2\pi f_{\mathrm{target}}$ directly with a real scalar shift
   $\tau \in \mathbb R$ in `libpetsc-real-dev` / `libslepc-real-dev`, Fullmag forms the rotated
   pencil $R(L) y = \omega R(\mathrm i B_\alpha) y$, where $R(C) = \begin{bsmallmatrix}\operatorname{Re}C & -\operatorname{Im}C \\ \operatorname{Im}C & \operatorname{Re}C\end{bsmallmatrix}$
   is the real $2\times 2$ block embedding of a complex matrix $C$.

### Coupled magnetostatic descriptor and Schur-complement elimination

When `include_demag=True` on an open-boundary or periodic airbox FEM mesh, the dynamic demagnetizing
field $\delta\mathbf H_{\mathrm{demag}} = -\nabla\delta\phi$ is governed by the quasi-static
Maxwell-magnetostatic Poisson equation over the combined magnetic and airbox domain
$\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$. This produces the block descriptor system

```{math}
:label: eq-eigen-root-coupled-descriptor
\begin{bmatrix}
A_{qq} & A_{q\phi} \\
A_{\phi q} & P
\end{bmatrix}
\begin{bmatrix}
q \\
\phi
\end{bmatrix}
=
\lambda
\begin{bmatrix}
B_{qq} & 0 \\
0 & 0
\end{bmatrix}
\begin{bmatrix}
q \\
\phi
\end{bmatrix},
```

where $A_{qq}$ is the local magnetic tangent operator (exchange, anisotropy, DMI, static internal
field), $A_{q\phi}$ and $A_{\phi q}$ are the magnetic–potential gradient and divergence coupling
blocks, and $P$ is the scalar Laplacian stiffness matrix (augmented by a gauge constraint when pure
Neumann/periodic boundary conditions leave a constant potential nullspace). Eliminating
$\phi = -P^{-1}A_{\phi q}q$ defines the reduced magnetic Schur-complement operator

```{math}
:label: eq-eigen-root-schur
S(\lambda)
= A_{qq} - A_{q\phi} P^{-1} A_{\phi q} - \lambda B_{qq}.
```

In the production `slepc_shift_invert_schur` path, $A_{qq} - A_{q\phi}P^{-1}A_{\phi q}$ is applied
matrix-free via a PETSc `MATSHELL` operator while $P^{-1}$ is evaluated using a cached sparse
factorization (LU/Cholesky on CPU) or preconditioned Krylov/AMG solve (on GPU). Every candidate
mode is certified against the **full coupled descriptor residual** $(r_q, r_\phi)$ after
reconstructing $\phi = -P^{-1}A_{\phi q}q$.

### Bloch/Floquet wave-vector sampling and 2.5D waveguide dispersion

For a periodic lattice translation $\mathbf R$ and in-plane or 3D wave vector $\mathbf k$, Bloch
modes satisfy the quasi-periodic boundary condition

```{math}
:label: eq-eigen-root-bloch
\delta\mathbf m(\mathbf r + \mathbf R)
= \delta\mathbf m(\mathbf r)\,\exp\!\left(-\mathrm i\mathbf k\cdot\mathbf R\right),
\qquad
\delta\phi(\mathbf r + \mathbf R)
= \delta\phi(\mathbf r)\,\exp\!\left(-\mathrm i\mathbf k\cdot\mathbf R\right).
```

Fullmag supports two distinct spatial representations for $\mathbf k$-resolved spin-wave dispersion:

- **`full_3d` with `FloquetBC` / `PeriodicBC`**: Uses a 3D unit-cell mesh with matched periodic
  boundary node pairs. The complex phase $\exp(-\mathrm i\mathbf k\cdot\Delta\mathbf r)$ is applied
  through `FloquetTangentProlongation` (`backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp`)
  and the $\mathbf k$-dependent dynamic demagnetization operator `build_floquet_dynamic_demag_k_real_split`
  (`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`).
- **`waveguide_2p5d`**: For translationally invariant waveguides along the propagation axis, the
  spatial gradient is replaced analytically by the shifted differential operator
  $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf e}_\parallel$ on a cross-sectional mesh
  (`build_floquet_waveguide_demag_k_real_split` in
  `backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp`), eliminating axial mesh
  discretization error at high wave numbers.

---

## Mode normalization, residuals, and branch tracking

### Mode normalization and phase gauge

An eigenvector $\mathbf q$ is defined up to an arbitrary nonzero complex scalar:

```{math}
:label: eq-eigen-root-phase
\mathbf q \sim c\mathbf q,
\qquad
c \in \mathbb C\setminus\{0\}.
```

Fullmag exposes two explicit normalization policies:

- `normalization="unit_l2"`: scales the reconstructed mode so its discrete $\ell_2$ (or mass-weighted)
  norm equals unity;
- `normalization="unit_max_amplitude"`: scales the reconstructed mode so
  $\max_i \|\delta\mathbf m_i\|_2 = 1$.

A deterministic phase gauge (rotating the component of largest magnitude at a canonical reference
node to be real and positive) is applied for reproducible artifact serialization and 3D phase-clock
animation.

### Scale-invariant generalized residual

Every returned eigenpair $(\lambda_n, \mathbf q_n)$ is accompanied by its relative residual:

```{math}
:label: eq-eigen-root-residual
\mathbf r_n = \mathsf K\mathbf q_n - \lambda_n\mathsf G\mathbf q_n,
\qquad
\varepsilon_{\mathrm{eig},n}
= \frac{\lVert\mathbf r_n\rVert_2}
{\lVert\mathsf K\mathbf q_n\rVert_2 + |\lambda_n|\lVert\mathsf G\mathbf q_n\rVert_2}.
```

Modes exceeding the solver tolerance are rejected or flagged as unconverged in
`eigen/spectrum.v2.json` and `SaveEigenDiagnostics`.

### Mass-weighted branch tracking and degenerate-subspace transport

Across a sequence of wave vectors $\mathbf k_s$ (`KPath`) or bias fields $\mathbf H_s$
(`BiasFieldSweep`), ordering eigenvalues solely by frequency $f_0 \le f_1 \le \dots$ produces
artificial branch switching at mode crossings and hybridizations. When `ModeTracking(enabled=True)`
is active (`crates/fullmag-runner/src/eigen/tracking.rs`), Fullmag tracks branches using the
consistent $P_1$ finite-element mass matrix $M$:

```{math}
:label: eq-eigen-root-mode-overlap
\widetilde{v}_{s,a}
= \frac{M^{1/2} v_{s,a}}{\lVert M^{1/2} v_{s,a}\rVert_2},
\qquad
\mathcal O_{ab}^{(s\to s+1)}
= \left|\left\langle \widetilde{v}_{s,a},\, \widetilde{v}_{s+1,b}\right\rangle\right|
= \frac{\left|v_{s,a}^\ast M v_{s+1,b}\right|}
{\sqrt{v_{s,a}^\ast M v_{s,a}}\,\sqrt{v_{s+1,b}^\ast M v_{s+1,b}}}.
```

1. **Non-degenerate matching**: The overlap matrix $\mathcal O_{ab}$ is solved globally via the
   Hungarian algorithm (`method="overlap_hungarian"`) to maximize total branch continuity, flagging
   steps where $\mathcal O_{ab} < \mathrm{min\_overlap}$.
2. **Degenerate subspace transport**: When adjacent modes lie within `degeneracy_tolerance`
   (`frequencies_are_degenerate` in `crates/fullmag-runner/src/eigen/tracking_subspace.rs`),
   `mass_weighted_subspace_transport` computes the singular value decomposition
   $C = U^\ast V = P\Sigma Q^\ast$ of the cross-step subspace overlap matrix, evaluates the minimum
   principal-angle cosine $s_{\mathrm{sub}} = \min_j \sigma_j(C)$, and applies the unitary
   Procrustes rotation $R = Q P^\ast$ to transport the basis smoothly across the degeneracy.

### Analytical reference error

When `ThinFilmDEBVDispersionValidation` or `K0KittelFieldSweepValidation` is attached to the study,
computed branch frequencies $f_j^{\mathrm{num}}$ are compared against the analytical Kittel or
Kalinikos–Slavin reference $f_j^{\mathrm{ref}}$:

```{math}
:label: eq-eigen-root-reference-error
\varepsilon_j
= \frac{\left|f_j^{\mathrm{num}} - f_j^{\mathrm{ref}}\right|}
{\left|f_j^{\mathrm{ref}}\right|}.
```

See {doc}`modal-validation` for the complete Kittel and Kalinikos–Slavin dipole-exchange formulas
and qualification gates.

---

## Public Python workflow

```python
# %% Equilibrium relaxation followed by FEM k-path dispersion and modal outputs
import fullmag as fm

nm = 1.0e-9
study = fm.study("linearized_llg_modes")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
study.stages.add_eigenmodes(
    stage_id="modes",
    count=12,
    target="lowest",
    operator="linearized_llg",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (1.0e7, 0.0, 0.0)),
        ],
        samples_per_segment=[8],
    ),
    solver_rtol=1.0e-8,
    solver_max_outer_iterations=500,
    solver_max_linear_iterations=200,
)
```

### Public parameter summary

| Parameter | Default | Unit | Meaning and validation |
|---|---:|---:|---|
| `count` | `10` | $1$ | Positive integer number of requested eigenmodes per sample |
| `target` | `"lowest"` | $1$ | Spectral selection policy: `"lowest"`, `"nearest"`, or `"frequency_window"` |
| `target_frequency` | `None` | $\mathrm{Hz}$ | Shift target frequency required when `target="nearest"` |
| `frequency_min`, `frequency_max` | `None` | $\mathrm{Hz}$ | Ordered positive window bounds required when `target="frequency_window"` |
| `operator` | `"linearized_llg"` | $1$ | Dynamic operator family: `"linearized_llg"` or `"full_2x2"` |
| `include_demag` | `True` | $1$ | Includes linearized dynamic demagnetization ($\delta\mathbf H_{\mathrm{demag}} = -\nabla\delta\phi$) |
| `equilibrium_source` | `"relax"` | $1$ | Equilibrium state provider: `"relax"`, `"provided"`, or `"artifact"` |
| `equilibrium_artifact` | `None` | $1$ | Artifact path required when `equilibrium_source="artifact"` |
| `normalization` | `"unit_l2"` | $1$ | Eigenvector normalization: `"unit_l2"` or `"unit_max_amplitude"` |
| `damping_policy` | `"ignore"` | $1$ | Gilbert damping treatment: `"ignore"` ($\alpha=0$ conservative) or `"include"` |
| `k_vector` | `None` | $\mathrm{rad\,m^{-1}}$ | Single Bloch wave vector $(k_x, k_y, k_z)$ |
| `k_sampling` | `None` | $1$ | `KPoint` or `KPath` wave-vector sampling specification |
| `bias_field_sweep` | `None` | $1$ | `BiasFieldSweep` sweep over external static magnetic field vectors |
| `mode_tracking` | `None` | $1$ | `ModeTracking` configuration for mass-weighted Hungarian/subspace branch continuity |
| `bc` | `"free"` | $1$ | Spin-wave boundary condition: `"free"`, `"pinned"`, `PeriodicBC`, or `FloquetBC` |
| `spatial_representation` | `"full_3d"` | $1$ | `"full_3d"` or `"waveguide_2p5d"` cross-sectional operator |
| `fem_solver_policy` | `None` | $1$ | `FemEigenSolverPolicy` controlling native SLEPc/Schur/dense/LOBPCG execution |
| `outputs` | `None` | $1$ | Modal output artifacts (`SaveSpectrum`, `SaveMode`, `SaveDispersion`, `SaveEigenDiagnostics`) |

---

## Realization matrix

| Solver | Device | Status | Meaning |
|---|---|---|---|
| FEM | CPU | `source-backed` | Production native modal lane: shared-domain Poisson-airbox Schur complement (`slepc_shift_invert_schur`), real-split rotated SLEPc pencil, Bloch/Floquet $\mathbf k$-paths, 2.5D waveguides, multi-process `EigenKProcessPool`, and dense/LOBPCG reference solvers |
| FEM | GPU | `partial` | Supported for qualified $\Gamma$-point ($\mathbf k=0$) and device-resident PETSc/SLEPc/CUDA Krylov (`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`, `solve_poisson_airbox_modal_eigen_gpu_device_krylov`); requires runtime device-residency proof |
| FDM | CPU | `unsupported` | No native production FDM modal eigensolver lane is claimed; planner fails closed |
| FDM | GPU | `unsupported` | No public CUDA FDM modal eigensolver lane is claimed; planner fails closed |

Unsupported combinations fail explicitly during planning (`plan_fem_eigen`) before matrix assembly.
They never route silently through a hidden CPU or alternative-discretization fallback.

---

## Implementation mapping and GitHub source index

All source citations below are pinned to the reviewed repository revision
`5e99782acbb7fb3f65d0cad872e102bf67733103`.

| Subsystem | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Python stage spec | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | `class EigenmodesStageSpec` | Public stage-first modal request schema and validation |
| Python stage builder | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L4633) | `add_eigenmodes` | Appends an `eigenmodes` stage to `study.stages` |
| Python study model | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | `class Eigenmodes` | Canonical Python `Eigenmodes` study representation and `.to_ir()` lowering |
| Python solver policy | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | `class FemEigenSolverPolicy` | Explicit FEM eigensolver backend, Krylov subspace, shift, and tolerance policy |
| Python $\mathbf k$ & tracking | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | `class KPath`, `class BiasFieldSweep`, `class ModeTracking` | Wave-vector paths, field sweeps, and mass-weighted mode tracking schemas |
| Python validation | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L244) | `class ThinFilmDEBVDispersionValidation`, `class K0KittelFieldSweepValidation` | Typed Kalinikos–Slavin DE/BV dispersion and $\mathbf k=0$ Kittel validation contracts |
| Canonical IR | [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study.rs#L1397) | `EigenOperatorIR`, `EigenTargetIR`, `KSamplingIR`, `BiasFieldSweepIR` | Rust `ProblemIR` modal study types and serde validation |
| Execution plan IR | [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/plan.rs#L1807) | `FemEigenPlanIR`, `FemEigenSolverPolicyIR` | Resolved FEM modal execution plan and native solver policy IR |
| FEM modal planner | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | `plan_fem_eigen`, `FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M` | Capability checks, $\Gamma$-point classification ($10^{-12}\,\mathrm{rad\,m^{-1}}$), and plan construction |
| Stage R4 handoff | [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-cli/src/orchestrator.rs#L2947) | `accepted_relax_handoff_for_eigen_stage` | Verifies converged `relax` equilibrium before launching an `eigenmodes` stage |
| Path orchestrator | [`crates/fullmag-runner/src/eigen/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/orchestrator.rs#L82) | `run_path_or_single_controlled` | Coordinates single-$\mathbf k$ and multi-sample $\mathbf k$-path execution |
| $\mathbf k$-process pool | [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | `EigenKProcessPool`, `ProcessPoolReportV1` | Multi-process worker pool isolating PETSc/SLEPc state across $\mathbf k$-points |
| Branch tracking | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | `track_branches` | Mass-weighted Hungarian mode matching across $\mathbf k$ and bias-field steps |
| Subspace transport | [`crates/fullmag-runner/src/eigen/tracking_subspace.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | `mass_weighted_subspace_transport`, `frequencies_are_degenerate` | SVD principal-angle and unitary Procrustes transport across degenerate crossings |
| $P_1$ mass metric | [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | `ConsistentP1TrackingMetric` | Consistent $P_1$ finite-element inner product for mode overlap |
| Equilibrium & V6 cert | [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | `build_owned_modal_certificate_v6_binding` | Cryptographic binding of equilibrium state, mesh topology, and periodic seam maps |
| PETSc/SLEPc mutex | [`backends/fem/core/petsc_slepc_runtime.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/core/petsc_slepc_runtime.cpp#L24) | `petsc_slepc_process_mutex` | Process-global mutex enforcing thread-safe PETSc/SLEPc access (ADR-0055) |
| Native modal contract | [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | `solve_modal_eigen_contract` | Primary C++ FEM modal entry point, validation, and diagnostic packaging |
| Tangent frame | [`backends/fem/include/frequency_domain/tangent_frame.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/tangent_frame.hpp#L38) | `build_tangent_frame` | Nodal orthonormal tangent basis $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$ construction |
| Dynamic pencil | [`backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp#L38) | `class LinearizedDynamicPencil` | Canonical operator pencil $L q = \lambda B_\alpha q$ and real-split actions |
| Rotated real pencil | [`backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp#L31) | `assemble_real_frequency_rotated_pencil` | Real-split rotated pencil $R(L)y = \omega R(\mathrm i B_\alpha)y$ for real SLEPc builds |
| Shared-domain assembly | [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | `assemble_poisson_airbox_shared_domain` | Coupled magnetic-airbox block assembly $(A_{qq}, A_{q\phi}, A_{\phi q}, P)$ |
| CPU Schur SLEPc | [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | `solve_poisson_airbox_modal_eigen_cpu_schur` | Matrix-free `MATSHELL` Schur-complement shift-and-invert SLEPc eigensolver |
| Shifted KSP gate | [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | `floquet_shifted_true_convergence_test` | Enforces true unpreconditioned residual convergence inside SLEPc shift-and-invert |
| GPU PETSc/SLEPc/Krylov | [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L15) | `solve_poisson_airbox_modal_eigen_gpu_device_krylov`, `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Device-resident CUDA Krylov and PETSc/SLEPc/hypre modal eigensolvers |

---

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers / Wiley, New York, 1963.
2. C. Kittel, “On the theory of ferromagnetic resonance absorption,” *Physical Review* **73**,
   155–161 (1948), [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
3. B. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for
   ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C: Solid State
   Physics* **19**, 7013–7033 (1986),
   [doi:10.1088/0022-3719/19/35/014](https://doi.org/10.1088/0022-3719/19/35/014).
4. V. Hernández, J. E. Román, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the
   solution of eigenvalue problems,” *ACM Transactions on Mathematical Software* **31**, 351–362
   (2005), [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
5. M. d'Aquino, C. Serpico, G. Miano, and C. Forestiere, “A novel formulation for the numerical
   computation of magnetization modes in complex micromagnetic systems,” *Journal of Computational
   Physics* **228**, 6130–6149 (2009),
   [doi:10.1016/j.jcp.2009.05.026](https://doi.org/10.1016/j.jcp.2009.05.026).
6. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

```{toctree}
:maxdepth: 1

linearized-llg
modal-validation
```

## Control Room crosswalk

This is a navigation page; use the terminal page named by the selected stage or solver
({doc}`linearized-llg` or {doc}`modal-validation`). In the Control Room Inspector, stage-level
controls for `eigenmodes` are routed through `StudyStageInspectorRouter`
(`EigenmodesSetupStageInspectorPanel`, `EigenmodesOperatorStageInspectorPanel`,
`EigenmodesKPathStageInspectorPanel`, `EigenmodesSolverStageInspectorPanel`, and
`EigenmodesOutputsStageInspectorPanel`). Numerical parameters without a matching UI control are
authored via the canonical Python script. See {doc}`/frontend/capability-register` for the current
register and exact source owner.

## Source-code index

This category index summarizes the end-to-end eigensolve pipeline; the validated terminal symbol
maps are maintained in {doc}`linearized-llg` and {doc}`modal-validation`.
