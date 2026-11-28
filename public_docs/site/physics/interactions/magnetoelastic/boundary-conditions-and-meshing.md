---
title: Magnetoelastic boundary conditions and spatial meshing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-magnetoelastic-boundary-conditions-and-meshing)=
# Magnetoelastic boundary conditions and spatial meshing

Coupled magnon–phonon simulations span two distinct physical domains—the magnetic subdomain
$\Omega_{\mathrm{mag}}$ and the larger elastic host solid $\Omega_{\mathrm{mech}} \supseteq \Omega_{\mathrm{mag}}$—embedded
inside a magnetostatic airbox $\Omega_{\mathrm{air}}$ for finite-element stray-field solves.
Correct mechanical boundary conditions, multilayer interface jump conditions, absorbing boundary
layers, rigid-body-mode well-posedness, and locking-free spatial discretizations are essential to
obtain physically accurate Rayleigh/Love waves, acoustic impedance reflection, spontaneous
magnetostrictive equilibria, and conservative energy transfer.

This page complements {doc}`index` (continuum physics and constitutive laws) and
{doc}`numerical-methods-and-libraries` (time integration, linear/eigen solvers, and HPC/GPU/MPI
architecture).

:::{important}
**Current `master` executable boundary vs. dedicated solver branch & planned runtime kernels.**
- **Executable on `master` today:** `MechanicalBoundaryCondition` (`traction_free`, `clamped`,
  `prescribed_displacement`, `prescribed_traction`) is authored in Python and serialized into
  `MechanicsIR`, while the executable FEM CPU/GPU subset evaluates prescribed-strain
  magnetoelastic fields without mechanical displacement DOFs.
- **Implemented on the dedicated bidirectional magnetoelastic solver branch (not yet merged to
  `master`):** all eight typed `MechanicalBoundaryCondition` kinds (adding `roller_symmetry`,
  `periodic` with affine macrostrain / Bloch–Floquet phase, `lysmer_kuhlemeyer`, and
  `ade_cfs_pml`), volumetric acoustic sponge `SpatialAbsorbingLayer` via
  `elasticity.absorbing_boundary(...)`, `MechanicalBoundaryHandle` stage helpers, `v0.3` $\to$
  `v0.4` FM+NM multidomain FEM/FDM lowering, conditional interface stabilizer $\theta_c$, and
  multi-component Fredholm RBM compatibility checks.
- **Planned native runtime kernels:** displacement BC assembly, absorbing collars, conforming
  `SubMesh` elasticity extraction, `Tet10` $\bar{\mathbf{B}}$, and `Prism6` `MITC6/ANS + EAS-1`
  fail closed at the planner boundary until runtime qualification completes.
:::

(magnetoelastic-bc-problem-statement)=
## Physical problem

Mechanical wave propagation and static magnetostriction depend critically on how the elastic
boundary $\partial\Omega_{\mathrm{mech}} = \Gamma_u \cup \Gamma_t \cup \Gamma_{\mathrm{roll}} \cup \Gamma_{\mathrm{per}} \cup \Gamma_{\mathrm{imp}} \cup \Gamma_{\mathrm{abs}}$
and internal ferromagnet–substrate interfaces $\Gamma_{\mathrm{FM/NM}} = \partial\Omega_{\mathrm{mag}} \cap \operatorname{int}(\Omega_{\mathrm{mech}})$
are treated:

1. **Free magnetic surfaces and internal interfaces** must balance the **total** stress
   $\boldsymbol{\sigma}^{\mathrm{tot}} = \boldsymbol{\sigma}^{\mathrm{el}} + \boldsymbol{\sigma}^{\mathrm{visc}} + \mathbf{1}_{\Omega_{\mathrm{mag}}}(\boldsymbol{\sigma}^{\mathrm{mel}} + \boldsymbol{\sigma}^{\mathrm{rot}}) + \boldsymbol{\sigma}^{\mathrm{drive}}$,
   not the elastic stress $\boldsymbol{\sigma}^{\mathrm{el}}$ alone. Enforcing
   $\boldsymbol{\sigma}^{\mathrm{el}}\cdot\hat{\mathbf{n}} = \mathbf{0}$ on a magnetic surface
   violates variational equilibrium and corrupts spontaneous strain and bilayer stress jumps.
2. **Open substrates** (semi-infinite $\mathrm{GGG}$, $\mathrm{LiNbO}_3$, or $\mathrm{Si}$
   wafers carrying GHz surface acoustic waves) require non-reflecting boundaries
   (`lysmer_kuhlemeyer` impedance, volumetric `SpatialAbsorbingLayer` sponge ABL, or
   displacement-form `ade_cfs_pml`) to eliminate spurious box-wall echoes while remaining
   strictly stable in anisotropic crystals.
3. **Unconstrained elastic bodies** in quasistatic equilibrium admit up to $6$ rigid-body modes
   per disconnected free component and require Fredholm force and torque compatibility checks.
4. **Spatial discretization** must simultaneously resolve the magnetic exchange length
   $\ell_{\mathrm{ex}}$, the shortest acoustic wavelength $\lambda_{\min}$, the SAW penetration
   depth $\delta_{\mathrm{SAW}}$, and high-aspect-ratio thin-film layers without FDM checkerboard
   modes or FEM shear/volumetric locking.

{numref}`fig-magnetoelastic-bc-meshing` summarizes the multi-domain mechanical boundary and
interface operators together with FullMag's staggered FDM and conforming FEM spatial
discretizations.

```{figure} /_static/diagrams/magnetoelastic-boundary-conditions-and-meshing.svg
:alt: Two-panel diagram of magnetoelastic boundary conditions and spatial meshing in FullMag: Panel (a) depicts a ferromagnetic film Omega_mag bonded to a non-magnetic elastic substrate Omega_sub with a traction-free top surface, prescribed IDT traction t_0, clamped base u = 0, Lysmer-Kuhlemeyer local viscous impedance on the left, a Rayleigh ABL / ADE CFS-PML absorbing collar on the right attenuating outgoing waves, and FM/NM interface continuity of displacement and total traction; Panel (b) compares the staggered FDM Virieux/Lebedev velocity-stress unit cell (normal stresses and m at cell centers, velocities on faces, shear stresses on edges) against a conforming FEM SubMesh (Omega_m subset Omega_el stripping Omega_air and Pyramid5) with shared interface nodes and locking-free P2 Tet10 B-bar and Prism6 MITC6+EAS-1 elements.
:width: 100%
:name: fig-magnetoelastic-bc-meshing
:figclass: fm-physics-figure

Multi-domain mechanical boundary conditions, interface jump relations, and spatial meshing in
FullMag. Panel (a) illustrates the canonical boundary operators on $\partial\Omega_{\mathrm{mech}}$
(traction-free $\boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}}=\mathbf{0}$, prescribed
traction $\mathbf{t}_0$, clamped base $\mathbf{u}=\mathbf{0}$, Lysmer–Kuhlemeyer local impedance
$-\mathbf{Z}_{\mathrm{LK}}\dot{\mathbf{u}}$, and Rayleigh ABL vs. ADE CFS-PML absorbing collars)
alongside continuous displacement and total-traction jumps across $\Gamma_{\mathrm{FM/NM}}$
(Komatitsch & Martin 2007; Bécache *et al.* 2003). Panel (b) contrasts the checkerboard-free
staggered FDM Virieux/Lebedev velocity–stress cell (Virieux 1986; Lisitsa & Vishnevskiy 2010)
against the conforming `mfem::SubMesh` extracting $\Omega_{\mathrm{el}} \supset \Omega_m$ without
vacuum airbox DOFs, equipped with locking-free `Tet10` $\bar{\mathbf{B}}$ and `Prism6`
`MITC6/ANS + EAS-1` elements (Hughes 1980; Bathe & Dvorkin 1986).
```

(magnetoelastic-bc-governing-equations)=
## Governing boundary, interface, and discretization equations

(magnetoelastic-v2-bc-catalog-contract)=
### Eight mechanical boundary conditions and volumetric acoustic ABL

Let $\hat{\mathbf{n}}$ denote the unit outward normal on $\partial\Omega_{\mathrm{mech}}$ and
$\mathbf{P}_t = \mathbf{I} - \hat{\mathbf{n}}\otimes\hat{\mathbf{n}}$ the surface tangential
projector. Variation of the coupled action $\int_{t_0}^{t_1} (E_{\mathrm{kin,el}} - \mathcal{F}[\mathbf{m},\mathbf{u}])\,dt$
with respect to $\delta\mathbf{u}$ yields the natural boundary traction
$\mathbf{t}_{\mathrm{tot}} = \boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}}$ (with
index convention $(\boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}})_i = \sigma_{ij}^{\mathrm{tot}} n_j$).
FullMag v2 (`MechanicalBoundaryCondition` / `MechanicalBoundaryHandle` on the solver branch)
defines eight typed boundary-condition kinds plus volumetric acoustic sponge layers
(`elasticity.absorbing_boundary(...)` / `SpatialAbsorbingLayer`):

| Boundary condition (`kind`) | Type / status | Mathematical boundary operator on $\Gamma$ | Physical role |
|---|---|---|---|
| `"traction_free"` | Natural (`master` IR + solver branch default) | $\boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}} = \mathbf{0}$ | Free top/side surfaces; default on unspecified $\partial\Omega_{\mathrm{mech}}$ |
| `"clamped"` | Essential (`master` IR + solver branch) | $\mathbf{u} = \mathbf{0},\; \dot{\mathbf{u}} = \mathbf{0}$ | Rigidly fixed substrate bottom or acoustic anchor |
| `"prescribed_displacement"` | Essential (`master` IR + solver branch) | $\mathbf{u}(\mathbf{r},t) = \bar{\mathbf{u}}(\mathbf{r},t)$ | Static substrate bending or kinematic piezo actuator |
| `"prescribed_traction"` | Natural (`master` IR + solver branch) | $\boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}} = \bar{\mathbf{t}}(\mathbf{r},t)$ | Surface IDT finger traction, shear transducer, or pressure pulse |
| `"roller_symmetry"` | Mixed (solver branch) | $\mathbf{u}\cdot\hat{\mathbf{n}} = 0,\; \mathbf{P}_t(\boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}}) = \mathbf{0}$ | Mirror symmetry planes and frictionless guided boundaries |
| `"periodic"` | Periodic / Bloch–Floquet (solver branch) | $\mathbf{u}(\mathbf{r}+\mathbf{a}) = e^{-i\mathbf{k}_B\cdot\mathbf{a}}\mathbf{u}(\mathbf{r})$ (or $+\overline{\mathbf{E}}_\parallel\mathbf{a}$), anti-periodic traction | Infinite waveguides, phononic crystals, and magnon–phonon dispersion bands |
| `"lysmer_kuhlemeyer"` | Local impedance (solver branch) | $\boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}} = -\mathbf{Z}_{\mathrm{LK}}\dot{\mathbf{u}}$, $\mathbf{Z}_{\mathrm{LK}} = \rho[c_L(\hat{\mathbf{n}}\otimes\hat{\mathbf{n}}) + c_T\mathbf{P}_t] \succ 0$ | First-order SPD non-reflecting viscous substrate termination |
| `"ade_cfs_pml"` | Stretched ADE PML (solver branch) | Uniaxial complex coordinate stretching $s_j(\omega)$ in $\Omega_{\mathrm{PML}}$ (optional M-PML) | Ultra-low-reflection ($R_0 \sim 10^{-6}\text{--}10^{-8}$) open substrate termination |

In addition, **`elasticity.absorbing_boundary(...)`** (`SpatialAbsorbingLayer`) attaches a
volumetric Rayleigh sponge collar $\Omega_{\mathrm{ABL}}$ harmonized with magnetic Gilbert-damping
ramps, accepting either explicit `max_damping` ($\mathrm{s}^{-1}$) or `target_reflection` in
$(0, 1)$ (mutually exclusive).

On a **traction-free magnetic surface** ($\Gamma_t \subset \partial\Omega_{\mathrm{mag}}$), the
zero total traction condition enforces the non-homogeneous elastic traction relation (including any
interior drive stress $\boldsymbol{\sigma}^{\mathrm{drive}}$ whose support reaches $\Gamma_t$):

```{math}
:label: eq-mel-bc-traction-free-mag
\left(\boldsymbol{\sigma}^{\mathrm{el}} + \boldsymbol{\sigma}^{\mathrm{visc}} + \boldsymbol{\sigma}^{\mathrm{drive}}\right)\cdot\hat{\mathbf{n}}
=
-\left(\boldsymbol{\sigma}^{\mathrm{mel}}(\mathbf{m}) + \boldsymbol{\sigma}^{\mathrm{rot}}(\mathbf{m},\boldsymbol{\omega})\right)\cdot\hat{\mathbf{n}}
\qquad \text{on } \Gamma_t \cap \partial\Omega_{\mathrm{mag}}.
```

For **`"periodic"` / Bloch–Floquet** boundaries across a pair translation vector $\mathbf{a}$ with
Bloch wave vector $\mathbf{k}_B$ (FullMag's canonical `exp_minus_i_k_dot_delta_r` convention
paired with $\exp(+i\omega t)$ harmonic time dependence), both displacement and total traction
transform by the unimodular phase factor $e^{-i\mathbf{k}_B\cdot\mathbf{a}}$:

```{math}
:label: eq-mel-bc-floquet-bloch
\mathbf{u}(\mathbf{r}+\mathbf{a}, t) = e^{-i\mathbf{k}_B\cdot\mathbf{a}}\,\mathbf{u}(\mathbf{r}, t),
\qquad
\boldsymbol{\sigma}^{\mathrm{tot}}(\mathbf{r}+\mathbf{a}, t)\cdot\hat{\mathbf{n}}(\mathbf{r}+\mathbf{a})
=
-e^{-i\mathbf{k}_B\cdot\mathbf{a}}\,\boldsymbol{\sigma}^{\mathrm{tot}}(\mathbf{r}, t)\cdot\hat{\mathbf{n}}(\mathbf{r}),
```

reducing to standard periodic boundary conditions (with optional affine macroscopic strain
`allow_affine_macrostrain` for stress-free unit-cell relaxation) when $\mathbf{k}_B = \mathbf{0}$.

(magnetoelastic-v2-absorbing-boundaries-contract)=
### Absorbing boundaries: Rayleigh sponge ABL, Lysmer–Kuhlemeyer, and ADE CFS-PML

#### Rayleigh sponge absorbing layer (`SpatialAbsorbingLayer` / `elasticity.absorbing_boundary`)

Inside an exterior sponge collar of thickness $L_{\mathrm{ABL}}$ with local inward penetration
coordinate $\xi \in [0, L_{\mathrm{ABL}}]$, mass damping ramps smoothly via a graded profile of
order $p \ge 2$ (default $p = 3$ or smootherstep):

```{math}
:label: eq-mel-bc-abl-ramp
\alpha_M(\xi) = \alpha_{\max}\left(\frac{\xi}{L_{\mathrm{ABL}}}\right)^p,
\qquad
\alpha_{\max} = -\frac{(p+1)\,c_{\max}}{2 L_{\mathrm{ABL}}}\ln R_0.
```

Because $\Delta\alpha_{\mathrm{ABL}}(\xi) \ge 0$ enters purely as a positive-semidefinite
dissipation term in the global energy balance {eq}`eq-mel-energy-power-balance`, acoustic ABL is
**unconditionally stable for every Born-stable anisotropic crystal symmetry** (including strongly
anisotropic rotated $\mathrm{LiNbO}_3$ cuts) and requires $L_{\mathrm{ABL}} \ge 2\text{--}3\,\lambda_{\max}$
to suppress reflections below $-40\,\mathrm{dB}$. For lightweight first-order truncation without
extra padding cells, `"lysmer_kuhlemeyer"` adds the strictly SPD surface damper
$\int_{\Gamma_{\mathrm{imp}}} \mathbf{w}\cdot\mathbf{Z}_{\mathrm{LK}}\dot{\mathbf{u}}\,dS$.

#### Displacement-form ADE Complex-Frequency-Shifted PML (`"ade_cfs_pml"`)

When compact open-domain collars ($L_{\mathrm{PML}} \approx 0.5\text{--}1.0\,\lambda_{\max}$,
reflection $R_0 \sim 10^{-6}\text{--}10^{-8}$) are needed, FullMag v2 employs the displacement-form
Auxiliary Differential Equation (ADE) Complex-Frequency-Shifted Perfectly Matched Layer (Komatitsch
& Martin 2007; Zhang & Shen 2010). Along each absorbed coordinate axis $x_j$, spatial derivatives
transform in the frequency domain as $\partial_{x_j} \mapsto s_j(\omega)^{-1}\partial_{x_j}$ with

```{math}
:label: eq-mel-bc-cfs-pml-stretch
s_j(\omega) = \kappa_j(\xi) + \frac{d_j(\xi)}{\alpha_{\mathrm{PML},j}(\xi) + i\omega},
\qquad
d_j(\xi) = d_{\max}\left(\frac{\xi}{L_{\mathrm{PML}}}\right)^p,
\qquad
\kappa_j(\xi) = 1 + (\kappa_{\max} - 1)\left(\frac{\xi}{L_{\mathrm{PML}}}\right)^p,
```

```{math}
:label: eq-mel-bc-cfs-pml-alpha-dmax
\alpha_{\mathrm{PML},j}(\xi) = \alpha_0\!\left(1 - \frac{\xi}{L_{\mathrm{PML}}}\right),
\qquad
d_{\max} = -\frac{(p+1)\,c_{\max}}{2 L_{\mathrm{PML}}}\ln R_0,
```

where $\alpha_0 > 0$ shifts the PML pole off the real frequency axis to absorb grazing-incidence
Rayleigh surface waves and low-frequency evanescent tails without late-time drift, and
$\kappa_{\max} \ge 1$ damps evanescent modes. In the time domain, each stretched derivative
$\tilde{\partial}_j f = \kappa_j^{-1}\partial_j f + \psi_{j}[f]$ is marched via an exact
exponential-integrator update for the memory variable $\psi_j$:

```{math}
:label: eq-mel-bc-cfs-pml-ade
\frac{\partial \psi_j}{\partial t} + \left(\alpha_{\mathrm{PML},j} + \frac{d_j}{\kappa_j}\right)\psi_j
=
-\frac{d_j}{\kappa_j^2}\frac{\partial f}{\partial x_j},
\qquad
\psi_j^{n+1} = b_j \psi_j^n + a_j (\partial_j f)^{n+1/2},
```

with $b_j = \exp\!\left[-(\alpha_{\mathrm{PML},j} + d_j/\kappa_j)\Delta t\right]$ and
$a_j = \frac{d_j}{\kappa_j(\kappa_j \alpha_{\mathrm{PML},j} + d_j)}(b_j - 1)$.

:::{warning}
**Anisotropic PML stability guard (Bécache–Fauqueux–Joly condition).**
In strongly anisotropic crystals whose acoustic slowness surface is non-convex such that the
phase velocity component $s_j$ and group velocity component $v_{g,j}$ have opposite signs
($s_j v_{g,j} < 0$, Bécache, Fauqueux & Joly 2003), standard coordinate-stretched PML supports
exponentially growing backward-wave instabilities. Before execution, the FullMag v2 planner
evaluates the Christoffel group-velocity sign criterion on the crystal slowness sheet along every
PML axis; if an instability direction exists, `"ade_cfs_pml"` requires multi-axial M-PML
stabilization ($d_{\mathrm{PML},\perp} = \chi_{\mathrm{MPML}} d_{\mathrm{PML},n}$,
`mpml_transverse_ratio` $\in [0.1, 0.25]$) or fails closed in strict mode
(`anisotropic_pml_slowness_instability`), directing the user to unconditionally dissipative
acoustic ABL (`elasticity.absorbing_boundary(...)`).
:::

(magnetoelastic-v2-interfaces-contract)=
### Multilayer interfaces, acoustic impedance, and conditional FDM stabilization

Across any bonded internal interface $\Gamma_{12}$ separating medium $1$ and medium $2$ (such as
a ferromagnet $\Omega_{\mathrm{mag}}$ bonded to a non-magnetic substrate $\Omega_{\mathrm{sub}}$),
mechanical compatibility requires continuous displacement and continuous **total** traction:

```{math}
:label: eq-mel-interface-jump
\llbracket \mathbf{u} \rrbracket = \mathbf{0},
\qquad
\llbracket \boldsymbol{\sigma}^{\mathrm{tot}} \cdot \hat{\mathbf{n}}_{12} \rrbracket = \mathbf{0}
\quad\Longrightarrow\quad
\llbracket (\boldsymbol{\sigma}^{\mathrm{el}} + \boldsymbol{\sigma}^{\mathrm{visc}})\cdot\hat{\mathbf{n}}_{12} \rrbracket
=
-\llbracket (\boldsymbol{\sigma}^{\mathrm{mel}} + \boldsymbol{\sigma}^{\mathrm{rot}})\cdot\hat{\mathbf{n}}_{12} \rrbracket.
```

Thus, at a passive ferromagnet–substrate boundary, the magnetostrictive stress inside the magnetic
film induces an abrupt jump in the elastic stress across $\Gamma_{\mathrm{FM/NM}}$ even when the
displacement field is smooth and continuous.

For a plane acoustic wave of polarization $a \in \{L, T\}$ normally incident from medium $1$
(characteristic acoustic impedance $Z_1 = \rho_1 c_{a,1}$) onto medium $2$ ($Z_2 = \rho_2 c_{a,2}$),
Equation {eq}`eq-mel-interface-jump` yields the exact Fresnel reflection and transmission ratios:

```{math}
:label: eq-mel-acoustic-impedance-fresnel
Z_a = \rho c_a,
\qquad
R_u = \frac{Z_1 - Z_2}{Z_1 + Z_2},
\qquad
T_{u,v} = \frac{2 Z_1}{Z_1 + Z_2},
\qquad
T_\sigma = \frac{2 Z_2}{Z_1 + Z_2},
\qquad
T_P = T_{u,v} T_\sigma = \frac{4 Z_1 Z_2}{(Z_1 + Z_2)^2},
```

with exact power conservation $R_P + T_P = R_u^2 + T_P = 1$. For transverse shear waves crossing
a passive $\mathrm{YIG}/\mathrm{GGG}$ interface ($Z_{\mathrm{YIG}} = 1.9869\times 10^7\,\mathrm{Pa\,s\,m^{-1}}$,
$Z_{\mathrm{GGG}} = 2.5262\times 10^7\,\mathrm{Pa\,s\,m^{-1}}$), Equation
{eq}`eq-mel-acoustic-impedance-fresnel` gives $T_{u,v} = 0.8805$, $T_\sigma = 1.1195$, and
$T_P = 0.9857$ (Benchmark G6).

#### FDM staggered averaging and conditional interface stabilizer $\theta_c \in (0, 1]$

On Cartesian FDM staggered grids with piecewise-constant cell materials, accurate interface
transmission requires **arithmetic averaging** of mass density at velocity nodes
($\bar{\rho}_{i+1/2} = \frac{1}{2}(\rho_i + \rho_{i+1})$) and **harmonic averaging** of shear
moduli at staggered shear-stress edges ($\underline{C}_{aa,c}^{\mathrm{harm}} = \bigl(\frac{1}{4}\sum_{q=1}^4 C_{aa,q}^{-1}\bigr)^{-1}$
for $a \in \{4,5,6\}$, Moczo *et al.* 2002).

However, in an anisotropic crystal with off-diagonal normal–shear coupling ($C_{14}, C_{15}, C_{16} \neq 0$),
replacing only the diagonal shear entries by their harmonic average across a heterogeneous
interface can make the composite cell matrix
$\mathbf{C}_c^{\mathrm{raw}} = \mathbf{C}_c^{\mathrm{diag,harm}} + \Delta\mathbf{C}_c^{\mathrm{anis}}$
indefinite ($\lambda_{\min} \le 0$). FullMag v2 resolves this through a **conditional interface
stabilizer** $\theta_c \in (0, 1]$:

```{math}
:label: eq-mel-fdm-conditional-stabilizer
\mathbf{C}_c^{\mathrm{eff}} = \mathbf{C}_c^{\mathrm{diag,harm}} + \theta_c\,\Delta\mathbf{C}_c^{\mathrm{anis}},
\qquad
\theta_c =
\begin{cases}
1, & \text{if } \forall a\in\{4,5,6\}:\; \underline{C}_{aa,c}^{\mathrm{harm}} \ge C'_{aa,c} - \epsilon_{\mathrm{tol}}, \\
\max\bigl\{\theta \in (0,1] : \mathbf{C}_c^{\mathrm{diag,harm}} + \theta\Delta\mathbf{C}_c^{\mathrm{anis}} \succeq \mu_{\mathrm{SPD},c}\mathbf{I}_6\bigr\}, & \text{otherwise.}
\end{cases}
```

Crucially, $\theta_c \equiv 1$ **unconditionally on every homogeneous cell** (even extreme
monoclinic crystals with $\mathbf{C}_V = \mathbf{I}_6$ and $C_{16} = 0.99$), so bulk anisotropic
wave dispersion suffers zero artificial modification; $\theta_c < 1$ activates **only** on
heterogeneous material-interface cells where harmonic shear softening would otherwise violate SPD
energy positivity.

(magnetoelastic-v2-fredholm-rbm-contract)=
### Multi-component Fredholm well-posedness and rigid-body modes

In a **quasistatic** mechanical equilibrium solve $\mathbf{K}_{\mathrm{stat}}\mathbf{u} = \mathbf{f}$,
let $\Omega_{\mathrm{mech}} = \bigsqcup_{s=1}^{N_{\mathrm{comp}}} \Omega^{(s)}$ be partitioned
into connected elastic components (covering both FM and NM solids), of which $N_{\mathrm{free\_comp}}$
have no essential Dirichlet (`"clamped"` / `"prescribed_displacement"`) or sufficient
`"roller_symmetry"` constraints. Each unconstrained component $s$ carries a $6$-dimensional
Euclidean rigid-body-mode (RBM) subspace
$\mathcal{N}_{\mathrm{RBM}}^{(s)} = \operatorname{span}\{\mathbf{e}_\alpha,\; \mathbf{e}_\alpha \times (\mathbf{r} - \mathbf{r}_0^{(s)})\}_{\alpha=1}^3$,
giving total nullspace dimension $d_{\mathrm{null}} \le 6 N_{\mathrm{free\_comp}}$.

By the Fredholm alternative, a static solution exists if and only if total force and total torque
vanish on every free component $s$:

```{math}
:label: eq-mel-fredholm-compatibility
\int_{\Omega^{(s)}} \mathbf{f}_{\mathrm{ext}}\,dV
+ \oint_{\partial\Omega^{(s)}} \bar{\mathbf{t}}\,dS
= \mathbf{0},
\qquad
\int_{\Omega^{(s)}} (\mathbf{r}-\mathbf{r}_0^{(s)})\times \mathbf{f}_{\mathrm{ext}}\,dV
+ \oint_{\partial\Omega^{(s)}} (\mathbf{r}-\mathbf{r}_0^{(s)})\times \bar{\mathbf{t}}\,dS
+ \boldsymbol{\tau}_{\mathrm{mag}}^{(s)}
= \mathbf{0},
```

where $\boldsymbol{\tau}_{\mathrm{mag}}^{(s)} = \int_{\Omega_{\mathrm{mag}}^{(s)}} \mu_0 M_s (\mathbf{m} \times \mathbf{H}_{\mathrm{ani}})\,dV$
is the net anisotropy torque from Melcher rotational coupling. FullMag v2 (enforced by
`evaluate_multicomponent_fredholm` on the solver branch) applies three strict rules:

1. **Unbalanced external loads fail closed:** if the projected external force/torque residual
   $\lVert\mathbf{R}^\top \mathbf{f}_{\mathrm{ext}}\rVert_2 > \epsilon_{\mathrm{tol}}$ on any free
   component $s$, quasistatic planning fails closed
   (`quasistatic_unbalanced_external_load_on_free_component`).
2. **Nonzero net rotational torque or indefinite tangent fails closed:** if
   $\lVert\mathbf{R}^\top \boldsymbol{\tau}_{\mathrm{mag}}^{(s)}\rVert_2 > \epsilon_{\mathrm{tol}}$
   or $\mathbf{K}_{\mathrm{stat}}(\mathbf{m}_0) \not\succeq \mathbf{0}$ on a free component, the
   quasistatic solver fails closed (`free_body_rotational_torque_requires_clamped_bc_or_elastodynamics`)
   because a free body experiencing unbalanced magnetic torque accelerates rotationally and must
   be solved dynamically or clamped.
3. **Collinear zero-torque rotational stiffening:** at a collinear equilibrium
   $\mathbf{m}_0 \parallel \mathbf{H}_{\mathrm{ext}} \parallel \hat{\mathbf{e}}_{\mathrm{easy}}$,
   $\boldsymbol{\tau}_{\mathrm{mag}}^{(s)} = \mathbf{0}$ and the second-order rotational energy
   $w_{\mathrm{rot}}^{(2)}$ contributes a positive-semidefinite rotational stiffness
   $\mathbf{K}_{\mathrm{rot},2} \succeq 0$ that stabilizes the two transverse rigid rotations
   orthogonal to $\hat{\mathbf{e}}_{\mathrm{easy}}$, cleanly reducing the component's nullspace
   dimension from $6$ to $4$ (3 translations + 1 axial rotation around $\hat{\mathbf{e}}_{\mathrm{easy}}$).

For well-posed free components, both FDM and FEM project the linear solve onto the orthogonal
complement $\ker(\mathbf{K}_{\mathrm{stat}})^\perp$ using orthonormalized per-component RBM
vectors $\mathbf{Z} \in \mathbb{R}^{N_{\mathrm{dof}}\times d_{\mathrm{null}}}$
($\mathbf{Z}^\top \mathbf{M}\mathbf{Z} = \mathbf{I}$).

(magnetoelastic-v2-fdm-meshing-contract)=
### FDM spatial meshing: Virieux, Lebedev, and 2D plane-stress condensation

#### Supergrid architecture and why collocated grids fail

In FDM, the mechanical supergrid $\Omega_{\mathrm{mech}}^{\mathrm{FDM}}$ embeds the magnetic
grid $\Omega_{\mathrm{mag}}^{\mathrm{FDM}}$ with identical cell spacings $(\Delta x, \Delta y, \Delta z)$
and cellwise material flags (`is_elastic`, `is_magnetic`). A naive collocated central difference
$D_x u_i = \frac{u_{i+1}-u_{i-1}}{2\Delta x}$ has Fourier symbol

```{math}
:label: eq-mel-fdm-checkerboard-vs-staggered
\widehat{D}_x^{\mathrm{colloc}}(k_x) = \frac{i}{\Delta x}\sin(k_x \Delta x),
\qquad
\widehat{D}_x^{\mathrm{stag}}(k_x) = \frac{2i}{\Delta x}\sin\!\left(\frac{k_x \Delta x}{2}\right).
```

Because $\widehat{D}_x^{\mathrm{colloc}}(\pi/\Delta x) = 0$, the Nyquist mode $(-1)^i$ lies in
the discrete gradient nullspace, causing undamped odd–even checkerboard oscillations. By contrast,
the half-staggered operator $\widehat{D}_x^{\mathrm{stag}}(k_x)$ vanishes **only** at $k_x = 0$,
eliminating checkerboard spurious modes completely.

#### Virieux staggered grid and Schur/BDF2 viscous free-surface closure

For `isotropic`, `cubic`, `hexagonal`, `tetragonal_4mmm`, and `orthorhombic` materials aligned
with the grid axes (requiring $N_\alpha^{\mathrm{mech}} \ge 2$ on every non-periodic axis in 3D),
FullMag v2 uses the **Virieux (1986) velocity–stress staggered grid**:

- Normal stresses $(\sigma_{xx}, \sigma_{yy}, \sigma_{zz})$ and magnetization $\mathbf{m}$ reside
  at cell centers $(i, j, k)$.
- Particle velocities reside at cell faces: $v_x(i+\tfrac{1}{2}, j, k)$,
  $v_y(i, j+\tfrac{1}{2}, k)$, $v_z(i, j, k+\tfrac{1}{2})$.
- Shear stresses reside at cell edges: $\sigma_{xy}(i+\tfrac{1}{2}, j+\tfrac{1}{2}, k)$,
  $\sigma_{xz}(i+\tfrac{1}{2}, j, k+\tfrac{1}{2})$, $\sigma_{yz}(i, j+\tfrac{1}{2}, k+\tfrac{1}{2})$.

At `"traction_free"` surfaces (e.g., $z = z_{\max}$), ghost stress and velocity values are closed
via an exact **Schur-complement free-surface elimination** coupled to an L-stable **BDF2**
implicit update whenever Kelvin–Voigt viscosity $\boldsymbol{\eta}_V \neq \mathbf{0}$ is active,
enforcing $\sigma_{zz}^{\mathrm{tot}} = \sigma_{xz}^{\mathrm{tot}} = \sigma_{yz}^{\mathrm{tot}} = 0$
to second order without restricting the explicit time step on viscous surface cells.

#### Four-grid Lebedev scheme for arbitrary 21-constant anisotropy

When Bond-rotated crystals or `trigonal_3m` / `anisotropic_voigt21` materials possess nonzero
normal–shear or shear–shear stiffness couplings ($C_{14}, C_{15}, C_{16}, C_{45}, C_{46}, C_{56} \neq 0$),
the Virieux grid requires 4-point spatial averaging of shear strains to evaluate normal stresses,
which degrades accuracy and can destabilize strong anisotropy. FullMag v2 automatically switches
to the **4-grid Lebedev scheme** (Lisitsa & Vishnevskiy 2010), which places all three velocity
components $(v_x, v_y, v_z)$ co-located on 4 staggered velocity sub-grids and all six stress
components $\boldsymbol{\sigma}_V$ co-located on the 4 dual stress sub-grids. Hooke's law
$\boldsymbol{\sigma}_V = \mathbf{C}_V^{\mathrm{lab}}\boldsymbol{\varepsilon}^{\mathrm{eng}}$ is
evaluated **strictly pointwise** with zero cross-component interpolation.

#### Automatic 2D plane-stress Schur condensation for single-layer thin films ($N_z = 1$)

In ultra-thin magnetic films modeled with a single FDM layer ($N_z = 1$) and traction-free top
and bottom surfaces, setting $\partial_z \mathbf{u} = \mathbf{0}$ naively imposes **plane strain**
($\varepsilon_{zz} = 0$), which stiffens longitudinal in-plane waves erroneously from the true
thin-plate speed $\sqrt{E/[\rho(1-\nu^2)]}$ to the bulk speed $\sqrt{C_{11}/\rho}$. Partitioning
Voigt indices into in-plane components $p = (11, 22, 12)$ and out-of-plane components
$o = (33, 23, 13)$ and enforcing $\boldsymbol{\sigma}_o^{\mathrm{tot}} = \mathbf{0}$ yields the
exact **plane-stress Schur condensation** (`plane_stress_2d`):

```{math}
:label: eq-mel-fdm-plane-stress-schur
\mathbf{C}_V^{\mathrm{2D}}
=
\mathbf{C}_{pp} - \mathbf{C}_{po}\mathbf{C}_{oo}^{-1}\mathbf{C}_{op},
\qquad
\boldsymbol{\sigma}_p^{\mathrm{mel,2D}}
=
\boldsymbol{\sigma}_p^{\mathrm{mel}} - \mathbf{C}_{po}\mathbf{C}_{oo}^{-1}\boldsymbol{\sigma}_o^{\mathrm{mel}},
\qquad
\boldsymbol{\varepsilon}_o^{\mathrm{eng}}
=
-\mathbf{C}_{oo}^{-1}\!\left(\mathbf{C}_{op}\boldsymbol{\varepsilon}_p^{\mathrm{eng}} + \boldsymbol{\sigma}_o^{\mathrm{mel}}\right).
```

Because $\mathbf{C}_V \succ 0$, the Schur complement $\mathbf{C}_V^{\mathrm{2D}} \succ 0$ is
strictly symmetric positive-definite for all seven crystal classes and arbitrary Bond orientations,
and recovers the exact out-of-plane Poisson contraction $\varepsilon_{zz}$ needed inside
$\mathbf{H}_{\mathrm{mel}}$ (reducing in orthotropic/cubic alignment to
$\varepsilon_{zz}^* = -(C_{13}\varepsilon_{xx} + C_{23}\varepsilon_{yy} + \sigma_{zz}^{\mathrm{mel}})/C_{33}$).

(magnetoelastic-v2-fem-meshing-contract)=
### FEM conforming SubMesh, element locking policy, and exact quadrature

#### Conforming `SubMesh`/`ParSubMesh` and `FaceKey` boundary reconstruction

In FullMag's shared-domain FEM architecture, the parent mesh covers
$\Omega_{\mathrm{all}} = \Omega_{\mathrm{mag}} \cup \Omega_{\mathrm{sub}} \cup \Omega_{\mathrm{air}}$
(where the magnetostatic airbox $\Omega_{\mathrm{air}}$ may contain `Pyramid5` transition
elements connecting swept `Prism6` ferromagnets to free tetrahedral airboxes). For mechanics:

1. **Strict airbox and `Pyramid5` exclusion:** FullMag extracts a conforming `mfem::SubMesh`
   (serial) or `mfem::ParSubMesh` (MPI) covering strictly $\Omega_{\mathrm{mech}} = \Omega_{\mathrm{mag}} \cup \Omega_{\mathrm{sub}}$,
   excluding $\Omega_{\mathrm{air}}$ and any `Pyramid5` airbox transition layers so zero elastic
   DOFs are wasted in vacuum and no degraded pyramid elasticity elements enter the stiffness matrix.
2. **Deterministic `FaceKey` boundary reconstruction:** SubMesh boundary faces on
   $\partial\Omega_{\mathrm{mech}}$ (including the newly exposed interface $\partial\Omega_{\mathrm{mech}} \cap \partial\Omega_{\mathrm{air}}$)
   are tagged deterministically by hashing sorted parent vertex-ID tuples (`FaceKey`), guaranteeing
   identical boundary attributes across serial and MPI-partitioned runs.
3. **Automatic interface continuity:** Because $\Omega_{\mathrm{mag}}$ and $\Omega_{\mathrm{sub}}$
   share conforming nodes across $\Gamma_{\mathrm{FM/NM}}$, continuous $H^1(\Omega_{\mathrm{mech}})^3$
   finite elements enforce $\llbracket\mathbf{u}\rrbracket = \mathbf{0}$ identically and satisfy
   the exact total-traction jump {eq}`eq-mel-interface-jump` weakly without penalty parameters.

#### Tetrahedral elements (`Tet4`, `Tet10`) and volumetric locking cutoff

Define the effective isotropic Poisson ratio $\nu_{\mathrm{eff}}$ from the Voigt–Reuss–Hill
average bulk and shear moduli $(K_{\mathrm{VRH}}, G_{\mathrm{VRH}})$:

```{math}
:label: eq-mel-fem-nu-eff
\nu_{\mathrm{eff}} = \frac{3 K_{\mathrm{VRH}} - 2 G_{\mathrm{VRH}}}{2(3 K_{\mathrm{VRH}} + G_{\mathrm{VRH}})}.
```

FullMag v2 enforces a three-tier locking policy for tetrahedral meshes:

- **`Tet4` ($P_1$):** standard displacement formulation for $\nu_{\mathrm{eff}} < 0.48$; **hard
  fail-closed rejection** for $\nu_{\mathrm{eff}} \ge 0.48$ (`tet4_volumetric_locking_exceeds_limit`)
  because linear tetrahedra lock severely near incompressibility.
- **`Tet10` ($P_2$):** standard $H^1$ displacement formulation for $\nu_{\mathrm{eff}} \le 0.45$;
  for $0.45 < \nu_{\mathrm{eff}} < 0.499$, automatic **$\bar{\mathbf{B}}$ ($P_2/P_0$ SPD static
  condensation)** replaces the volumetric strain $\operatorname{tr}\boldsymbol{\varepsilon}$ by its
  element-averaged projection $\overline{\operatorname{tr}\boldsymbol{\varepsilon}}_e = \frac{1}{\lvert K_e\rvert}\int_{K_e}\operatorname{tr}\boldsymbol{\varepsilon}\,dV$,
  yielding a strictly symmetric positive-definite element stiffness $\mathbf{K}_e^{\bar{\mathbf{B}}} \succ 0$
  free of volumetric locking.
- **Near-incompressible regime ($\nu_{\mathrm{eff}} \ge 0.499$):** fails closed with
  `incompressible_taylor_hood_deferred_to_v2_1` (mixed $P_2/P_1$ Taylor–Hood saddle-point
  elements are deferred to v2.1).

#### Thin-film swept wedges (`Prism6`): `MITC6/ANS + EAS-1` and 12-point quadrature

High-aspect-ratio swept `Prism6` thin films ($h_{xy} / h_z \sim 10\text{--}100$) suffer both
transverse shear locking and thickness locking under standard trilinear displacement interpolation.
FullMag v2 equips `Prism6` with:

1. **MITC6/ANS (Mixed Interpolation of Tensorial Components / Assumed Natural Strain):**
   interpolates covariant transverse shear strains $(\gamma_{\xi\zeta}, \gamma_{\eta\zeta})$ from
   6 tying points along the triangular mid-edges (Bathe & Dvorkin 1986).
2. **EAS-1 (1-mode Enhanced Assumed Strain):** enriches the through-thickness strain
   $\varepsilon_{\zeta\zeta}$ by a single bubble mode $\tilde{\varepsilon}_{\zeta\zeta} = \zeta\,\alpha_e$
   statically condensed at the element level:

```{math}
:label: eq-mel-fem-prism6-eas1
\mathbf{K}_e^{\mathrm{MITC6+EAS1}}
=
\mathbf{K}_{uu,e}^{\mathrm{MITC6}}
- \mathbf{K}_{u\alpha,e}\, K_{\alpha\alpha,e}^{-1}\, \mathbf{K}_{\alpha u,e},
\qquad
\operatorname{rank}\!\left(\mathbf{K}_e^{\mathrm{MITC6+EAS1}}\right) = 12 \;\; (\text{on } 18\text{ DOFs}).
```

The resulting element has exact physical rank $12 = 18 - 6\text{ RBM}$ (**zero spurious hourglass
modes**), eliminates both shear and Poisson thickness locking in flexural Lamb/SAW modes, and
remains strictly SPD on the non-RBM subspace.

3. **Mandatory 12-point quadrature (`IntRules(PRISM, 3)`) for magnetoelastic assembly:** while the
   linear elastic stiffness matrix $\int_{K_e} \mathbf{B}^\top \mathbf{C}_V \mathbf{B}\,dV$ is
   exact under the 6-point rule `IntRules(PRISM, 2)`, the magnetostrictive coupling integral
   $\int_{K_e} \boldsymbol{\sigma}^{\mathrm{mel}}(\mathbf{m}) : \nabla\mathbf{w}\,dV$ integrates
   cubic polynomials of the form $m_a m_b \nabla w_c$ (containing triangular monomials $L_1^3$
   with exact integral $\frac{1}{20}$, on which the 6-point rule commits a $1.852\%$ quadrature
   error). FullMag v2 therefore mandates the **12-point rule `IntRules(PRISM, 3)`** for all
   magnetoelastic assembly and variational adjoint evaluations on `Prism6` (elevated further when
   fourth-order anisotropies $K_{c1}, K_{u2}$ enter $\boldsymbol{\sigma}^{\mathrm{rot}}$),
   eliminating quadrature drift to machine precision.

### Quantitative mesh-resolution guidelines (FDM and FEM)

| Physical length scale | Formula | FDM Virieux / FEM $P_1$ (`Tet4`, `Prism6`) | FEM $P_2$ (`Tet10`, `Hex27`) |
|---|---|---|---|
| Magnetic exchange length | $\ell_{\mathrm{ex}} = \sqrt{2 A_{\mathrm{ex}} / (\mu_0 M_s^2)}$ | $h \le 0.5\,\ell_{\mathrm{ex}}$ in $\Omega_{\mathrm{mag}}$ | $h \le 1.0\,\ell_{\mathrm{ex}}$ (edge nodes $\le 0.5\,\ell_{\mathrm{ex}}$) |
| Shortest acoustic wavelength | $\lambda_{\min} = c_{\min} / f_{\max}$ | $\mathrm{PPW} = \lambda_{\min} / h \ge 12\text{--}16$ | $\mathrm{PPW} = \lambda_{\min} / h \ge 6\text{--}8$ |
| Rayleigh SAW decay depth | $\delta_{\mathrm{SAW}} \approx \lambda_{\mathrm{SAW}} / 2$ | $h_z \le \delta_{\mathrm{SAW}}/4$; substrate depth $H_{\mathrm{sub}} \ge 2.5\,\lambda_{\mathrm{SAW}}$ (or $1.5\,\lambda_{\mathrm{SAW}}$ + PML) | $h_z \le \delta_{\mathrm{SAW}}/2$ near surface, graded into substrate |
| Thin-film thickness modes | $f_n = n c_t / (2 d_{\mathrm{FM}})$ | $N_z = 1$ (auto 2D plane-stress Schur in FDM) or $N_z \ge 3$ for $n=1$ thickness shear | $N_z \ge 1$ `Prism6` (`MITC6+EAS-1`) for bending; $\ge 2$ for thickness shear |
| Absorbing collar thickness | $L_{\mathrm{ABL}}$ or $L_{\mathrm{PML}}$ | $L_{\mathrm{ABL}} \ge 2.5\,\lambda_{\max}$; $L_{\mathrm{PML}} \ge 0.8\,\lambda_{\max}$ ($\ge 10\text{--}12$ cells) | $L_{\mathrm{PML}} \ge 0.8\,\lambda_{\max}$ ($\ge 6$ $P_2$ elements) |

(magnetoelastic-bc-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\hat{\mathbf{n}}$ | unit outward boundary or interface normal vector | $1$ |
| $\bar{\mathbf{u}}$ | prescribed Dirichlet boundary displacement | $\mathrm{m}$ |
| $\bar{\mathbf{t}}$ | prescribed Neumann boundary traction vector | $\mathrm{Pa}$ |
| $\mathbf{k}_B$ | Floquet–Bloch wave vector across periodic cell | $\mathrm{rad\,m^{-1}}$ |
| $L_{\mathrm{ABL}}, L_{\mathrm{PML}}$ | absorbing sponge or PML collar thickness | $\mathrm{m}$ |
| $R_0$ | target normal-incidence absorbing-boundary reflection coefficient | $1$ |
| $s_j(\omega)$ | complex-frequency-shifted PML coordinate stretch factor | $1$ |
| $d_j, \kappa_j, \alpha_{\mathrm{PML},j}$ | CFS-PML damping, real stretch, and frequency-shift profiles | $\mathrm{s^{-1}}, 1, \mathrm{s^{-1}}$ |
| $Z_a$ | characteristic acoustic impedance ($\rho c_a$) | $\mathrm{Pa\,s\,m^{-1}}$ |
| $R_u, T_{u,v}, T_\sigma, T_P$ | Fresnel acoustic displacement, stress, and power coefficients | $1$ |
| $\theta_c$ | conditional FDM heterogeneous-interface anisotropy stabilizer | $1$ |
| $N_{\mathrm{free\_comp}}$ | number of unconstrained disconnected elastic components | $1$ |
| $\mathbf{C}_V^{\mathrm{2D}}$ | plane-stress Schur-condensed $3\times 3$ stiffness matrix | $\mathrm{Pa}$ |
| $\nu_{\mathrm{eff}}$ | Voigt–Reuss–Hill effective isotropic Poisson ratio | $1$ |
| $\ell_{\mathrm{ex}}$ | micromagnetic exchange length | $\mathrm{m}$ |
| $\lambda_{\min}$ | shortest resolved acoustic wavelength | $\mathrm{m}$ |

(magnetoelastic-bc-assumptions-and-validity)=
## Assumptions and validity

1. **Bonded interfaces:** internal interfaces $\Gamma_{\mathrm{FM/NM}}$ assume perfect mechanical
   adhesion ($\llbracket\mathbf{u}\rrbracket = \mathbf{0}$). Delamination, sliding contact, and
   interfacial spring compliance (Kapitza-like mechanical resistance) are outside v2 scope.
2. **Anisotropic PML stability:** `"ade_cfs_pml"` is strictly valid on crystals whose acoustic
   slowness sheets satisfy the Bécache–Fauqueux–Joly condition ($s_j v_{g,j} \ge 0$) along every
   stretched axis; otherwise M-PML stabilization (`mpml_transverse_ratio`) or unconditionally
   dissipative acoustic ABL (`elasticity.absorbing_boundary(...)`) must be used.
3. **Thin-film plane-stress reduction:** automatic 2D Schur condensation applies only when
   $N_z = 1$ with traction-free top and bottom surfaces and wavelength $\lambda \gg d_{\mathrm{FM}}$.
4. **Element locking boundaries:** `Tet4` is restricted to $\nu_{\mathrm{eff}} < 0.48$, `Tet10`
   $\bar{\mathbf{B}}$ covers $0.45 < \nu_{\mathrm{eff}} < 0.499$, and $\nu_{\mathrm{eff}} \ge 0.499$
   fails closed pending v2.1 Taylor–Hood mixed elements.

(magnetoelastic-bc-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR (`master`) | Executable realization (`master`) | Scientific qualification | Exact capability boundary and v2 roadmap |
|---|---|---|---|---|---|
| FDM | CPU | `MechanicalBoundaryCondition` IR (`traction_free`, `clamped`, `prescribed_displacement`, `prescribed_traction`) | not yet executed; public FDM mechanics plans fail closed | no executed FDM mechanics BC qualification yet | solver branch lowers 8 BC kinds + ABL + Virieux/Lebedev/2D-Schur + Fredholm plans; v2 runtime adds Schur+BDF2 viscous free surface, conditional $\theta_c$, ABL & ADE CFS-PML |
| FDM | GPU | same `MechanicsIR` boundary-condition schema | not yet executed | no executed FDM GPU BC qualification yet | v2 target: GPU-resident staggered/Lebedev kernels with fused halo/BC/PML updates and zero host transfers |
| FEM | CPU | `MechanicalBoundaryCondition` IR + shared-domain mesh (`resolve_fem_magnetoelastic_plan`) | prescribed-strain field evaluation only; displacement BCs not assembled | prescribed-strain mask and mesh consistency tests | solver branch lowers FM+NM FEM plans & multi-component Fredholm checks; v2 runtime adds `mfem::SubMesh` excluding $\Omega_{\mathrm{air}}$/`Pyramid5`, `FaceKey` BC tags, `Tet10` $\bar{\mathbf{B}}$, `Prism6` `MITC6+EAS-1` + 12-pt quadrature |
| FEM | GPU | same `MechanicsIR` + `FaceKey` mesh pipeline | prescribed-strain CUDA upload/field only; displacement BCs not assembled | prescribed-strain GPU 0-ULP parity gate separate | v2 target: GPU-assembled `SubMesh` operators, `libCEED` PA + `cuDSS` / `Hypre 3.1.0` with essential BC elimination and ADE PML |

(magnetoelastic-bc-python-api)=
## Python API and stage-first example

The stage-first example below executes against the current `master` Python package and constructs
all four `master` `MechanicalBoundaryCondition` variants alongside a heterostructure film and
substrate geometry:

```python
# %% Study and FEM meshing setup
import fullmag as fm

nm = 1.0e-9
study = fm.study("magnetoelastic_bc_authoring_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(fm.Box(80 * nm, 40 * nm, 8 * nm), name="yig_film")
film.mesh(maximum_element_size=4 * nm, order=1)
film.Ms = 1.40e5
film.Aex = 3.7e-12
film.alpha = 0.001
film.m = fm.texture.uniform(0.0, 0.0, 1.0)

# %% Canonical MechanicalBoundaryCondition constructors (master IR boundary)
bc_top = fm.MechanicalBoundaryCondition(kind="traction_free", surface="top")
bc_bottom = fm.MechanicalBoundaryCondition(kind="clamped", surface="bottom")
bc_left = fm.MechanicalBoundaryCondition(
    kind="prescribed_displacement",
    surface="left",
    u=(1.0e-12, 0.0, 0.0),
)
bc_idt = fm.MechanicalBoundaryCondition(
    kind="prescribed_traction",
    surface="idt_pad",
    t=(0.0, 0.0, 1.0e6),
)

# %% Verify ProblemIR serialization and attach study stage
assert bc_top.to_ir() == {"kind": "traction_free", "surface": "top"}
assert bc_bottom.to_ir() == {"kind": "clamped", "surface": "bottom"}
assert bc_left.to_ir()["u"] == [1.0e-12, 0.0, 0.0]
assert bc_idt.to_ir()["t"] == [0.0, 0.0, 1.0e6]
study.stages.add_run(stage_id="bc_authoring_check", until=1.0e-15)
```

For API details on `MechanicalBoundaryCondition`, see
{doc}`/python-api/boundary-conditions/mechanical-boundary-conditions`.

### Exhaustive Python parameter contract (`master`)

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR mapping |
|---|---|---|---|---|---|---|---|
| `MechanicalBoundaryCondition.kind` | `str` | required | `1` | `"traction_free"`, `"clamped"`, `"prescribed_displacement"`, or `"prescribed_traction"` (8 variants in v2) | mechanical boundary condition family on `surface` | IR authoring on `master`; assembled in v2 FDM/FEM | `mechanics.boundary_conditions[].kind` |
| `MechanicalBoundaryCondition.surface` | `str` | required | `1` | non-empty surface selector name | named boundary patch mapped via `FaceKey` (FEM) or grid face (FDM) | IR authoring on `master`; assembled in v2 FDM/FEM | `mechanics.boundary_conditions[].surface` |
| `MechanicalBoundaryCondition.u` | `Sequence[float] \| None` | `None` | `m` | required 3-vector for `"prescribed_displacement"` | prescribed Dirichlet boundary displacement $\bar{\mathbf{u}}$ | IR authoring on `master`; essential BC in v2 | `mechanics.boundary_conditions[].u` |
| `MechanicalBoundaryCondition.t` | `Sequence[float] \| None` | `None` | `Pa` | required 3-vector for `"prescribed_traction"` | prescribed Neumann boundary traction $\bar{\mathbf{t}}$ | IR authoring on `master`; natural BC in v2 | `mechanics.boundary_conditions[].t` |

(magnetoelastic-bc-problem-ir)=
## ProblemIR semantics

On `master`, `MechanicalBoundaryConditionIR` (`crates/fullmag-ir/src/mechanics.rs`) serializes the
four canonical boundary records:

```json
{
  "boundary_conditions": [
    { "kind": "traction_free", "surface": "top" },
    { "kind": "clamped", "surface": "bottom" },
    { "kind": "prescribed_displacement", "surface": "left", "u": [1.0e-12, 0.0, 0.0] },
    { "kind": "prescribed_traction", "surface": "idt_pad", "t": [0.0, 0.0, 1.0e6] }
  ]
}
```

On the dedicated solver branch (FullMag v2), `MechanicalBoundaryConditionIR` adds typed variants
for `roller_symmetry` (`surface`), `periodic` (`pair_id` / `axis`, `allow_affine_macrostrain`),
`lysmer_kuhlemeyer` (`surface`, optional `c_l_override_m_s` / `c_t_override_m_s`), and
`ade_cfs_pml` (`faces`, `width_m` / `thickness_m`, `target_reflection`, `f0_hz`, `mpml_transverse_ratio`),
alongside volumetric `SpatialAbsorbingLayerIR` (`absorbing_boundary` on `ObjectElasticityModuleIR`)
and FEM element-formulation metadata (`tet10_bbar_threshold=0.45`, `tet4_locking_cutoff=0.48`,
`prism6_mitc6_eas1=true`, `prism6_mel_quadrature_points=12`).

(magnetoelastic-bc-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent** preserves every named surface selector, boundary-condition variant,
  displacement/traction vector, absorbing-collar geometry, Floquet wave vector, and mesh element
  formulation request verbatim in `ProblemIR`.
- **Resolved execution** records the materialized `SubMesh`/`ParSubMesh` DOF counts, `FaceKey`
  attribute map, selected FDM grid topology (`virieux_split_anis` vs. `lebedev` vs.
  `plane_stress_2d`), FEM locking projection (`standard`, `tet10_bbar`, `prism6_mitc6_eas1`), and
  per-component RBM nullspace dimension $d_{\mathrm{null}}$.
- **Validation errors** reject unknown surface names, ambiguous object aliases, conflicting
  overlapping essential BCs on the same boundary patch, non-finite displacement/traction vectors,
  specifying both `max_damping` and `target_reflection` on `SpatialAbsorbingLayer`, non-positive
  ABL/PML collar thicknesses, or non-conforming magnetic/substrate meshes.
- **Unsupported combinations** fail closed before execution:
  - `tet4_volumetric_locking_exceeds_limit` when `Tet4` is paired with $\nu_{\mathrm{eff}} \ge 0.48$;
  - `incompressible_taylor_hood_deferred_to_v2_1` when $\nu_{\mathrm{eff}} \ge 0.499$;
  - `anisotropic_pml_slowness_instability` when `"ade_cfs_pml"` violates the Bécache–Fauqueux–Joly
    condition on a crystal slowness sheet without stabilization;
  - `quasistatic_unbalanced_external_load_on_free_component` when a free component carries
    unbalanced external force/torque in quasistatic mode;
  - `free_body_rotational_torque_requires_clamped_bc_or_elastodynamics` when an unconstrained
    component in quasistatic mode carries nonzero magnetic rotational torque or indefinite tangent;
  - `master` execution of any non-prescribed-strain mechanical BC solve fails closed at
    `resolve_fem_magnetoelastic_plan`.

(magnetoelastic-bc-implementation-mapping)=
## Implementation mapping

- **Python BC authoring (`master`):** `packages/fullmag-py/src/fullmag/model/mechanics.py`
  (`class MechanicalBoundaryCondition`).
- **Canonical IR (`master`):** `crates/fullmag-ir/src/mechanics.rs` (`MechanicalBoundaryConditionIR`,
  `ElasticBodyIR`, `MechanicsIR`).
- **Planner boundary (`master`):** `crates/fullmag-plan/src/fem.rs` (`resolve_fem_magnetoelastic_plan`).
- **Shared-domain meshing integration:** inherits FullMag's shared-domain FEM assembly and
  swept-prism pipelines ({doc}`/numerical-methods/meshing/fem/shared-domain/index`,
  {doc}`/numerical-methods/meshing/fem/ferromagnet/swept-prism`) and FDM grid infrastructure
  ({doc}`/numerical-methods/meshing/fdm-grids`), extended in v2 with `SubMesh`/`ParSubMesh`
  airbox/`Pyramid5` stripping, `FaceKey` reconstruction, `MITC6/ANS + EAS-1`, and Virieux/Lebedev
  supergrids.

(magnetoelastic-bc-validation)=
## Validation

Verification of boundary conditions, interfaces, and spatial meshing requires:

1. **Free-surface traction test (G1 & G2):** exact magnetostrictive equilibrium strain under
   `"traction_free"` and exact $\mathrm{Ni}/\mathrm{Al}$ bilayer continuity
   ($\partial_x u_x = -4.48228\times 10^{-6}$,
   $(\sigma_{xx}^{\mathrm{tot}},\sigma_{yy}^{\mathrm{tot}},\sigma_{zz}^{\mathrm{tot}}) = (0, +0.443746, -2.971754)\,\mathrm{MPa}$).
2. **Acoustic impedance transmission test (G6):** $\mathrm{YIG}/\mathrm{GGG}$ normal-incidence
   wave packet reproducing $T_{u,v} = 0.8805$, $T_\sigma = 1.1195$, $T_P = 0.9857$ within $0.5\%$
   across both Virieux/Lebedev FDM and conforming FEM meshes.
3. **Absorbing-boundary reflection test:** broadband acoustic pulse entering `SpatialAbsorbingLayer`
   ABL ($< -40\,\mathrm{dB}$) and `"ade_cfs_pml"` ($< -60\,\mathrm{dB}$ for grazing Rayleigh
   waves), plus fail-closed trigger test on a slowness-unstable anisotropic crystal.
4. **Element locking & quadrature patch tests:**
   - `Prism6` `MITC6/ANS + EAS-1` exact rank $12/18$ eigenvalue test (6 zero RBM eigenvalues, 12
     strictly positive eigenvalues, zero hourglass modes) and thin-plate flexural Lamb-wave match;
   - `Prism6` 12-point `IntRules(PRISM, 3)` vs. 6-point quadrature test confirming elimination of
     the $1.852\%$ cubic $L_1^3$ integration error;
   - `Tet10` $\bar{\mathbf{B}}$ bending/compression convergence at $\nu_{\mathrm{eff}} = 0.49$ and
     fail-closed rejection of `Tet4` at $\nu_{\mathrm{eff}} = 0.48$.
5. **Multi-component Fredholm RBM test:** disconnected two-body free mesh verifying
   $d_{\mathrm{null}} = 12$ without rotational coupling, $d_{\mathrm{null}} = 8$ under collinear
   uniaxial rotational coupling, and fail-closed rejection under unbalanced external loads or
   nonzero net rotational torque.

(magnetoelastic-bc-limitations)=
## Limitations

- On `master`, boundary conditions are authored in `ProblemIR` only; displacement assembly,
  absorbing collars, `SubMesh` elasticity extraction, and locking-free element formulations are
  not yet active in runtime binaries (8-kind BC authoring, ABL, and multi-component Fredholm
  planner contracts live on the dedicated solver branch pending runtime kernel qualification).
- Mixed $P_2/P_1$ Taylor–Hood elements for strictly incompressible solids ($\nu_{\mathrm{eff}} \ge 0.499$)
  are deferred to v2.1.
- Frictional contact, interfacial delamination, and non-conforming mortar/Nitsche tied interfaces
  between independently meshed bodies are outside v2 scope (meshes across $\Gamma_{\mathrm{FM/NM}}$
  must be topologically conforming).

(magnetoelastic-bc-scientific-bibliography)=
## Scientific bibliography

1. J. Virieux, "P-SV wave propagation in heterogeneous media: Velocity-stress finite-difference
   method," *Geophysics* **51**(4), 889–901 (1986),
   [doi:10.1190/1.1442147](https://doi.org/10.1190/1.1442147).
2. P. Moczo, J. Kristek, V. Vavryčuk, R. J. Archuleta, and L. Halada, "3D heterogeneous
   staggered-grid finite-difference modeling of seismic motion with volume harmonic and arithmetic
   averaging of elastic moduli and densities," *Bulletin of the Seismological Society of America*
   **92**(8), 3042–3066 (2002), [doi:10.1785/0120010167](https://doi.org/10.1785/0120010167).
3. V. Lisitsa and D. Vishnevskiy, "Lebedev scheme for the numerical simulation of wave propagation
   in 3D anisotropic elasticity," *Geophysical Prospecting* **58**(4), 619–635 (2010),
   [doi:10.1111/j.1365-2478.2009.00862.x](https://doi.org/10.1111/j.1365-2478.2009.00862.x).
4. E. Bécache, S. Fauqueux, and P. Joly, "Stability of perfectly matched layers, group velocities
   and anisotropic waves," *Journal of Computational Physics* **188**(2), 399–433 (2003),
   [doi:10.1016/S0021-9991(03)00184-0](https://doi.org/10.1016/S0021-9991(03)00184-0).
5. D. Komatitsch and R. Martin, "An unsplit convolutional perfectly matched layer improved at
   grazing incidence for the seismic wave equation," *Geophysics* **72**(5), SM155–SM167 (2007),
   [doi:10.1190/1.2757586](https://doi.org/10.1190/1.2757586).
6. W. Zhang and Y. Shen, "Unsplit complex frequency-shifted PML implementation using auxiliary
   differential equations for seismic wave modeling," *Geophysics* **75**(4), T141–T154 (2010),
   [doi:10.1190/1.3463431](https://doi.org/10.1190/1.3463431).
7. K.-J. Bathe and E. N. Dvorkin, "A formulation of general shell elements—the use of mixed
   interpolation of tensorial components," *International Journal for Numerical Methods in
   Engineering* **22**(3), 697–722 (1986),
   [doi:10.1002/nme.1620220312](https://doi.org/10.1002/nme.1620220312).
8. J. C. Simo and M. S. Rifai, "A class of mixed assumed strain methods and the method of
   incompatible modes," *International Journal for Numerical Methods in Engineering* **29**(8),
   1595–1638 (1990), [doi:10.1002/nme.1620290802](https://doi.org/10.1002/nme.1620290802).
9. T. J. R. Hughes, "Generalization of selective integration procedures to anisotropic and
   nonlinear media," *International Journal for Numerical Methods in Engineering* **15**(9),
   1413–1418 (1980), [doi:10.1002/nme.1620150914](https://doi.org/10.1002/nme.1620150914).
10. T. J. R. Hughes, *The Finite Element Method: Linear Static and Dynamic Finite Element
    Analysis*, Dover Publications, 2000.
11. P. Flauger, M. Küß, M. K. Steinbauer, F. Bruckner, B. Emhofer, E. Nysten, M. Weiß,
    D. Suess, H. J. Krenner, M. Albrecht, and C. Abert, "Modeling magnetoelastic wave interactions
    in magnetic films and heterostructures: A finite-difference approach," *Physical Review
    Applied* **25**(3) (2026), [doi:10.1103/9txq-sc8f](https://doi.org/10.1103/9txq-sc8f)
    (Hybrid OA CC-BY; [arXiv:2509.06007](https://arxiv.org/abs/2509.06007)).
12. R. Anderson *et al.*, "MFEM: A modular finite element methods library," *Computers &
    Mathematics with Applications* **81**, 42–74 (2021),
    [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

(magnetoelastic-bc-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/mechanics.py`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/packages/fullmag-py/src/fullmag/model/mechanics.py#L135) | `class MechanicalBoundaryCondition` | Python authoring and validation of mechanical boundary conditions |
| [`crates/fullmag-ir/src/mechanics.rs`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/crates/fullmag-ir/src/mechanics.rs#L66) | `MechanicalBoundaryConditionIR` | Canonical Rust IR serialization for mechanical boundary conditions |
| [`crates/fullmag-ir/src/mechanics.rs`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/crates/fullmag-ir/src/mechanics.rs#L37) | `ElasticBodyIR` | Elastic body geometry-to-material IR record |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/9dee602ba086f95b1ae7477f1b0ea69e2d9cef50/crates/fullmag-plan/src/fem.rs#L2900) | `resolve_fem_magnetoelastic_plan` | FEM mechanics capability boundary and fail-closed planner checks |
| Specification contract (v2) | {ref}`Eight mechanical BCs <magnetoelastic-v2-bc-catalog-contract>` | Planned v2 contract for all 8 mechanical boundary conditions and acoustic ABL |
| Specification contract (v2) | {ref}`Rayleigh ABL and ADE CFS-PML <magnetoelastic-v2-absorbing-boundaries-contract>` | Planned v2 contract for Rayleigh sponge ABL, Lysmer–Kuhlemeyer impedance, and ADE CFS-PML |
| Specification contract (v2) | {ref}`Multilayer interfaces <magnetoelastic-v2-interfaces-contract>` | Planned v2 contract for multilayer interface jumps and conditional FDM stabilizer |
| Specification contract (v2) | {ref}`Fredholm RBM well-posedness <magnetoelastic-v2-fredholm-rbm-contract>` | Planned v2 contract for multi-component Fredholm well-posedness and RBM nullspace |
| Specification contract (v2) | {ref}`FDM staggered and Lebedev grids <magnetoelastic-v2-fdm-meshing-contract>` | Planned v2 contract for Virieux, 4-grid Lebedev, and 2D plane-stress Schur condensation |
| Specification contract (v2) | {ref}`FEM SubMesh and locking policy <magnetoelastic-v2-fem-meshing-contract>` | Planned v2 contract for FEM SubMesh, `FaceKey`, `Tet10` B-bar, and `Prism6` `MITC6+EAS-1` |
