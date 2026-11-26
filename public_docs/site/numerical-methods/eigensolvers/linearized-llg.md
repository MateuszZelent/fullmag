---
title: Linearized LLG
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: /physics/foundations/llg-equation, /physics/interactions/demagnetization/fem-poisson-airbox
---

(public-docs-numerical-methods-eigensolvers-linearized-llg)=
(numerical-methods-eigensolvers-linearized-llg)=
# Linearized LLG eigenvalue problem

This chapter specifies the mathematical formulation, tangent-plane discretization, magnetostatic
Schur-complement reduction, CPU Krylov-Schur and GPU Hermitian augmented `cuDSS` eigensolver
pipelines, and branch-tracking algebra used by FullMag to compute small-amplitude spin-wave
eigenmodes around a static micromagnetic equilibrium.

A modal calculation is not an isolated algebraic formula evaluated on an arbitrary magnetization
snapshot. The computed spectrum and spatial mode profiles depend on five coupled numerical elements:

1. a verified static micromagnetic equilibrium $\mathbf m_0(\mathbf x)$ satisfying the torque gate
   $\lVert\mathbf m_0\times\mathbf H_{\mathrm{eff}}[\mathbf m_0]\rVert_\infty \le \varepsilon_{\mathrm{eq}}$
   (or an explicitly marked diagnostic handoff via `equilibrium_acceptance="force"`);
2. a nodal orthonormal tangent-plane basis $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$ eliminating the
   longitudinal norm constraint $\mathbf m_0\cdot\delta\mathbf m = 0$;
3. the selected tangent dynamic operator family (`linearized_llg` scalar projection vs `full_2x2`
   Herring–Kittel coupled tangent block operator);
4. the treatment of dynamic magnetostatics on the shared magnetic-plus-airbox mesh
   ($\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$) via the coupled $(q,\phi)$ descriptor pencil
   (`open_airbox_k0`, `periodic_airbox_k0`, or `floquet_airbox`) and its matrix-free Schur
   complement or Hermitian augmented `cuDSS` shift operator;
5. the spectral transformation, inner linear-solver residual gate or `cuDSS` VRAM admission, and
   post-solve unreduced coupled residual certification.

(linearized-llg-problem-statement)=
## 1. Physical problem and modal operator families

Let $\Omega_m \subset \mathbb R^3$ denote the ferromagnetic body and $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$
the conforming finite-element domain including the surrounding magnetostatic airbox. Around a static
equilibrium configuration $\mathbf m_0 : \Omega_m \to S^2$, small-amplitude magnetization
oscillations are expanded to first order in the local tangent plane $T_{\mathbf m_0(\mathbf x)}S^2$
as harmonic modes $\delta\mathbf m(\mathbf x, t) = \operatorname{Re}\{\delta\widehat{\mathbf m}_n(\mathbf x)\mathrm e^{\lambda_n t}\}$
with complex eigenvalue $\lambda_n = \sigma_n + \mathrm i\omega_n$ and cyclic eigenfrequency
$f_n = \omega_n / (2\pi)$.

FullMag exposes two distinct tangent operator families (`Eigenmodes.operator`), two spatial
geometry representations (`SpatialRepresentationIR`), and four magnetostatic boundary closures
(`magnetostatic_bc`):

| Selector | Value | Discrete structure | Intended physical regime |
|---|---|---|---|
| `operator` | `"linearized_llg"` | $N_m \times N_m$ scalar projected stiffness-mass pencil along $\mathbf e_1$ | Approximately uniform equilibrium and collinear internal field |
| `operator` | `"full_2x2"` | $2N_m \times 2N_m$ coupled Herring–Kittel tangent-plane block pencil in $(\mathbf e_1, \mathbf e_2)$ with gyrotropic $J$ | Non-collinear textures, elliptical precession, coupled Poisson-airbox demagnetization, and Floquet $\mathbf k \neq \mathbf 0$ |
| `magnetostatic_bc` | `"open_airbox_k0"` | Identity equivalence classes ($\kappa_\phi(i)=i$, $\kappa_m(i)=i$), Robin closure on $\partial\Omega$, zero periodic pairs | Isolated 3D bodies (spheres, patterned elements, STL shells) with $\mathbf k = \mathbf 0$ dynamic demag |
| `magnetostatic_bc` | `"periodic_airbox_k0"` | Periodic equivalence classes at $\mathbf k = \mathbf 0$ (2D films resolve to pure Neumann $\beta = 0$ + `mean_zero_augmented`) | Infinite periodic thin films and periodic arrays at $\Gamma$ |
| `magnetostatic_bc` | `"floquet_airbox"` | Complex Bloch prolongation $C(\mathbf k)$ across periodic seams with open-face Robin/Dirichlet closure | Nonzero-$\mathbf k$ magnonic dispersion in 3D periodic cells |
| `spatial_representation` | `"full_3d"` / `"waveguide_2p5d"` | 3D volume mesh vs 2D cross-section with shifted gradient $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf z}$ | 3D nanostructures/Bloch crystals vs translationally invariant waveguides |

(linearized-llg-governing-equations)=
## 2. Governing equations and operator derivations

### 2.1 Static equilibrium prerequisite, R4 handoff gate, and diagnostic forced acceptance

Linearization is mathematically well-posed only at a stationary point of the micromagnetic free
energy $E[\mathbf m]$. The baseline state $\mathbf m_0(\mathbf x)$ must satisfy the pointwise unit-length
constraint and vanishing equilibrium torque:

```{math}
:label: eq-numerical-linearized-llg-equilibrium
\lvert\mathbf m_0(\mathbf x)\rvert = 1,
\qquad
\mathbf m_0(\mathbf x)\times\mathbf H_{\mathrm{eff}}[\mathbf m_0](\mathbf x) = \mathbf 0,
\qquad
H_0(\mathbf x) = \mathbf m_0(\mathbf x)\cdot\mathbf H_{\mathrm{eff}}[\mathbf m_0](\mathbf x).
```

Here $H_0(\mathbf x)$ (in $\mathrm{A\,m^{-1}}$) is the collinear equilibrium projection of the
effective field onto $\mathbf m_0(\mathbf x)$. Before assembling the modal operator, the CLI and
runner enforce the R4 handoff gate (`accepted_relax_handoff_for_eigen_stage` and
`build_owned_modal_certificate_v6_binding`). For diagnostic workflows where a preceding relaxation
stopped at its step ceiling, `add_eigenmodes(..., equilibrium_source="relax", equilibrium_acceptance="force")`
permits `forced_relax_acceptance_requests` and `forced_equilibrium_criterion` to build an explicit
residual-torque certificate carrying $\tau_{\max} = \max_i \lvert\mathbf m_{0,i}\times\mathbf H_{\mathrm{eff},0,i}\rvert$,
the true `converged = false` and `stop_reason`, and `forced = true`. This option is diagnostic only
(never default), omits `forced` on converged runs so certified digests remain byte-identical, never
publishes an accepted equilibrium for antennas, and is disallowed for `equilibrium_source="artifact"`.

### 2.2 Local tangent-plane frame and symplectic kinematics

To preserve $\lvert\mathbf m(\mathbf x, t)\rvert = 1 + \mathcal O(\lvert\delta\mathbf m\rvert^2)$
identically without Lagrange multipliers, `build_tangent_frame` constructs a right-handed
orthonormal triad $(\mathbf e_1(\mathbf x_i), \mathbf e_2(\mathbf x_i), \mathbf m_0(\mathbf x_i))$ at
every magnetic mesh node $i \in \{1,\dots,N_m\}$:

```{math}
:label: eq-numerical-linearized-llg-tangent
\mathbf m(\mathbf x, t) = \mathbf m_0(\mathbf x) + \delta\mathbf m(\mathbf x, t),
\qquad
\mathbf m_0(\mathbf x)\cdot\delta\mathbf m(\mathbf x, t) = 0,
\qquad
\delta\mathbf m(\mathbf x, t) = q_1(\mathbf x, t)\mathbf e_1(\mathbf x) + q_2(\mathbf x, t)\mathbf e_2(\mathbf x) = T(\mathbf x)\mathbf q(\mathbf x, t),
```

where $T \in \mathbb R^{3N_m \times 2N_m}$ satisfies $T^\top T = I_{2N_m}$ and
$T T^\top = I_{3N_m} - \mathbf m_0\mathbf m_0^\top$. The cross-product operator $\mathbf m_0\times(\cdot)$
restricted to the tangent bundle is represented by the skew-symmetric symplectic operator $J$:

```{math}
:label: eq-numerical-linearized-llg-symplectic
T^\top\bigl(\mathbf m_0\times T\mathbf q\bigr) = J\mathbf q,
\qquad
J = \operatorname{diag}(J_2,\dots,J_2) \in \mathbb R^{2N_m\times 2N_m},
\qquad
J_2 = \begin{bmatrix} 0 & -1 \\ 1 & 0 \end{bmatrix},
\qquad
J^\top = -J,
\qquad
J^2 = -I_{2N_m}.
```

### 2.3 First variation of the effective field and tangent magnetic stiffness

Under a perturbation $(\delta\mathbf m, \delta\phi)$ with $\delta\mathbf m = T\mathbf q$ and dynamic
magnetostatic scalar potential $\delta\phi$ ($\delta\mathbf H_{\mathrm d} = -\nabla\delta\phi$), the
linearized effective field decomposes into local micromagnetic contributions and the nonlocal
magnetostatic gradient:

```{math}
:label: eq-numerical-linearized-llg-hessian
\delta\mathbf H_{\mathrm{eff}}[\mathbf q, \delta\phi] = -C_{\mathrm{mag}}T\mathbf q - \nabla\delta\phi,
\qquad
T^\top\bigl(\delta\mathbf H_{\mathrm{eff}} - H_0\,\delta\mathbf m\bigr) = -\bigl(A_{\mathrm{loc}}\mathbf q + T^\top\nabla\delta\phi\bigr),
\qquad
A_{\mathrm{loc}} = T^\top C_{\mathrm{mag}}T + H_0 I_{2N_m},
\qquad
A_{\mathrm{tot}} = A_{\mathrm{loc}} + A_{\mathrm{demag}}.
```

On shared-domain $\mathbf k = \mathbf 0$ operators (`open_airbox_k0` and `periodic_airbox_k0`),
where the relaxation producer may have solved a P2 static potential while the dynamic modal block
uses P1, the native shared-domain assembler recomputes the static P1 demagnetizing field on the same
$P$ operator and substitutes the parallel component $H_0$ before assembling $A_{qq}$, restoring
exact $N_\perp = N_\parallel$ symmetry (e.g., matching the sphere Kittel oracle to `0.04%`).

### 2.4 Rate-form and energy-Hessian generalized eigenvalue pencils

FullMag maintains two unit-consistent normalizations ({doc}`/physics/foundations/llg-equation` and
{doc}`/numerical-methods/frequency-domain/response-solver`):

1. **Rate-form dynamic operator pencil (`LinearizedDynamicPencil`)**:

```{math}
:label: eq-numerical-linearized-llg-operator-pencil
L\mathbf q = \lambda B_\alpha\mathbf q,
\qquad
L = \gamma_0 J A_{\mathrm{tot}},
\qquad
B_\alpha = I_{2N_m} - \alpha_{\mathrm{eff}}J,
\qquad
\lambda = \sigma + \mathrm i\omega,
\qquad
f = \frac{\omega}{2\pi},
\qquad
\alpha_{\mathrm{eff}} = \begin{cases} 0, & \text{if }\texttt{damping\_policy = "ignore"}, \\ \alpha, & \text{if }\texttt{damping\_policy = "include"}. \end{cases}
```

2. **Energy-Hessian gyrotropic descriptor pencil (`assemble_poisson_airbox_shared_domain`)**:

```{math}
:label: eq-numerical-linearized-llg-pencil
A_{qq}\mathbf q = \lambda B_{qq}\mathbf q
\quad\Longleftrightarrow\quad
A_{qq}\mathbf q = -\mathrm i\omega G\mathbf q
\quad(\text{for }\lambda = \mathrm i\omega,\; B_{qq} = -G).
```

### 2.5 Real-split rotated pencil for real-arithmetic SLEPc builds

When SLEPc runs in real scalar arithmetic, `assemble_real_frequency_rotated_pencil` embeds any
complex operator $C = C_r + \mathrm i C_i$ into a real $2\times 2$ block matrix acting on
$y = [\operatorname{Re}\mathbf q;\;\operatorname{Im}\mathbf q]^\top \in \mathbb R^{4N_m}$:

```{math}
:label: eq-numerical-linearized-llg-real-split
R(C) = \begin{bmatrix} C_r & -C_i \\ C_i & C_r \end{bmatrix},
\qquad
R(L)\,y = \omega\,R(\mathrm i B_\alpha)\,y,
\qquad
y = \begin{bmatrix} \operatorname{Re}\mathbf q \\ \operatorname{Im}\mathbf q \end{bmatrix}.
```

### 2.6 Coupled Poisson-airbox descriptor, CPU Schur complement, and GPU Hermitian augmented `cuDSS`

On a shared magnetic-plus-airbox mesh ($\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$),
`assemble_poisson_airbox_shared_domain` builds the coupled $(q,\phi)$ descriptor pencil:

```{math}
:label: eq-numerical-linearized-llg-schur
\begin{bmatrix} A_{qq} & A_{q\phi} \\ A_{\phi q} & P \end{bmatrix}
\begin{bmatrix} \mathbf q \\ \boldsymbol\phi \end{bmatrix}
=
\lambda
\begin{bmatrix} B_{qq} & 0 \\ 0 & 0 \end{bmatrix}
\begin{bmatrix} \mathbf q \\ \boldsymbol\phi \end{bmatrix},
\qquad
S(\tau) = A_{qq} - A_{q\phi}P^{-1}A_{\phi q} - \mathrm i\tau B_{qq},
```

satisfying the exact reciprocity identity $A_{q\phi} = -\mu_0 A_{\phi q}^H$.

- **FEM CPU (`solve_poisson_airbox_modal_eigen_cpu_schur`):** wraps $S(\tau)$ in a matrix-free
  PETSc `MATSHELL` and runs SLEPc Krylov-Schur with `STSINVERT` (using a sparse augmented shift
  preconditioner and SLEPc-default Krylov subspace sizing for single-shift queries).
- **FEM GPU (`assemble_open_airbox_augmented_pencil`, `check_device_memory_budget`, `solve_airbox_augmented_window`, `count_airbox_augmented_window`):**
  multiplies the potential block row by $-s\mu_0$ so that for conservative problems ($A_{qq}^{\mathsf H} = A_{qq}$,
  $P^{\mathsf H} = P$, $B_{qq}^{\mathsf H} = -B_{qq}$, $A_{q\phi} = -\mu_0 A_{\phi q}^{\mathsf H}$)
  the augmented shifted matrix $H_\sigma$ is strictly Hermitian complex indefinite, diagonally
  equilibrated, and factored directly by `cuDSS` after post-analysis VRAM budget admission
  (`check_device_memory_budget`). Shifted block solves use lifted QR Rayleigh–Ritz projection
  preserving both magnetic and potential components, and frequency-window bisection shares a
  local single-solve exact-shift inertia cache (`count_airbox_augmented_window`) that avoids
  re-factorizing repeated exact shift values during window counting (without recycling numeric
  factors into Ritz solves).

### 2.7 Full coupled descriptor residual certification

After convergence on $\mathbf q_n$, `evaluate_poisson_airbox_modal_residuals` reconstructs
$\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$ and certifies $(\lambda_n, \mathbf q_n, \boldsymbol\phi_n)$
against the unreduced block system:

```{math}
:label: eq-numerical-linearized-llg-coupled-residual
r_{q,n} = \bigl\lVert A_{qq}\mathbf q_n + A_{q\phi}\boldsymbol\phi_n - \lambda_n B_{qq}\mathbf q_n \bigr\rVert_2,
\qquad
r_{\phi,n} = \bigl\lVert A_{\phi q}\mathbf q_n + P\boldsymbol\phi_n \bigr\rVert_2,
\qquad
\varepsilon_{\mathrm{eig},n} = \frac{\sqrt{r_{q,n}^2 + (\mu_0 M_{s,\mathrm{ref}}\,r_{\phi,n})^2}}{\lVert A_{qq}\mathbf q_n\rVert_2 + \lvert\lambda_n\rvert\,\lVert B_{qq}\mathbf q_n\rVert_2}.
```

Every accepted mode on both CPU and GPU must satisfy $\varepsilon_{\mathrm{eig},n} \le \mathrm{tolerance}$.

### 2.8 3D Bloch–Floquet periodicity, narrow single-$\mathbf k$ GPU Floquet, and 2.5D waveguide dispersion

```{math}
:label: eq-numerical-linearized-llg-bloch-waveguide
\mathbf q(\mathbf x + \Delta\mathbf r) = \mathrm e^{\mathrm i\mathbf k\cdot\Delta\mathbf r}\mathbf q(\mathbf x),
\qquad
\delta\phi(\mathbf x + \Delta\mathbf r) = \mathrm e^{\mathrm i\mathbf k\cdot\Delta\mathbf r}\delta\phi(\mathbf x),
\qquad
D_{\mathbf k} = \nabla_\perp - \mathrm i k\,\hat{\mathbf z}.
```

1. **3D Bloch–Floquet CPU (`FloquetReducedMagneticOperator`, `build_floquet_dynamic_demag_k_real_split`):**
   applies unitary Bloch prolongation $C(\mathbf k)$ across certified periodic seams; wave vectors
   with $\max_d\lvert k_d\rvert \le \texttt{FEM\_EIGEN\_POLICY\_GAMMA\_K\_TOLERANCE\_RAD\_PER\_M}$
   ($10^{-9}\,\mathrm{rad\,m^{-1}}$) classify as $\Gamma$-point ($\mathbf k = \mathbf 0$).
2. **Narrow single-$\mathbf k$ GPU Floquet (`solve_gpu_floquet_shared_domain`, `solve_floquet_airbox_augmented_ritz`, `augmented_floquet_cudss_cuda`):**
   a source-visible and native-contract-tested slice targeting `StudyIR::Eigenmodes` with a single
   finite nonzero `KSamplingIR::Single` (`KPoint`), `operator="full_2x2"`, FEM P1/FP64, `alpha = 0`,
   `damping_policy="ignore"`, and `magnetostatic_bc="floquet_airbox"`. It enforces exact Hermitian
   block identities without artificial symmetrization, applies the shared `cuDSS` VRAM admission
   and single-solve inertia cache (`count_airbox_augmented_window`), carries C ABI kind 4 /
   attestation `augmented_floquet_cudss_cuda`, and certifies full complex $(q,\phi)$ residuals.
   **Qualification boundary:** unlike `open_airbox_k0` GPU (which is RTX 4080 SUPER verified on
   accepted checkpoints), single-$\mathbf k$ GPU Floquet remains pending full managed end-to-end
   physical qualification and `KSamplingIR::Path` remains outside this GPU slice (forced GPU never
   falls back to CPU).
3. **2.5D waveguide cross-section (`build_floquet_waveguide_demag_k_real_split`):** replaces
   $\nabla$ with $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf z}$, giving
   $P(k) = K_\perp + k^2 M_{\mathrm{air}}$.

### 2.9 Shifted inner KSP true-residual convergence gate

Inside CPU SLEPc shift-and-invert (`STSINVERT`), `floquet_shifted_true_convergence_test` computes
the explicit unpreconditioned residual $r_{\mathrm{true}} = b_\tau - A_\tau x_\tau$ and enforces:

```{math}
:label: eq-numerical-linearized-llg-ksp-gate
\lVert b_\tau - A_\tau x_\tau \rVert_2 \le \max\!\bigl(\mathrm{atol}_{\mathrm{ksp}},\, \mathrm{rtol}_{\mathrm{ksp}}\,\lVert b_\tau \rVert_2\bigr).
```

### 2.10 Consistent-$P_1$ mass-weighted Hungarian and SVD Procrustes branch tracking

`ConsistentP1TrackingMetric` and `track_branches` compute the gauge-invariant overlap matrix using
the consistent $P_1$ finite-element volume mass matrix $M$ on $\Omega_m$:

```{math}
:label: eq-numerical-linearized-llg-tracking
\mathcal O_{ab}^{(s\to s+1)}
= \frac{\bigl\lvert \mathbf q_{a,s}^H (M \otimes I_2) \mathbf q_{b,s+1} \bigr\rvert}{\sqrt{\mathbf q_{a,s}^H (M \otimes I_2) \mathbf q_{a,s}}\,\sqrt{\mathbf q_{b,s+1}^H (M \otimes I_2) \mathbf q_{b,s+1}}},
\qquad
C = U_{\mathrm{sub}}^H (M \otimes I_2) V_{\mathrm{sub}} = W_1 \Sigma_{\mathrm{sub}} W_2^H,
\qquad
s_{\mathrm{sub}} = \sigma_{\min}(\Sigma_{\mathrm{sub}}),
\qquad
R_{\mathrm{sub}} = W_1 W_2^H.
```

Non-degenerate branches are matched via the Hungarian algorithm subject to
$\mathcal O_{ab}^{(s\to s+1)} \ge \texttt{overlap\_floor}$; near-degenerate multiplets use
`mass_weighted_subspace_transport` with unitary Procrustes transport $R_{\mathrm{sub}} = W_1 W_2^H$.

(linearized-llg-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf m$ | unit magnetization vector field | $1$ |
| $\mathbf m_0$ | static equilibrium unit magnetization | $1$ |
| $\delta\mathbf m$ | first-order dynamic magnetization perturbation | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | total effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $H_0$ | equilibrium effective-field projection $\mathbf m_0\cdot\mathbf H_{\mathrm{eff}}[\mathbf m_0]$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf e_1,\mathbf e_2$ | local orthonormal tangent-plane basis vectors orthogonal to $\mathbf m_0$ | $1$ |
| $q_1,q_2$ | nodal tangent-plane perturbation amplitudes along $\mathbf e_1$ and $\mathbf e_2$ | $1$ |
| $T$ | global tangent-frame prolongation matrix ($\mathbb R^{2N_m}\to\mathbb R^{3N_m}$) | $1$ |
| $J$ | global block-diagonal tangent symplectic skew-symmetric operator | $1$ |
| $J_2$ | nodal $2\times 2$ symplectic rotation block representing $\mathbf m_0\times(\cdot)$ | $1$ |
| $C_{\mathrm{mag}}$ | conservative Cartesian field-stiffness operator $-\delta\mathbf H_{\mathrm{loc}}/\delta\mathbf m$ | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{loc}}$ | local tangent-plane magnetic field-stiffness operator $T^\top C_{\mathrm{mag}}T + H_0 I$ | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{tot}}$ | total tangent-plane magnetic field-stiffness operator including magnetostatics | $\mathrm{A\,m^{-1}}$ |
| $\delta\phi$ | continuous dynamic magnetostatic scalar potential perturbation | $\mathrm{A}$ |
| $\boldsymbol\phi$ | discrete shared-domain FEM scalar potential degree-of-freedom vector | $\mathrm{A}$ |
| $\mathbf q$ | discrete tangent-plane magnetization eigenvector | $1$ |
| $\lambda$ | complex modal eigenvalue $\sigma + \mathrm i\omega$ | $\mathrm{s^{-1}}$ |
| $\sigma$ | modal decay or growth rate $\operatorname{Re}\lambda$ | $\mathrm{s^{-1}}$ |
| $\omega$ | modal angular eigenfrequency $\operatorname{Im}\lambda$ | $\mathrm{rad\,s^{-1}}$ |
| $f$ | cyclic spin-wave eigenfrequency $\omega/(2\pi)$ | $\mathrm{Hz}$ |
| $\gamma_0$ | rescaled gyromagnetic prefactor $\mu_0\lvert\gamma\rvert$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha_{\mathrm{eff}}$ | effective Gilbert damping coefficient in the modal operator | $1$ |
| $L$ | canonical rate-form linearized dynamic operator $\gamma_0 J A_{\mathrm{tot}}$ | $\mathrm{s^{-1}}$ |
| $B_\alpha$ | damping-modified tangent metric operator $I - \alpha_{\mathrm{eff}}J$ | $1$ |
| $A_{qq}$ | assembled tangent-plane micromagnetic energy-Hessian stiffness block | $\mathrm{J}$ |
| $A_{q\phi}$ | assembled magnetic-to-potential Zeeman gradient coupling block | $\mathrm{J\,A^{-1}}$ |
| $A_{\phi q}$ | assembled potential-to-magnetic flux divergence coupling block | $\mathrm{A\,m}$ |
| $P$ | shared-domain magnetic-plus-airbox Poisson stiffness matrix | $\mathrm{m}$ |
| $G$ | assembled tangent-plane gyrotropic mass matrix | $\mathrm{J\,s}$ |
| $B_{qq}$ | descriptor right-hand gyrotropic operator block $-G$ | $\mathrm{J\,s}$ |
| $S(\tau)$ | magnetostatic Schur-complement matrix $A_{qq} - A_{q\phi}P^{-1}A_{\phi q} - \mathrm i\tau B_{qq}$ | $\mathrm{J}$ |
| $\tau$ | real angular-frequency spectral shift $2\pi f_{\mathrm{shift}}$ | $\mathrm{rad\,s^{-1}}$ |
| $R(C)$ | real $2\times 2$ block embedding of a complex rate operator $C$ | $\mathrm{s^{-1}}$ |
| $y$ | stacked real-imaginary tangent state vector $[\operatorname{Re}\mathbf q;\,\operatorname{Im}\mathbf q]$ | $1$ |
| $r_{q,n}$ | Euclidean norm of the magnetic descriptor residual for mode $n$ | $\mathrm{J}$ |
| $r_{\phi,n}$ | Euclidean norm of the Poisson flux-continuity residual for mode $n$ | $\mathrm{A\,m}$ |
| $\varepsilon_{\mathrm{eig},n}$ | dimensionless relative coupled eigenpair residual for mode $n$ | $1$ |
| $\mathbf k$ | 3D Bloch-Floquet spin-wave wave vector | $\mathrm{rad\,m^{-1}}$ |
| $k$ | axial propagation wavenumber along a 2.5D waveguide | $\mathrm{rad\,m^{-1}}$ |
| $\Delta\mathbf r$ | direct-lattice translation vector between periodic boundary partner nodes | $\mathrm{m}$ |
| $D_{\mathbf k}$ | 2.5D waveguide shifted-gradient operator $\nabla_\perp - \mathrm i k\hat{\mathbf z}$ | $\mathrm{m^{-1}}$ |
| $A_\tau$ | inner shifted linear system matrix inside shift-and-invert SLEPc | $\mathrm{J}$ |
| $x_\tau$ | inner shifted Krylov iterate for tangent perturbation degrees of freedom | $1$ |
| $b_\tau$ | inner shifted Krylov right-hand side vector | $\mathrm{J}$ |
| $\mathrm{atol}_{\mathrm{ksp}}$ | absolute unpreconditioned residual tolerance for shifted inner KSP solves | $\mathrm{J}$ |
| $\mathrm{rtol}_{\mathrm{ksp}}$ | relative unpreconditioned residual tolerance for shifted inner KSP solves | $1$ |
| $M$ | consistent $P_1$ finite-element volume mass matrix on $\Omega_m$ | $\mathrm{m^3}$ |
| $\mathcal O_{ab}^{(s\to s+1)}$ | normalized mass-weighted inter-step mode overlap score | $1$ |
| $C$ | degenerate-multiplet mass-weighted cross-gramian matrix | $1$ |
| $U_{\mathrm{sub}}$ | orthonormal degenerate-subspace basis matrix at step $s$ | $1$ |
| $V_{\mathrm{sub}}$ | orthonormal degenerate-subspace basis matrix at step $s+1$ | $1$ |
| $\Sigma_{\mathrm{sub}}$ | diagonal matrix of principal-angle cosines between degenerate subspaces | $1$ |
| $s_{\mathrm{sub}}$ | minimum singular value $\sigma_{\min}(\Sigma_{\mathrm{sub}})$ certifying subspace continuity | $1$ |
| $R_{\mathrm{sub}}$ | unitary Procrustes transport matrix across a degenerate multiplet | $1$ |

(linearized-llg-assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

| Configuration choice | Mathematical meaning | What it does not mean |
|---|---|---|
| `equilibrium_acceptance="certified"` (default) | Linearizes strictly around a converged relaxation state verified by the R4 torque gate. | Does not accept unrelaxed snapshots. |
| `equilibrium_acceptance="force"` | Diagnostic opt-in recording residual torque $\tau_{\max}$, `converged=false`, and `forced=true`. | Is not a certified equilibrium spectrum and cannot publish accepted antenna equilibria or override `equilibrium_source="artifact"`. |
| `operator="full_2x2"` | Assembles the full $2N_m\times 2N_m$ coupled $(\mathbf e_1, \mathbf e_2)$ tangent pencil with gyrotropic coupling $J$. | Is not reducible to a scalar Helmholtz equation when dipolar ellipticity or DMI is present. |
| `magnetostatic_bc="open_airbox_k0"` | Isolated body in a Robin airbox with identity equivalence classes, zero periodic pairs, and explicit `k_vector=(0.0, 0.0, 0.0)`. | Cannot be combined with non-`free` `bc`, omitted or nonzero $\mathbf k$, or `damping_policy="include"`. |
| `damping_policy="ignore"` | Sets $\alpha_{\mathrm{eff}} = 0$ in $B_\alpha$ so conservative modes have purely imaginary $\lambda = \mathrm i\omega$. | Does not modify the material parameter `film.alpha` stored for relaxation or time-domain stages. |
| `pure_prism_p2` mesh guard | Uncertified `prism6` eigen studies fail closed in planning (`validate_pure_prism_topology_certificate_against_mesh`). | `prism6` meshes cannot silently bypass topology certification. |

(linearized-llg-python-api)=
## 5. Python API and complete parameter reference

### Executable stage workflow

The following copyable workflow configures a shared-domain FEM study, relaxes the magnetization to
a verified static equilibrium, computes open-airbox $\mathbf k = \mathbf 0$ spin-wave eigenmodes
using the coupled $2\times 2$ tangent solver and explicit solver controls, and constructs an
optional Brillouin-zone $\mathbf k$-path schema for periodic waveguides.

```python
# %% Imports and study declaration
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_modal_schur_dispersion")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Shared magnetic-plus-airbox domain and graded exterior mesh
study.universe(
    mode="manual",
    size=(400 * nm, 200 * nm, 160 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5 * nm,
    maximum_element_size=40 * nm,
    maximum_element_growth_rate=1.8,
    grading="geometric",
)

# %% Ferromagnetic waveguide strip and material parameters
strip = study.geometry(
    fm.Box(size=(200 * nm, 80 * nm, 5 * nm), name="strip"),
    name="strip",
)
strip.Ms = 8.0e5
strip.Aex = 13.0e-12
strip.alpha = 0.01
strip.m = fm.init.UniformMagnetization((1.0, 0.02, 0.0))
strip.mesh.thin_film(
    minimum_element_size=5 * nm,
    maximum_element_size=5 * nm,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)

# %% Interactions: exchange, external bias field, and Robin airbox demagnetization
study.exchange()
study.b_ext(0.1, 0.0, 0.0)
study.demag(model="airbox", variant="robin")

# %% Stage 1: Relax to a verified static equilibrium (R4 handoff prerequisite)
study.stages.add_relax(
    stage_id="relax_eq",
    algorithm="nonlinear_cg",
    max_steps=10_000,
    tolT=1.0e-8,
)

# %% Stage 2: Coupled 2x2 Schur-complement modal eigensolve (open-airbox k=0)
study.stages.add_eigenmodes(
    stage_id="modes_k0",
    count=8,
    target="nearest",
    target_frequency=8.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    equilibrium_acceptance="certified",
    normalization="unit_l2",
    damping_policy="ignore",
    magnetostatic_bc="open_airbox_k0",
    k_vector=(0.0, 0.0, 0.0),
    solver_rtol=1.0e-8,
    solver_max_outer_iterations=300,
    solver_max_linear_iterations=2000,
)

# %% Optional Bloch k-path dispersion sampling schema (for periodic waveguides)
k_path = fm.KPath(
    points=(
        fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
        fm.KPoint("X", (3.14159265e7, 0.0, 0.0)),
    ),
    samples_per_segment=(16,),
)
```

### `EigenmodesStageSpec`, `FemEigenSolverPolicy`, and `ModeTracking` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `EigenmodesStageSpec.count` | `int` | `10` | $1$ | positive integer | number of requested eigenmodes | FEM modal lane | `study.count` |
| `EigenmodesStageSpec.target` | `str` | `lowest` | $1$ | `lowest`, `nearest`, or `frequency_window` | spectral selection policy | FEM modal lane | `study.target` |
| `EigenmodesStageSpec.target_frequency` | `float \| None` | `None` | $\mathrm{Hz}$ | required when `target="nearest"` | spectral shift center frequency | FEM modal lane | `study.target_frequency` |
| `EigenmodesStageSpec.frequency_min` | `float \| None` | `None` | $\mathrm{Hz}$ | required when `target="frequency_window"` | lower frequency window bound | FEM modal lane | `study.frequency_min` |
| `EigenmodesStageSpec.frequency_max` | `float \| None` | `None` | $\mathrm{Hz}$ | strictly greater than `frequency_min` | upper frequency window bound | FEM modal lane | `study.frequency_max` |
| `EigenmodesStageSpec.operator` | `str` | `linearized_llg` | $1$ | `linearized_llg` or `full_2x2` | tangent dynamic operator family | FEM modal lane | `study.operator` |
| `EigenmodesStageSpec.include_demag` | `bool` | `True` | $1$ | Boolean | include dynamic magnetostatic coupling | FEM modal lane | `study.include_demag` |
| `EigenmodesStageSpec.equilibrium_source` | `str` | `relax` | $1$ | `relax`, `provided`, or `artifact` | source of equilibrium magnetization $\mathbf m_0$ | planner and runner | `study.equilibrium_source` |
| `EigenmodesStageSpec.equilibrium_artifact` | `str \| None` | `None` | $1$ | required when `equilibrium_source="artifact"` | path to equilibrium state artifact | planner and runner | `study.equilibrium_artifact` |
| `EigenmodesStageSpec.equilibrium_acceptance` | `str` | `certified` | $1$ | `certified` or `force` | require converged relaxation handoff or allow diagnostic forced torque certificate | FEM planner and CLI | `study.equilibrium_acceptance` |
| `EigenmodesStageSpec.normalization` | `str` | `unit_l2` | $1$ | `unit_l2` or `unit_max_amplitude` | exported spatial mode normalization | FEM modal lane | `study.normalization` |
| `EigenmodesStageSpec.damping_policy` | `str` | `ignore` | $1$ | `ignore` or `include` | retain or zero Gilbert damping in modal pencil | FEM modal lane | `study.damping_policy` |
| `EigenmodesStageSpec.k_vector` | `tuple[float,float,float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | finite three-vector | single Bloch-Floquet wave vector | FEM periodic/Floquet lane | `study.k_vector` |
| `EigenmodesStageSpec.k_sampling` | `object \| None` | `None` | $1$ | `KPoint` or `KPath` schema | Brillouin-zone dispersion sampling specification | FEM modal runner | `study.k_sampling` |
| `EigenmodesStageSpec.bias_field_sweep` | `BiasFieldSweep \| None` | `None` | $1$ | non-empty finite field list | static external bias-field sweep schedule | FEM modal runner | `study.bias_field_sweep` |
| `EigenmodesStageSpec.bc` | `str \| dict[str,object]` | `free` | $1$ | `free`, `pinned`, `PeriodicBC`, or `FloquetBC` | spin-wave lateral boundary condition | FEM modal lane | `study.spin_wave_bc` |
| `EigenmodesStageSpec.magnetostatic_bc` | `str` | `open` | $1$ | `open`, `open_airbox_k0`, `periodic_airbox_k0`, or `floquet_airbox` | dynamic magnetostatic boundary closure | FEM modal lane | `study.magnetostatic_bc` |
| `EigenmodesStageSpec.solver_policy` | `FemEigenSolverPolicy \| None` | `None` | $1$ | validated native eigensolver control policy | optional residual and iteration limits | FEM modal lane | `study.solver_policy` |
| `FemEigenSolverPolicy.residual_tolerance` | `float \| None` | `None` | $1$ | finite float $> 0$ | relative coupled eigenpair residual tolerance (`solver_rtol`) | FEM modal lane | `study.solver_policy.residual_tolerance` |
| `FemEigenSolverPolicy.max_outer_iterations` | `int \| None` | `None` | $1$ | positive 32-bit integer | maximum outer eigensolver restart cycles (`solver_max_outer_iterations`) | FEM modal lane | `study.solver_policy.max_outer_iterations` |
| `FemEigenSolverPolicy.max_linear_iterations` | `int \| None` | `None` | $1$ | positive 32-bit integer | maximum inner shifted linear solver iterations (`solver_max_linear_iterations`) | FEM modal lane | `study.solver_policy.max_linear_iterations` |
| `ModeTracking.method` | `str` | `overlap_hungarian` | $1$ | `overlap_hungarian` | combinatorial branch assignment solver | FEM modal runner | `study.mode_tracking.method` |
| `ModeTracking.frequency_window_hz` | `float \| None` | `None` | $\mathrm{Hz}$ | positive finite float when supplied | optional frequency gating window for branch matching | FEM modal runner | `study.mode_tracking.frequency_window_hz` |
| `ModeTracking.overlap_floor` | `float` | `0.50` | $1$ | finite float in $(0, 1]$ | minimum mass-weighted mode overlap threshold | FEM modal runner | `study.mode_tracking.overlap_floor` |
| `ModeTracking.max_branch_gap` | `int` | `1` | $1$ | non-negative integer | maximum skipped sample gap when tracking branches | FEM modal runner | `study.mode_tracking.max_branch_gap` |

(linearized-llg-problem-ir)=
## 6. ProblemIR, normalization, and provenance

The Python stage specification lowers into `ProblemIR` (`StudyIR::Eigenmodes` in
`crates/fullmag-ir/src/study.rs`) and is resolved by `plan_fem_eigen` into `FemEigenPlanIR`
(`crates/fullmag-ir/src/plan.rs`):

```json
{
  "kind": "eigenmodes",
  "count": 8,
  "target": "nearest",
  "target_frequency": 8000000000.0,
  "operator": "full_2x2",
  "include_demag": true,
  "equilibrium_source": "relax",
  "equilibrium_acceptance": "certified",
  "normalization": "unit_l2",
  "damping_policy": "ignore",
  "magnetostatic_bc": "open_airbox_k0",
  "solver_policy": {
    "residual_tolerance": 1e-8,
    "max_outer_iterations": 300,
    "max_linear_iterations": 2000
  }
}
```

When `magnetostatic_bc="open_airbox_k0"`, `open_airbox_k0_execution_requested` resolves CPU Schur
by default under `auto` and selects the qualified GPU augmented `cuDSS` / PETSc-SLEPc lane under
explicit `gpu` (failing closed with zero CPU fallback if GPU contracts are unmet). Native GPU
operator attestation distinguishes `augmented_robin_cudss_cuda` (open-airbox K0) from
`augmented_floquet_cudss_cuda` (single-$\mathbf k$ Floquet).

(linearized-llg-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

* **Requested intent**: preserves `operator`, `target`, `count`, `damping_policy`,
  `magnetostatic_bc`, `equilibrium_acceptance`, `k_sampling`, `bias_field_sweep`, `mode_tracking`,
  and `solver_policy` across Python $\leftrightarrow$ `ProblemIR` round-trip serialization.
* **Resolved execution**: records the resolved backend and operator kind
  (`augmented_robin_cudss_cuda`, `augmented_floquet_cudss_cuda`, or CPU Schur), `demag_kind`,
  spectral shift $\tau$, `cuDSS` inertia-cache reuse counts, cryptographic V6 modal certificate
  digest (`build_owned_modal_certificate_v6_binding`), and per-mode coupled residuals
  $(r_{q,n}, r_{\phi,n}, \varepsilon_{\mathrm{eig},n})$.
* **Validation errors**: fail closed when `count < 1`, `target="nearest"` is missing
  `target_frequency`, `target="frequency_window"` has `frequency_max <= frequency_min`, the
  equilibrium handoff fails the R4 torque gate without explicit `equilibrium_acceptance="force"`,
  an uncertified `prism6` mesh violates `validate_pure_prism_topology_certificate_against_mesh`, or
  `check_device_memory_budget` rejects an over-budget `cuDSS` shift factorization.
* **Unsupported combinations**: fail closed in `plan_fem_eigen` when FDM is requested for a FEM
  modal study, when `open_airbox_k0` is combined with periodic `bc` or nonzero $\mathbf k$, when
  `FloquetBC` lacks conforming seam pairs, when `KSamplingIR::Path` is requested on the narrow
  single-$\mathbf k$ GPU Floquet slice, or when a forced GPU modal backend cannot execute on device.
  Silent fallback from `include_demag=True` to a local approximation or from GPU to CPU is forbidden.

(linearized-llg-discrete-realization)=
## 8. Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | implemented | MFEM shared-domain $(q,\phi)$ assembly, consistent P1 static $h_\parallel$, `open_airbox_k0` / `periodic_airbox_k0` / 3D Floquet / 2.5D waveguide real-split SLEPc `MATSHELL` Schur shift-invert, true-residual KSP gate, and `EigenKProcessPool` |
| FEM | GPU | partial | Qualified for `open_airbox_k0` (`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` + `assemble_open_airbox_augmented_pencil` + guarded `cuDSS` shifts + local inertia cache, RTX 4080 SUPER verified on archived K0 sphere checkpoint); narrow single-$\mathbf k$ conservative Floquet (`solve_gpu_floquet_shared_domain`, `solve_floquet_airbox_augmented_ritz`, `augmented_floquet_cudss_cuda`) is source-visible and contract-tested, pending full managed end-to-end qualification |
| FDM | CPU | unsupported | No native FDM linearized LLG eigensolver is claimed by this reference |
| FDM | GPU | unsupported | No native CUDA FDM modal eigensolver is claimed by this reference |

### 8.1 Quadrature and execution sequence

To prevent hourglass zero-energy modes on `prism6` meshes while avoiding negative tetrahedral
weights, `assemble_poisson_airbox_shared_domain` enforces `p1_geometry_aware_tet5_prism4_positive`
(order 5 on `tet4`, order 4 on `prism6`).

1. **Equilibrium materialization and V6 certificate binding**: `materialize_equilibrium` loads
   $\mathbf m_0$ (including zero-step strict GPU `cuda_fem_initial_equilibrium` or diagnostic
   `forced_equilibrium_criterion`) and binds the V6 cryptographic certificate
   (`build_owned_modal_certificate_v6_binding`, identity view for `open_airbox_k0`).
2. **Tangent-frame and shared-domain assembly**: `build_tangent_frame` and
   `assemble_poisson_airbox_shared_domain` build $A_{qq}$, $A_{q\phi}$, $A_{\phi q}$, $P$, and
   $B_{qq} = -G$ (with consistent P1 static $h_\parallel$ substitution for K0).
3. **Eigensolve**: CPU runs `solve_poisson_airbox_modal_eigen_cpu_schur` with
   `floquet_shifted_true_convergence_test`; GPU runs `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`
   (or `solve_gpu_floquet_shared_domain` for narrow single-$\mathbf k$ Floquet) with
   `check_device_memory_budget`, `count_airbox_augmented_window`, and `solve_airbox_augmented_window`.
4. **Process isolation, certification, and tracking**: `petsc_slepc_process_mutex` serializes
   in-process PETSc/SLEPc calls; `EigenKProcessPool` isolates multi-$\mathbf k$ sweeps;
   `evaluate_poisson_airbox_modal_residuals` certifies unreduced coupled residuals; and
   `track_branches` tracks dispersion branches.

(linearized-llg-implementation-mapping)=
## 9. Implementation mapping

| Architectural stage | CPU owner | GPU owner |
|---|---|---|
| Equilibrium handoff, forced diagnostic gate, and V6 certificate | `accepted_relax_handoff_for_eigen_stage`, `forced_relax_acceptance_requests`, `forced_equilibrium_criterion`, and `build_owned_modal_certificate_v6_binding` | Shared host-side certificate gate plus strict zero-step `cuda_fem_initial_equilibrium` receipt |
| Tangent basis, rate pencil, and `pure_prism_p2` guard | `build_tangent_frame`, `LinearizedDynamicPencil`, `open_airbox_k0_execution_requested`, and `validate_pure_prism_topology_certificate_against_mesh` | Same validated tangent frame and planner guard prior to device upload |
| Shared-domain $(q,\phi)$ descriptor assembly | `assemble_poisson_airbox_shared_domain` | `assemble_open_airbox_augmented_pencil` (Hermitian scaled complex CSR) |
| 3D Floquet and 2.5D waveguide $\mathbf k$-operators | `FloquetReducedMagneticOperator`, `build_floquet_dynamic_demag_k_real_split`, and `build_floquet_waveguide_demag_k_real_split` | Narrow single-$\mathbf k$ conservative Floquet slice: `solve_gpu_floquet_shared_domain` and `solve_floquet_airbox_augmented_ritz` (`augmented_floquet_cudss_cuda`) |
| Shift-and-invert / augmented eigensolve | `solve_poisson_airbox_modal_eigen_cpu_schur` and `floquet_shifted_true_convergence_test` | `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`, `check_device_memory_budget`, `count_airbox_augmented_window`, and `solve_airbox_augmented_window` |
| Coupled residual certification | `evaluate_poisson_airbox_modal_residuals` | Device/host unreduced residual certification via `solve_modal_eigen_contract` |
| Multi-$\mathbf k$ pool and branch tracking | `EigenKProcessPool`, `track_branches`, `ConsistentP1TrackingMetric`, and `mass_weighted_subspace_transport` | Host runner post-processing on converged modal spectra |

(linearized-llg-validation)=
## 10. Validation and qualification

| Validation gate | Required check | Evidence required |
|---|---|---|
| Equilibrium handoff | $\lVert\mathbf m_0\times\mathbf H_{\mathrm{eff}}[\mathbf m_0]\rVert_\infty \le \varepsilon_{\mathrm{eq}}$ and matching V6 certificate digest (or explicit diagnostic `forced=true` receipt). | `accepted_relax_handoff_for_eigen_stage` / `forced_equilibrium_criterion`. |
| Inner shifted KSP / GPU `cuDSS` admission | CPU unpreconditioned residual below tolerance (`floquet_shifted_true_convergence_test`); GPU post-analysis VRAM budget check (`check_device_memory_budget`) passes in-budget and refuses 1 B over-limit deterministically. | Native CPU/GPU contracts (`gpu_augmented_modal_pencil_contract`, `gpu_floquet_modal_pencil_contract`). |
| Coupled $(q,\phi)$ residual | Reconstructed potential $\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$ and $\varepsilon_{\mathrm{eig},n} \le \mathrm{tolerance}$. | `evaluate_poisson_airbox_modal_residuals` per-mode table. |
| GPU open-airbox K0 parity | Archived K0 sphere checkpoint (RTX 4080 SUPER, `1.56 GHz` nearest mode): GPU `cuDSS` `82.71 s` vs CPU PETSc/SLEPc `125.61 s`, relative frequency diff `5.0e-15`, phase-aligned profile overlap `1.0`, GPU residual `6.3e-12` (`<= 1e-8`), 5 inertia factorizations + 5 cache reuses. | Managed Docker DEV RTX 4080 SUPER run (see {ref}`numerical-methods-performance-fem-spectral-multiphysics`). |
| Homogeneous Kittel & dispersion | Ellipsoid, sphere, thin-film Kittel, Kalinikos–Slavin DE/BV, and COMSOL nonzero-$\mathbf k$ antidot benchmarks. | See {doc}`modal-validation`. |

(linearized-llg-limitations)=
## 11. Limitations and failure modes

* **Small-amplitude validity**: The linearized operator predicts onset frequencies, spatial mode
  profiles, and linear damping rates, but cannot capture nonlinear frequency shifts, Suhl
  instabilities, or domain-wall depinning.
* **Legacy `modal_krylov.cu` is test-only**: `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu`
  is retained solely for unit-test coverage and is NOT an active production GPU modal solver.
* **GPU Floquet qualification boundary**: Single-$\mathbf k$ GPU Floquet (`augmented_floquet_cudss_cuda`)
  is source-visible and contract-tested for conservative (`alpha = 0`) single-`KPoint` problems,
  but full managed end-to-end physical qualification and multi-point `KPath` GPU Floquet remain open.
* **`cuDSS` post-analysis memory admission**: `check_device_memory_budget` reads post-analysis
  estimates before factorization starts, so extreme meshes can still exhaust VRAM during symbolic
  analysis or subsequent Ritz workspace allocations.
* **Diagnostic `equilibrium_acceptance="force"`**: Results around a non-converged state with
  residual torque $\tau_{\max}$ carry frequency shifts of order $\gamma_0 \tau_{\max}/(2\pi)$ and
  can exhibit negative or complex eigenvalues near saddle points.
* **Backend support**: Production FDM modal eigensolvers are not claimed by this reference.

(linearized-llg-scientific-bibliography)=
## 12. Scientific bibliography

1. C. Herring and C. Kittel, “On the theory of spin waves in ferromagnetic media,” *Physical Review*, 81, 869–880 (1951).
2. M. d'Aquino, C. Serpico, G. Miano, and C. Forestiere, “A novel formulation for the numerical computation of magnetization modes in complex micromagnetic systems,” *Journal of Computational Physics*, 228, 6130–6149 (2009).
3. V. Hernandez, J. E. Roman, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the solution of eigenvalue problems,” *ACM Transactions on Mathematical Software*, 31, 351–362 (2005).
4. NVIDIA, *cuDSS Documentation*, `CUDSS_DATA_MEMORY_ESTIMATES` and Hermitian sparse factorization.
5. FullMag public physics contracts: {doc}`/physics/foundations/llg-equation`, {doc}`/physics/interactions/demagnetization/fem-poisson-airbox`, and {ref}`numerical-methods-performance-fem-spectral-multiphysics`.

(linearized-llg-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3081) | [`class EigenmodesStageSpec`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3081) | Public modal stage schema (including `magnetostatic_bc` and `equilibrium_acceptance`). |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3520) | [`eigenmodes_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3520) | Public stage construction. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1159) | [`class Eigenmodes`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1159) | Canonical Python Eigenmodes model and IR lowering. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L184) | [`class FemEigenSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L184) | Optional native PETSc/SLEPc residual and iteration limits. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | [`class KPath`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | Piecewise-linear Brillouin-zone wave-vector path schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L65) | [`class BiasFieldSweep`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L65) | Static bias-field sweep schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L408) | [`class ModeTracking`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L408) | Mass-weighted Hungarian and degeneracy tracking policy. |
| [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study.rs#L1502) | [`EigenOperatorIR`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study.rs#L1502) | Canonical ProblemIR operator family enum. |
| [`crates/fullmag-ir/src/study_v04.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study_v04.rs#L21) | [`SpatialRepresentationIR`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study_v04.rs#L21) | Full3d vs Waveguide2p5d spatial representation IR. |
| [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/plan.rs#L1975) | [`FemEigenPlanIR`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/plan.rs#L1975) | Resolved FEM modal execution plan IR. |
| [`crates/fullmag-ir/src/mixed_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855) | [`validate_pure_prism_topology_certificate_against_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855) | Fail-closed `pure_prism_p2` certificate guard for `prism6` meshes. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L6107) | [`plan_fem_eigen`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L6107) | Capability validation and FemEigenPlanIR resolution. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L5947) | [`open_airbox_k0_execution_requested`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L5947) | Resolves `open_airbox_k0` CPU and GPU execution legality. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L1803) | [`FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L1803) | Componentwise Gamma-point wave-vector classification tolerance. |
| [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/orchestrator.rs#L2976) | [`accepted_relax_handoff_for_eigen_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/orchestrator.rs#L2976) | Verifies converged relaxation equilibrium handoff before modal execution. |
| [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/orchestrator.rs#L3114) | [`forced_relax_acceptance_requests`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-cli/src/orchestrator.rs#L3114) | Opt-in diagnostic forced handoff when `equilibrium_acceptance="force"`. |
| [`crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs#L2242) | [`forced_equilibrium_criterion`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs#L2242) | Builds measured residual-torque certificate with `forced=true` and `converged=false`. |
| [`crates/fullmag-runner/src/eigen/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/orchestrator.rs#L82) | [`run_path_or_single_controlled`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/orchestrator.rs#L82) | Coordinates single-k and multi-sample k-path modal execution. |
| [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | [`EigenKProcessPool`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | Multi-process worker pool isolating PETSc/SLEPc runtime state across k-points. |
| [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking.rs#L1222) | [`track_branches`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking.rs#L1222) | Mass-weighted Hungarian branch tracking across k and bias-field steps. |
| [`crates/fullmag-runner/src/eigen/tracking_subspace.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | [`mass_weighted_subspace_transport`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | SVD principal-angle and unitary Procrustes transport across degenerate crossings. |
| [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | [`ConsistentP1TrackingMetric`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | Consistent P1 finite-element mass inner product for mode overlap. |
| [`crates/fullmag-runner/src/fem/eigen_equilibrium.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L388) | [`materialize_equilibrium`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L388) | Loads and validates static equilibrium m0 for modal linearization. |
| [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1193) | [`build_owned_modal_certificate_v6_binding`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1193) | Cryptographic V6 certificate binding equilibrium, mesh, and periodic seam maps. |
| [`backends/fem/core/petsc_slepc_runtime.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/core/petsc_slepc_runtime.cpp#L24) | [`petsc_slepc_process_mutex`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/core/petsc_slepc_runtime.cpp#L24) | Process-global mutex serializing in-process PETSc/SLEPc operations. |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2352) | [`solve_modal_eigen_contract`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2352) | Native modal contract, validation and diagnostics. |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2168) | [`solve_gpu_floquet_shared_domain`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2168) | Narrow single-k GPU Floquet shared-domain dispatch (`augmented_floquet_cudss_cuda`). |
| [`backends/fem/include/frequency_domain/tangent_frame.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/tangent_frame.hpp#L38) | [`build_tangent_frame`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/tangent_frame.hpp#L38) | Constructs orthonormal nodal tangent basis (e1, e2, m0). |
| [`backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp#L38) | [`class LinearizedDynamicPencil`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp#L38) | Canonical linearized dynamic operator pencil L q = lambda B_alpha q. |
| [`backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp#L31) | [`assemble_real_frequency_rotated_pencil`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp#L31) | Assembles real-split rotated pencil R(L) y = omega R(i B_alpha) y. |
| [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | [`assemble_poisson_airbox_shared_domain`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | Assembles coupled magnetic-airbox block operators (A_qq, A_qphi, A_phiq, P). |
| [`backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | [`class FloquetReducedMagneticOperator`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | Bloch-reduced magnetic tangent operator across periodic boundary pairs. |
| [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | [`build_floquet_dynamic_demag_k_real_split`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | 3D Floquet k-dependent dynamic demagnetization operator. |
| [`backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | [`build_floquet_waveguide_demag_k_real_split`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | 2.5D waveguide shifted-gradient dynamic demagnetization operator. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | [`solve_poisson_airbox_modal_eigen_cpu_schur`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | Matrix-free MATSHELL Schur-complement shift-and-invert SLEPc eigensolver. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L676) | [`evaluate_poisson_airbox_modal_residuals`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L676) | Reconstructs scalar potential and evaluates full coupled descriptor residuals. |
| [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | [`floquet_shifted_true_convergence_test`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | Enforces true unpreconditioned residual gate inside shifted KSP solves. |
| [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L22) | [`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L22) | Production GPU modal eigensolver entry point (qualified open-airbox K0 `cuDSS` & PETSc/SLEPc). |
| [`backends/fem/gpu/frequency_domain/modal_augmented_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_pencil.hpp#L209) | [`assemble_open_airbox_augmented_pencil`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_pencil.hpp#L209) | Builds scaled Hermitian complex CSR shift operator for open-airbox Robin GPU eigensolves. |
| [`backends/fem/gpu/frequency_domain/modal_cudss_shift.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_cudss_shift.cpp#L171) | [`check_device_memory_budget`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_cudss_shift.cpp#L171) | Fail-closed post-analysis VRAM admission before GPU modal `cuDSS` factorization. |
| [`backends/fem/gpu/frequency_domain/modal_augmented_ritz.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_ritz.hpp#L59) | [`solve_floquet_airbox_augmented_ritz`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_ritz.hpp#L59) | Projected Rayleigh–Ritz solver for single-k GPU Floquet augmented shifts. |
| [`backends/fem/gpu/frequency_domain/modal_augmented_window_count.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_window_count.cpp#L13) | [`count_airbox_augmented_window`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_window_count.cpp#L13) | Exact-shift inertia cache and window mode counting for K0 and Floquet GPU solves. |
| [`backends/fem/gpu/frequency_domain/modal_augmented_window.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_window.cpp#L127) | [`solve_airbox_augmented_window`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_window.cpp#L127) | Shared GPU augmented frequency-window solver orchestrating inertia cache and Ritz blocks. |

## Cross-links

* {ref}`numerical-methods-performance-fem-spectral-multiphysics`
* {doc}`index`
* {doc}`modal-validation`
* {doc}`/python-api/studies/eigenmodes`
* {doc}`/python-api/outputs/modes-and-spectra`
* {doc}`/python-api/outputs/dispersion-and-response`
* {doc}`/frontend/capability-register`
