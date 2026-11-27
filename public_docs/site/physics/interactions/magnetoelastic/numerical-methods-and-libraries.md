---
title: Magnetoelastic numerical methods, HPC optimization, and solver libraries
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-magnetoelastic-numerical-methods-and-libraries)=
# Magnetoelastic numerical methods, HPC optimization, and solver libraries

Bidirectional magnon–phonon simulations couple a stiff nonlinear micromagnetic Landau–Lifshitz–Gilbert
(LLG) system (characteristic time scales $0.1\text{--}10\,\mathrm{ps}$, exchange length
$\ell_{\mathrm{ex}} \sim 3\text{--}20\,\mathrm{nm}$) to hyperbolic/parabolic anisotropic
elastodynamics across micrometer-to-millimeter acoustic substrates (sound speeds
$c_{\max} \sim 4\text{--}12\,\mathrm{km\,s^{-1}}$, $10^5\text{--}10^8$ mechanical DOFs).
Achieving both conservation-law accuracy and production throughput across CPU, GPU, and multi-node
MPI clusters requires specialized time integrators, preconditioners, spectral congruence scalings,
and carefully configured external sparse/multigrid libraries.

This page documents the complete FullMag numerical architecture across all four solver lanes
(FDM CPU, FDM GPU, FEM CPU, FEM GPU), the C ABI v1 capability contracts, HPC/CUDA/AVX-512/MPI
optimizations, the pinned external numerical library stack (`cuDSS`, `oneMKL PARDISO`, `MFEM`,
`libCEED`, `Hypre`, `PETSc`, `SLEPc`, `MUMPS`, `ParMETIS`, `OpenMPI`, `FFTW`/`cuFFT`), and the
eight quantitative verification gates (`G1`–`G8`). For continuum physics see {doc}`index`; for
boundary conditions, interfaces, and spatial meshing see {doc}`boundary-conditions-and-meshing`;
and for FullMag's measured production optimizations across FDM, FEM, and multiphysics see
{ref}`numerical-methods-performance` (in particular
{ref}`numerical-methods-performance-fem-gpu-kernels` and
{ref}`numerical-methods-performance-fem-spectral-multiphysics`).

:::{important}
**Current `master` executable boundary vs. dedicated solver branch & planned runtime kernels.**
- **Executable on `master` today:** the FEM CPU/GPU prescribed-strain magnetoelastic kernels
  (with `ComputeEnergy` reduction gating, single-launch fused $\mathbf{H}_{\mathrm{eff}}$, and
  0-ULP non-contracted FP64 parity; see {ref}`numerical-methods-performance-fem-gpu-kernels`),
  `CudssModalShift`, `solve_driven_response_gpu_cudss`, and the pinned `MFEM v4.10` /
  `libCEED v0.12.0` / `Hypre` / `PETSc v3.24.6` / `SLEPc v3.24.3` / `cuDSS 0.8.0.10` container
  stack.
- **Implemented on the dedicated bidirectional magnetoelastic solver branch (not yet merged to
  `master`):** `v0.3`/`v0.4` IR & `PhysicsObjectTypeIR::Solid` multidomain migration, stage-first
  Python DSL, full FDM/FEM planner lowering (`FdmElastodynamicsPlanIR` with Kelvin–Mandel acoustic
  and viscous CFL $\Delta t_{\mathrm{visc}}$ plus lateral `v_imex_m_s` guard, FM+NM FEM
  `FemMechanicalPlanIR`, coupled `FdmEigenPlanIR` / `FdmFrequencyResponsePlanIR` with
  `acoustic_drives` and `equilibrium_mechanics`, multi-component Fredholm RBM verification), and
  the hardened toolchain (decoupled `cuDSS`/`SLEPc`, `Intel oneMKL 2025.0.1-14` via
  `Fullmag::MklGnuThread` strictly linking `mkl_gnu_thread` + `libgomp`, neutral CUDA-free
  `/opt/fullmag-metis` hosting `METIS v5.1.0-p12` + `ParMETIS v4.0.3-p9` with `ldd` ABI gate, and
  isolated MPI runner).
- **Planned native bidirectional runtime kernels:** two-way elastodynamic time integrators,
  `HEVI IMEX-z PC2`, `GpuElasticCudssSolver` Frozen-Factor PCG, coupled $(k,\omega)$
  magnetoelastic pencils, and `G1`–`G8` runtime qualification gates fail closed on `master` until
  activated and verified.
:::

(magnetoelastic-num-problem-statement)=
## Numerical problem and four-lane execution architecture

### Why coupled magnon–phonon dynamics is numerically challenging

Four distinct stiffness mechanisms govern coupled magnetoelastic integration:

1. **Multi-scale geometric stiffness:** magnetic films are often $d_{\mathrm{FM}} = 1\text{--}50\,\mathrm{nm}$
   thick while substrates extend $H_{\mathrm{sub}} = 1\text{--}50\,\mu\mathrm{m}$ deep, creating
   cell aspect ratios $\Delta x / \Delta z \sim 10\text{--}100$ that cripple naive explicit
   elastodynamics ($\Delta t_{\mathrm{CFL}} \propto \Delta z / c_{\max}$).
2. **Parabolic Kelvin–Voigt viscous stiffness:** explicit strain-rate viscosity scales as
   $\Delta t_{\mathrm{visc}} \propto \rho \Delta z^2 / \lVert\boldsymbol{\eta}_{\mathrm{KM}}\rVert_2$,
   tightening quadratically with vertical grid refinement.
3. **Magnetic–elastic scale disparity:** elastic stiffness ($C_{11} \sim 10^{11}\,\mathrm{Pa}$)
   exceeds micromagnetic energy density ($\mu_0 M_s^2 \sim 10^4\text{--}10^6\,\mathrm{J\,m^{-3}}$)
   by $5\text{--}7$ orders of magnitude, causing severe ill-conditioning in unscaled coupled
   frequency-domain eigenproblems.
4. **Cross-platform residency & ABI discipline:** GPU performance collapses if displacement or
   magnetization arrays cross PCIe every time step, while MPI scalability collapses if magnetic
   elements are unbalanced across ranks or if OpenMP thread runtimes (`libgomp` vs. `libiomp5`)
   conflict inside `oneMKL PARDISO`.

### Positioning relative to existing magnetoelastic simulators

| Simulator / literature reference | Spatial method | Coupling & time integration | Key architectural distinction in FullMag v2 |
|---|---|---|---|
| MuMax3 / Vanderveken *et al.* (2021) | FDM GPU (cubic/isotropic) | Explicit velocity-Verlet / RK; uniform cubic cells | FullMag adds 7-class anisotropy + Bond rotation, 4-grid Lebedev, HEVI IMEX-$z$, Melcher $\mathcal{O}(\omega^2)$ rotation, and FEM conformal heterostructures |
| magnum.np / Flauger *et al.* (2026) | FDM PyTorch GPU | Explicit staggered / RK; multilayer films | FullMag adds native C++/CUDA 3.5D ping-pong kernels, `cuDSS`/`oneMKL` quasistatics, 2D plane-stress Schur, and coupled $(k,\omega)$ eigensolvers |
| Normington & Ruggeri (2025, `arXiv:2309.00605`) | FEM CPU (Firedrake/PETSc) | Decoupled tangent-plane LLG + **implicit Backward Euler (BDF1)** elasticity | FullMag uses 2nd-order Chung–Hulbert Generalized-$\alpha$ (zero artificial amplitude decay at $\rho_\infty = 1$), `Prism6` `MITC6+EAS-1`, and GPU `cuDSS`/`libCEED`/`Hypre` |
| FullMag v2 (4-lane unified) | FDM + FEM on CPU + GPU + MPI | Unified `ProblemIR`, C ABI v1 bitmasks, exact variational adjoint | Single physics schema driving both FDM supergrids and FEM `SubMesh` with matched `G1`–`G8` verification oracles |

(magnetoelastic-v2-cabi-contract)=
### Versioned C ABI v1 and capability bitmasks

Rust planning (`crates/fullmag-plan`) lowers `ProblemIR` into explicit lane plans checked against
compiled native capability bitmasks before allocating solver memory:

- **FDM C ABI v1 (`FullmagFdmMechState`, 23 capability bits):** advertises Virieux staggered,
  Lebedev 4-grid, 2D plane-stress Schur, conditional interface stabilizer $\theta_c$, Velocity-Verlet
  + Hermite multirate, HEVI IMEX-$z$ `PC2`, BDF2/HHT-$\alpha$, Schur+BDF2 viscous free surface,
  ABL, ADE CFS-PML, Melcher $\mathcal{O}(\omega^2)$ rotation, 5 damping variants, Langevin FDT
  bath, IDT/Thomsen/harmonic drives, multi-component Fredholm RBM, `SpectralZThomasPCG`, `GMG`,
  `cuDSS`, `oneMKL PARDISO`, 1D-$z$ Floquet–Bloch, 3D Harmonic Balance, AVX-512, and OpenMPI 2D
  pencil decomposition.
- **FEM C ABI v1 (`FullmagFemMechState`, 17 capability bits):** advertises prescribed-strain
  cubic $B_1/B_2$, `SubMesh`/`ParSubMesh` airbox stripping, `FaceKey` BC tags, `Tet10` $\bar{\mathbf{B}}$,
  `Prism6` `MITC6+EAS-1`, 12-point `IntRules(PRISM, 3)`, Chung–Hulbert Generalized-$\alpha$,
  Central Difference, `PGBB`/`NCG` primal-dual quasistatics, `GpuElasticCudssSolver` Frozen-Factor
  PCG, `libCEED` PA, `Hypre 3.1.0` GPU `BoomerAMG`, `oneMKL PARDISO`, `MUMPS` exact inertia,
  `SLEPc` `EPS_GNHEP` congruence-scaled modal pencil, `CudssModalShift`, and `ParMETIS` `ncon=3`.

(magnetoelastic-num-governing-equations)=
## Governing discrete algorithms and stability theorems

(magnetoelastic-v2-fdm-integrators-contract)=
### FDM time integration, stability bounds, and quasistatic solvers

#### Kelvin–Mandel explicit CFL and viscous limits

For a 3D staggered grid with cell spacings $(\Delta x, \Delta y, \Delta z)$ and orthonormal
Kelvin–Mandel stiffness $\mathbf{C}_{\mathrm{KM}}$ and viscosity $\boldsymbol{\eta}_{\mathrm{KM}}$,
explicit time stepping must obey both the hyperbolic acoustic CFL condition and the parabolic
Kelvin–Voigt diffusion limit (both enforced in the solver-branch planner's
`FdmElastodynamicsPlanIR` alongside the horizontal IMEX-$z$ wave-speed guard `v_imex_m_s`):

```{math}
:label: eq-mel-num-fdm-cfl
\Delta t_{\mathrm{CFL}}
=
\frac{S_{\mathrm{CFL}}}{c_{\max}\sqrt{\Delta x^{-2} + \Delta y^{-2} + \Delta z^{-2}}},
\qquad
c_{\max} \le \sqrt{\frac{\left\lVert \mathbf{C}_{\mathrm{KM}} \right\rVert_2}{\rho}},
\qquad
\Delta t_{\mathrm{visc}}
=
\frac{\rho}{2\left\lVert \boldsymbol{\eta}_{\mathrm{KM}} \right\rVert_2\left(\Delta x^{-2} + \Delta y^{-2} + \Delta z^{-2}\right)},
```

with safety factor $S_{\mathrm{CFL}} = 0.85$ for Virieux staggered stencils (and $S_{\mathrm{CFL}} = 0.80$
for 4-grid Lebedev). For HEVI IMEX-$z$, the planner computes the bounded lateral wave speed
$v_{\mathrm{imex}}$ from the horizontal Christoffel spectrum with vertical-coupling stabilization
so strongly coupled anisotropic cuts cannot yield an unbounded lateral CFL ceiling.

#### Symplectic Velocity-Verlet with FSAL-safe Cubic Hermite multirate LLG coupling

When $\Delta t_{\mathrm{mech}} < \Delta t_{\mathrm{LLG}}$, FullMag sub-steps elastodynamics
$N_{\mathrm{sub}} = \lceil \Delta t_{\mathrm{LLG}} / \Delta t_{\mathrm{mech}} \rceil$ times per
magnetic macro-step using symplectic staggered velocity–stress leapfrog:

```{math}
:label: eq-mel-num-fdm-verlet
\begin{aligned}
\mathbf{v}^{n+1/2}
&= \frac{1 - \frac{1}{2}\alpha_M \Delta t_m}{1 + \frac{1}{2}\alpha_M \Delta t_m}\,\mathbf{v}^{n-1/2}
+ \frac{\Delta t_m / \rho}{1 + \frac{1}{2}\alpha_M \Delta t_m}\!\left(\nabla_h \cdot \boldsymbol{\sigma}^{\mathrm{tot},n} + \mathbf{f}_{\mathrm{ext}}^n + \mathbf{f}_{\mathrm{th}}^n\right), \\
\mathbf{u}^{n+1} &= \mathbf{u}^n + \Delta t_m\,\mathbf{v}^{n+1/2}, \qquad
\boldsymbol{\varepsilon}^{n+1} = \nabla_h^{\mathrm{sym}}\mathbf{u}^{n+1}.
\end{aligned}
```

Across sub-steps $s \in [0, 1]$ inside $[t_k, t_k + \Delta t_{\mathrm{LLG}}]$, magnetization is
reconstructed via **Cubic Hermite interpolation** using the endpoint states $(\mathbf{m}_k, \mathbf{m}_{k+1})$
and already-computed LLG time derivatives $(\dot{\mathbf{m}}_k, \dot{\mathbf{m}}_{k+1})$:

```{math}
:label: eq-mel-num-hermite-multirate
\mathbf{m}_H(s)
=
(2s^3 - 3s^2 + 1)\mathbf{m}_k
+ (s^3 - 2s^2 + s)\Delta t_{\mathrm{LLG}}\dot{\mathbf{m}}_k
+ (-2s^3 + 3s^2)\mathbf{m}_{k+1}
+ (s^3 - s^2)\Delta t_{\mathrm{LLG}}\dot{\mathbf{m}}_{k+1},
\qquad
\widehat{\mathbf{m}}(s) = \frac{\mathbf{m}_H(s)}{\left\lVert\mathbf{m}_H(s)\right\rVert_2}.
```

Because `Dormand–Prince` (`RK45`) is FSAL (First Same As Last), both $\dot{\mathbf{m}}_k$ and
$\dot{\mathbf{m}}_{k+1}$ are already available at **zero additional magnetic field evaluations**,
preserving $\mathcal{O}(\Delta t_{\mathrm{LLG}}^2)$ coupling accuracy without breaking FSAL reuse.

#### HEVI IMEX-$z$ `PC2` with adaptive viscous stabilization $\alpha_{\mathrm{KV},z,c}$

In thin films with $\Delta z \ll \min(\Delta x, \Delta y)$ (typical aspect ratio $10\text{--}100$),
splitting the discrete elastic–viscous operator into explicit lateral derivatives
$\mathcal{L}_{xy}$ and implicit vertical derivatives $\mathcal{L}_z$ eliminates $\Delta z$ from
the explicit stability ceiling. Naive implicit–explicit splitting of anisotropic Kelvin–Voigt
viscosity suffers a subtle vertical blow-up ($\lvert\xi\rvert \approx 1.761$) when off-diagonal
$z$-viscosity terms are left explicit. FullMag v2 eliminates this instability completely through
an **adaptive diagonal viscous stabilization factor** $\alpha_{\mathrm{KV},z,c}$ inside a 2-stage
trapezoidal predictor–corrector (`PC2`) scheme:

```{math}
:label: eq-mel-num-hevi-alpha-kv
\alpha_{\mathrm{KV},z,c}
:=
\max\!\left(2,\; 2\,\lambda_{\max}\!\left(\left(\boldsymbol{\eta}_{z,c}^{\mathrm{diag}}\right)^{-1}\boldsymbol{\eta}_{z,c}\right)\right),
```

where $\boldsymbol{\eta}_{z,c}$ is the $3\times 3$ vertical Kelvin–Voigt viscosity block at cell
$c$ and $\boldsymbol{\eta}_{z,c}^{\mathrm{diag}} = \operatorname{diag}(\eta_{55}, \eta_{44}, \eta_{33})$
is its decoupled diagonal part. Each stage solves strictly independent batched tridiagonal
vertical systems of size $N_z$ per $(i,j)$ column ($\mathcal{O}(N_z)$ FLOPs via Thomas algorithm
with zero inter-column coupling), maintaining unconditional vertical stability ($\lvert\xi\rvert \le 1$)
and $\mathcal{O}(\Delta t^2)$ temporal accuracy across the resolved viscous regime.

#### FDM quasistatic solvers

For quasistatic equilibria $\mathbf{K}\mathbf{u} = \mathbf{f}$ (with multi-component Fredholm RBM
projection onto $\ker(\mathbf{K})^\perp$):

- **`SpectralZThomasPCG`:** for laterally periodic multilayer stacks, applies 2D FFT in $(x,y)$
  followed by exact banded vertical Thomas inversion in $z$ as a spectrally tight PCG preconditioner
  ($\mathcal{O}(N\log N)$ per iteration, converging in $5\text{--}15$ iterations even across high
  stiffness contrasts).
- **Geometric Multigrid (`GMG`):** semi-coarsening in $xy$ / full 3D coarsening with colored
  Gauss–Seidel / Chebyshev smoothers for non-periodic 3D geometries.
- **Direct sparse solvers:** `cuDSS` (GPU) and `oneMKL PARDISO` (CPU) for exact reference solves
  and modest-size 3D heterostructures.

(magnetoelastic-v2-fem-integrators-contract)=
### FEM variational adjoint, time integrators, and Frozen-Factor PCG

#### Exact variational adjoint coupling

In the $H^1(\Omega_{\mathrm{mech}})^3$ finite-element space spanned by vector basis functions
$\{\boldsymbol{\phi}_a\}$, the discrete nodal magnetostrictive force vector and nodal
magnetoelastic effective field satisfy the exact discrete variational adjoint identity:

```{math}
:label: eq-mel-num-fem-adjoint
f_{\mathrm{mel},a}
=
-\frac{\partial E_{\mathrm{mel}}}{\partial u_a}
=
-\int_{\Omega_{\mathrm{mag}}} \boldsymbol{\sigma}^{\mathrm{mel}}(\mathbf{m}) : \nabla\boldsymbol{\phi}_a\,dV,
\qquad
\mathbf{H}_{\mathrm{mel},i}
=
-\frac{1}{\mu_0 M_{s,i} m_{L,i}}\frac{\partial E_{\mathrm{mel}}}{\partial \mathbf{m}_i},
```

evaluated with the identical quadrature rule (mandatory 12-point `IntRules(PRISM, 3)` on `Prism6`).
This guarantees exact discrete cancellation of cross-coupling work
$\sum_a f_{\mathrm{mel},a}\dot{u}_a - \sum_i \mu_0 M_{s,i} m_{L,i} \mathbf{H}_{\mathrm{mel},i}\cdot\dot{\mathbf{m}}_i = -\frac{d}{dt}E_{\mathrm{mel}}$
down to machine precision.

#### Chung–Hulbert Generalized-$\alpha$ implicit elastodynamics

For the semi-discrete FEM elastodynamic system
$\mathbf{M}\ddot{\mathbf{U}} + \mathbf{D}\dot{\mathbf{U}} + \mathbf{K}\mathbf{U} = \mathbf{F}(t, \mathbf{m})$,
FullMag v2 uses the **Chung–Hulbert (1993) Generalized-$\alpha$ method** parameterized solely by
the high-frequency spectral radius $\rho_\infty \in [0, 1]$:

```{math}
:label: eq-mel-num-gen-alpha-params
\alpha_m = \frac{2\rho_\infty - 1}{\rho_\infty + 1},
\qquad
\alpha_f = \frac{\rho_\infty}{\rho_\infty + 1},
\qquad
1 - \alpha_m = \frac{2 - \rho_\infty}{1 + \rho_\infty} \in \left[\tfrac{1}{2}, 2\right],
\qquad
\gamma = \frac{1}{2} - \alpha_m + \alpha_f,
\qquad
\beta = \frac{1}{4}\left(1 - \alpha_m + \alpha_f\right)^2.
```

At each step $t_n \to t_{n+1}$, the linearized dynamic equilibrium evaluates at midpoint stages
$(1-\alpha_m)\mathbf{A}^{n+1} + \alpha_m\mathbf{A}^n$ and $(1-\alpha_f)\mathbf{U}^{n+1} + \alpha_f\mathbf{U}^n$,
leading to the strictly symmetric positive-definite effective dynamic stiffness matrix

```{math}
:label: eq-mel-num-gen-alpha-keff
\mathbf{K}_{\mathrm{eff}}(\Delta t)
=
\frac{1 - \alpha_m}{\beta \Delta t^2}\,\mathbf{M}
+ \frac{(1 - \alpha_f)\gamma}{\beta \Delta t}\,\mathbf{D}
+ (1 - \alpha_f)\,\mathbf{K}
\succ 0.
```

Setting $\rho_\infty = 1.0$ recovers the energy-conserving Newmark trapezoidal rule ($\alpha_m = \alpha_f = \frac{1}{2}$,
zero numerical dissipation, ideal for G3 energy conservation and G8 thermal equipartition);
$\rho_\infty \in [0.8, 0.95]$ provides optimal high-frequency spurious-mesh-mode filtering while
remaining strictly second-order accurate and unconditionally stable.

#### Explicit Central Difference, Defect-Correction `RK45`, and primal-dual quasistatics

- **Explicit Central Difference:** uses row-sum lumped mass $\mathbf{M}_L$ and evaluates viscous
  forces consistently at the half-step velocity $-\mathbf{D}_L \mathbf{V}^{n+1/2}$ for shock and
  picosecond laser-pulse simulations where $\Delta t_{\mathrm{CFL}}$ is already comparable to
  $\Delta t_{\mathrm{LLG}}$.
- **Stiff coupled LLG–FEM stepping:** tracks a filtered stiffness indicator $\phi_{\mathrm{stiff}}$
  and activates Defect-Correction `RK45` (or tangent-plane implicit LLG) whenever high-frequency
  exchange or magnetoelastic stiffness would otherwise shrink adaptive explicit steps.
- **Quasistatic coupled minimization (`PGBB` / `NCG`):** eliminates $\mathbf{u}^*(\mathbf{m}) = \mathbf{K}_{\mathrm{stat}}^{-1}\mathbf{f}_{\mathrm{mel}}(\mathbf{m})$
  at outer iterations and certifies global optimality via the primal-dual mechanical energy gap
  $\Delta\mathcal{E}_{\mathrm{mech}}^* = \mathcal{E}_{\mathrm{primal}}(\mathbf{u}_k) - \mathcal{E}_{\mathrm{dual}}(\boldsymbol{\sigma}_k)$.

#### `GpuElasticCudssSolver`, Frozen-Factor PCG, and `libCEED` PA + `Hypre 3.1.0`

Solving $\mathbf{K}_{\mathrm{eff}}(\Delta t)\Delta\mathbf{U} = \mathbf{R}$ dominates FEM
elastodynamics cost. FullMag v2 employs a two-tier GPU acceleration strategy:

1. **Direct + Frozen-Factor PCG (`GpuElasticCudssSolver`, up to $\sim 1\text{--}2\times 10^6$ DOFs):**
   `cuDSS` computes the sparse Cholesky factorization $\mathbf{K}_{\mathrm{eff}}(\Delta t_0) = \mathbf{L}\mathbf{L}^\top$
   once on GPU. While $\Delta t = \Delta t_0$ stays constant, every time step executes a single
   GPU triangular solve ($\sim 10\text{--}50\times$ faster than re-factorizing). Under mild
   adaptive $\Delta t$ changes, the cached factor $\mathbf{L}\mathbf{L}^\top$ preconditions PCG
   with **exact Euclidean residual certification**

```{math}
:label: eq-mel-num-frozen-factor-pcg
\left\lVert \mathbf{r}_k \right\rVert_2
=
\left\lVert \mathbf{R} - \mathbf{K}_{\mathrm{eff}}(\Delta t)\,\Delta\mathbf{U}_k \right\rVert_2
\le
\epsilon_{\mathrm{rel}} \left\lVert \mathbf{R} \right\rVert_2,
```

   preventing false convergence from preconditioned-norm drift when $\Delta t$ shifts; `cuDSS`
   re-factorizes automatically only when PCG exceeds $6\text{--}8$ iterations.
2. **Matrix-Free `libCEED` PA + `Hypre 3.1.0` GPU `BoomerAMG` ($> 10^6$ DOFs & multi-GPU MPI):**
   `libCEED` Partial Assembly evaluates $\mathbf{K}_{\mathrm{eff}}\mathbf{v}$ directly from
   quadrature-point material tensors ($\mathcal{O}(p)$ memory per DOF vs. $\mathcal{O}(p^6)$ for
   assembled high-order CSR), preconditioned by `Hypre 3.1.0` GPU-native `BoomerAMG` configured
   with `HYPRE_MEMORY_DEVICE`, rigid-body near-nullspace vectors (`SetNumFunctions(3)`), and
   `coarse_relax_type = 18` (device-resident coarse triangular solve eliminating PCIe round-trips).

(magnetoelastic-v2-eigen-congruence-contract)=
### Coupled $(k, \omega)$ eigensolvers and congruence scaling

Linearizing Equations {eq}`eq-mel-coupled-pde-system` about an equilibrium $(\mathbf{m}_0, \mathbf{u}_0)$
in the orthonormal local tangent basis $(\hat{\mathbf{e}}_1, \hat{\mathbf{e}}_2) \perp \mathbf{m}_0$
($\delta\mathbf{m} = \xi_1\hat{\mathbf{e}}_1 + \xi_2\hat{\mathbf{e}}_2$) together with elastic
displacement $\delta\mathbf{u}$ and velocity $\delta\mathbf{v} = \delta\dot{\mathbf{u}}$ produces
the first-order coupled generalized eigenvalue pencil:

```{math}
:label: eq-mel-num-coupled-pencil
\begin{pmatrix}
\mathbf{H}_{mm} & \mathbf{K}_{mu} & \mathbf{0} \\
\mathbf{K}_{mu}^\top & \mathbf{K}_{uu} & \mathbf{0} \\
\mathbf{0} & \mathbf{0} & \mathbf{M}
\end{pmatrix}
\begin{pmatrix} \boldsymbol{\xi} \\ \delta\mathbf{u} \\ \delta\mathbf{v} \end{pmatrix}
=
\lambda
\begin{pmatrix}
\mathbf{G}_m & \mathbf{0} & \mathbf{0} \\
\mathbf{0} & -\mathbf{D} & -\mathbf{M} \\
\mathbf{0} & \mathbf{M} & \mathbf{0}
\end{pmatrix}
\begin{pmatrix} \boldsymbol{\xi} \\ \delta\mathbf{u} \\ \delta\mathbf{v} \end{pmatrix},
```

where $\mathbf{G}_m$ encodes the skew-symmetric gyroscopic + Gilbert damping LLG metric and
$\mathbf{K}_{mu}$ is the discrete linearized magnetoelastic + Melcher rotational coupling block.

#### Symmetric congruence scaling $\mathbf{S}$

Because $\lVert\mathbf{K}_{uu}\rVert / \lVert\mathbf{H}_{mm}\rVert \sim 10^5\text{--}10^{11}$ in
SI units, raw Krylov-Schur / shift-and-invert solves lose $5\text{--}8$ digits of accuracy.
FullMag v2 applies a diagonal **congruence transformation**
$\widetilde{\mathbf{A}} = \mathbf{S}\mathbf{A}\mathbf{S}$,
$\widetilde{\mathbf{B}} = \mathbf{S}\mathbf{B}\mathbf{S}$ that preserves all eigenvalues $\lambda$
identically while equilibrating every diagonal block to $\mathcal{O}(1)$:

```{math}
:label: eq-mel-num-congruence-scaling
\mathbf{S} = \operatorname{diag}\!\left(s_m\mathbf{I}_m,\; s_u\mathbf{I}_u,\; s_v\mathbf{I}_v\right),
\qquad
s_m = \frac{1}{\sqrt{\mu_0 M_s^2 V_{\mathrm{ref}}}},
\qquad
s_u = \frac{1}{\sqrt{C_{\mathrm{ref}} L_{\mathrm{ref}}}},
\qquad
s_v = \frac{1}{\omega_{\mathrm{ref}}\sqrt{\rho_{\mathrm{ref}} V_{\mathrm{ref}}}}.
```

#### `SLEPc`, `CudssModalShift`, `MUMPS` inertia, and FDM Floquet–Bloch

- **`SLEPc` Krylov–Schur policy:** defaults to **`EPS_GNHEP`** with shift-and-invert (`STSINVERT`)
  and `EPS_TARGET_MAGNITUDE` around target angular frequency $\sigma = i\omega_0$, and serves as
  automatic fallback if `EPS_GHIEP` detects $B$-inner-product breakdown near hybrid anticrossings.
- **Shift-and-invert linear factorizations:**
  - FEM GPU: **`CudssModalShift`** (`backends/fem/gpu/frequency_domain/modal_cudss_shift.hpp`)
    with device CUDA Graph replay (`prepare_device_replay` / `enqueue_device_replay`) and exact
    negative inertia reporting (see {ref}`numerical-methods-performance-fem-spectral-multiphysics`);
  - FEM CPU shared memory: **`oneMKL PARDISO`**;
  - FEM CPU MPI distributed: **`MUMPS`** with **`ICNTL(13)=1`** (ScaLAPACK root off for exact
    inertia), **`ICNTL(24)=1`** (null-pivot detection), and **`ICNTL(35)=0`** (BLR low-rank
    compression disabled so Sylvester inertia counts remain exact across shifts).
- **FDM 1D-$z$ Floquet–Bloch & 3D Harmonic Balance:** for laterally translation-invariant
  multilayers ($\mathrm{YIG}/\mathrm{GGG}$, $\mathrm{CoFeB}/\mathrm{LiNbO}_3$), a 1D-$z$
  plane-wave Bloch pencil evaluates full magnon–phonon dispersion branches $\omega_n(k_x, k_y)$
  in milliseconds (`FdmEigenPlanIR`); for arbitrary 3D geometries, driven frequency response uses
  `solve_driven_response_gpu_cudss` (FEM GPU) or coupled `FdmFrequencyResponsePlanIR` (supporting
  both magnetic and `acoustic_drives` harmonic excitations).

(magnetoelastic-v2-hpc-stack-contract)=
### HPC optimizations (CUDA, AVX-512, MPI) and external solver library stack

#### Hardware-level execution optimizations

| Architecture | Optimization technique | Quantitative performance impact |
|---|---|---|
| **FDM GPU (CUDA)** | **3.5D ping-pong shared-memory streaming** ($32\times 16$ $(x,y)$ tiles sliding 3 $z$-planes $(k-1,k,k+1)$ in SMEM/registers) + **full-in-GPU zero-transfer residency** | $\sim 3\times$ global-memory bandwidth reduction; approaches HBM roofline ($>70\%$ peak bandwidth); zero per-step PCIe stalls |
| **FDM CPU (x86_64)** | **AVX-512 cache-blocked tiles ($64\times 8\times 8$)**, 64-byte aligned Structure-of-Arrays (SoA), NUMA first-touch OpenMP | Maximizes L1/L2 reuse across 9 stress/velocity arrays; full 8-wide FP64 SIMD utilization |
| **FDM MPI** | **2D lateral pencil/slab decomposition ($P_x \times P_y \times 1$)** with overlapped `MPI_Isend`/`MPI_Irecv` | Keeps entire $z$-columns rank-local so HEVI IMEX-$z$ Thomas solves require **zero vertical MPI communication** |
| **FEM GPU (CUDA)** | Prescribed-strain `ComputeEnergy` reduction gating + fused `H_eff` + 0-ULP FP64 (`master`); **`GpuElasticCudssSolver` Frozen-Factor PCG**, `CudssModalShift` CUDA Graph replay, `libCEED` PA + `Hypre 3.1.0` `coarse_relax_type=18` (v2) | Zero intermediate RK energy reductions on `master`; v2 amortizes Cholesky factorization over $10^2\text{--}10^4$ time steps and eliminates host-device synchronization on AMG coarse grid |
| **FEM MPI** | **3-weight `ParMETIS` partitioning (`ncon = 3`)** balancing elastic, magnetic, and airbox DOFs | Prevents straggler ranks when $\Omega_{\mathrm{mag}} \ll \Omega_{\mathrm{mech}} \ll \Omega_{\mathrm{all}}$ |

For FullMag's measured production optimizations across non-magnetoelastic FDM, FEM, and
multiphysics workloads on RTX 4080 SUPER and Threadripper 3960X, see
{ref}`numerical-methods-performance`.

#### Pinned external numerical library stack & threading contracts

Exact library versions reflect FullMag's production containers (`docker/fem-gpu/Dockerfile` and
`docker/fem-cpu/Dockerfile`) and the solver-branch toolchain upgrades (decoupled `cuDSS`/`SLEPc`,
`oneMKL` GNU-thread CMake target, neutral `/opt/fullmag-metis` prefix, and isolated MPI batch
runner):

| Library | Pinned version (containers / solver branch) | Role in magnetoelasticity | Critical configuration & threading hygiene |
|---|---|---|---|
| **NVIDIA `cuDSS`** | `0.8.0.10` (CUDA `12.4.1`/`12.6.3`) | GPU sparse direct Cholesky/LDL$^T$/LU (`GpuElasticCudssSolver`, `CudssModalShift`, `solve_driven_response_gpu_cudss`) | Decoupled from `SLEPc` builds on solver branch; reuses symbolic analysis + frozen numerical factor across steps; exact inertia queries for modal shift counting |
| **Intel `oneMKL PARDISO`** | `2025.0.1-14` (`intel-oneapi-mkl-devel`, `amd64`; clean no-op on `arm64`, solver branch) | Shared-memory CPU sparse direct solver for FEM/FDM quasistatics, Generalized-$\alpha$, and modal shifts | Strictly link **`mkl_gnu_thread` + `libgomp`** (`Fullmag::MklGnuThread`, never mix `libiomp5` and `libgomp`). `iparm[23]=1, iparm[24]=2` for `mtype=2` SPD In-Core; `iparm[23]=0, iparm[24]=0` for `mtype in {-2, 6, -4}` (with scaling/matching) or OOC (`iparm[59] in {1, 2}`); `iparm[23]=10` with `full_csr_with_diagonal` for `mtype in {11, 13}` In-Core |
| **`MFEM`** | `v4.10` | `SubMesh`/`ParSubMesh` extraction, `H1` finite elements, `IntRules(PRISM, 3)` quadrature, `Hypre`/`PETSc` interfaces | Excludes $\Omega_{\mathrm{air}}$ and `Pyramid5` from mechanical `SubMesh`; deterministic `FaceKey` boundary tagging |
| **`libCEED`** | `v0.12.0` | Matrix-free GPU/CPU Partial Assembly (PA) for large-scale elasticity ($>10^6$ DOFs, `Tet10`/`Hex27`) | Evaluates anisotropic $\mathbf{C}_V^{\mathrm{lab}}$ QFunctions at quadrature points without assembling full CSR |
| **`Hypre`** | `v3.1.0` (GPU) / `v2.32.0` (CPU) | Algebraic multigrid (`BoomerAMG`) preconditioner + MPI `ParCSR` Krylov solvers | GPU mandates `HYPRE_MEMORY_DEVICE`, `SetNumFunctions(3)` + RBM near-nullspace, and **`coarse_relax_type = 18`** |
| **`PETSc` & `SLEPc`** | `v3.24.6` / `v3.24.3` | Distributed matrices/Krylov-Schur eigensolvers (`EPS_GNHEP`, `STSINVERT`, `EPS_TARGET_MAGNITUDE`) | Thread-safe process lifecycle guarded by `petsc_slepc_process_mutex`; congruence scaling $\mathbf{S}$ applied prior to `EPSSolve` |
| **`MUMPS`** | PETSc-bundled MPI MUMPS | Distributed MPI sparse direct solver & modal shift-and-invert | Exact Sylvester inertia requires **`ICNTL(13)=1`, `ICNTL(24)=1`, `ICNTL(35)=0`** (BLR disabled) |
| **`METIS 5` / `ParMETIS`** | `METIS v5.1.0-p12` / `ParMETIS v4.0.3-p9` in neutral CUDA-free `/opt/fullmag-metis` (solver branch) | Serial & distributed mesh partitioning shared ABI-cleanly by MFEM and PETSc | Hardened `ldd` ABI gate prevents dual-METIS linkage; multi-constraint `ncon = 3` (elastic + magnetic + airbox DOF weights) |
| **`OpenMPI`** | CUDA-aware OpenMPI (`scripts/docker_dev_mpi.py` isolated batch runner on solver branch) | Multi-GPU & multi-node halo exchange and collective reductions | FDM $P_x \times P_y \times 1$ pencil decomposition; FEM `ParSubMesh` + `ParCSR` communication with isolated per-run scratch |
| **`FFTW3` / `cuFFT`** | System / CUDA Toolkit | Demagnetization FFT convolution + FDM `SpectralZThomasPCG` 2D lateral FFT | Single-rank local $z$-columns preserve zero-MPI vertical Thomas solves |

(magnetoelastic-num-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\Delta t_{\mathrm{CFL}}, \Delta t_{\mathrm{visc}}$ | explicit acoustic CFL and Kelvin–Voigt viscous time-step limits | $\mathrm{s}$ |
| $S_{\mathrm{CFL}}$ | dimensionless explicit CFL safety factor | $1$ |
| $N_{\mathrm{sub}}$ | mechanical sub-steps per magnetic LLG macro-step | $1$ |
| $\alpha_{\mathrm{KV},z,c}$ | adaptive HEVI IMEX-$z$ vertical Kelvin–Voigt stabilization factor | $1$ |
| $\mathbf{M}, \mathbf{D}, \mathbf{K}$ | FEM mass, mechanical damping, and elastic stiffness matrices | $\mathrm{kg}, \mathrm{N\,s\,m^{-1}}, \mathrm{N\,m^{-1}}$ |
| $\mathbf{K}_{\mathrm{eff}}$ | Generalized-$\alpha$ effective dynamic stiffness matrix | $\mathrm{N\,m^{-1}}$ |
| $\rho_\infty$ | Chung–Hulbert Generalized-$\alpha$ high-frequency spectral radius | $1$ |
| $\alpha_m, \alpha_f, \gamma, \beta$ | Chung–Hulbert Generalized-$\alpha$ integration parameters | $1$ |
| $\mathbf{f}_{\mathrm{mel}}$ | discrete nodal magnetostrictive force vector | $\mathrm{N}$ |
| $\mathbf{r}_k$ | unpreconditioned Euclidean PCG residual vector | $\mathrm{N}$ |
| $\epsilon_{\mathrm{rel}}$ | relative Euclidean residual convergence tolerance | $1$ |
| $\mathbf{S}$ | diagonal congruence scaling matrix for coupled $(k,\omega)$ pencil | $\text{mixed}$ |
| $\lambda$ | complex eigenfrequency eigenvalue ($i\omega - \Gamma$) | $\mathrm{rad\,s^{-1}}$ |
| $\Delta f_{\mathrm{1D}}, \Delta f_{\mathrm{3D}}$ | single-TA vs. full-3D doublet magnon–polaron anticrossing gap | $\mathrm{Hz}$ |

(magnetoelastic-num-assumptions-and-validity)=
## Assumptions and validity

1. **Precision policy:** all sparse direct factorizations (`cuDSS`, `oneMKL PARDISO`, `MUMPS`),
   Generalized-$\alpha$ updates, congruence-scaled eigensolves, and `G1`–`G8` energy-balance
   diagnostics run in **FP64 (`double`)**. Single-precision (`float`) is restricted to optional
   explicit FDM acoustic streaming only when explicitly requested and validated against FP64.
2. **Thread-runtime isolation:** linking `oneMKL PARDISO` on Linux requires `mkl_gnu_thread`
   matched to GCC's `libgomp` (`Fullmag::MklGnuThread`); mixing `libiomp5` and `libgomp` produces
   oversubscription or ABI corruption and is rejected by build verification.
3. **Direct vs. iterative crossover:** `GpuElasticCudssSolver` is optimal up to
   $\sim 1\text{--}2\times 10^6$ DOFs on an $80\,\mathrm{GB}$ GPU (depending on 3D fill-in);
   larger meshes automatically route to `libCEED` PA + `Hypre 3.1.0` GPU `BoomerAMG`.
4. **Inertia safety in `MUMPS`:** BLR low-rank compression (`ICNTL(35) > 0`) may perturb
   near-zero pivots and is strictly disabled (`ICNTL(35)=0`) during Sylvester inertia counting.

(magnetoelastic-num-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR (`master`) | Executable realization (`master`) | Scientific qualification | Exact capability boundary and v2 roadmap |
|---|---|---|---|---|---|
| FDM | CPU | `MechanicsIR` + local `h_mel_single_with_ms` / `e_mel_density_single` | partial; public FDM mechanics planner fails closed | local cubic formula unit tests only | solver branch lowers `FdmElastodynamicsPlanIR` (viscous CFL, `v_imex`, coupled FR); v2 runtime adds Virieux/Lebedev, Velocity-Verlet + Hermite multirate, HEVI IMEX-$z$ `PC2`, AVX-512 `64x8x8`, `SpectralZThomasPCG`, `oneMKL PARDISO`, OpenMPI $P_x\times P_y\times 1$ |
| FDM | GPU | `MechanicsIR` + `reduce_magnetoelastic_energy_fp64` | partial; energy reduction kernel below planner | no end-to-end GPU qualification yet | v2 target: 3.5D ping-pong SMEM CUDA kernels, full-in-GPU zero-transfer residency, `cuDSS`, `GMG`, 1D-$z$ Floquet–Bloch |
| FEM | CPU | `MechanicsIR` + `resolve_fem_magnetoelastic_plan` | implemented prescribed-strain field/energy (`compute_magnetoelastic_field`) + `PETSc`/`SLEPc` modal infrastructure | prescribed-strain field/energy tests; magnetic modal SLEPc tests | solver branch lowers FM+NM `FemMechanicalPlanIR` + Fredholm checks; v2 runtime adds Generalized-$\alpha$, Central Difference, `PGBB`/`NCG` primal-dual, `oneMKL PARDISO` (`iparm[23]` per `mtype`), `MUMPS` exact inertia, `SLEPc` `EPS_GNHEP` coupled pencil |
| FEM | GPU | same `MechanicsIR` + `CudssModalShift` / `solve_driven_response_gpu_cudss` | implemented prescribed-strain CUDA kernels (`fullmag_cuda_magnetoelastic_field_energy_blocks`, `fullmag_cuda_accumulate_heff_fused_xyz`) + magnetic GPU cuDSS modal/driven solvers | 0-ULP FP64 prescribed-strain parity gate (`ComputeEnergy` gating, fused `H_eff`) + magnetic cuDSS modal/driven contracts | v2 target: `GpuElasticCudssSolver` Frozen-Factor PCG, `libCEED` PA + `Hypre 3.1.0` GPU `BoomerAMG` `coarse_relax_type=18`, coupled GPU `CudssModalShift` |

(magnetoelastic-num-python-api)=
## Python API and stage-first example

The executable stage-first example below configures strict FP64 FEM execution with canonical
`MechanicsIR` authoring on `master` (demonstrating precision and lane selection alongside the
magnetoelastic object graph):

```python
# %% Strict FP64 study configuration for numerical reproducibility
import fullmag as fm

nm = 1.0e-9
study = fm.study("magnetoelastic_fp64_numerical_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

film = study.geometry(fm.Box(64 * nm, 32 * nm, 8 * nm), name="yig_layer")
film.mesh(maximum_element_size=4 * nm, order=1)
film.Ms = 1.40e5
film.Aex = 3.7e-12
film.alpha = 0.001
film.m = fm.texture.uniform(0.0, 0.0, 1.0)

# %% Define cubic YIG elastic properties and prescribed shear test load
yig_elastic = fm.ElasticMaterial(
    name="yig_elastic",
    C11=2.69e11,
    C12=1.077e11,
    C44=7.64e10,
    rho=5170.0,
)
yig_body = fm.ElasticBody(
    name="yig_body",
    geometry=fm.Box(64 * nm, 32 * nm, 8 * nm, name="yig_elastic_box"),
    elastic_material=yig_elastic,
)
yig_law = fm.MagnetostrictionLaw(
    name="yig_mel",
    kind="cubic",
    B1=3.48e5,
    B2=6.96e5,
)
shear_load = fm.MechanicalLoad(
    kind="prescribed_strain",
    strain=(0.0, 0.0, 0.0, 2.0e-5, 0.0, 0.0),
)
coupling = fm.Magnetoelastic(magnet="yig_layer", body=yig_body.name, law=yig_law.name)

# %% Verify IR contract and register time-evolution stage
assert coupling.to_ir()["law"] == "yig_mel"
assert shear_load.to_ir()["strain"][3] == 2.0e-5
study.stages.add_run(stage_id="fp64_prescribed_strain_check", until=1.0e-12)
```

### Exhaustive numerical-control parameter contract (`master` & v2 mapping)

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR mapping |
|---|---|---|---|---|---|---|---|
| `study.engine(name)` | `str` | `"fdm"` | `1` | `"fdm"` or `"fem"` | selects FDM supergrid or FEM `SubMesh` numerical lane | `"fem"` prescribed-strain on `master`; both lanes in v2 | `runtime.engine` |
| `study.device(kind, precision)` | `str, str` | `"cpu", "double"` | `1` | `"cpu"`/`"gpu"` and `"double"`/`"float"` | selects execution device and FP64/FP32 arithmetic contract | FEM CPU/GPU FP64 on `master`; all 4 lanes in v2 | `runtime.device` |
| `study.mode(policy)` | `str` | `"strict"` | `1` | `"strict"` or `"permissive"` | enforces fail-closed capability and stability validation | all lanes | `runtime.mode` |
| `ElasticMaterial.rho` | `float` | required | `kg/m^3` | strictly positive (`> 0`) | mass density entering $\mathbf{M}$, $c_{\max}$, and $\Delta t_{\mathrm{CFL}}$ | IR on `master`; active in v2 elastodynamics | `mechanics.materials[].density` |
| `MechanicalLoad.kind` | `str` | required | `1` | `"prescribed_strain"`, `"prescribed_stress"`, or `"body_force"` | selects static/dynamic mechanical loading operator | `"prescribed_strain"` on FEM `master`; all in v2 | `mechanics.loads[].kind` |

(magnetoelastic-num-problem-ir)=
## ProblemIR semantics

On the dedicated solver branch (FullMag v2), the planner lowers `ProblemIR` mechanics intent into
typed per-lane execution plans (`FdmElastodynamicsPlanIR`, `FemMechanicalPlanIR`, `FdmEigenPlanIR`,
and `FdmFrequencyResponsePlanIR`) recording mode, staggered layout, CFL/viscous bounds, linear
solver policy, and Fredholm RBM diagnostics:

```json
{
  "fdm_elastodynamics_plan": {
    "mode": "imex_z_hevi",
    "layout": "virieux_split_anis",
    "requested_linear_solver": "auto",
    "resolved_linear_solver": "spectral_z_thomas_pcg",
    "include_lattice_rotation": true,
    "cfl_safety": 0.85,
    "dt_explicit_cfl_s": 1.2e-14,
    "dt_imex_z_cfl_s": 4.8e-13,
    "v_imex_m_s": 6980.0,
    "subcycle_ratio_k": 1,
    "free_component_count": 1,
    "expected_rbm_nullspace_dim": 4
  },
  "fem_solver_policy_v2": {
    "fem_integrator": "generalized_alpha",
    "generalized_alpha_rho_inf": 0.9,
    "linear_solver": "cudss_frozen_factor_pcg",
    "pcg_euclidean_rtol": 1.0e-10,
    "cudss_refactor_iter_threshold": 8,
    "eigen_solver": "slepc_gnhep_stsinvert",
    "congruence_scaling": true,
    "mumps_inertia_exact": { "icntl13": 1, "icntl24": 1, "icntl35": 0 },
    "hypre_gpu_coarse_relax_type": 18,
    "parmetis_ncon": 3
  }
}
```

(magnetoelastic-num-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent** preserves the authored engine (`fdm`/`fem`), device (`cpu`/`gpu`),
  precision (`double`/`float`), integrator family, spectral radius $\rho_\infty$, linear/eigen
  solver preferences, and convergence tolerances verbatim in `ProblemIR`.
- **Resolved execution** records the materialized C ABI v1 capability bitmask, chosen solver
  backend (`GpuElasticCudssSolver`, `libCEED`+`Hypre`, `oneMKL PARDISO`, `MUMPS`, `SpectralZThomasPCG`),
  `iparm` / `ICNTL` configuration, computed Kelvin–Mandel $\Delta t_{\mathrm{CFL}}$,
  $\Delta t_{\mathrm{visc}}$, lateral $v_{\mathrm{imex}}$, $\alpha_{\mathrm{KV},z,c}$,
  factorization counts, and congruence scaling factors $\mathbf{S}$.
- **Validation errors** reject non-positive tolerances, out-of-range $\rho_\infty \notin [0, 1]$,
  invalid `iparm`/`mtype` pairings, or FP32 requests on sparse direct / eigensolver stages.
- **Unsupported combinations** fail closed before solver launch:
  - missing C ABI v1 capability bit on the requested lane;
  - `master` invocation of bidirectional elastodynamics, quasistatic solves, or FDM mechanics
    plans fails closed at `resolve_fem_magnetoelastic_plan`;
  - requesting `MUMPS` inertia counting with BLR compression enabled (`ICNTL(35) > 0`) fails
    closed to protect Sylvester inertia exactness.

(magnetoelastic-num-implementation-mapping)=
## Implementation mapping

- **Planner & capability gate (`master`):** `crates/fullmag-plan/src/fem.rs`
  (`resolve_fem_magnetoelastic_plan`).
- **FEM CPU/GPU prescribed-strain kernels (`master`):**
  - `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp` (`compute_magnetoelastic_field`);
  - `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu` (`fullmag_cuda_magnetoelastic_field_energy_blocks` with `ComputeEnergy` gating and non-contracted FP64 parity);
  - `backends/fem/gpu/cuda/fields/vector_field_kernels.cu` (`fullmag_cuda_accumulate_heff_fused_xyz`).
- **FDM GPU reduction (`master`):**
  - `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` (`reduce_magnetoelastic_energy_fp64`).
- **Existing GPU `cuDSS` & `PETSc`/`SLEPc` solver infrastructure reused by v2 mechanics:**
  - `backends/fem/gpu/frequency_domain/modal_cudss_shift.hpp` (`CudssModalShift` with CUDA Graph replay and exact inertia);
  - `backends/fem/gpu/frequency_domain/driven_response_cudss.hpp` (`solve_driven_response_gpu_cudss`);
  - `backends/fem/core/petsc_slepc_runtime.hpp` (`petsc_slepc_process_mutex` lifecycle safety).
- **Containerized library builds:** `docker/fem-gpu/Dockerfile` (`MFEM v4.10`, `libCEED v0.12.0`,
  `Hypre v3.1.0`, `PETSc v3.24.6`, `SLEPc v3.24.3`, `cuDSS 0.8.0.10`) and
  `docker/fem-cpu/Dockerfile` (`MFEM v4.10`, `Hypre v2.32.0`, `PETSc v3.24.6`, `SLEPc v3.24.3`),
  extended on the solver branch with `Intel oneMKL 2025.0.1-14` (`Fullmag::MklGnuThread`),
  neutral `/opt/fullmag-metis` (`METIS v5.1.0-p12` + `ParMETIS v4.0.3-p9`), and
  `scripts/docker_dev_mpi.py`.

(magnetoelastic-num-validation)=
## Validation: canonical `G1`–`G8` golden verification benchmarks

Every bidirectional magnetoelastic solver lane (FDM CPU, FDM GPU, FEM CPU, FEM GPU) must satisfy
all eight quantitative golden verification gates before promotion from `partial` to `implemented`:

| Gate | Physical system & test | Exact analytical / reference oracle | Required tolerance & acceptance criterion |
|---|---|---|---|
| **G1** | Free cubic crystal magnetostrictive equilibrium (`"traction_free"` + RBM projection) | $\varepsilon_{ii}^{\mathrm{eq}} = -\frac{B_1}{C_{11}-C_{12}}(m_i^2 - \frac{1}{3})$, $\gamma_{ij}^{\mathrm{eq}} = -\frac{B_2}{C_{44}}m_i m_j$ | Relative $L_2$ strain error $< 10^{-10}$ (quasistatic) and $< 10^{-4}$ (damped dynamic relaxation) |
| **G2** | $\mathrm{Ni}/\mathrm{Al}$ bilayer interface traction continuity | $\partial_x u_x = -4.48228\times 10^{-6}$; Ni total stress $(\sigma_{xx}^{\mathrm{tot}}, \sigma_{yy}^{\mathrm{tot}}, \sigma_{zz}^{\mathrm{tot}}) = (0, +0.443746, -2.971754)\,\mathrm{MPa}$ | Interface traction jump $\lvert\llbracket\sigma_{xx}^{\mathrm{tot}}\rrbracket\rvert < 10^{-8}\,\mathrm{MPa}$; in-plane total stress within $10^{-4}$ |
| **G3** | Undamped conservative magnon–phonon energy exchange ($\alpha=0$, `NoMechanicalDamping`) | $\frac{d}{dt}(E_{\mathrm{mag}}+E_{\mathrm{el}}+E_{\mathrm{mel}}+E_{\mathrm{kin,el}}) = 0$ (Generalized-$\alpha$ $\rho_\infty = 1$, Velocity-Verlet) | Relative energy drift $\lvert\Delta E_{\mathrm{tot}}\rvert / E_{\mathrm{exch}} < 10^{-6}$ over $\ge 10$ oscillation periods |
| **G4** | YIG Turov–Shavrov gap & `stress_free` vs. `clamped` anisotropy renormalization | `stress_free`: $36.040\,\mathrm{A\,m^{-1}}$ ($[001]$), $17.704\,\mathrm{A\,m^{-1}}$ ($[111]$); `clamped`: $8.535\,\mathrm{A\,m^{-1}}$ ($[001]$), $36.040\,\mathrm{A\,m^{-1}}$ ($[111]$) | Gap frequency & effective field match analytic oracle within $0.1\%$ |
| **G5** | YIG magnon–polaron anticrossing at $f_\times = 5.000\,\mathrm{GHz}$ ($\mathbf{k}\parallel\mathbf{m}_0$) | $\Delta f_{\mathrm{1D}} = 79.6312\,\mathrm{MHz}$ (single TA); $\Delta f_{\mathrm{3D}} = 112.6155\,\mathrm{MHz}$ (full 3D TA doublet + dark $\mathrm{TA}_-$ at $5.000\,\mathrm{GHz}$) | Dispersion eigenvalues & time-domain FFT peak splitting match within $0.5\%$ |
| **G6** | Passive acoustic impedance transmission across $\mathrm{YIG}/\mathrm{GGG}$ | $T_{u,v} = 0.8805$, $T_\sigma = 1.1195$, $T_P = 0.9857$, $R_P = 0.0143$ ($R_P + T_P = 1$) | Amplitude & power transmission ratios match within $0.5\%$ across FDM and FEM |
| **G7** | Melcher $\mathcal{O}(\omega^2)$ rotational coupling & Rayleigh SAW nonreciprocity | $\boldsymbol{\tau}_{\mathrm{mag}} + \boldsymbol{\tau}_{\mathrm{mech}} = \mathbf{0}$; Goldstone zero mode to $\mathcal{O}(\omega^2)$; $\pm k$ attenuation asymmetry | Torque balance to $10^{-12}$; Goldstone eigenvalue $< 10^{-10}$; nonreciprocity ratio matches analytic linearized theory |
| **G8** | Thermal acoustic Langevin FDT equipartition ($T > 0$, Kelvin–Voigt / mass damping) | $\langle E_{\mathrm{kin},n}\rangle = \langle E_{\mathrm{pot},n}\rangle = \frac{1}{2}k_B T$, $\langle E_{\mathrm{tot},n}\rangle = k_B T$ per harmonic mode (excluding $6 N_{\mathrm{free\_comp}}$ RBM zero modes) | Ensemble-averaged modal energies within $3\%$ of $k_B T$ across acoustic spectrum |

(magnetoelastic-num-limitations)=
## Limitations

- On `master`, bidirectional elastodynamics time integrators, `GpuElasticCudssSolver`
  Frozen-Factor PCG, `HEVI IMEX-z PC2`, `SpectralZThomasPCG`, and coupled $(k,\omega)$
  magnetoelastic eigenpencils are not yet executed in CI (planner lowering and toolchain upgrades
  live on the dedicated solver branch pending native runtime kernel qualification).
- Multi-GPU distributed direct sparse factorization (`cuDSS` multi-GPU / `MUMPS` GPU offload)
  is deferred beyond single-GPU `cuDSS` + multi-GPU `libCEED`/`Hypre 3.1.0` `BoomerAMG`.
- Automated runtime auto-tuning between `GpuElasticCudssSolver` and `libCEED`+`Hypre` uses
  conservative DOF/VRAM heuristics rather than live micro-benchmarking.

(magnetoelastic-num-scientific-bibliography)=
## Scientific bibliography

1. J. Chung and G. M. Hulbert, "A Time Integration Algorithm for Structural Dynamics With Improved
   Numerical Dissipation: The Generalized-$\alpha$ Method," *Journal of Applied Mechanics*
   **60**(2), 371–375 (1993), [doi:10.1115/1.2900803](https://doi.org/10.1115/1.2900803).
2. N. M. Newmark, "A Method of Computation for Structural Dynamics," *Journal of the Engineering
   Mechanics Division* **85**(3), 67–94 (1959),
   [doi:10.1061/JMCEA3.0000098](https://doi.org/10.1061/JMCEA3.0000098).
3. H. M. Hilber, T. J. R. Hughes, and R. L. Taylor, "Improved numerical dissipation for time
   integration algorithms in structural dynamics," *Earthquake Engineering & Structural Dynamics*
   **5**(3), 283–292 (1977), [doi:10.1002/eqe.4290050306](https://doi.org/10.1002/eqe.4290050306).
4. J. R. Dormand and P. J. Prince, "A family of embedded Runge–Kutta formulae," *Journal of
   Computational and Applied Mathematics* **6**(1), 19–26 (1980),
   [doi:10.1016/0771-50X(80)90013-3](https://doi.org/10.1016/0771-50X(80)90013-3).
5. J. Normington and M. Ruggeri, "A finite element method for magnetoelasticity in
   ferromagnetism," *arXiv preprint* (2025), [arXiv:2309.00605](https://arxiv.org/abs/2309.00605).
6. F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos,
   F. Ciubotaru, and C. Adelmann, "Finite difference magnetoelastic simulator," *Open Research
   Europe* **1**, 35 (2021),
   [doi:10.12688/openreseurope.13302.1](https://doi.org/10.12688/openreseurope.13302.1)
   (Gold OA CC-BY; [EuropePMC PMC10445870](https://europepmc.org/articles/PMC10445870)).
7. P. Flauger, M. Küß, M. K. Steinbauer, F. Bruckner, B. Emhofer, E. Nysten, M. Weiß,
   D. Suess, H. J. Krenner, M. Albrecht, and C. Abert, "Modeling magnetoelastic wave interactions
   in magnetic films and heterostructures: A finite-difference approach," *Physical Review
   Applied* **25**(3) (2026), [doi:10.1103/9txq-sc8f](https://doi.org/10.1103/9txq-sc8f)
   (Hybrid OA CC-BY; [arXiv:2509.06007](https://arxiv.org/abs/2509.06007)).
8. U. M. Ascher, S. J. Ruuth, and R. J. Spiteri, "Implicit-explicit Runge–Kutta methods for
   time-dependent partial differential equations," *Applied Numerical Mathematics* **25**(2–3),
   151–167 (1997), [doi:10.1016/S0168-9274(97)00056-1](https://doi.org/10.1016/S0168-9274(97)00056-1).
9. R. Anderson *et al.*, "MFEM: A modular finite element methods library," *Computers &
   Mathematics with Applications* **81**, 42–74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).
10. J. Brown *et al.*, "libCEED: Fast algebra for high-order element-based discretizations,"
    *Journal of Open Source Software* **6**(63), 2945 (2021),
    [doi:10.21105/joss.02945](https://doi.org/10.21105/joss.02945).
11. R. D. Falgout and U. M. Yang, "hypre: A Library of High Performance Preconditioners," in
    *Computational Science — ICCS 2002*, LNCS **2331**, 632–641 (2002),
    [doi:10.1007/3-540-47789-6_66](https://doi.org/10.1007/3-540-47789-6_66).
12. S. Balay *et al.*, "PETSc/TAO Users Manual," Argonne National Laboratory Technical Report
    ANL-21/39 (2025), [doi:10.2172/2205494](https://doi.org/10.2172/2205494).
13. V. Hernandez, J. E. Roman, and V. Vidal, "SLEPc: A scalable and flexible toolkit for the
    solution of eigenvalue problems," *ACM Transactions on Mathematical Software* **31**(3),
    351–362 (2005), [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
14. P. R. Amestoy, I. S. Duff, J.-Y. L'Excellent, and J. Koster, "A Fully Asynchronous Multifrontal
    Solver Using Distributed Dynamic Scheduling," *SIAM Journal on Matrix Analysis and Applications*
    **23**(1), 15–41 (2001), [doi:10.1137/S0895479899358194](https://doi.org/10.1137/S0895479899358194).
15. O. Schenk and K. Gärtner, "Solving unsymmetric sparse systems of linear equations with
    PARDISO," *Future Generation Computer Systems* **20**(3), 475–487 (2004),
    [doi:10.1016/j.future.2003.07.011](https://doi.org/10.1016/j.future.2003.07.011).
16. G. Karypis and V. Kumar, "A Fast and High Quality Multilevel Scheme for Partitioning Irregular
    Graphs," *SIAM Journal on Scientific Computing* **20**(1), 359–392 (1998),
    [doi:10.1137/S1064827595287997](https://doi.org/10.1137/S1064827595287997).
17. M. Frigo and S. G. Johnson, "The Design and Implementation of FFTW3," *Proceedings of the IEEE*
    **93**(2), 216–231 (2005), [doi:10.1109/JPROC.2004.840301](https://doi.org/10.1109/JPROC.2004.840301).
18. NVIDIA Corporation, *cuDSS: NVIDIA CUDA Direct Sparse Solver Documentation* (v0.8, 2025),
    [https://docs.nvidia.com/cuda/cudss/](https://docs.nvidia.com/cuda/cudss/).

(magnetoelastic-num-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/crates/fullmag-plan/src/fem.rs#L2900) | `resolve_fem_magnetoelastic_plan` | FEM magnetoelastic capability gating and planner boundary |
| [`backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp#L15) | `compute_magnetoelastic_field` | FEM CPU prescribed-strain field and lumped-mass energy evaluation |
| [`backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu#L105) | `fullmag_cuda_magnetoelastic_field_energy_blocks` | FEM GPU CUDA prescribed-strain kernel with `ComputeEnergy` gating and non-contracted FP64 parity |
| [`backends/fem/gpu/cuda/fields/vector_field_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/backends/fem/gpu/cuda/fields/vector_field_kernels.cu#L248) | `fullmag_cuda_accumulate_heff_fused_xyz` | FEM GPU single-launch fused `H_eff` combiner including `H_mel` |
| [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L1602) | `reduce_magnetoelastic_energy_fp64` | FDM GPU FP64 magnetoelastic energy reduction kernel |
| [`backends/fem/gpu/frequency_domain/modal_cudss_shift.hpp`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/backends/fem/gpu/frequency_domain/modal_cudss_shift.hpp#L15) | `class CudssModalShift` | GPU `cuDSS` shift-and-invert factorization with CUDA Graph replay and exact inertia |
| [`backends/fem/gpu/frequency_domain/driven_response_cudss.hpp`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/backends/fem/gpu/frequency_domain/driven_response_cudss.hpp#L39) | `solve_driven_response_gpu_cudss` | GPU `cuDSS` driven frequency-domain response solver |
| [`backends/fem/core/petsc_slepc_runtime.hpp`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/backends/fem/core/petsc_slepc_runtime.hpp#L10) | `petsc_slepc_process_mutex` | Thread-safe PETSc/SLEPc process lifecycle synchronization |
| Specification contract (v2) | {ref}`C ABI v1 and bitmasks <magnetoelastic-v2-cabi-contract>` | Planned v2 contract for C ABI v1 and 23 FDM / 17 FEM capability bitmasks |
| Specification contract (v2) | {ref}`FDM time integrators and quasistatics <magnetoelastic-v2-fdm-integrators-contract>` | Planned v2 contract for Kelvin–Mandel CFL, Hermite multirate, HEVI IMEX-$z$ `PC2`, and FDM quasistatics |
| Specification contract (v2) | {ref}`FEM variational adjoint and Generalized-alpha <magnetoelastic-v2-fem-integrators-contract>` | Planned v2 contract for FEM variational adjoint, Generalized-$\alpha$, and Frozen-Factor PCG |
| Specification contract (v2) | {ref}`Coupled eigensolvers and congruence scaling <magnetoelastic-v2-eigen-congruence-contract>` | Planned v2 contract for coupled $(k,\omega)$ pencil, congruence scaling, `SLEPc`/`MUMPS`, and Floquet–Bloch |
| Specification contract (v2) | {ref}`HPC optimizations and pinned library stack <magnetoelastic-v2-hpc-stack-contract>` | Planned v2 contract for CUDA 3.5D ping-pong, AVX-512, MPI, and pinned library stack hygiene |
