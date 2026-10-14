---
title: Linearized LLG
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0600-fem-eigenmodes-linearized-llg.md and docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md
---

(public-docs-numerical-methods-eigensolvers-linearized-llg)=
# Linearized LLG eigensolver

(numerical-methods-eigensolver-linearized-llg-problem-statement)=
## Scope and purpose

The canonical nonlinear magnetization dynamics model is owned by
{doc}`../../physics/foundations/llg-equation`. This chapter documents the **linearized
Landau–Lifshitz–Gilbert (LLG) modal eigensolver** (`operator="linearized_llg"` and the companion
Herring–Kittel block formulation `operator="full_2x2"`): starting from a certified static
micromagnetic equilibrium $\mathbf m_0(\mathbf r)$, the solver projects small-amplitude
magnetization perturbations onto the local two-component tangent bundle $T_{\mathbf m_0}\mathbb S^2$,
couples them to the dynamic Maxwell-magnetostatic scalar potential $\delta\phi(\mathbf r)$ over the
shared magnetic-plus-airbox finite-element domain $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$,
and solves the resulting generalized operator eigenproblem for complex eigenvalues
$\lambda = \sigma + \mathrm i\omega$ and spatial eigenmodes $\delta\mathbf m(\mathbf r)$.

Unlike time-domain ringdown followed by discrete Fourier transforms, the modal eigensolver resolves
closely spaced or degenerate modes, extracts intrinsic modal damping rates $-\sigma$, tracks
continuous dispersion branches $\omega_n(\mathbf k)$ across Brillouin-zone paths (`KPath`) and static
bias-field sweeps (`BiasFieldSweep`), and certifies each mode with a scale-invariant coupled
descriptor residual. A modal run is reproducible only when the equilibrium state, operator family,
damping policy, dynamic demagnetization closure, boundary condition, spatial representation
(`full_3d` vs `waveguide_2p5d`), spectral transformation, and normalization convention are recorded
in provenance.

(numerical-methods-eigensolver-linearized-llg-governing-equations)=
## Scientific and numerical model

### 1. Equilibrium prerequisite and tangent-plane kinematics

Let $\Omega_m$ denote the magnetic subdomain and $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$ the
shared magnetic-plus-airbox finite-element domain. The static linearization state $\mathbf m_0(\mathbf r)$
must satisfy the pointwise unit-length and zero-torque conditions in $\Omega_m$:

```{math}
:label: eq-numerical-linearized-llg-equilibrium
|\mathbf m_0(\mathbf r)| = 1,
\qquad
\mathbf m_0(\mathbf r)\times\mathbf H_{\mathrm{eff}}[\mathbf m_0](\mathbf r) = \mathbf 0,
\qquad
\mathbf H_{\mathrm{eff}}[\mathbf m_0] = H_0(\mathbf r)\,\mathbf m_0(\mathbf r),
```

where $H_0(\mathbf r) = \mathbf m_0(\mathbf r)\cdot\mathbf H_{\mathrm{eff}}[\mathbf m_0](\mathbf r)$
is the scalar equilibrium internal-field projection along $\mathbf m_0$. Expanding the time-dependent
unit magnetization around $\mathbf m_0(\mathbf r)$ with the canonical Fullmag temporal phase
convention $\exp(+\mathrm i\omega t)$ gives

```{math}
:label: eq-numerical-linearized-llg-tangent
\mathbf m(\mathbf r, t)
= \mathbf m_0(\mathbf r) + \delta\mathbf m(\mathbf r, t) + \mathcal O\!\left(\|\delta\mathbf m\|^2\right),
\qquad
\mathbf m_0\cdot\delta\mathbf m = 0,
\qquad
\delta\mathbf m = \mathbf e_1 q_1 + \mathbf e_2 q_2 = T\mathbf q.
```

At each magnetic node $i \in \{1,\dots,N_{\mathrm{mag}}\}$, `build_tangent_frame` constructs a
right-handed orthonormal triad $(\mathbf e_{1,i}, \mathbf e_{2,i}, \mathbf m_{0,i})$ satisfying
$\mathbf e_{1,i}\times\mathbf e_{2,i} = \mathbf m_{0,i}$. Stacking the nodal $3\times 2$ blocks
$T_i = [\mathbf e_{1,i},\,\mathbf e_{2,i}] \in \mathbb R^{3\times 2}$ forms the global prolongation
matrix $T \in \mathbb R^{3N_{\mathrm{mag}}\times 2N_{\mathrm{mag}}}$ satisfying
$T^{\mathsf T}T = I_{2N_{\mathrm{mag}}}$ and
$T T^{\mathsf T} = I_{3N_{\mathrm{mag}}} - \mathbf m_0\mathbf m_0^{\mathsf T}$. In the local tangent
basis, the cross-product operator $\mathbf m_{0,i}\times(\cdot)$ acts as the canonical $2\times 2$
symplectic skew-symmetric matrix $J$:

```{math}
:label: eq-numerical-linearized-llg-symplectic
J_2 =
\begin{bmatrix}
0 & -1 \\
1 & 0
\end{bmatrix},
\qquad
J = \operatorname{diag}_{i=1}^{N_{\mathrm{mag}}}(J_2),
\qquad
J^{\mathsf T} = -J,
\qquad
J^2 = -I_{2N_{\mathrm{mag}}}.
```

### 2. Linearization of the effective field and energy Hessian

Let $\mathcal H[\mathbf m] = -\mu_0 M_s\,\mathcal D\mathbf H_{\mathrm{eff}}[\mathbf m_0]$ denote the
self-adjoint magnetic energy Hessian of the enabled conservative interactions (bulk exchange,
magnetocrystalline anisotropy, bulk/interfacial Dzyaloshinskii–Moriya interaction, and static Zeeman
stiffness). Restricted to the tangent bundle via $T$, the local magnetic stiffness combines the
projected Fréchet derivative of $\mathbf H_{\mathrm{eff}}$ and the equilibrium internal-field shift
$H_0(\mathbf r) I_2$:

```{math}
:label: eq-numerical-linearized-llg-hessian
\delta\mathbf H_{\mathrm{eff}}(\mathbf q, \delta\phi)
= -C_{\mathrm{mag}}\,T\mathbf q - \nabla\delta\phi,
\qquad
A_{\mathrm{loc}}
= T^{\mathsf T} C_{\mathrm{mag}} T + H_0 I_{2N_{\mathrm{mag}}},
```

where $C_{\mathrm{mag}}$ is the discrete conservative field-stiffness operator assembled over
finite-element degrees of freedom, and $-\nabla\delta\phi$ is the dynamic magnetostatic field when
`include_demag=True`.

### 3. Canonical operator dictionary: state-space, gyrotropic, and rotated real-split pencils

Linearizing the Gilbert form of the LLG equation
$\partial_t\mathbf m + \alpha\,\mathbf m\times\partial_t\mathbf m = -\gamma_0\,\mathbf m\times\mathbf H_{\mathrm{eff}}(\mathbf m)$
around $\mathbf m_0$ and projecting with $T^{\mathsf T}$ yields the generalized tangent eigenproblem:

```{math}
:label: eq-numerical-linearized-llg-pencil
\mathsf K\mathbf q = \lambda\mathsf G\mathbf q,
\qquad
\lambda = \sigma + \mathrm i\omega,
\qquad
f = \frac{|\omega|}{2\pi}.
```

Fullmag's native operator contract (`LinearizedDynamicPencil`) maintains an exact algebraic
dictionary between three representations of this problem:

**Direct tangent operator pencil**:

```{math}
:label: eq-numerical-linearized-llg-operator-pencil
L\mathbf q = \lambda B_\alpha\mathbf q,
\qquad
L = -\gamma_0 J A_{\mathrm{tot}},
\qquad
B_\alpha = I_{2N_{\mathrm{mag}}} + \alpha_{\mathrm{eff}} J,
```

where $\gamma_0 = \mu_0|\gamma|$, $A_{\mathrm{tot}}$ includes both local stiffness $A_{\mathrm{loc}}$
and the eliminated dynamic demagnetization operator, and $\alpha_{\mathrm{eff}} = 0$ when
`damping_policy="ignore"` or $\alpha_{\mathrm{eff}} = \alpha$ when `damping_policy="include"`. Under
the $\exp(+\mathrm i\omega t)$ convention, $\lambda = \sigma + \mathrm i\omega$ has oscillation
frequency $f = |\omega|/(2\pi)$ and modal damping rate $-\sigma \ge 0$ for passive media. When
$\alpha_{\mathrm{eff}} = 0$, multiplying by $J^{\mathsf T}\mathsf M$ (with tangent mass matrix
$\mathsf M$) yields the Hermitian energy-Hessian gyrotropic form
$\mathsf K\mathbf q = -\mathrm i\omega\mathsf G\mathbf q$ with $\mathsf K = \gamma_0\mathsf M A_{\mathrm{tot}}$
and $\mathsf G = \mathsf M J$.

**Real-split rotated SLEPc pencil**: Because production Linux containers link real-scalar
`libpetsc-real-dev` and `libslepc-real-dev`, Fullmag embeds any complex matrix
$C = C_r + \mathrm i C_i \in \mathbb C^{n\times n}$ into its real $2n\times 2n$ block representation
$R(C)$ and divides $L\mathbf q = \mathrm i\omega B_\alpha\mathbf q$ by $\mathrm i$
(`assemble_real_frequency_rotated_pencil`):

```{math}
:label: eq-numerical-linearized-llg-real-split
R(C) =
\begin{bmatrix}
\operatorname{Re} C & -\operatorname{Im} C \\
\operatorname{Im} C & \operatorname{Re} C
\end{bmatrix},
\qquad
R(L)\,y = \omega\,R(\mathrm i B_\alpha)\,y,
\qquad
y =
\begin{bmatrix}
\operatorname{Re}\mathbf q \\
\operatorname{Im}\mathbf q
\end{bmatrix}.
```

In this rotated real-split coordinate system, an undamped physical mode with real circular frequency
$\omega = 2\pi f > 0$ has a **purely real eigenvalue** $\omega \in \mathbb R$, allowing SLEPc's real
shift-and-invert spectral transformation (`STSINVERT`) to target interior frequencies directly with a
real shift $\tau = 2\pi f_{\mathrm{target}}$. Each complex mode produces a conjugate-paired doublet
in the $2n$-dimensional real space, which is deduplicated and certified in complex coordinates before
publication.

### 4. Coupled magnetostatic descriptor and Schur-complement reduction

When `include_demag=True`, the dynamic scalar potential $\delta\phi \in H^1(\Omega)$ satisfies
$\nabla\cdot(\nabla\delta\phi - M_s T\mathbf q\,\mathbb 1_{\Omega_m}) = 0$ across the shared
magnetic-plus-airbox finite-element mesh $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$ (with Robin,
Dirichlet, or pure-Neumann + zero-mean gauge closure on $\partial\Omega$). Assembling the
finite-element weak form yields the coupled block descriptor eigenproblem and its magnetic
Schur-complement reduction:

```{math}
:label: eq-numerical-linearized-llg-schur
\begin{bmatrix}
A_{qq} & A_{q\phi} \\
A_{\phi q} & P
\end{bmatrix}
\begin{bmatrix}
\mathbf q \\
\boldsymbol\phi
\end{bmatrix}
=
\lambda
\begin{bmatrix}
B_{qq} & 0 \\
0 & 0
\end{bmatrix}
\begin{bmatrix}
\mathbf q \\
\boldsymbol\phi
\end{bmatrix},
\qquad
S(\tau)\,\mathbf q
= \left(A_{qq} - A_{q\phi} P^{-1} A_{\phi q} - \tau B_{qq}\right)\mathbf q.
```

Once SLEPc converges on $(\lambda_n, \mathbf q_n)$, the scalar potential is reconstructed as
$\boldsymbol\phi_n = -P^{-1} A_{\phi q}\mathbf q_n$ and the **full coupled descriptor residual**
$(r_q, r_\phi)$ is evaluated (`evaluate_poisson_airbox_modal_residuals`):

```{math}
:label: eq-numerical-linearized-llg-coupled-residual
r_{q,n} = A_{qq}\mathbf q_n + A_{q\phi}\boldsymbol\phi_n - \lambda_n B_{qq}\mathbf q_n,
\qquad
r_{\phi,n} = A_{\phi q}\mathbf q_n + P\boldsymbol\phi_n,
\qquad
\varepsilon_{\mathrm{eig},n}
= \frac{\sqrt{\|r_{q,n}\|_2^2 + \|r_{\phi,n}\|_2^2}}
{\|A_{qq}\mathbf q_n + A_{q\phi}\boldsymbol\phi_n\|_2 + |\lambda_n|\,\|B_{qq}\mathbf q_n\|_2}.
```

### 5. Bloch/Floquet wave vectors, 2.5D waveguides, and shifted-KSP true convergence

For periodic lattices (`FloquetBC` / `PeriodicBC`) with wave vector $\mathbf k \in \mathbb R^3$,
degrees of freedom on periodic slave boundaries are related to master degrees of freedom across a
lattice translation $\Delta\mathbf r$ by the Bloch phase factor, while
`spatial_representation="waveguide_2p5d"` replaces axial meshing by the shifted differential
operator $D_{\mathbf k}$:

```{math}
:label: eq-numerical-linearized-llg-bloch-waveguide
\mathbf q_{\mathrm{slave}}
= \exp\!\left(-\mathrm i\mathbf k\cdot\Delta\mathbf r\right)\mathbf q_{\mathrm{master}},
\qquad
D_{\mathbf k} = \nabla_\perp - \mathrm i k\,\hat{\mathbf e}_\parallel.
```

During shift-and-invert iterations at shift $\tau$, every inner linear solve
$A_\tau x_\tau = b_\tau$ is gated by `floquet_shifted_true_convergence_test`, which verifies the
**unpreconditioned true residual**:

```{math}
:label: eq-numerical-linearized-llg-ksp-gate
\left\|b_\tau - A_\tau x_\tau\right\|_2
\le \max\!\left(\mathrm{atol}_{\mathrm{ksp}},\,\mathrm{rtol}_{\mathrm{ksp}}\,\|b_\tau\|_2\right).
```

### 6. Mass-weighted Hungarian mode tracking and degenerate subspace transport

Across a discrete parameter sequence $s \in \{0, 1, \dots, N_s - 1\}$ (`KPath` or `BiasFieldSweep`),
`track_branches` matches modes between adjacent steps $s$ and $s+1$ using the consistent $P_1$
finite-element mass matrix $M$ (`ConsistentP1TrackingMetric`) and transports nearly degenerate
subspaces via SVD principal angles and unitary Procrustes rotation (`mass_weighted_subspace_transport`):

```{math}
:label: eq-numerical-linearized-llg-tracking
\mathcal O_{ab}^{(s\to s+1)}
= \frac{\left|v_{s,a}^\ast M v_{s+1,b}\right|}
{\sqrt{v_{s,a}^\ast M v_{s,a}}\,\sqrt{v_{s+1,b}^\ast M v_{s+1,b}}},
\qquad
C = U^\ast M V = P\Sigma Q^\ast,
\qquad
s_{\mathrm{sub}} = \min_j \sigma_j(C),
\qquad
R_{\mathrm{sub}} = Q P^\ast.
```

(numerical-methods-eigensolver-linearized-llg-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | unit magnetization | $1$ |
| $\mathbf m_0$ | equilibrium magnetization | $1$ |
| $\delta\mathbf m$ | first-order magnetization perturbation | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | total effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $H_0$ | equilibrium effective-field projection along $\mathbf m_0$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf e_1,\mathbf e_2$ | local tangent basis | $1$ |
| $q_1,q_2$ | tangent perturbation amplitudes | $1$ |
| $T$ | global tangent-frame prolongation matrix | $1$ |
| $J, J_2$ | tangent-plane symplectic skew-symmetric operator and nodal $2\times 2$ block | $1$ |
| $C_{\mathrm{mag}}$ | conservative tangent field-stiffness operator | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{loc}}, A_{\mathrm{tot}}$ | local and total tangent magnetic stiffness operators | $\mathrm{A\,m^{-1}}$ |
| $\delta\phi, \boldsymbol\phi$ | continuous and discrete dynamic magnetostatic scalar potential | $\mathrm{A}$ |
| $\mathsf K$ | tangent stiffness/dynamic matrix | problem-dependent |
| $\mathsf G$ | gyrotropic mass/operator matrix | problem-dependent |
| $\mathbf q$ | discrete tangent eigenvector | $1$ |
| $\lambda$ | complex eigenvalue | $\mathrm{s^{-1}}$ |
| $\sigma$ | modal growth/decay real part | $\mathrm{s^{-1}}$ |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $f$ | eigenfrequency | $\mathrm{Hz}$ |
| $\gamma_0$ | rescaled gyromagnetic prefactor $\mu_0|\gamma|$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha_{\mathrm{eff}}$ | effective Gilbert damping parameter in modal operator | $1$ |
| $L, B_\alpha$ | canonical linearized dynamic operator and damping-modified right-hand operator | $\mathrm{s^{-1}}$, $1$ |
| $R(C), y$ | real $2\times 2$ block embedding of complex operator $C$ and stacked real-imaginary state vector | problem-dependent, $1$ |
| $A_{qq}, A_{q\phi}, A_{\phi q}, P, B_{qq}$ | coupled magnetostatic descriptor blocks (magnetic, gradient, divergence, Poisson Laplacian, mass) | problem-dependent |
| $S(\tau), \tau$ | magnetostatic Schur-complement matrix at spectral shift $\tau$ | problem-dependent, $\mathrm{rad\,s^{-1}}$ |
| $r_{q,n}, r_{\phi,n}, \varepsilon_{\mathrm{eig},n}$ | magnetic block residual, Poisson block residual, and relative coupled eigenpair residual | problem-dependent, $1$ |
| $\mathbf k, k, \Delta\mathbf r, D_{\mathbf k}$ | Bloch wave vector, axial wave number, lattice translation vector, and 2.5D shifted gradient | $\mathrm{rad\,m^{-1}}$, $\mathrm{rad\,m^{-1}}$, $\mathrm{m}$, $\mathrm{m^{-1}}$ |
| $A_\tau, x_\tau, b_\tau, \mathrm{atol}_{\mathrm{ksp}}, \mathrm{rtol}_{\mathrm{ksp}}$ | shifted inner linear system matrix, solution, right-hand side, and KSP true-residual tolerances | problem-dependent, $1$ |
| $M, \mathcal O_{ab}^{(s\to s+1)}$ | consistent $P_1$ finite-element mass matrix and inter-step mode overlap | $\mathrm{m^3}$, $1$ |
| $C, U, V, P, \Sigma, Q, s_{\mathrm{sub}}, R_{\mathrm{sub}}$ | degenerate-subspace cross-gramian, basis matrices, SVD factors, minimum principal-angle cosine, and Procrustes transport matrix | $1$ |

(numerical-methods-eigensolver-linearized-llg-assumptions-and-validity)=
## Assumptions and validity

| Choice | Mathematical meaning | What it does not mean |
|---|---|---|
| `equilibrium_source="relax"` | Consumes the converged magnetization $\mathbf m_0$ from the preceding `relax` stage after verifying `tolT` via `accepted_relax_handoff_for_eigen_stage`. | It does not accept a transient state that stopped only because `max_steps` was exhausted. |
| `operator="linearized_llg"` vs `"full_2x2"` | Selects between the canonical projected tangent operator and the explicit $2\times 2$ Herring–Kittel nodal block assembly. | Neither operator predicts nonlinear finite-amplitude saturation, foldover, or suhl instability. |
| `damping_policy="ignore"` vs `"include"` | Sets $\alpha_{\mathrm{eff}}=0$ (conservative gyrotropic spectrum) or $\alpha_{\mathrm{eff}}=\alpha$ (complex damped spectrum). | Results from `"ignore"` and `"include"` are distinct eigenproblems and cannot be compared as CPU/GPU parity runs. |
| `include_demag=True` | Couples tangent magnetization $\mathbf q$ to the dynamic Poisson potential $\boldsymbol\phi$ on the shared magnetic-plus-airbox mesh. | Omitting `include_demag` drops dynamic dipolar restoring fields while keeping static equilibrium demagnetization only if present in $\mathbf m_0$. |
| `spatial_representation="waveguide_2p5d"` | Replaces axial meshing by the exact shifted gradient $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf e}_\parallel$ on a cross-sectional mesh. | It is valid only when the geometry, material, and equilibrium $\mathbf m_0$ are translationally invariant along the propagation axis. |
| `normalization="unit_l2"` vs `"unit_max_amplitude"` | Fixes the arbitrary complex scaling of linear eigenvectors after tangent reconstruction. | Neither normalization assigns a physical thermal or driven oscillation amplitude in radians or $\mathrm{A\,m^{-1}}$. |

(numerical-methods-eigensolver-linearized-llg-python-api)=
## Python API

### Executable stage workflow

The multi-cell workflow below declares the shared magnetic-plus-airbox universe, thin-film geometry,
Robin Poisson demagnetization, nonlinear-CG equilibrium relaxation stage, and linearized-LLG modal
dispersion stage with `KPath`, `ModeTracking`, `FemEigenSolverPolicy`, and modal outputs.

```python
# %% Imports and FEM modal study setup
import fullmag as fm

nm = 1.0e-9
study = fm.study("linearized_llg_modes")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Shared magnetic-plus-air domain and magnetic film geometry
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

# %% Interactions and static equilibrium relaxation stage
study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=2000,
)

# %% Linearized-LLG modal and k-path dispersion stage
study.stages.add_eigenmodes(
    stage_id="eigen_dispersion",
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
            fm.KPoint("X", (1.5e7, 0.0, 0.0)),
        ],
        samples_per_segment=[6],
    ),
    solver_rtol=1.0e-8,
    solver_max_outer_iterations=400,
    solver_max_linear_iterations=200,
)
```

## Parameters

### `EigenmodesStageSpec` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `EigenmodesStageSpec.count` | `int` | `10` | $1$ | positive integer | number of modes | FEM planner | `study.count` |
| `EigenmodesStageSpec.target` | `str` | `lowest` | $1$ | `lowest`, `nearest`, or `frequency_window` | spectral target policy | FEM planner | `study.target` |
| `EigenmodesStageSpec.target_frequency` | `float | None` | `None` | $\mathrm{Hz}$ | required for `nearest` | shift target | FEM modal lane | `study.target_frequency` |
| `EigenmodesStageSpec.frequency_min` | `float | None` | `None` | $\mathrm{Hz}$ | required with window | lower window bound | FEM modal lane | `study.frequency_min` |
| `EigenmodesStageSpec.frequency_max` | `float | None` | `None` | $\mathrm{Hz}$ | greater than `frequency_min` | upper window bound | FEM modal lane | `study.frequency_max` |
| `EigenmodesStageSpec.operator` | `str` | `linearized_llg` | $1$ | `linearized_llg` or `full_2x2` | dynamic operator family | FEM | `study.operator` |
| `EigenmodesStageSpec.include_demag` | `bool` | `True` | $1$ | Boolean | include demagnetization | FEM | `study.include_demag` |
| `EigenmodesStageSpec.equilibrium_source` | `str` | `relax` | $1$ | `relax`, `provided`, or `artifact` | equilibrium source | planner | `study.equilibrium_source` |
| `EigenmodesStageSpec.equilibrium_artifact` | `str | None` | `None` | $1$ | required for `artifact` | equilibrium artifact path | planner | `study.equilibrium_artifact` |
| `EigenmodesStageSpec.normalization` | `str` | `unit_l2` | $1$ | `unit_l2` or `unit_max_amplitude` | mode normalization | FEM | `study.normalization` |
| `EigenmodesStageSpec.damping_policy` | `str` | `ignore` | $1$ | `ignore` or `include` | damping in the linearized operator | FEM modal lane | `study.damping_policy` |
| `EigenmodesStageSpec.k_vector` | `tuple[float,float,float] | None` | `None` | $\mathrm{rad\,m^{-1}}$ | finite three-vector | Bloch wave vector | FEM periodic/Floquet lane | `study.k_vector` |
| `EigenmodesStageSpec.k_sampling` | `object | None` | `None` | $1$ | `KPoint` or `KPath` schema | dispersion sampling | FEM modal lane | `study.k_sampling` |
| `EigenmodesStageSpec.bias_field_sweep` | `BiasFieldSweep | None` | `None` | $1$ | non-empty finite field list | static bias-field sweep | FEM modal lane | `study.bias_field_sweep` |
| `EigenmodesStageSpec.mode_tracking` | `ModeTracking | None` | `None` | $1$ | validated tracking schema | mass-weighted branch tracking | FEM modal runner | `study.mode_tracking` |
| `EigenmodesStageSpec.bc` | `str | dict[str,object]` | `free` | $1$ | `free`, `pinned`, `PeriodicBC`, or `FloquetBC` | spin-wave boundary policy | FEM | `study.spin_wave_bc` |
| `EigenmodesStageSpec.spatial_representation` | `str` | `full_3d` | $1$ | `full_3d` or `waveguide_2p5d` | spatial operator geometry | FEM modal lane | `study.spatial_representation` |
| `EigenmodesStageSpec.fem_solver_policy` | `FemEigenSolverPolicy | None` | `None` | $1$ | validated solver policy | native eigensolver configuration | FEM modal lane | `study.fem_solver_policy` |

### `FemEigenSolverPolicy` and `ModeTracking` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FemEigenSolverPolicy.backend` | `str` | `auto` | $1$ | `auto`, `slepc_shift_invert_schur`, `slepc`, `lobpcg_reference`, or `dense_reference` | native eigensolver backend | FEM modal lane | `study.fem_solver_policy.backend` |
| `FemEigenSolverPolicy.subspace_dimension` | `int | None` | `None` | $1$ | integer $\ge 2$ and $\ge \mathrm{count}$ | Krylov/Arnoldi subspace dimension | FEM modal lane | `study.fem_solver_policy.subspace_dimension` |
| `FemEigenSolverPolicy.max_iterations` | `int` | `200` | $1$ | positive integer | maximum outer eigensolver iterations | FEM modal lane | `study.fem_solver_policy.max_iterations` |
| `FemEigenSolverPolicy.tolerance` | `float` | `1e-8` | $1$ | finite float $> 0$ | relative residual convergence tolerance | FEM modal lane | `study.fem_solver_policy.tolerance` |
| `FemEigenSolverPolicy.shift_Hz` | `float | None` | `None` | $\mathrm{Hz}$ | finite float $\ge 0$ | explicit spectral shift frequency | FEM shift-invert lane | `study.fem_solver_policy.shift_hz` |
| `FemEigenSolverPolicy.target_spectrum` | `str` | `smallest_magnitude` | $1$ | `smallest_magnitude` or `target_magnitude` | SLEPc spectral ordering target | FEM modal lane | `study.fem_solver_policy.target_spectrum` |
| `ModeTracking.method` | `str` | `overlap_hungarian` | $1$ | `overlap_hungarian` | branch assignment algorithm | FEM modal runner | `study.mode_tracking.method` |
| `ModeTracking.min_overlap` | `float` | `0.5` | $1$ | finite float in $(0, 1]$ | minimum mass-weighted overlap threshold | FEM modal runner | `study.mode_tracking.min_overlap` |
| `ModeTracking.degeneracy_tolerance` | `float` | `1e6` | $\mathrm{Hz}$ | finite float $> 0$ | frequency window for degenerate subspace grouping | FEM modal runner | `study.mode_tracking.degeneracy_tolerance` |

(numerical-methods-eigensolver-linearized-llg-problem-ir)=
## ProblemIR and provenance

The stage lowers to `StudyIR::Eigenmodes` (`"kind": "eigenmodes"`) inside `ProblemIR`:

```json
{
  "study": {
    "kind": "eigenmodes",
    "count": 12,
    "target": "lowest",
    "target_frequency": null,
    "frequency_min": null,
    "frequency_max": null,
    "operator": "linearized_llg",
    "include_demag": true,
    "equilibrium_source": "relax",
    "equilibrium_artifact": null,
    "normalization": "unit_l2",
    "damping_policy": "ignore",
    "k_vector": [0.0, 0.0, 0.0],
    "k_sampling": {
      "kind": "path",
      "nodes": [
        [0.0, 0.0, 0.0],
        [15000000.0, 0.0, 0.0]
      ],
      "samples_per_segment": 6,
      "labels": ["Gamma", "X"]
    },
    "bias_field_sweep": null,
    "mode_tracking": {
      "enabled": true,
      "method": "overlap_hungarian",
      "min_overlap": 0.6,
      "degeneracy_tolerance": 1000000.0
    },
    "spin_wave_bc": {
      "kind": "free"
    },
    "spatial_representation": "full_3d",
    "fem_solver_policy": {
      "backend": "auto",
      "subspace_dimension": 36,
      "max_iterations": 400,
      "tolerance": 1e-8,
      "shift_hz": null,
      "target_spectrum": "smallest_magnitude"
    },
    "sampling": {
      "outputs": [
        {"kind": "eigen_spectrum", "scope": "all_samples"},
        {"kind": "eigen_mode", "modes": [0, 1, 2], "include_potential": true},
        {"kind": "dispersion_curve", "track_modes": true},
        {"kind": "eigen_diagnostics"}
      ]
    }
  }
}
```

`plan_fem_eigen` lowers `StudyIR::Eigenmodes` into `FemEigenPlanIR` (`crates/fullmag-ir/src/plan.rs`).
Provenance records the equilibrium source and V6 certificate digest (`OwnedModalCertificateV6Binding`),
resolved FEM device and precision, `ProcessPoolReportV1` worker telemetry, tangent DOF count,
spectral shift $\tau$, KSP true-residual diagnostics, and published artifacts (`eigen/spectrum.v2.json`,
`eigen/branches.v2.json`, `eigen/dispersion.csv`, and `frequency_domain/manifest.v1.json`).

(numerical-methods-eigensolver-linearized-llg-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Script export preserves stage order and all modal parameters. The **requested intent** and the
**resolved execution** are recorded separately in provenance, including **validation errors** and
dependency availability. Planner capability resolution rejects **unsupported combinations** before
expensive matrix assembly:

- Invalid target windows (`frequency_max <= frequency_min`), missing `target_frequency` for
  `nearest`, or missing `equilibrium_artifact` for `artifact` raise immediate validation errors.
- `accepted_relax_handoff_for_eigen_stage` rejects an `equilibrium_source="relax"` handoff if the
  preceding relaxation stage stopped on `max_steps` without satisfying its torque criterion.
- Requesting FDM modal execution or an unqualified FEM GPU operator/Floquet configuration fails
  closed; no silent fallback to FEM CPU or to a toy dense solver is permitted.
- Inner shift-and-invert KSP solves that violate `floquet_shifted_true_convergence_test` or return
  fewer converged modes than `count` fail closed with explicit solver diagnostics.

(numerical-methods-eigensolver-linearized-llg-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | `source-backed` | Shared-domain Poisson-airbox `MATSHELL` Schur complement (`slepc_shift_invert_schur`), real-split rotated SLEPc pencil, full 3D Bloch/Floquet and 2.5D waveguide operators, multi-process `EigenKProcessPool`, and `dense_reference` / `lobpcg_reference` |
| FEM | GPU | `partial` | Device-resident CUDA Krylov (`solve_poisson_airbox_modal_eigen_gpu_device_krylov`) and PETSc/SLEPc/hypre (`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`) for qualified $\Gamma$-point and shared-domain configurations |
| FDM | CPU | `unsupported` | Planner rejects FDM modal requests; no production FDM eigensolver lane is claimed |
| FDM | GPU | `unsupported` | Planner rejects CUDA FDM modal requests; no public CUDA FDM modal lane is claimed |

### 8.1 Ordered execution sequence and process-pool orchestration

The FEM modal execution lifecycle is strictly ordered:

1. **Equilibrium certification**: `materialize_equilibrium` loads or receives $\mathbf m_0$,
   verifies $|\mathbf m_{0,i}|=1$ and the static torque bound, and binds the V6 modal certificate
   (`build_owned_modal_certificate_v6_binding`).
2. **Tangent-frame construction**: `build_tangent_frame` builds the orthonormal nodal basis
   $(\mathbf e_{1,i}, \mathbf e_{2,i}, \mathbf m_{0,i})$ and prolongation operator $T$.
3. **$\Gamma$-point vs Floquet classification**: `plan_fem_eigen` classifies $\mathbf k$ against
   `FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M` ($10^{-12}\,\mathrm{rad\,m^{-1}}$) componentwise.
4. **Process-pool dispatch**: For multi-sample `KPath` dispersion solves, `EigenKProcessPool`
   spawns isolated worker processes (`execute_request` in `eigen_k_worker.rs`) with bounded thread
   budgets so each worker owns a private PETSc/SLEPc runtime; in-process calls acquire
   `petsc_slepc_process_mutex`.
5. **Coupled block assembly**: `assemble_poisson_airbox_shared_domain` (or the Floquet/waveguide
   assemblers) builds $(A_{qq}, A_{q\phi}, A_{\phi q}, P, B_{qq})$.
6. **Spectral transformation & solve**: SLEPc shift-and-invert (`STSINVERT`) solves the Schur
   complement $S(\tau)\mathbf q = \mathbf 0$ or real-split rotated pencil $R(L)y = \omega R(\mathrm i B_\alpha)y$,
   guarded at each inner KSP step by `floquet_shifted_true_convergence_test`.
7. **Potential recovery & residual certification**: Reconstructs $\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$
   and evaluates coupled residuals $(r_{q,n}, r_{\phi,n})$ via `evaluate_poisson_airbox_modal_residuals`.
8. **3D reconstruction & normalization**: Lifts $\delta\mathbf m_n = T\mathbf q_n$, applies
   `unit_l2` or `unit_max_amplitude` normalization and canonical phase gauge.
9. **Branch tracking & publication**: `track_branches` and `mass_weighted_subspace_transport`
   connect branches across $\mathbf k$ or $\mathbf H$ samples and write `spectrum.v2.json`,
   `branches.v2.json`, `dispersion.csv`, and binary mode fields.

### 8.2 FEM CPU

The production FEM CPU path (`solve_poisson_airbox_modal_eigen_cpu_schur`) uses a matrix-free PETSc
`MATSHELL` wrapper around the magnetostatic Schur complement $A_{qq} - A_{q\phi}P^{-1}A_{\phi q}$
combined with a cached sparse factorization of the scalar Poisson matrix $P$. For finite-$\mathbf k$
periodic structures, `FloquetReducedMagneticOperator` and `build_floquet_dynamic_demag_k_real_split`
apply the exact Bloch phase across periodic seam pairs, while `build_floquet_waveguide_demag_k_real_split`
realizes the 2.5D cross-sectional waveguide operator. Small reference problems may also explicitly
select `dense_reference` or `lobpcg_reference` via `FemEigenSolverPolicy.backend`.

### 8.3 FEM GPU

The FEM GPU modal lane provides two native engines declared in `modal_gpu_krylov.hpp`:
`solve_poisson_airbox_modal_eigen_gpu_device_krylov` (which uploads the CSR blocks once and runs
device-resident Krylov/inverse-iteration with device Poisson solves) and
`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` (where SLEPc owns the device-resident Krylov
subspace and hypre BoomerAMG preconditions the scalar Poisson block on the GPU). GPU execution
requires runtime device-residency verification and does not silently fall back to CPU.

(numerical-methods-eigensolver-linearized-llg-implementation-mapping)=
## Where this is implemented

All source links below point to the reviewed revision `5e99782acbb7fb3f65d0cad872e102bf67733103`.

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python stage schema | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | `class EigenmodesStageSpec` | Validates stage-first modal parameters | Python |
| Python stage builder | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3224) | `eigenmodes_stage` | Constructs ordered `eigenmodes` stage | Python/IR |
| Python study class | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | `class Eigenmodes` | Canonical Python `Eigenmodes` model and `.to_ir()` | Python/IR |
| Python solver policy | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | `class FemEigenSolverPolicy` | Explicit FEM eigensolver backend, shift, and Krylov settings | Python/IR |
| Python $\mathbf k$-path | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | `class KPath` | Piecewise-linear Brillouin-zone wave-vector path | Python/IR |
| Python field sweep | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L65) | `class BiasFieldSweep` | Static external bias-field sweep specification | Python/IR |
| Python mode tracking | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L408) | `class ModeTracking` | Mass-weighted Hungarian and degeneracy tracking policy | Python/IR |
| IR operator & target | [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study.rs#L1397) | `EigenOperatorIR` | Canonical operator enum (`LinearizedLlg`, `Full2x2`) | ProblemIR |
| IR spatial representation | [`crates/fullmag-ir/src/study_v04.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study_v04.rs#L21) | `SpatialRepresentationIR` | `Full3d` vs `Waveguide2p5d` representation | ProblemIR |
| FEM modal plan IR | [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/plan.rs#L1807) | `FemEigenPlanIR` | Resolved FEM modal execution plan | Planner |
| FEM modal planner | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | `plan_fem_eigen` | Capability validation and `FemEigenPlanIR` construction | Planner |
| $\Gamma$-point tolerance | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L1319) | `FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M` | Componentwise $\Gamma$-point threshold ($10^{-12}\,\mathrm{rad\,m^{-1}}$) | Planner |
| Stage R4 handoff | [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-cli/src/orchestrator.rs#L2947) | `accepted_relax_handoff_for_eigen_stage` | Enforces converged relaxation handoff into modal stage | CLI/Runner |
| Path orchestrator | [`crates/fullmag-runner/src/eigen/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/orchestrator.rs#L82) | `run_path_or_single_controlled` | Orchestrates single-$\mathbf k$ and multi-point `KPath` execution | Runner |
| $\mathbf k$-process pool | [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | `EigenKProcessPool` | Multi-process worker pool isolating PETSc/SLEPc state | Runner |
| Branch tracking | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | `track_branches` | Mass-weighted Hungarian mode matching | Runner |
| Subspace transport | [`crates/fullmag-runner/src/eigen/tracking_subspace.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | `mass_weighted_subspace_transport` | SVD principal-angle and Procrustes degenerate transport | Runner |
| $P_1$ mass metric | [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | `ConsistentP1TrackingMetric` | Consistent $P_1$ finite-element overlap metric | Runner |
| Equilibrium materializer | [`crates/fullmag-runner/src/fem/eigen_equilibrium.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L388) | `materialize_equilibrium` | Loads and verifies static equilibrium $\mathbf m_0$ | Runner |
| V6 modal certificate | [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | `build_owned_modal_certificate_v6_binding` | Cryptographic V6 binding of mesh, seam maps, and $\mathbf m_0$ | Runner |
| PETSc/SLEPc mutex | [`backends/fem/core/petsc_slepc_runtime.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/core/petsc_slepc_runtime.cpp#L24) | `petsc_slepc_process_mutex` | Process-wide PETSc/SLEPc serialization mutex (ADR-0055) | FEM Core |
| Native modal contract | [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | `solve_modal_eigen_contract` | Primary C++ FEM modal contract and diagnostics | FEM CPU/GPU |
| Tangent basis | [`backends/fem/include/frequency_domain/tangent_frame.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/tangent_frame.hpp#L38) | `build_tangent_frame` | Nodal orthonormal tangent basis $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$ | FEM CPU/GPU |
| Dynamic pencil | [`backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp#L38) | `class LinearizedDynamicPencil` | Canonical operator pencil $L\mathbf q = \lambda B_\alpha\mathbf q$ | FEM CPU/GPU |
| Rotated real pencil | [`backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp#L31) | `assemble_real_frequency_rotated_pencil` | Real-split rotated pencil $R(L)y = \omega R(\mathrm i B_\alpha)y$ | FEM CPU |
| Shared-domain blocks | [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | `assemble_poisson_airbox_shared_domain` | Assembles coupled blocks $(A_{qq}, A_{q\phi}, A_{\phi q}, P)$ | FEM CPU |
| Floquet magnetic op | [`backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | `class FloquetReducedMagneticOperator` | Bloch-reduced magnetic operator on periodic seams | FEM CPU |
| Floquet 3D demag | [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | `build_floquet_dynamic_demag_k_real_split` | 3D Floquet dynamic demagnetization Schur operator | FEM CPU |
| Waveguide 2.5D demag | [`backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | `build_floquet_waveguide_demag_k_real_split` | 2.5D waveguide shifted-gradient demagnetization operator | FEM CPU |
| CPU Schur SLEPc | [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | `solve_poisson_airbox_modal_eigen_cpu_schur` | Matrix-free `MATSHELL` Schur-complement SLEPc eigensolver | FEM CPU |
| Coupled residuals | [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | `evaluate_poisson_airbox_modal_residuals` | Reconstructs $\boldsymbol\phi$ and evaluates coupled residual $(r_q, r_\phi)$ | FEM CPU |
| Shifted-KSP gate | [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | `floquet_shifted_true_convergence_test` | True unpreconditioned residual gate for shift-and-invert KSP | FEM CPU |
| GPU Krylov & SLEPc | [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L15) | `solve_poisson_airbox_modal_eigen_gpu_device_krylov` | Device-resident CUDA Krylov modal eigensolver | FEM GPU |
| GPU PETSc/SLEPc | [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L22) | `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Device-resident PETSc/SLEPc/hypre modal eigensolver | FEM GPU |

(numerical-methods-eigensolver-linearized-llg-validation)=
## Validation

| Validation layer | Required check | Evidence required |
|---|---|---|
| Equilibrium & R4 handoff | $\|\mathbf m_{0,i}\|=1$ and static torque below `tolT` before linearization. | Accepted relaxation handoff (`accepted_relax_handoff_for_eigen_stage`) and V6 certificate digest (`OwnedModalCertificateV6Binding`). |
| Tangent-frame kinematics | Orthonormality $T^{\mathsf T}T = I$ and spectrum invariance under local $SO(2)$ rotation of $(\mathbf e_1, \mathbf e_2)$. | Tangent-frame diagnostics (`TangentFrameDiagnostics`) and basis-rotation invariance tests. |
| Coupled algebraic solve | Both magnetic residual $\|r_{q,n}\|_2$ and Poisson residual $\|r_{\phi,n}\|_2$ satisfy `tolerance`, and inner shifted KSP solves satisfy the true-residual gate. | `PoissonAirboxModalResidualMetrics` and `floquet_shifted_true_convergence_test` telemetry in `eigen/spectrum.v2.json`. |
| Analytical benchmarks | $\mathbf k=0$ Kittel field sweep and thin-film Damon–Eshbach / backward-volume dispersion agreement within declared relative tolerance. | `K0KittelFieldSweepValidation` and `ThinFilmDEBVDispersionValidation` artifacts (see {doc}`modal-validation`). |
| Branch tracking | Mass-weighted overlap $\mathcal O_{ab}^{(s\to s+1)} \ge \mathrm{min\_overlap}$ and degenerate-subspace principal-angle cosine $s_{\mathrm{sub}}$. | `eigen/branches.v2.json` and `ConsistentP1TrackingMetric` provenance. |
| Driven-response parity | Modal eigenfrequencies match susceptibility resonance peaks from `FrequencyResponse` on identical mesh and $\mathbf m_0$. | Modal-vs-driven comparison table (`buildFmrModalDrivenComparisonModel`). |

(numerical-methods-eigensolver-linearized-llg-limitations)=
## Limitations

- Production modal eigensolving is a native FEM capability; FDM CPU and FDM CUDA modal lanes are
  not implemented and fail closed during planning.
- FEM GPU modal execution is restricted to qualified operator/boundary combinations with proven
  device residency; arbitrary 3D Floquet $\mathbf k$-paths default to the multi-process FEM CPU
  lane (`EigenKProcessPool`).
- Linearized normal modes describe small-amplitude dynamics around a single local energy minimum
  $\mathbf m_0$ and do not capture large-angle precession, foldover, or parametric spin-wave
  instabilities.
- PETSc/SLEPc runtime state is process-global; multi-sample $\mathbf k$ parallelism must use process
  isolation (`EigenKProcessPool`) rather than shared-process multithreading.

(numerical-methods-eigensolver-linearized-llg-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers / Wiley, New York, 1963.
2. C. Kittel, “On the theory of ferromagnetic resonance absorption,” *Physical Review* **73**,
   155–161 (1948), [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
3. C. Herring and C. Kittel, “On the theory of spin waves in ferromagnetic media,” *Physical Review*
   **81**, 869–880 (1951), [doi:10.1103/PhysRev.81.869](https://doi.org/10.1103/PhysRev.81.869).
4. B. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for
   ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C: Solid State
   Physics* **19**, 7013–7033 (1986),
   [doi:10.1088/0022-3719/19/35/014](https://doi.org/10.1088/0022-3719/19/35/014).
5. V. Hernández, J. E. Román, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the
   solution of eigenvalue problems,” *ACM Transactions on Mathematical Software* **31**, 351–362
   (2005), [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
6. M. d'Aquino, C. Serpico, G. Miano, and C. Forestiere, “A novel formulation for the numerical
   computation of magnetization modes in complex micromagnetic systems,” *Journal of Computational
   Physics* **228**, 6130–6149 (2009),
   [doi:10.1016/j.jcp.2009.05.026](https://doi.org/10.1016/j.jcp.2009.05.026).
7. Canonical LLG owner: {doc}`../../physics/foundations/llg-equation`; internal solver notes:
   `docs/physics/0600-fem-eigenmodes-linearized-llg.md` and
   `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.

(numerical-methods-eigensolver-linearized-llg-source-code-index)=

## Control Room workflow

Use `Model Explorer -> Stages -> Add stage -> Eigenmodes` to configure modal studies in the Control
Room workspace. `StudyStageInspectorRouter` (`apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx`)
routes stage selection to specialized sub-panels: `EigenmodesSetupStageInspectorPanel` (mode count
and spectral targeting), `EigenmodesEquilibriumStageInspectorPanel` (equilibrium handoff source),
`EigenmodesOperatorStageInspectorPanel` (operator family, dynamic demagnetization, damping policy,
and normalization), `EigenmodesBoundaryStageInspectorPanel` / `EigenmodesPeriodicPairsStageInspectorPanel`
(spin-wave and Floquet boundary conditions), `EigenmodesKPathStageInspectorPanel` (Brillouin-zone
$\mathbf k$-paths), `EigenmodesSolverStageInspectorPanel` (`FemEigenSolverPolicy`), and
`EigenmodesOutputsStageInspectorPanel`. Post-solve spectra, dispersion curves, residual tables, and
3D phase-animated spatial modes are rendered through `frequencyDomainChartModels.ts`,
`eigenResidualSummary.ts`, and `modeCompositionViewportProjection.ts`. Numerical parameters without
a matching UI control are authored in Python. See {doc}`/frontend/capability-register` for the
current capability register.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Python stage schema | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | `class EigenmodesStageSpec` | Modal stage parameters and validation | Python API source |
| Python stage construction | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3224) | `eigenmodes_stage` | Stage lowering entry point | Python API source |
| Python study model | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | `class Eigenmodes` | Canonical Python study representation | Python API source |
| Python solver policy | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | `class FemEigenSolverPolicy` | Native FEM eigensolver policy schema | Python API source |
| Python $\mathbf k$-path | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | `class KPath` | Piecewise-linear $\mathbf k$-path schema | Python API source |
| Python field sweep | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L65) | `class BiasFieldSweep` | Bias-field sweep schema | Python API source |
| Python mode tracking | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L408) | `class ModeTracking` | Mode-tracking policy schema | Python API source |
| IR operator enum | [`crates/fullmag-ir/src/study.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study.rs#L1397) | `EigenOperatorIR` | `ProblemIR` operator family | Rust IR source |
| IR spatial representation | [`crates/fullmag-ir/src/study_v04.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/study_v04.rs#L21) | `SpatialRepresentationIR` | `Full3d` vs `Waveguide2p5d` IR | Rust IR source |
| FEM modal plan IR | [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/plan.rs#L1807) | `FemEigenPlanIR` | Resolved FEM modal plan IR | Rust IR source |
| FEM modal planner | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | `plan_fem_eigen` | Capability check and plan resolution | Rust planner source |
| $\Gamma$-point tolerance | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L1319) | `FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M` | Componentwise $\Gamma$-point threshold | Rust planner source |
| Stage R4 handoff | [`crates/fullmag-cli/src/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-cli/src/orchestrator.rs#L2947) | `accepted_relax_handoff_for_eigen_stage` | Verified equilibrium stage handoff | Rust CLI source |
| Path orchestrator | [`crates/fullmag-runner/src/eigen/orchestrator.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/orchestrator.rs#L82) | `run_path_or_single_controlled` | Multi-sample path and single-$\mathbf k$ runner | Rust runner source |
| $\mathbf k$-process pool | [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | `EigenKProcessPool` | Multi-process $\mathbf k$-point pool | Rust runner source |
| Branch tracking | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | `track_branches` | Mass-weighted Hungarian mode tracking | Rust runner source |
| Subspace transport | [`crates/fullmag-runner/src/eigen/tracking_subspace.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | `mass_weighted_subspace_transport` | SVD principal-angle subspace transport | Rust runner source |
| $P_1$ mass metric | [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | `ConsistentP1TrackingMetric` | Consistent $P_1$ mass inner product | Rust runner source |
| Equilibrium materializer | [`crates/fullmag-runner/src/fem/eigen_equilibrium.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_equilibrium.rs#L388) | `materialize_equilibrium` | Static equilibrium preparation | Rust runner source |
| V6 modal certificate | [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | `build_owned_modal_certificate_v6_binding` | V6 equilibrium and seam-map certificate | Rust runner source |
| PETSc/SLEPc mutex | [`backends/fem/core/petsc_slepc_runtime.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/core/petsc_slepc_runtime.cpp#L24) | `petsc_slepc_process_mutex` | Process-wide PETSc/SLEPc lock | Native C++ source |
| Native modal solve | [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | `solve_modal_eigen_contract` | Native modal contract and diagnostics | Native C++ source |
| Tangent basis | [`backends/fem/include/frequency_domain/tangent_frame.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/tangent_frame.hpp#L38) | `build_tangent_frame` | Orthonormal tangent frame $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$ | Native C++ header |
| Dynamic pencil | [`backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp#L38) | `class LinearizedDynamicPencil` | Operator pencil $L\mathbf q = \lambda B_\alpha\mathbf q$ | Native C++ header |
| Rotated real pencil | [`backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/real_frequency_rotated_pencil.hpp#L31) | `assemble_real_frequency_rotated_pencil` | Real-split rotated pencil assembly | Native C++ header |
| Shared-domain blocks | [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | `assemble_poisson_airbox_shared_domain` | Coupled $(A_{qq}, A_{q\phi}, A_{\phi q}, P)$ assembly | Native C++ header |
| Floquet magnetic op | [`backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | `class FloquetReducedMagneticOperator` | Bloch-reduced magnetic operator | Native C++ header |
| Floquet 3D demag | [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | `build_floquet_dynamic_demag_k_real_split` | 3D Floquet dynamic demagnetization | Native C++ header |
| Waveguide 2.5D demag | [`backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | `build_floquet_waveguide_demag_k_real_split` | 2.5D waveguide demagnetization | Native C++ header |
| CPU Schur SLEPc | [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | `solve_poisson_airbox_modal_eigen_cpu_schur` | Matrix-free `MATSHELL` Schur eigensolver | Native C++ header |
| Coupled residuals | [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | `evaluate_poisson_airbox_modal_residuals` | Coupled descriptor residual evaluation | Native C++ header |
| Shifted-KSP gate | [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | `floquet_shifted_true_convergence_test` | True residual gate for shifted KSP | Native C++ header |
| GPU Krylov modal | [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L15) | `solve_poisson_airbox_modal_eigen_gpu_device_krylov` | Device-resident CUDA Krylov modal solve | Native C++ header |
| GPU PETSc/SLEPc | [`backends/fem/include/frequency_domain/modal_gpu_krylov.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp#L22) | `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Device-resident PETSc/SLEPc/hypre modal solve | Native C++ header |
