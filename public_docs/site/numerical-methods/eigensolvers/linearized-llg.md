---
title: Linearized LLG
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0600-fem-eigenmodes-linearized-llg.md
---

(public-docs-numerical-methods-eigensolvers-linearized-llg)=
(numerical-methods-eigensolvers-linearized-llg)=
# Linearized LLG eigenvalue problem

This chapter specifies the mathematical formulation, tangent-plane discretization, magnetostatic
Schur-complement reduction, Krylov-Schur eigensolver pipeline, and branch-tracking algebra used by
FullMag to compute small-amplitude spin-wave eigenmodes around a static micromagnetic equilibrium.

A modal calculation is not an isolated algebraic formula evaluated on an arbitrary magnetization
snapshot. The computed spectrum and spatial mode profiles depend on five coupled numerical elements:

1. a verified static micromagnetic equilibrium $\mathbf m_0(\mathbf x)$ satisfying the torque gate
   $\lVert\mathbf m_0\times\mathbf H_{\mathrm{eff}}[\mathbf m_0]\rVert_\infty \le \varepsilon_{\mathrm{eq}}$;
2. a nodal orthonormal tangent-plane basis $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$ eliminating the
   longitudinal norm constraint $\mathbf m_0\cdot\delta\mathbf m = 0$;
3. the selected tangent dynamic operator family (`linearized_llg` scalar projection vs `full_2x2`
   Herring–Kittel coupled tangent block operator);
4. the treatment of dynamic magnetostatics on the shared magnetic-plus-airbox mesh
   ($\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$) via the coupled $(q,\phi)$ descriptor pencil and
   its matrix-free Schur complement;
5. the spectral transformation, inner linear-solver residual gate, and post-solve coupled residual
   certification.

(linearized-llg-problem-statement)=
## 1. Physical problem and modal operator families

Let $\Omega_m \subset \mathbb R^3$ denote the ferromagnetic body and $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$
the conforming finite-element domain including the surrounding magnetostatic airbox. Around a static
equilibrium configuration $\mathbf m_0 : \Omega_m \to S^2$, small-amplitude magnetization
oscillations are expanded to first order in the local tangent plane $T_{\mathbf m_0(\mathbf x)}S^2$
as harmonic modes $\delta\mathbf m(\mathbf x, t) = \operatorname{Re}\{\delta\widehat{\mathbf m}_n(\mathbf x)\mathrm e^{\lambda_n t}\}$
with complex eigenvalue $\lambda_n = \sigma_n + \mathrm i\omega_n$ and cyclic eigenfrequency
$f_n = \omega_n / (2\pi)$.

FullMag exposes two distinct tangent operator families (`Eigenmodes.operator`) and two spatial
geometry representations (`Eigenmodes.spatial_representation`). They define different discrete
eigenvalue problems and must not be treated as interchangeable aliases:

| Selector | Value | Discrete dimension | Mathematical structure | Intended physical regime |
|---|---|---:|---|---|
| `operator` | `"linearized_llg"` | $N_m \times N_m$ | Scalar projected stiffness-mass pencil along the primary tangent axis $\mathbf e_1$ | Approximately uniform equilibrium and collinear internal field |
| `operator` | `"full_2x2"` | $2N_m \times 2N_m$ | Coupled $2\times 2$ Herring–Kittel tangent-plane block pencil in $(\mathbf e_1, \mathbf e_2)$ with gyrotropic cross-coupling $J$ | Non-collinear textures, elliptical precession, coupled Poisson-airbox demagnetization, and Floquet $\mathbf k \neq \mathbf 0$ |
| `spatial_representation` | `"full_3d"` | 3D volume mesh | Full three-dimensional finite-element discretization on $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$ | General 3D nanostructures, patterned elements, and 3D Bloch crystals |
| `spatial_representation` | `"waveguide_2p5d"` | 2D cross-section mesh | Translationally invariant cross-section in $(x,y)$ with analytical axial phase $\mathrm e^{\mathrm i k z}$ and shifted gradient $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf z}$ | Waveguides, nanostrips, and Damon–Eshbach / backward-volume dispersion $f(k)$ |

(linearized-llg-governing-equations)=
## 2. Governing equations and operator derivations

### 2.1 Static equilibrium prerequisite and R4 handoff gate

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
effective field onto $\mathbf m_0(\mathbf x)$. Because $\mathbf m_0\times\mathbf H_{\mathrm{eff}}[\mathbf m_0] = \mathbf 0$
at equilibrium, $\mathbf H_{\mathrm{eff}}[\mathbf m_0](\mathbf x) = H_0(\mathbf x)\mathbf m_0(\mathbf x)$.
If $\mathbf m_0$ is not converged, the non-vanishing zeroth-order torque enters the first variation,
destroying the symmetry of the conservative stiffness Hessian and producing spurious unstable modes
($\operatorname{Re}\lambda > 0$). Before assembling the modal operator, the CLI and runner enforce
the R4 handoff gate (`accepted_relax_handoff_for_eigen_stage` and `build_owned_modal_certificate_v6_binding`),
verifying that the relaxation stage converged and that the mesh, material parameters, and periodic
seam identifications match the equilibrium certificate.

### 2.2 Local tangent-plane frame and symplectic kinematics

To preserve $\lvert\mathbf m(\mathbf x, t)\rvert = 1 + \mathcal O(\lvert\delta\mathbf m\rvert^2)$
identically without Lagrange multipliers, `build_tangent_frame` constructs a right-handed
orthonormal triad $(\mathbf e_1(\mathbf x_i), \mathbf e_2(\mathbf x_i), \mathbf m_0(\mathbf x_i))$ at
every magnetic mesh node $i \in \{1,\dots,N_m\}$ such that
$\mathbf e_1 \cdot \mathbf e_2 = 0$ and $\mathbf e_1 \times \mathbf e_2 = \mathbf m_0$. The dynamic
perturbation is parameterized by two dimensionless tangent amplitudes $\mathbf q_i(t) = [q_{1,i}(t), q_{2,i}(t)]^\top \in \mathbb R^2$:

```{math}
:label: eq-numerical-linearized-llg-tangent
\mathbf m(\mathbf x, t) = \mathbf m_0(\mathbf x) + \delta\mathbf m(\mathbf x, t),
\qquad
\mathbf m_0(\mathbf x)\cdot\delta\mathbf m(\mathbf x, t) = 0,
\qquad
\delta\mathbf m(\mathbf x, t) = q_1(\mathbf x, t)\mathbf e_1(\mathbf x) + q_2(\mathbf x, t)\mathbf e_2(\mathbf x) = T(\mathbf x)\mathbf q(\mathbf x, t),
```

where $T \in \mathbb R^{3N_m \times 2N_m}$ is the block-diagonal nodal prolongation operator with
blocks $T_i = [\mathbf e_1(\mathbf x_i)\;\;\mathbf e_2(\mathbf x_i)] \in \mathbb R^{3\times 2}$
satisfying $T^\top T = I_{2N_m}$ and $T T^\top = I_{3N_m} - \mathbf m_0\mathbf m_0^\top$.

Because $\mathbf m_0\times\mathbf e_1 = \mathbf e_2$ and $\mathbf m_0\times\mathbf e_2 = -\mathbf e_1$,
the cross-product operator $\mathbf m_0\times(\cdot)$ restricted to the tangent bundle is
represented in the $(\mathbf e_1, \mathbf e_2)$ basis by the skew-symmetric symplectic operator $J$:

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
linearized effective field decomposes into local micromagnetic contributions (exchange, anisotropy,
DMI) and the nonlocal magnetostatic gradient:

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

Here $C_{\mathrm{mag}} = -\delta\mathbf H_{\mathrm{loc}}/\delta\mathbf m$ (in $\mathrm{A\,m^{-1}}$)
is the Cartesian local field-stiffness operator, $H_0 I_{2N_m}$ is the static internal-field
curvature correction arising from $-\gamma_0\,\delta\mathbf m\times\mathbf H_{\mathrm{eff}}[\mathbf m_0] = +\gamma_0\,\mathbf m_0\times(H_0\delta\mathbf m)$,
and $A_{\mathrm{tot}}$ (in $\mathrm{A\,m^{-1}}$) is the total tangent-plane field-stiffness operator
after eliminating $\delta\phi$ via the magnetostatic Poisson equation.

### 2.4 Rate-form and energy-Hessian generalized eigenvalue pencils

FullMag maintains two mathematically equivalent, unit-consistent normalizations of the linearized
LLG eigenvalue problem (`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`):

1. **Rate-form dynamic operator pencil (`LinearizedDynamicPencil`)**:
   Starting from the Gilbert equation $\partial_t\mathbf m - \alpha\,\mathbf m\times\partial_t\mathbf m = -\gamma_0\,\mathbf m\times\mathbf H_{\mathrm{eff}}$
   with $\gamma_0 = \mu_0\lvert\gamma\rvert$ (in $\mathrm{m\,A^{-1}\,s^{-1}}$), linearizing around
   $\mathbf m_0$ and projecting onto the tangent basis $T$ gives
   $(I_{2N_m} - \alpha_{\mathrm{eff}}J)\dot{\mathbf q} = \gamma_0 J A_{\mathrm{tot}}\mathbf q$.
   Substituting $\mathbf q(t) = \widehat{\mathbf q}\,\mathrm e^{\lambda t}$ yields the canonical
   rate-form generalized eigenvalue pencil:

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

   In this normalization, $L$ has SI unit $\mathrm{s^{-1}}$, $B_\alpha$ is dimensionless ($1$), and
   $\lambda$ has SI unit $\mathrm{s^{-1}}$.

2. **Energy-Hessian gyrotropic descriptor pencil (`assemble_poisson_airbox_shared_domain`)**:
   In the shared-domain finite-element variational formulation over $\Omega_m$, multiplying the
   tangent field equations by $\mu_0 M_s(\mathbf x)$ and integrating against $P_1$ test functions
   yields the symmetric energy-Hessian stiffness block $A_{qq}$ (in $\mathrm{J}$) and the
   skew-symmetric gyrotropic matrix $G$ (in $\mathrm{J\,s}$), with weak entries
   $G_{ab} = \int_{\Omega_m} \frac{\mu_0 M_s(\mathbf x)}{\gamma_0}\,\boldsymbol\eta_a(\mathbf x)\cdot\bigl(\mathbf m_0(\mathbf x)\times\boldsymbol\xi_b(\mathbf x)\bigr)\,\mathrm dV$.
   With $B_{qq} = -G$ (or $B_{qq} = -G + D_\alpha$ when energy-Hessian Gilbert damping is included),
   the conservative or damped modal pencil takes the form:

```{math}
:label: eq-numerical-linearized-llg-pencil
A_{qq}\mathbf q = \lambda B_{qq}\mathbf q
\quad\Longleftrightarrow\quad
A_{qq}\mathbf q = -\mathrm i\omega G\mathbf q
\quad(\text{for }\lambda = \mathrm i\omega,\; B_{qq} = -G).
```

   Here $A_{qq}$ has SI unit $\mathrm{J}$, $G$ and $B_{qq}$ have SI unit $\mathrm{J\,s}$, and
   $\lambda B_{qq}\mathbf q$ has SI unit $\mathrm{J}$. Because $A_{qq}$ is Hermitian positive
   definite on stable equilibria and $\mathrm i G$ is Hermitian, all undamped eigenvalues
   $\omega$ are real and appear in conjugate pairs $(\pm\omega_n, \mathbf q_n, \overline{\mathbf q}_n)$.

### 2.5 Real-split rotated pencil for real-arithmetic SLEPc builds

When SLEPc is compiled in real scalar arithmetic (`PetscScalar = double`), solving
$L\mathbf q = \mathrm i\omega B_\alpha\mathbf q$ directly would require complex shift targets.
`assemble_real_frequency_rotated_pencil` embeds any complex operator $C = C_r + \mathrm i C_i$ into
a real $2\times 2$ block matrix $R(C)$ acting on the stacked real-imaginary state vector
$y = [\operatorname{Re}\mathbf q;\;\operatorname{Im}\mathbf q]^\top \in \mathbb R^{4N_m}$:

```{math}
:label: eq-numerical-linearized-llg-real-split
R(C) = \begin{bmatrix} C_r & -C_i \\ C_i & C_r \end{bmatrix},
\qquad
R(L)\,y = \omega\,R(\mathrm i B_\alpha)\,y,
\qquad
y = \begin{bmatrix} \operatorname{Re}\mathbf q \\ \operatorname{Im}\mathbf q \end{bmatrix}.
```

This maps the purely imaginary spectral parameter $\lambda = \mathrm i\omega$ onto the real
eigenvalue $\omega \in \mathbb R$, allowing real-arithmetic Krylov-Schur shift-and-invert at any
real target shift $\tau = 2\pi f_{\mathrm{shift}} \in \mathbb R$.

### 2.6 Coupled Poisson-airbox magnetostatic descriptor and Schur complement

On a shared magnetic-plus-airbox mesh ($\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$), dynamic
demagnetization is governed by the quasistatic Maxwell-Poisson equation
$-\nabla\cdot(\nabla\delta\phi) + \nabla\cdot(M_s T\mathbf q\,\mathbf 1_{\Omega_m}) = 0$ in $\Omega$,
subject to Dirichlet ($\delta\phi = 0$) or Robin ($\partial_n\delta\phi + \beta\delta\phi = 0$)
closure on $\Gamma_{\mathrm{air}} = \partial\Omega$. `assemble_poisson_airbox_shared_domain`
assembles the coupled $(q,\phi)$ saddle-point descriptor pencil:

```{math}
:label: eq-numerical-linearized-llg-schur
\begin{bmatrix} A_{qq} & A_{q\phi} \\ A_{\phi q} & P \end{bmatrix}
\begin{bmatrix} \mathbf q \\ \boldsymbol\phi \end{bmatrix}
=
\lambda
\begin{bmatrix} B_{qq} & 0 \\ 0 & 0 \end{bmatrix}
\begin{bmatrix} \mathbf q \\ \boldsymbol\phi \end{bmatrix},
\qquad
S(\tau) = A_{qq} - A_{q\phi}P^{-1}A_{\phi q} - \mathrm i\tau B_{qq}.
```

The block dimensions and SI units are:

* $A_{qq} \in \mathbb C^{2N_m\times 2N_m}$ (unit $\mathrm{J}$): local micromagnetic energy Hessian;
* $A_{q\phi} \in \mathbb C^{2N_m\times N_\phi}$ (unit $\mathrm{J\,A^{-1}}$): magnetic-to-potential Zeeman gradient coupling, with weak form $\int_{\Omega_m} \mu_0 M_s\,(T\boldsymbol\eta)\cdot\nabla\phi\,\mathrm dV$;
* $A_{\phi q} \in \mathbb C^{N_\phi\times 2N_m}$ (unit $\mathrm{A\,m}$): potential-to-magnetic flux divergence coupling, satisfying the exact energy-flux reciprocity relation $A_{q\phi} = -\mu_0 A_{\phi q}^H$;
* $P \in \mathbb C^{N_\phi\times N_\phi}$ (unit $\mathrm{m}$): shared-domain Poisson stiffness matrix (including the outer Robin surface form $\beta B_{\Gamma}$ when `variant="robin"`, or mean-zero gauge augmentation when pure Neumann).

Because the $\boldsymbol\phi$ row of the right-hand mass matrix is identically zero, $\boldsymbol\phi$
is an algebraic constraint ($\boldsymbol\phi = -P^{-1}A_{\phi q}\mathbf q$) whose direct inclusion in
a standard Krylov eigensolver introduces an $N_\phi$-dimensional infinite-eigenvalue nullspace.
`solve_poisson_airbox_modal_eigen_cpu_schur` eliminates $\boldsymbol\phi$ exactly at each spectral
shift $\tau = 2\pi f_{\mathrm{shift}}$ by wrapping $S(\tau)$ in a matrix-free PETSc `MATSHELL`
whose matrix-vector product evaluates $\mathbf w \mapsto A_{qq}\mathbf w - A_{q\phi}\bigl(P^{-1}(A_{\phi q}\mathbf w)\bigr) - \mathrm i\tau B_{qq}\mathbf w$
without ever forming the dense $2N_m \times 2N_m$ demagnetization matrix.

### 2.7 Full coupled descriptor residual certification

After SLEPc converges on the reduced magnetic eigenvector $\mathbf q_n$,
`evaluate_poisson_airbox_modal_residuals` reconstructs the companion dynamic scalar potential
$\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$ and certifies the eigenpair $(\lambda_n, \mathbf q_n, \boldsymbol\phi_n)$
against the full unreduced block system:

```{math}
:label: eq-numerical-linearized-llg-coupled-residual
r_{q,n} = \bigl\lVert A_{qq}\mathbf q_n + A_{q\phi}\boldsymbol\phi_n - \lambda_n B_{qq}\mathbf q_n \bigr\rVert_2,
\qquad
r_{\phi,n} = \bigl\lVert A_{\phi q}\mathbf q_n + P\boldsymbol\phi_n \bigr\rVert_2,
\qquad
\varepsilon_{\mathrm{eig},n} = \frac{\sqrt{r_{q,n}^2 + (\mu_0 M_{s,\mathrm{ref}}\,r_{\phi,n})^2}}{\lVert A_{qq}\mathbf q_n\rVert_2 + \lvert\lambda_n\rvert\,\lVert B_{qq}\mathbf q_n\rVert_2}.
```

Every accepted mode must satisfy $\varepsilon_{\mathrm{eig},n} \le \mathrm{tolerance}$.

### 2.8 3D Bloch–Floquet periodicity vs 2.5D waveguide dispersion

For nonzero spin-wave wave vectors, FullMag supports two distinct $\mathbf k$-dependent operator
assemblies:

```{math}
:label: eq-numerical-linearized-llg-bloch-waveguide
\mathbf q(\mathbf x + \Delta\mathbf r) = \mathrm e^{\mathrm i\mathbf k\cdot\Delta\mathbf r}\mathbf q(\mathbf x),
\qquad
\delta\phi(\mathbf x + \Delta\mathbf r) = \mathrm e^{\mathrm i\mathbf k\cdot\Delta\mathbf r}\delta\phi(\mathbf x),
\qquad
D_{\mathbf k} = \nabla_\perp - \mathrm i k\,\hat{\mathbf z}.
```

1. **3D Bloch–Floquet periodicity (`spatial_representation="full_3d"`)**:
   On a 3D unit cell with periodic partner node pairs separated by lattice translation vectors
   $\Delta\mathbf r$, `FloquetReducedMagneticOperator` and `build_floquet_dynamic_demag_k_real_split`
   construct the complex unitary prolongation matrix $C(\mathbf k)$ that eliminates slave boundary
   DOFs with the Bloch phase $\mathrm e^{\mathrm i\mathbf k\cdot\Delta\mathbf r}$, projecting the
   interior blocks as $A_{qq}(\mathbf k) = C(\mathbf k)^H A_{qq}^{\mathrm{full}} C(\mathbf k)$ and
   $P(\mathbf k) = C_\phi(\mathbf k)^H P^{\mathrm{full}} C_\phi(\mathbf k)$. The planner classifies
   a wave vector as the $\Gamma$-point ($\mathbf k = \mathbf 0$) when
   $\max_d \lvert k_d\rvert \le \texttt{FEM\_EIGEN\_POLICY\_GAMMA\_K\_TOLERANCE\_RAD\_PER\_M}$ ($10^{-9}\,\mathrm{rad\,m^{-1}}$).
2. **2.5D waveguide cross-section (`spatial_representation="waveguide_2p5d"`)**:
   For a structure invariant along $\hat{\mathbf z}$, `build_floquet_waveguide_demag_k_real_split`
   replaces the three-dimensional gradient $\nabla$ in the exchange and Poisson bilinear forms by the
   shifted differential operator $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf z}$, yielding
   a $k$-dependent stiffness $P(k) = K_\perp + k^2 M_{\mathrm{air}}$ on the cross-section mesh.

### 2.9 Shifted inner KSP true-residual convergence gate

Inside SLEPc shift-and-invert (`STSINVERT`), each Arnoldi step solves a shifted linear system
$A_\tau x_\tau = b_\tau$ where $A_\tau = S(\tau)$. Preconditioned residual norms can be artificially
small when the preconditioner is ill-conditioned near a resonance. Therefore,
`floquet_shifted_true_convergence_test` computes the explicit unpreconditioned residual
$r_{\mathrm{true}} = b_\tau - A_\tau x_\tau$ and enforces:

```{math}
:label: eq-numerical-linearized-llg-ksp-gate
\lVert b_\tau - A_\tau x_\tau \rVert_2 \le \max\!\bigl(\mathrm{atol}_{\mathrm{ksp}},\, \mathrm{rtol}_{\mathrm{ksp}}\,\lVert b_\tau \rVert_2\bigr).
```

### 2.10 Consistent-$P_1$ mass-weighted Hungarian and SVD Procrustes branch tracking

Across a wave-vector path $\{\mathbf k_s\}$ or bias-field sweep $\{\mathbf B_s\}$, eigenfrequencies
cross and hybridize. Sorting by frequency order alone swaps mode identities at crossings.
`ConsistentP1TrackingMetric` and `track_branches` compute the gauge-invariant overlap matrix using
the consistent $P_1$ finite-element volume mass matrix $M$ on $\Omega_m$
($M_{ij} = \int_{\Omega_m}\varphi_i(\mathbf x)\varphi_j(\mathbf x)\,\mathrm dV$):

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

Non-degenerate branches are matched by solving the maximum-weight bipartite assignment problem via
the Hungarian algorithm on $\mathcal O^{(s\to s+1)}$ subject to $\mathcal O_{ab}^{(s\to s+1)} \ge \texttt{min\_overlap}$.
When adjacent frequencies lie within `ModeTracking.degeneracy_tolerance`,
`mass_weighted_subspace_transport` forms the $d\times d$ mass-weighted cross-gramian $C$ between the
orthonormalized multiplet bases $U_{\mathrm{sub}}$ and $V_{\mathrm{sub}}$, computes its singular
value decomposition $C = W_1 \Sigma_{\mathrm{sub}} W_2^H$, verifies that the smallest principal-angle
cosine $s_{\mathrm{sub}} = \sigma_{\min}(\Sigma_{\mathrm{sub}})$ exceeds `min_overlap`, and applies
the unitary Procrustes transport matrix $R_{\mathrm{sub}} = W_1 W_2^H$ to maintain smooth mode
frames across the degeneracy.

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

The modal solver applies strictly within the small-amplitude linear regime around a stationary
equilibrium. The following distinctions govern valid physical interpretation:

| Configuration choice | Mathematical meaning | What it does not mean |
|---|---|---|
| Equilibrium handoff (`equilibrium_source="relax"`) | Linearizes around a relaxed state $\mathbf m_0$ verified by the R4 torque gate. | Does not allow linearizing around an arbitrary unrelaxed initialization. |
| `operator="full_2x2"` | Assembles the full $2N_m\times 2N_m$ coupled $(\mathbf e_1, \mathbf e_2)$ tangent pencil with gyrotropic coupling $J$. | Is not reducible to a scalar Helmholtz equation when dipolar ellipticity or DMI is present. |
| `damping_policy="ignore"` | Sets $\alpha_{\mathrm{eff}} = 0$ in $B_\alpha$ so conservative modes have purely imaginary $\lambda = \mathrm i\omega$. | Does not modify the material parameter `film.alpha` stored for relaxation or time-domain stages. |
| `damping_policy="include"` | Retains $\alpha_{\mathrm{eff}} = \alpha$ in $B_\alpha = I - \alpha J$, yielding complex eigenvalues $\lambda = \sigma + \mathrm i\omega$. | Does not account for nonlinear four-magnon or Eddy-current damping. |
| `include_demag=True` | Solves the coupled $(q,\phi)$ magnetostatic descriptor problem on $\Omega_m \cup \Omega_{\mathrm{air}}$. | Does not approximate demagnetization by a static local demagnetizing factor. |
| `spatial_representation="waveguide_2p5d"` | Uses $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf z}$ on a translationally invariant cross-section. | Cannot represent finite-length longitudinal end modes or 3D axial inhomogeneities. |

(linearized-llg-python-api)=
## 5. Python API and complete parameter reference

### Executable stage workflow

The following copyable workflow configures a shared-domain FEM study, relaxes the magnetization to
a verified static equilibrium, and computes the lowest spin-wave eigenmodes across a Brillouin-zone
$\mathbf k$-path using the coupled $2\times 2$ tangent Schur-complement solver and consistent-$P_1$
mass-weighted branch tracking.

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
strip.Aex = 1.3e-11
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

# %% Interactions: exchange, Zeeman bias, and Robin airbox demagnetization
study.exchange()
study.zeeman(field=(8.0e4, 0.0, 0.0))
study.demag(model="airbox", variant="robin")

# %% Stage 1: Relax to a verified static equilibrium (R4 handoff prerequisite)
study.stages.add_relax(
    stage_id="relax_eq",
    algorithm="nonlinear_cg",
    max_steps=10_000,
    tolT=1.0e-8,
)

# %% Stage 2: Coupled 2x2 Schur-complement modal eigensolve with branch tracking
study.stages.add_eigenmodes(
    stage_id="modes",
    count=8,
    target="nearest",
    target_frequency=8.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    spatial_representation="full_3d",
    k_sampling=fm.KPath(
        nodes=[
            ("Gamma", (0.0, 0.0, 0.0)),
            ("X", (3.14159265e7, 0.0, 0.0)),
        ],
        samples_per_segment=16,
    ),
    mode_tracking=fm.ModeTracking(
        method="overlap_hungarian",
        min_overlap=0.6,
        degeneracy_tolerance=2.0e6,
    ),
    fem_solver_policy=fm.FemEigenSolverPolicy(
        backend="slepc_shift_invert_schur",
        subspace_dimension=32,
        max_iterations=300,
        tolerance=1.0e-8,
        shift_Hz=8.0e9,
        target_spectrum="target_magnitude",
    ),
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=1,
            quantities=["mode_index", "frequency_Hz", "damping_rate_rad_s", "residual_norm"],
        ),
        fields=[fm.FieldAutosave("eigenmodes", every_steps=1)],
    )
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
| `EigenmodesStageSpec.normalization` | `str` | `unit_l2` | $1$ | `unit_l2` or `unit_max_amplitude` | exported spatial mode normalization | FEM modal lane | `study.normalization` |
| `EigenmodesStageSpec.damping_policy` | `str` | `ignore` | $1$ | `ignore` or `include` | retain or zero Gilbert damping in modal pencil | FEM modal lane | `study.damping_policy` |
| `EigenmodesStageSpec.k_vector` | `tuple[float,float,float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | finite three-vector | single Bloch-Floquet wave vector | FEM periodic/Floquet lane | `study.k_vector` |
| `EigenmodesStageSpec.k_sampling` | `object \| None` | `None` | $1$ | `KPoint` or `KPath` schema | Brillouin-zone dispersion sampling specification | FEM modal runner | `study.k_sampling` |
| `EigenmodesStageSpec.bias_field_sweep` | `BiasFieldSweep \| None` | `None` | $1$ | non-empty finite field list | static external bias-field sweep schedule | FEM modal runner | `study.bias_field_sweep` |
| `EigenmodesStageSpec.mode_tracking` | `ModeTracking \| None` | `None` | $1$ | validated tracking schema | mass-weighted branch tracking policy | FEM modal runner | `study.mode_tracking` |
| `EigenmodesStageSpec.bc` | `str \| dict[str,object]` | `free` | $1$ | `free`, `pinned`, `PeriodicBC`, or `FloquetBC` | spin-wave lateral boundary condition | FEM modal lane | `study.spin_wave_bc` |
| `EigenmodesStageSpec.spatial_representation` | `str` | `full_3d` | $1$ | `full_3d` or `waveguide_2p5d` | 3D volumetric vs 2.5D cross-section geometry | FEM modal lane | `study.spatial_representation` |
| `EigenmodesStageSpec.fem_solver_policy` | `FemEigenSolverPolicy \| None` | `None` | $1$ | validated solver policy | native eigensolver backend and Krylov policy | FEM modal lane | `study.fem_solver_policy` |
| `FemEigenSolverPolicy.backend` | `str` | `auto` | $1$ | `auto`, `slepc_shift_invert_schur`, `slepc`, `lobpcg_reference`, or `dense_reference` | native eigensolver realization | FEM modal lane | `study.fem_solver_policy.backend` |
| `FemEigenSolverPolicy.subspace_dimension` | `int \| None` | `None` | $1$ | integer $\ge 2$ and $\ge \mathrm{count}$ | Krylov-Schur or Arnoldi subspace dimension | FEM modal lane | `study.fem_solver_policy.subspace_dimension` |
| `FemEigenSolverPolicy.max_iterations` | `int` | `200` | $1$ | positive integer | maximum outer eigensolver restart cycles | FEM modal lane | `study.fem_solver_policy.max_iterations` |
| `FemEigenSolverPolicy.tolerance` | `float` | `1e-8` | $1$ | finite float $> 0$ | relative coupled eigenpair residual tolerance | FEM modal lane | `study.fem_solver_policy.tolerance` |
| `FemEigenSolverPolicy.shift_Hz` | `float \| None` | `None` | $\mathrm{Hz}$ | finite float $\ge 0$ | spectral shift frequency $\tau/(2\pi)$ | FEM shift-invert lane | `study.fem_solver_policy.shift_hz` |
| `FemEigenSolverPolicy.target_spectrum` | `str` | `smallest_magnitude` | $1$ | `smallest_magnitude` or `target_magnitude` | SLEPc eigenvalue sorting criterion | FEM modal lane | `study.fem_solver_policy.target_spectrum` |
| `ModeTracking.method` | `str` | `overlap_hungarian` | $1$ | `overlap_hungarian` | combinatorial branch assignment solver | FEM modal runner | `study.mode_tracking.method` |
| `ModeTracking.min_overlap` | `float` | `0.5` | $1$ | finite float in $(0, 1]$ | minimum mass-weighted mode overlap threshold | FEM modal runner | `study.mode_tracking.min_overlap` |
| `ModeTracking.degeneracy_tolerance` | `float` | `1e6` | $\mathrm{Hz}$ | finite float $> 0$ | frequency window for degenerate multiplet grouping | FEM modal runner | `study.mode_tracking.degeneracy_tolerance` |

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
  "normalization": "unit_l2",
  "damping_policy": "ignore",
  "spatial_representation": "full_3d",
  "fem_solver_policy": {
    "backend": "slepc_shift_invert_schur",
    "subspace_dimension": 32,
    "max_iterations": 300,
    "tolerance": 1e-8,
    "shift_hz": 8000000000.0,
    "target_spectrum": "target_magnitude"
  }
}
```

When `FemEigenSolverPolicy.backend="auto"`, the planner resolves `slepc_shift_invert_schur` for
shared-domain magnetostatic problems and records both the authored policy and the resolved
backend in `FemEigenPlanIR` and the stage provenance receipt.

(linearized-llg-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

* **Requested intent**: preserves the authored `operator`, `target`, `count`, `damping_policy`,
  `spatial_representation`, `k_sampling`, `bias_field_sweep`, `mode_tracking`, and
  `fem_solver_policy` fields across Python $\leftrightarrow$ `ProblemIR` round-trip serialization.
* **Resolved execution**: records the resolved eigensolver backend (`slepc_shift_invert_schur`,
  `slepc`, `lobpcg_reference`, or `dense_reference`), spectral shift $\tau$, Krylov subspace
  dimension, outer iteration count, inner KSP solve telemetry, cryptographic V6 modal certificate
  digest (`build_owned_modal_certificate_v6_binding`), and per-mode coupled residuals
  $(r_{q,n}, r_{\phi,n}, \varepsilon_{\mathrm{eig},n})$.
* **Validation errors**: fail closed when `count < 1`, `target="nearest"` is missing
  `target_frequency`, `target="frequency_window"` has `frequency_max <= frequency_min`,
  `subspace_dimension < count`, or the equilibrium handoff fails the R4 torque gate.
* **Unsupported combinations**: fail closed in `plan_fem_eigen` when an FDM engine is requested for
  a FEM modal study, when `FloquetBC` is combined with missing periodic boundary partner pairs, or
  when a forced GPU modal backend is requested without a qualified device runtime. Silent fallback
  from `include_demag=True` to a local approximation or from GPU to CPU is forbidden.

(linearized-llg-discrete-realization)=
## 8. Discrete realization and execution sequence

### 8.1 Quadrature and shared-domain assembly

To prevent hourglass zero-energy modes on prismatic thin-film meshes (`prism6`, where reference
shape-function gradients are linear and their products are quadratic) while avoiding the negative
quadrature weight present in MFEM's order-4 tetrahedral rule, `assemble_poisson_airbox_shared_domain`
enforces the geometry-aware positive quadrature policy `p1_geometry_aware_tet5_prism4_positive`
(order 5 on `tet4` elements and order 4 on `prism6` elements) and records the per-geometry
quadrature provenance in the stage receipt.

### 8.2 Execution sequence

1. **Equilibrium materialization and V6 certificate binding**: `materialize_equilibrium` loads
   $\mathbf m_0$ from the preceding relaxation stage or artifact, verifies unit norm and equilibrium
   torque, and binds the V6 cryptographic certificate (`build_owned_modal_certificate_v6_binding`).
2. **Tangent-frame construction**: `build_tangent_frame` builds $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$
   at all $N_m$ magnetic nodes and forms the prolongation operator $T$ and symplectic block $J$.
3. **Shared-domain block assembly**: `assemble_poisson_airbox_shared_domain` assembles $A_{qq}$,
   $A_{q\phi}$, $A_{\phi q}$, $P$, and $B_{qq} = -G$, applying periodic or Bloch–Floquet reduction
   $C(\mathbf k)$ when $\mathbf k \neq \mathbf 0$ or the 2.5D shifted gradient $D_{\mathbf k}$ when
   `spatial_representation="waveguide_2p5d"`.
4. **Matrix-free Schur shift-and-invert**: `solve_poisson_airbox_modal_eigen_cpu_schur` constructs
   the PETSc `MATSHELL` operator for $S(\tau)$ and runs SLEPc Krylov-Schur with `STSINVERT`. Each
   inner shifted solve is gated by `floquet_shifted_true_convergence_test`.
5. **Process isolation for multi-$\mathbf k$ sweeps**: for single-process runs,
   `petsc_slepc_process_mutex` (ADR-0055) serializes PETSc/SLEPc state; for multi-point `KPath`
   dispersion sweeps, `EigenKProcessPool` dispatches $\mathbf k$-points across isolated OS worker
   processes.
6. **Potential reconstruction, residual certification, and branch tracking**:
   `evaluate_poisson_airbox_modal_residuals` reconstructs $\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$,
   verifies $\varepsilon_{\mathrm{eig},n} \le \mathrm{tolerance}$, maps tangent eigenvectors back to
   Cartesian perturbations $\delta\mathbf m_n = T\mathbf q_n$, and runs `track_branches` with
   `ConsistentP1TrackingMetric` and `mass_weighted_subspace_transport`.

(linearized-llg-implementation-mapping)=
## 9. Implementation mapping

| Architectural stage | CPU owner | GPU owner |
|---|---|---|
| Equilibrium handoff and V6 certificate | `accepted_relax_handoff_for_eigen_stage` and `build_owned_modal_certificate_v6_binding` | shared host-side certificate gate prior to device upload |
| Tangent basis and rate pencil | `build_tangent_frame` and `LinearizedDynamicPencil` | device-mirrored tangent frame in modal Krylov workspace |
| Shared-domain $(q,\phi)$ descriptor assembly | `assemble_poisson_airbox_shared_domain` | host CSR assembly transferred to device CSR buffers |
| 3D Floquet and 2.5D waveguide $\mathbf k$-operators | `FloquetReducedMagneticOperator`, `build_floquet_dynamic_demag_k_real_split`, and `build_floquet_waveguide_demag_k_real_split` | partial; host-assembled real-split operators |
| Schur-complement shift-and-invert eigensolve | `solve_poisson_airbox_modal_eigen_cpu_schur` and `floquet_shifted_true_convergence_test` | `solve_poisson_airbox_modal_eigen_gpu_device_krylov` and `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` |
| Coupled residual certification | `evaluate_poisson_airbox_modal_residuals` | device/host residual reduction via `solve_modal_eigen_contract` |
| Multi-$\mathbf k$ pool and branch tracking | `EigenKProcessPool`, `track_branches`, and `mass_weighted_subspace_transport` | host runner post-processing on converged modal spectra |

(linearized-llg-validation)=
## 10. Validation and qualification

| Validation gate | Required check | Evidence required |
|---|---|---|
| Equilibrium handoff | $\lVert\mathbf m_0\times\mathbf H_{\mathrm{eff}}[\mathbf m_0]\rVert_\infty \le \varepsilon_{\mathrm{eq}}$ and matching V6 certificate digest. | `accepted_relax_handoff_for_eigen_stage` and V6 binding receipt. |
| Inner shifted KSP | True unpreconditioned residual $\lVert b_\tau - A_\tau x_\tau\rVert_2$ below tolerance on every Arnoldi step. | `floquet_shifted_true_convergence_test` telemetry. |
| Coupled $(q,\phi)$ residual | Reconstructed potential $\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$ and coupled relative residual $\varepsilon_{\mathrm{eig},n} \le \mathrm{tolerance}$. | `evaluate_poisson_airbox_modal_residuals` per-mode table. |
| Homogeneous Kittel limit | Ellipsoid / thin-film uniform mode matches analytical Herring–Kittel frequency within contract tolerance. | `verify_kittel_analytic` benchmark suite (see {doc}`modal-validation`). |
| Dispersion branch continuity | Mass-weighted overlap $\mathcal O_{ab}^{(s\to s+1)} \ge \texttt{min\_overlap}$ and Procrustes singular value $s_{\mathrm{sub}}$ across crossings. | `track_branches` and `mass_weighted_subspace_transport` diagnostics. |

(linearized-llg-limitations)=
## 11. Limitations and failure modes

* **Small-amplitude validity**: The linearized operator predicts onset frequencies, spatial mode
  profiles, and linear damping rates, but cannot capture nonlinear frequency shifts, suhl
  instabilities, or domain-wall depinning.
* **Spectral shift placement**: If `shift_Hz` coincides to machine precision with an exact undamped
  eigenfrequency ($\tau = \omega_n$ with $\alpha_{\mathrm{eff}} = 0$), the shifted Schur operator
  $S(\tau)$ becomes singular; offsetting `shift_Hz` slightly or enabling `damping_policy="include"`
  restores invertibility.
* **Backend support**: The FEM CPU modal lane (`slepc_shift_invert_schur`, `slepc`,
  `lobpcg_reference`, `dense_reference`) is source-backed and validated. The FEM GPU modal lane is
  partial and requires compiled CUDA/PETSc/SLEPc/Hypre device support. Production FDM modal
  eigensolvers are not claimed by this reference.

(linearized-llg-scientific-bibliography)=
## 12. Scientific bibliography

1. C. Herring and C. Kittel, “On the theory of spin waves in ferromagnetic media,” *Physical Review*, 81, 869–880 (1951).
2. M. d'Aquino, C. Serpico, G. Miano, and C. Forestiere, “A novel formulation for the numerical computation of magnetization modes in complex micromagnetic systems,” *Journal of Computational Physics*, 228, 6130–6149 (2009).
3. V. Hernandez, J. E. Roman, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the solution of eigenvalue problems,” *ACM Transactions on Mathematical Software*, 31, 351–362 (2005).
4. FullMag physics contracts: `docs/physics/0600-fem-eigenmodes-linearized-llg.md`, `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`, and `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.

(linearized-llg-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | [`class EigenmodesStageSpec`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | Public modal stage schema. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3224) | [`eigenmodes_stage`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3224) | Public stage construction. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | [`class Eigenmodes`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | Canonical Python Eigenmodes model and IR lowering. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | [`class FemEigenSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | FEM eigensolver backend, Krylov subspace, shift, and tolerance policy. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | [`class KPath`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | Piecewise-linear Brillouin-zone wave-vector path schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L65) | [`class BiasFieldSweep`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L65) | Static bias-field sweep schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L408) | [`class ModeTracking`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L408) | Mass-weighted Hungarian and degeneracy tracking policy. |
| [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study.rs#L1397) | [`EigenOperatorIR`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study.rs#L1397) | Canonical ProblemIR operator family enum. |
| [`crates/fullmag-ir/src/study_v04.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study_v04.rs#L21) | [`SpatialRepresentationIR`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study_v04.rs#L21) | Full3d vs Waveguide2p5d spatial representation IR. |
| [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/plan.rs#L1807) | [`FemEigenPlanIR`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/plan.rs#L1807) | Resolved FEM modal execution plan IR. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | [`plan_fem_eigen`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | Capability validation and FemEigenPlanIR resolution. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L1319) | [`FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L1319) | Componentwise Gamma-point wave-vector classification tolerance. |
| [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-cli/src/orchestrator.rs#L2947) | [`accepted_relax_handoff_for_eigen_stage`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-cli/src/orchestrator.rs#L2947) | Verifies converged relaxation equilibrium handoff before modal stage execution. |
| [`crates/fullmag-runner/src/eigen/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/orchestrator.rs#L82) | [`run_path_or_single_controlled`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/orchestrator.rs#L82) | Coordinates single-k and multi-sample k-path modal execution. |
| [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | [`EigenKProcessPool`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | Multi-process worker pool isolating PETSc/SLEPc runtime state across k-points. |
| [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | [`track_branches`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | Mass-weighted Hungarian branch tracking across k and bias-field steps. |
| [`crates/fullmag-runner/src/eigen/tracking_subspace.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | [`mass_weighted_subspace_transport`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | SVD principal-angle and unitary Procrustes transport across degenerate crossings. |
| [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | [`ConsistentP1TrackingMetric`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | Consistent P1 finite-element mass inner product for mode overlap. |
| [`crates/fullmag-runner/src/fem/eigen_equilibrium.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L388) | [`materialize_equilibrium`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L388) | Loads and validates static equilibrium m0 for modal linearization. |
| [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | [`build_owned_modal_certificate_v6_binding`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | Cryptographic V6 certificate binding equilibrium, mesh, and periodic seam maps. |
| [`backends/fem/core/petsc_slepc_runtime.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/core/petsc_slepc_runtime.cpp#L24) | [`petsc_slepc_process_mutex`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/core/petsc_slepc_runtime.cpp#L24) | Process-global mutex serializing in-process PETSc/SLEPc operations (ADR-0055). |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | [`solve_modal_eigen_contract`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | Native modal contract, validation and diagnostics. |
| [`backends/fem/include/frequency_domain/tangent_frame.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/tangent_frame.hpp#L38) | [`build_tangent_frame`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/tangent_frame.hpp#L38) | Constructs orthonormal nodal tangent basis (e1, e2, m0). |
| [`backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp#L38) | [`class LinearizedDynamicPencil`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp#L38) | Canonical linearized dynamic operator pencil L q = lambda B_alpha q. |
| [`backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp#L31) | [`assemble_real_frequency_rotated_pencil`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp#L31) | Assembles real-split rotated pencil R(L) y = omega R(i B_alpha) y. |
| [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | [`assemble_poisson_airbox_shared_domain`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | Assembles coupled magnetic-airbox block operators (A_qq, A_qphi, A_phiq, P). |
| [`backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | [`class FloquetReducedMagneticOperator`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | Bloch-reduced magnetic tangent operator across periodic boundary pairs. |
| [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | [`build_floquet_dynamic_demag_k_real_split`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | 3D Floquet k-dependent dynamic demagnetization operator. |
| [`backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | [`build_floquet_waveguide_demag_k_real_split`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | 2.5D waveguide shifted-gradient dynamic demagnetization operator. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | [`solve_poisson_airbox_modal_eigen_cpu_schur`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | Matrix-free MATSHELL Schur-complement shift-and-invert SLEPc eigensolver. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | [`evaluate_poisson_airbox_modal_residuals`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | Reconstructs scalar potential and evaluates full coupled descriptor residuals. |
| [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | [`floquet_shifted_true_convergence_test`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | Enforces true unpreconditioned residual gate inside shifted KSP solves. |
| [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L15) | [`solve_poisson_airbox_modal_eigen_gpu_device_krylov`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L15) | Device-resident CUDA Krylov modal eigensolver. |
| [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L22) | [`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L22) | Device-resident PETSc/SLEPc/hypre modal eigensolver. |

## Cross-links

* {doc}`index`
* {doc}`modal-validation`
* {doc}`/python-api/studies/eigenmodes`
* {doc}`/python-api/outputs/modes-and-spectra`
* {doc}`/python-api/outputs/dispersion-and-response`
* {doc}`/frontend/capability-register`
