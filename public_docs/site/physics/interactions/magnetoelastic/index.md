---
title: Magnetoelastic interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-magnetoelastic)=
# Magnetoelastic interaction

Magnetoelasticity couples magnetization dynamics $\mathbf{m}(\mathbf{r},t)$ to lattice strain
$\boldsymbol{\varepsilon}(\mathbf{r},t)$ and local lattice rotation
$\boldsymbol{\omega}(\mathbf{r},t)$ across magnetic films and hybrid ferromagnet–substrate
heterostructures. This page provides the complete continuum theory, tensor and sign conventions,
all seven anisotropic crystal-symmetry classes, Born stability criteria, Bond crystal-frame
rotations, variational derivations of cubic, isotropic, hexagonal, and rotational couplings, the
coupled Landau–Lifshitz–Gilbert (LLG)–elastodynamics partial differential equations, energy and
angular-momentum balance laws, mechanical damping models, thermal acoustic fluctuations, and
external acoustic/optical drives.

```{toctree}
:maxdepth: 1

boundary-conditions-and-meshing
numerical-methods-and-libraries
```

:::{important}
**Current executable boundary vs. bidirectional v2 architecture.**
On the current `master` revision, the executable runtime subset is one-way cubic $B_1/B_2$
coupling to **prescribed strain** on FEM CPU and FEM GPU (with local FDM reference kernels below
the public planner boundary). Full two-way elastodynamics, quasistatic equilibrium solves,
anisotropic 7-class elasticity, hexagonal 4-constant magnetostriction, Melcher magneto-rotational
coupling, mechanical damping, absorbing layers, and thermal acoustic baths constitute the
verified FullMag v2 specification documented across this three-page reference subtree and fail
closed at the planner boundary until their corresponding solver modules are activated.
:::

(physics-magnetoelastic-problem-statement)=
## Physical problem

In spintronic, magnonic, and surface-acoustic-wave (SAW) devices, magnetic layers occupy a domain
$\Omega_{\mathrm{mag}} \subseteq \Omega_{\mathrm{mech}}$ bonded to a non-magnetic elastic
substrate $\Omega_{\mathrm{sub}} = \Omega_{\mathrm{mech}} \setminus \Omega_{\mathrm{mag}}$.
Representative heterostructures include $\mathrm{Ni}/\mathrm{Al}$ bilayers, epitaxial
$\mathrm{YIG}(111)/\mathrm{GGG}(111)$ stacks, $\mathrm{Co}/\mathrm{LiNbO}_3$,
$\mathrm{Ni}/\mathrm{LiNbO}_3$, and $\mathrm{Ta}/\mathrm{CoFeB}(1.6\,\mathrm{nm})/\mathrm{MgO}$
on Y-cut $\mathrm{LiNbO}_3$.

Two distinct physical regimes arise:

1. **One-way prescribed strain (currently executable FEM CPU/GPU subset):** an externally supplied
   engineering-Voigt strain field $\boldsymbol{\varepsilon}^{\mathrm{eng}}(\mathbf{r})$ generates
   a magnetoelastic effective field $\mathbf{H}_{\mathrm{mel}}[\mathbf{m}, \boldsymbol{\varepsilon}]$
   in the LLG equation without solving for mechanical displacement $\mathbf{u}(\mathbf{r},t)$ or
   magnetic back-action stress $\boldsymbol{\sigma}^{\mathrm{mel}}(\mathbf{m})$.
2. **Bidirectional magnon–phonon coupling (FullMag v2 architecture):** the magnetization field
   $\mathbf{m}(\mathbf{r},t)$ on $\Omega_{\mathrm{mag}}$ and the elastic displacement field
   $\mathbf{u}(\mathbf{r},t)$ on the entire solid $\Omega_{\mathrm{mech}}$ evolve self-consistently.
   Lattice strain and rotation act on spins through $\mathbf{H}_{\mathrm{mel}} + \mathbf{H}_{\mathrm{rot}}$,
   while spin textures exert magnetostrictive and rotational back-action stresses
   $\boldsymbol{\sigma}^{\mathrm{mel}} + \boldsymbol{\sigma}^{\mathrm{rot}}$ that launch bulk
   longitudinal/transverse acoustic waves, surface Rayleigh/Love waves, and hybrid
   magnon–polarons into $\Omega_{\mathrm{sub}}$.

```{figure} /_static/diagrams/magnetoelastic-voigt-strain-coupling.svg
:alt: Two-panel diagram of magnetoelastic coupling in Fullmag: Panel (a) maps the symmetric 3x3 strain tensor to the 6-component engineering-Voigt vector (epsilon_11, epsilon_22, epsilon_33, gamma_23, gamma_13, gamma_12), highlighting the factor of 2 in engineering shear gamma_ij = 2 epsilon_ij and the resulting B_1/B_2 energy density and field; Panel (b) maps the Fullmag mechanics object graph and separates the executable FEM prescribed-strain subset from fail-closed FDM and coupled-mechanics roadmaps.
:width: 100%
:name: fig-magnetoelastic-voigt-strain-coupling
:figclass: fm-physics-figure

Engineering-Voigt strain convention and FullMag magnetoelastic object-graph boundaries. Panel (a)
shows the tensor-to-Voigt mapping where normal strains couple through $B_1$ and engineering shear
strains $\gamma_{ij}=2\varepsilon_{ij}$ are halved in the kernel to recover tensor shear
$\varepsilon_{ij}$ in $2B_2\varepsilon_{ij}m_im_j$ (compare Kittel 1949; Vanderveken *et al.*
2021). Panel (b) shows `ElasticMaterial`, `ElasticBody`, `MagnetostrictionLaw`, `MechanicalLoad`,
and `Magnetoelastic`, isolating the executable FEM CPU/GPU prescribed-strain subset from
semantic-only isotropic laws, FDM public plans, and coupled elasticity/elastodynamics solvers
(Vanderveken *et al.* 2021; Flauger *et al.* 2026).
```

Boundary conditions, absorbing boundaries (Rayleigh sponge ABL and ADE CFS-PML), multilayer
interfaces, and FDM/FEM spatial meshing are documented in
{doc}`boundary-conditions-and-meshing`. Discretization schemes, stability proofs, time
integrators, eigensolvers, CUDA/AVX-512/MPI optimizations, and external numerical libraries
(`cuDSS`, `oneMKL PARDISO`, `Hypre`, `MFEM`, `libCEED`, `PETSc`, `SLEPc`, `MUMPS`) are
documented in {doc}`numerical-methods-and-libraries`.

(physics-magnetoelastic-governing-equations)=
## Governing equations and continuum derivations

### Continuum kinematics, engineering Voigt, and orthonormal Kelvin–Mandel bases

For a displacement field $\mathbf{u}(\mathbf{r},t) = (u_1, u_2, u_3)^\top$ in Cartesian
laboratory coordinates $(x_1, x_2, x_3) \equiv (x, y, z)$, the displacement gradient decomposes
additively into the symmetric infinitesimal strain tensor $\boldsymbol{\varepsilon}$ and the
antisymmetric infinitesimal lattice rotation tensor $\boldsymbol{\omega}$:

```{math}
:label: eq-mel-kinematics-strain-rotation
\varepsilon_{ij}
=
\frac{1}{2}\left(\frac{\partial u_i}{\partial x_j} + \frac{\partial u_j}{\partial x_i}\right),
\qquad
\omega_{ij}
=
\frac{1}{2}\left(\frac{\partial u_i}{\partial x_j} - \frac{\partial u_j}{\partial x_i}\right),
\qquad
\theta_k
=
\frac{1}{2}(\nabla \times \mathbf{u})_k
=
-\frac{1}{2}\epsilon_{ijk}\omega_{ij},
```

so that $\omega_{ij} = -\epsilon_{ijk}\theta_k$ and, to first order in $\lvert\boldsymbol{\theta}\rvert \ll 1$,
an infinitesimal rigid rotation maps any material vector $\mathbf{a}$ as
$\delta \mathbf{a} = \boldsymbol{\theta} \times \mathbf{a} = \boldsymbol{\omega}\mathbf{a}$.

FullMag adopts the canonical Voigt index ordering
$I \in \{1, 2, 3, 4, 5, 6\} \leftrightarrow (11, 22, 33, 23, 13, 12)$ throughout Python,
`ProblemIR`, Rust, C++, and CUDA. The public six-component **engineering-Voigt strain vector**
and **stress Voigt vector** are

```{math}
:label: eq-public-magnetoelastic-mel-voigt
\boldsymbol{\varepsilon}^{\mathrm{eng}}
=
(\varepsilon_{11}, \varepsilon_{22}, \varepsilon_{33},
\gamma_{23}, \gamma_{13}, \gamma_{12})^\top
=
\mathbf{W}_V \boldsymbol{\varepsilon}_{\mathrm{ten}},
\qquad
\gamma_{ij} = 2\varepsilon_{ij} \;\; (i \neq j),
```

```{math}
:label: eq-mel-stress-voigt-and-kelvin-mandel
\boldsymbol{\sigma}_V
=
(\sigma_{11}, \sigma_{22}, \sigma_{33},
\sigma_{23}, \sigma_{13}, \sigma_{12})^\top,
\qquad
\mathbf{W}_V = \operatorname{diag}(1, 1, 1, 2, 2, 2),
\qquad
\mathbf{W}_{\mathrm{KM}} = \operatorname{diag}(1, 1, 1, \sqrt{2}, \sqrt{2}, \sqrt{2}),
```

where $\boldsymbol{\varepsilon}_{\mathrm{ten}} = (\varepsilon_{11},\varepsilon_{22},\varepsilon_{33},\varepsilon_{23},\varepsilon_{13},\varepsilon_{12})^\top$.
While the dual pair $(\boldsymbol{\sigma}_V, \boldsymbol{\varepsilon}^{\mathrm{eng}})$ preserves
virtual work via $\boldsymbol{\sigma}:\boldsymbol{\varepsilon} = \boldsymbol{\sigma}_V^\top \boldsymbol{\varepsilon}^{\mathrm{eng}}$,
the engineering-Voigt basis is **not** orthonormal in the Frobenius inner product of symmetric
second-order tensors. For spectral bounds, CFL acoustic-velocity estimates, and SVD/eigenvalue
diagnostics, FullMag transforms stiffness and viscosity into the orthonormal **Kelvin–Mandel**
representation:

```{math}
:label: eq-mel-kelvin-mandel-stiffness
\boldsymbol{\varepsilon}_{\mathrm{KM}} = \mathbf{W}_{\mathrm{KM}} \boldsymbol{\varepsilon}_{\mathrm{ten}},
\qquad
\boldsymbol{\sigma}_{\mathrm{KM}} = \mathbf{W}_{\mathrm{KM}} \boldsymbol{\sigma}_V,
\qquad
\mathbf{C}_{\mathrm{KM}} = \mathbf{W}_{\mathrm{KM}} \mathbf{C}_V \mathbf{W}_{\mathrm{KM}}.
```

Because $\boldsymbol{\sigma}:\boldsymbol{\varepsilon} = \boldsymbol{\sigma}_{\mathrm{KM}}^\top \boldsymbol{\varepsilon}_{\mathrm{KM}}$
and $\lVert\boldsymbol{\varepsilon}\rVert_F = \lVert\boldsymbol{\varepsilon}_{\mathrm{KM}}\rVert_2$,
the Kelvin–Mandel operator 2-norm provides a rigorous upper bound on the acoustic Christoffel
tensor $\Gamma_{ik}(\hat{\mathbf{n}}) = C_{ijkl} n_j n_l$ (units $\mathrm{Pa}$) for every unit
wave normal $\hat{\mathbf{n}} \in S^2$:

```{math}
:label: eq-mel-christoffel-km-bound
\lambda_{\max}\!\left(\boldsymbol{\Gamma}(\hat{\mathbf{n}})\right)
\le
\left\lVert \mathbf{C}_{\mathrm{KM}} \right\rVert_2,
\qquad
c_{\max}
=
\sqrt{\frac{\max_{\hat{\mathbf{n}} \in S^2} \lambda_{\max}(\boldsymbol{\Gamma}(\hat{\mathbf{n}}))}{\rho}}
\le
\sqrt{\frac{\left\lVert \mathbf{C}_{\mathrm{KM}} \right\rVert_2}{\rho}}.
```

By contrast, the raw Voigt norm $\lVert\mathbf{C}_V\rVert_2$ is **not** a valid upper bound on
$\lambda_{\max}(\boldsymbol{\Gamma}(\hat{\mathbf{n}}))$: for the SPD matrix
$\mathbf{C}_V = \operatorname{diag}(1, 0.99, 1, 1, 1, 1)\,\mathrm{GPa}$,
$\lVert\mathbf{C}_V\rVert_2 = 1\,\mathrm{GPa}$, whereas for $\hat{\mathbf{n}} = \hat{\mathbf{e}}_1$
and shear polarization $\hat{\mathbf{e}}_2$, $\Gamma_{22}(\hat{\mathbf{e}}_1) = C_{66} = 1\,\mathrm{GPa}$
and along $\hat{\mathbf{n}} = \frac{1}{\sqrt{2}}(\hat{\mathbf{e}}_1 + \hat{\mathbf{e}}_2)$,
$\lambda_{\max}(\boldsymbol{\Gamma}(\hat{\mathbf{n}})) = \frac{1}{2}(C_{11}+C_{66}) + \dots > 1\,\mathrm{GPa}$
when $\mathbf{C}_{\mathrm{KM}}$ scales shear entries by $2$ (yielding
$\lVert\mathbf{C}_{\mathrm{KM}}\rVert_2 = 2\,\mathrm{GPa}$). Every planner stability check and
explicit CFL bound therefore uses $\mathbf{C}_{\mathrm{KM}}$ or direct maximization of
$\boldsymbol{\Gamma}(\hat{\mathbf{n}})$ over $S^2$.

(magnetoelastic-v2-anisotropic-elasticity-contract)=
### Anisotropic linear elasticity across all seven crystal symmetry classes

Hooke's law in engineering-Voigt form reads $\boldsymbol{\sigma}_V = \mathbf{C}_V \boldsymbol{\varepsilon}^{\mathrm{eng}}$
with elastic strain-energy density

```{math}
:label: eq-mel-elastic-energy
w_{\mathrm{el}}(\boldsymbol{\varepsilon})
=
\frac{1}{2} \varepsilon_{ij} C_{ijkl} \varepsilon_{kl}
=
\frac{1}{2} (\boldsymbol{\varepsilon}^{\mathrm{eng}})^\top \mathbf{C}_V \boldsymbol{\varepsilon}^{\mathrm{eng}}
=
\frac{1}{2} \boldsymbol{\varepsilon}_{\mathrm{KM}}^\top \mathbf{C}_{\mathrm{KM}} \boldsymbol{\varepsilon}_{\mathrm{KM}},
```

where $\mathbf{C}_V = \mathbf{C}_V^\top \in \mathbb{R}^{6\times 6}$ satisfies major and minor
symmetries $C_{ijkl} = C_{jikl} = C_{ijlk} = C_{klij}$. In the crystal's principal frame, FullMag
v2 supports all seven symmetry classes below.

1. **`isotropic` (2 constants: Lamé $(\lambda, \mu)$ or $(E, \nu)$):**
   $C_{11} = \lambda + 2\mu$, $C_{12} = \lambda$, $C_{44} = \mu = \frac{C_{11}-C_{12}}{2}$, with
   $\lambda = \frac{E\nu}{(1+\nu)(1-2\nu)}$ and $\mu = \frac{E}{2(1+\nu)}$.
2. **`cubic` (3 constants: $C_{11}, C_{12}, C_{44}$):**
   Zener anisotropy ratio $A_Z = \frac{2C_{44}}{C_{11}-C_{12}}$ (isotropic when $A_Z = 1$).
3. **`hexagonal` (5 constants: $C_{11}, C_{12}, C_{13}, C_{33}, C_{44}$, with $C_{66} = \frac{C_{11}-C_{12}}{2}$):**
   transversely isotropic about the crystal $c$-axis $\hat{\mathbf{c}} = \hat{\mathbf{e}}_3^{\mathrm{cryst}}$
   (e.g., hcp $\mathrm{Co}$, $\mathrm{ZnO}$, $\mathrm{AlN}$).
4. **`trigonal_3m` (6 constants: $C_{11}, C_{12}, C_{13}, C_{14}, C_{33}, C_{44}$, with $C_{66} = \frac{C_{11}-C_{12}}{2}$):**
   explicitly captures piezoelectric/acoustic substrates such as $\mathrm{LiNbO}_3$, $\mathrm{LiTaO}_3$,
   $\alpha$-quartz, and hematite ($\alpha\text{-Fe}_2\mathrm{O}_3$):

```{math}
:label: eq-mel-trigonal-3m-voigt
\mathbf{C}_V^{\mathrm{trigonal\_3m}}
=
\begin{pmatrix}
C_{11} & C_{12} & C_{13} & C_{14} & 0 & 0 \\
C_{12} & C_{11} & C_{13} & -C_{14} & 0 & 0 \\
C_{13} & C_{13} & C_{33} & 0 & 0 & 0 \\
C_{14} & -C_{14} & 0 & C_{44} & 0 & 0 \\
0 & 0 & 0 & 0 & C_{44} & C_{14} \\
0 & 0 & 0 & 0 & C_{14} & \frac{1}{2}(C_{11}-C_{12})
\end{pmatrix}.
```

Note the exact symmetry signs: $C_{14} = -C_{24} = C_{56}$ in Voigt $(23, 13, 12)$ ordering.
Setting $C_{14} = 0$ recovers `hexagonal`; setting $C_{14}=0$, $C_{33}=C_{11}$, $C_{13}=C_{12}$
recovers `cubic` when $C_{66}=C_{44}$.

5. **`tetragonal_4mmm` (6 constants: $C_{11}, C_{12}, C_{13}, C_{33}, C_{44}, C_{66}$):**
   same block pattern as `hexagonal` except $C_{66}$ is independent of $(C_{11}-C_{12})/2$ (e.g.,
   $L1_0$-$\mathrm{FePt}$, $\mathrm{Mn}_2\mathrm{Au}$, $\mathrm{Fe}_2\mathrm{CoSi}$).
6. **`orthorhombic` (9 constants: $C_{11}, C_{22}, C_{33}, C_{12}, C_{13}, C_{23}, C_{44}, C_{55}, C_{66}$):**
   symmetric upper-left $3\times 3$ normal block and diagonal $3\times 3$ shear block.
7. **`anisotropic_voigt21` (21 independent constants):**
   arbitrary symmetric positive-definite $6\times 6$ matrix $\mathbf{C}_V = \mathbf{C}_V^\top \succ 0$
   covering monoclinic and triclinic crystals and arbitrarily cut wafers.

#### Born mechanical stability criteria

Elastic energy convexity $w_{\mathrm{el}}(\boldsymbol{\varepsilon}) > 0$ for all nonzero strains
requires strict positive definiteness $\mathbf{C}_V \succ 0$ (Born & Huang 1954; Mouhat &
Coudert 2014). Every class admits closed-form Sylvester principal-minor inequalities, and the v2
validator additionally verifies Cholesky factorization $\mathbf{C}_V = \mathbf{L}\mathbf{L}^\top$
with $\lambda_{\min}(\mathbf{C}_{\mathrm{KM}}) > 0$:

| Symmetry class | Independent constants | Exact Born stability inequalities ($\mathbf{C}_V \succ 0$) |
|---|---:|---|
| `isotropic` | 2 | $\mu > 0,\; \lambda + \frac{2}{3}\mu > 0$ (equivalently $E > 0,\; -1 < \nu < \frac{1}{2}$) |
| `cubic` | 3 | $C_{44} > 0,\; C_{11} - C_{12} > 0,\; C_{11} + 2C_{12} > 0$ |
| `hexagonal` | 5 | $C_{44} > 0,\; C_{11} > \lvert C_{12}\rvert,\; (C_{11}+C_{12})C_{33} > 2C_{13}^2$ |
| `trigonal_3m` | 6 | $C_{44} > 0,\; C_{11} > \lvert C_{12}\rvert,\; (C_{11}+C_{12})C_{33} > 2C_{13}^2,\; (C_{11}-C_{12})C_{44} > 2C_{14}^2$ |
| `tetragonal_4mmm` | 6 | $C_{44} > 0,\; C_{66} > 0,\; C_{11} > \lvert C_{12}\rvert,\; (C_{11}+C_{12})C_{33} > 2C_{13}^2$ |
| `orthorhombic` | 9 | $C_{11}, C_{22}, C_{33}, C_{44}, C_{55}, C_{66} > 0$, $C_{11}C_{22} > C_{12}^2$, and $\det(\mathbf{C}_{1:3,1:3}) > 0$ |
| `anisotropic_voigt21` | 21 | All 6 leading principal minors positive (Cholesky $\mathbf{C}_V = \mathbf{L}\mathbf{L}^\top$ succeeds with $L_{ii} > 0$) |

#### Bond transformation for arbitrary crystal orientations

When the crystal principal axes $(\hat{\mathbf{a}}_1, \hat{\mathbf{a}}_2, \hat{\mathbf{a}}_3)$
are rotated relative to the laboratory frame by a proper orthogonal matrix
$\mathbf{R} \in SO(3)$ whose columns are the crystal basis vectors expressed in laboratory
coordinates ($\mathbf{v}^{\mathrm{lab}} = \mathbf{R}\mathbf{v}^{\mathrm{cryst}}$, validated to
$\lVert\mathbf{R}^\top\mathbf{R} - \mathbf{I}\rVert_F \le 10^{-12}$ and $\lvert\det\mathbf{R}-1\rvert \le 10^{-12}$),
the fourth-rank stiffness tensor transforms via the $6\times 6$ **Bond matrix**
$\mathbf{M}_\sigma(\mathbf{R})$ (Auld 1973):

```{math}
:label: eq-mel-bond-transformation
\mathbf{C}_V^{\mathrm{lab}}
=
\mathbf{M}_\sigma(\mathbf{R})\, \mathbf{C}_V^{\mathrm{cryst}}\, \mathbf{M}_\sigma^\top(\mathbf{R}),
\qquad
\mathbf{M}_\varepsilon(\mathbf{R})
=
\mathbf{W}_V \mathbf{W}_V^{-1}\text{-dual}
=
\mathbf{M}_\sigma^{-\top}(\mathbf{R})
=
\mathbf{M}_\sigma(\mathbf{R}^{-1})^\top,
```

with explicit block structure in $(11, 22, 33, 23, 13, 12)$ Voigt ordering:

```{math}
:label: eq-mel-bond-matrix-explicit
\mathbf{M}_\sigma(\mathbf{R})
=
\begin{pmatrix}
R_{11}^2 & R_{12}^2 & R_{13}^2 & 2R_{12}R_{13} & 2R_{13}R_{11} & 2R_{11}R_{12} \\
R_{21}^2 & R_{22}^2 & R_{23}^2 & 2R_{22}R_{23} & 2R_{23}R_{21} & 2R_{21}R_{22} \\
R_{31}^2 & R_{32}^2 & R_{33}^2 & 2R_{32}R_{33} & 2R_{33}R_{31} & 2R_{31}R_{32} \\
R_{21}R_{31} & R_{22}R_{32} & R_{23}R_{33} & R_{22}R_{33}+R_{23}R_{32} & R_{21}R_{33}+R_{23}R_{31} & R_{22}R_{31}+R_{21}R_{32} \\
R_{31}R_{11} & R_{32}R_{12} & R_{33}R_{13} & R_{12}R_{33}+R_{13}R_{32} & R_{13}R_{31}+R_{11}R_{33} & R_{11}R_{32}+R_{12}R_{31} \\
R_{11}R_{21} & R_{12}R_{22} & R_{13}R_{23} & R_{12}R_{23}+R_{13}R_{22} & R_{13}R_{21}+R_{11}R_{23} & R_{11}R_{22}+R_{12}R_{21}
\end{pmatrix}.
```

Because $\mathbf{M}_\sigma(\mathbf{R})$ is nonsingular for every $\mathbf{R}\in SO(3)$, Sylvester's
law of inertia guarantees that $\mathbf{C}_V^{\mathrm{lab}} \succ 0$ if and only if
$\mathbf{C}_V^{\mathrm{cryst}} \succ 0$. In particular, for epitaxial $\mathrm{YIG}(111)/\mathrm{GGG}(111)$
films with $\hat{\mathbf{e}}_3^{\mathrm{lab}} \parallel [111]$, $\hat{\mathbf{e}}_1^{\mathrm{lab}} \parallel [1\bar{1}0]$,
$\hat{\mathbf{e}}_2^{\mathrm{lab}} \parallel [11\bar{2}]$, the Bond matrix produces exact trigonal-like
off-diagonal couplings ($C_{14}^{\mathrm{lab}} \neq 0$) even though cubic YIG is nearly isotropic
($A_Z \approx 0.947$).

### Total coupled free-energy functional and magnetostriction laws

The total continuum free energy of a coupled magnetic–elastic system is

```{math}
:label: eq-mel-total-free-energy
\mathcal{F}[\mathbf{m}, \mathbf{u}]
=
\underbrace{\int_{\Omega_{\mathrm{mag}}} w_{\mathrm{mag}}(\mathbf{m}, \nabla\mathbf{m})\,dV}_{\mathcal{F}_{\mathrm{mag}}}
+
\underbrace{\int_{\Omega_{\mathrm{mech}}} \frac{1}{2}(\boldsymbol{\varepsilon}^{\mathrm{eng}})^\top \mathbf{C}_V^{\mathrm{lab}} \boldsymbol{\varepsilon}^{\mathrm{eng}}\,dV}_{\mathcal{F}_{\mathrm{el}}}
+
\underbrace{\int_{\Omega_{\mathrm{mag}}} w_{\mathrm{mel}}(\mathbf{m}, \boldsymbol{\varepsilon})\,dV}_{\mathcal{F}_{\mathrm{mel}}}
+
\underbrace{\int_{\Omega_{\mathrm{mag}}} w_{\mathrm{rot}}(\mathbf{m}, \boldsymbol{\omega})\,dV}_{\mathcal{F}_{\mathrm{rot}}},
```

where the micromagnetic energy density $w_{\mathrm{mag}}$ collects exchange, demagnetization,
Zeeman, magnetocrystalline anisotropy, and DMI terms. By the variational principle at constant
temperature, the magnetoelastic effective field $\mathbf{H}_{\mathrm{mel}}$ and symmetric
magnetostrictive back-action stress $\boldsymbol{\sigma}^{\mathrm{mel}}$ follow from the exact
partial derivatives

```{math}
:label: eq-public-magnetoelastic-mel-field
\mathbf{H}_{\mathrm{mel}}
=
-\frac{1}{\mu_0 M_s} \frac{\partial w_{\mathrm{mel}}}{\partial \mathbf{m}},
\qquad
\sigma_{ij}^{\mathrm{mel}}
=
\frac{\partial w_{\mathrm{mel}}}{\partial \varepsilon_{ij}}
\quad\Longleftrightarrow\quad
\boldsymbol{\sigma}_V^{\mathrm{mel}}
=
\frac{\partial w_{\mathrm{mel}}}{\partial \boldsymbol{\varepsilon}^{\mathrm{eng}}}.
```

#### Cubic magnetostriction: prescribed-strain vs. traceless bidirectional convention

In the currently executable **prescribed-strain** realization (`master`), the cubic magnetoelastic
energy density is written in the classical Kittel (1949) form:

```{math}
:label: eq-public-magnetoelastic-mel-density
w_{\mathrm{mel}}
=
B_1(\varepsilon_{11}m_1^2 + \varepsilon_{22}m_2^2 + \varepsilon_{33}m_3^2)
+
2B_2(\varepsilon_{12}m_1 m_2 + \varepsilon_{13}m_1 m_3 + \varepsilon_{23}m_2 m_3),
```

whose laboratory $x$-component effective field (with $\varepsilon_{ij} = \tfrac{1}{2}\gamma_{ij}$
for $i \neq j$) is

```{math}
:label: eq-public-magnetoelastic-mel-field-x
H_{\mathrm{mel},1}
=
-\frac{2B_1 \varepsilon_{11} m_1 + 2B_2(\varepsilon_{12} m_2 + \varepsilon_{13} m_3)}{\mu_0 M_s},
```

and cyclically for $H_{\mathrm{mel},2}$ and $H_{\mathrm{mel},3}$.

For **bidirectional elastodynamics** (FullMag v2), the deviatoric (traceless) cubic energy density
in crystal coordinates ($\tilde{\mathbf{m}} = \mathbf{R}^\top \mathbf{m}$,
$\tilde{\boldsymbol{\varepsilon}} = \mathbf{R}^\top \boldsymbol{\varepsilon} \mathbf{R}$) is

```{math}
:label: eq-mel-cubic-traceless
w_{\mathrm{mel}}^{\mathrm{cubic,tr}}(\tilde{\mathbf{m}}, \tilde{\boldsymbol{\varepsilon}})
=
B_1 \sum_{i=1}^{3} \tilde{\varepsilon}_{ii}\!\left(\tilde{m}_i^2 - \frac{1}{3}\right)
+
2B_2\left(\tilde{\varepsilon}_{12}\tilde{m}_1\tilde{m}_2
+ \tilde{\varepsilon}_{13}\tilde{m}_1\tilde{m}_3
+ \tilde{\varepsilon}_{23}\tilde{m}_2\tilde{m}_3\right).
```

Because $\sum_i \tilde{m}_i^2 = 1$, Equation {eq}`eq-mel-cubic-traceless` differs from
{eq}`eq-public-magnetoelastic-mel-density` solely by $-\frac{1}{3}B_1 \operatorname{tr}\boldsymbol{\varepsilon}$,
which is independent of $\mathbf{m}$. Consequently:

- At fixed strain $\boldsymbol{\varepsilon}$, **both forms yield the exact same $\mathbf{H}_{\mathrm{mel}}$**
  and identical LLG dynamics.
- When $\mathbf{u}$ is solved dynamically, the traceless form yields a zero-trace hydrostatic-free
  back-action stress $\operatorname{tr}\boldsymbol{\sigma}^{\mathrm{mel,cubic}} = B_1(\lvert\tilde{\mathbf{m}}\rvert^2 - 1) = 0$:

```{math}
:label: eq-mel-cubic-stress-crystal
\tilde{\sigma}_{ii}^{\mathrm{mel}} = B_1\!\left(\tilde{m}_i^2 - \frac{1}{3}\right),
\qquad
\tilde{\sigma}_{ij}^{\mathrm{mel}} = B_2 \tilde{m}_i \tilde{m}_j \;\; (i \neq j),
\qquad
\boldsymbol{\sigma}^{\mathrm{mel}} = \mathbf{R}\,\tilde{\boldsymbol{\sigma}}^{\mathrm{mel}}\,\mathbf{R}^\top,
```

removing the unphysical uniform volume dilation $\Delta V/V = -B_1/(C_{11}+2C_{12})$ that
otherwise appears even in a demagnetized isotropic average $\langle m_i^2\rangle = \frac{1}{3}$.
Equivalently, $\mathbf{H}_{\mathrm{mel}} = \mathbf{R}\tilde{\mathbf{H}}_{\mathrm{mel}}$.
The cubic constants relate to experimental saturation magnetostrictions $(\lambda_{100}, \lambda_{111})$
along $[100]$ and $[111]$ via the free-crystal equilibrium relations:

```{math}
:label: eq-mel-cubic-b-from-lambda
B_1 = -\frac{3}{2}\lambda_{100}(C_{11} - C_{12}),
\qquad
B_2 = -3\lambda_{111} C_{44}.
```

#### Isotropic magnetostriction

For an elastically and magnetostrictively isotropic solid ($\lambda_{100} = \lambda_{111} = \lambda_s$,
$C_{11} - C_{12} = 2C_{44} = 2\mu$), Equations {eq}`eq-mel-cubic-b-from-lambda` collapse to

```{math}
:label: eq-mel-isotropic-b
B_1 = B_2 = -3\lambda_s \mu = -\frac{3\lambda_s E}{2(1+\nu)},
\qquad
\boldsymbol{\sigma}^{\mathrm{mel,iso}} = -3\lambda_s\mu\!\left(\mathbf{m}\otimes\mathbf{m} - \frac{1}{3}\mathbf{I}\right).
```

FullMag never silently converts `lambda_s` to $(B_1, B_2)$ without a declared isotropic elastic
model because an anisotropic cubic material with $A_Z \neq 1$ has two distinct shear moduli
$\frac{1}{2}(C_{11}-C_{12})$ and $C_{44}$ and therefore cannot be uniquely mapped from a single
scalar $\lambda_s$.

(magnetoelastic-v2-hexagonal-contract)=
#### Hexagonal four-constant magnetostriction

For hexagonal crystals (point groups $6/mmm$, $6mm$, $\bar{6}m2$, $622$, e.g., hcp $\mathrm{Co}$),
cylindrical invariance about the crystal $c$-axis $\hat{\mathbf{e}}_3^{\mathrm{cryst}}$ admits
four independent linear-in-strain, quadratic-in-$\mathbf{m}$ magnetoelastic constants
$(B_1^{\mathrm{hex}}, B_2^{\mathrm{hex}}, B_3^{\mathrm{hex}}, B_4^{\mathrm{hex}})$
(Mason 1954; Clark 1980; du Trémolet de Lacheisserie 1993). In crystal coordinates
$(\tilde{\mathbf{m}}, \tilde{\boldsymbol{\varepsilon}})$, FullMag v2 defines the traceless
four-constant energy density as

```{math}
:label: eq-mel-hexagonal-density
\begin{aligned}
w_{\mathrm{mel}}^{\mathrm{hex}}(\tilde{\mathbf{m}}, \tilde{\boldsymbol{\varepsilon}})
&=
B_1^{\mathrm{hex}}\!\left(\tilde{\varepsilon}_{11}\tilde{m}_1^2
+ 2\tilde{\varepsilon}_{12}\tilde{m}_1\tilde{m}_2
+ \tilde{\varepsilon}_{22}\tilde{m}_2^2
- \frac{1}{3}(\tilde{\varepsilon}_{11}+\tilde{\varepsilon}_{22})\right) \\
&\quad + B_2^{\mathrm{hex}}(\tilde{\varepsilon}_{11}+\tilde{\varepsilon}_{22})\!\left(\tilde{m}_3^2 - \frac{1}{3}\right)
+ B_3^{\mathrm{hex}}\tilde{\varepsilon}_{33}\!\left(\tilde{m}_3^2 - \frac{1}{3}\right) \\
&\quad + 2B_4^{\mathrm{hex}}\!\left(\tilde{\varepsilon}_{13}\tilde{m}_1\tilde{m}_3
+ \tilde{\varepsilon}_{23}\tilde{m}_2\tilde{m}_3\right).
\end{aligned}
```

Differentiating with respect to $\tilde{\mathbf{m}}$ and $\tilde{\boldsymbol{\varepsilon}}$ yields
the crystal-frame effective field and back-action stress:

```{math}
:label: eq-mel-hexagonal-field-stress
\begin{aligned}
\tilde{H}_{\mathrm{mel},1}^{\mathrm{hex}}
&= -\frac{2B_1^{\mathrm{hex}}(\tilde{\varepsilon}_{11}\tilde{m}_1 + \tilde{\varepsilon}_{12}\tilde{m}_2)
+ 2B_4^{\mathrm{hex}}\tilde{\varepsilon}_{13}\tilde{m}_3}{\mu_0 M_s}, \\
\tilde{H}_{\mathrm{mel},2}^{\mathrm{hex}}
&= -\frac{2B_1^{\mathrm{hex}}(\tilde{\varepsilon}_{12}\tilde{m}_1 + \tilde{\varepsilon}_{22}\tilde{m}_2)
+ 2B_4^{\mathrm{hex}}\tilde{\varepsilon}_{23}\tilde{m}_3}{\mu_0 M_s}, \\
\tilde{H}_{\mathrm{mel},3}^{\mathrm{hex}}
&= -\frac{2B_2^{\mathrm{hex}}(\tilde{\varepsilon}_{11}+\tilde{\varepsilon}_{22})\tilde{m}_3
+ 2B_3^{\mathrm{hex}}\tilde{\varepsilon}_{33}\tilde{m}_3
+ 2B_4^{\mathrm{hex}}(\tilde{\varepsilon}_{13}\tilde{m}_1 + \tilde{\varepsilon}_{23}\tilde{m}_2)}{\mu_0 M_s},
\end{aligned}
```

```{math}
:label: eq-mel-hexagonal-stress
\begin{aligned}
\tilde{\sigma}_{11}^{\mathrm{mel,hex}} &= B_1^{\mathrm{hex}}\!\left(\tilde{m}_1^2 - \frac{1}{3}\right) + B_2^{\mathrm{hex}}\!\left(\tilde{m}_3^2 - \frac{1}{3}\right), &
\tilde{\sigma}_{23}^{\mathrm{mel,hex}} &= B_4^{\mathrm{hex}}\tilde{m}_2\tilde{m}_3, \\
\tilde{\sigma}_{22}^{\mathrm{mel,hex}} &= B_1^{\mathrm{hex}}\!\left(\tilde{m}_2^2 - \frac{1}{3}\right) + B_2^{\mathrm{hex}}\!\left(\tilde{m}_3^2 - \frac{1}{3}\right), &
\tilde{\sigma}_{13}^{\mathrm{mel,hex}} &= B_4^{\mathrm{hex}}\tilde{m}_1\tilde{m}_3, \\
\tilde{\sigma}_{33}^{\mathrm{mel,hex}} &= B_3^{\mathrm{hex}}\!\left(\tilde{m}_3^2 - \frac{1}{3}\right), &
\tilde{\sigma}_{12}^{\mathrm{mel,hex}} &= B_1^{\mathrm{hex}}\tilde{m}_1\tilde{m}_2.
\end{aligned}
```

The $B_4^{\mathrm{hex}}$ shear-tilting coupling is essential for Rayleigh SAW excitation of
out-of-plane or tilted hexagonal ferromagnets. Setting $B_1^{\mathrm{hex}} = B_3^{\mathrm{hex}} = B_4^{\mathrm{hex}} = B$
and $B_2^{\mathrm{hex}} = 0$ recovers the isotropic law exactly. Note that Mason (1954) swaps the
indices of $B_2^{\mathrm{hex}}$ and $B_3^{\mathrm{hex}}$ relative to FullMag's basal/axial
ordering; users converting literature coefficients should verify whether $B_2$ multiplies
$(\tilde{\varepsilon}_{11}+\tilde{\varepsilon}_{22})\tilde{m}_3^2$ (FullMag / Lacheisserie) or
$\tilde{\varepsilon}_{33}\tilde{m}_3^2$ (Mason).

#### `stress_free` vs. `clamped` anisotropy convention and the Turov–Shavrov gap

Experimental magnetocrystalline anisotropy constants $K_{c1}^{\mathrm{free}}$ (cubic) and
$K_{u1}^{\mathrm{free}}$ (uniaxial) are typically measured on mechanically **stress-free** crystals
that relax to their spontaneous magnetostrictive strain
$\boldsymbol{\varepsilon}^{\mathrm{eq}}(\mathbf{m}) = -\mathbf{C}_V^{-1}\boldsymbol{\sigma}_V^{\mathrm{mel}}(\mathbf{m})$.
Substituting $\boldsymbol{\varepsilon}^{\mathrm{eq}}(\mathbf{m})$ back into
$w_{\mathrm{el}} + w_{\mathrm{mel}}$ yields the morphic magnetoelastic energy contribution:

```{math}
:label: eq-mel-morphic-anisotropy-renormalization
w_{\mathrm{el}}(\boldsymbol{\varepsilon}^{\mathrm{eq}}) + w_{\mathrm{mel}}(\mathbf{m}, \boldsymbol{\varepsilon}^{\mathrm{eq}})
=
-\frac{1}{2}(\boldsymbol{\sigma}_V^{\mathrm{mel}})^\top \mathbf{C}_V^{-1} \boldsymbol{\sigma}_V^{\mathrm{mel}}
=
\mathrm{const.} - \Delta K_{c1}^{\mathrm{ms}}\!\left(m_1^2 m_2^2 + m_2^2 m_3^2 + m_3^2 m_1^2\right),
```

where the cubic **magnetostrictive morphic shift** is

```{math}
:label: eq-mel-delta-kc1-ms
\Delta K_{c1}^{\mathrm{ms}}
=
\frac{B_2^2}{2 C_{44}} - \frac{B_1^2}{C_{11} - C_{12}},
\qquad
K_{c1}^{\mathrm{clamped}} = K_{c1}^{\mathrm{free}} + \Delta K_{c1}^{\mathrm{ms}}.
```

In a **clamped** (high-frequency frozen-lattice) FMR measurement, the crystal retains its static
equilibrium strain $\boldsymbol{\varepsilon}^{\mathrm{eq}}(\mathbf{m}_0)$ while $\mathbf{m}$
precesses, producing the **Turov–Shavrov magnetoelastic gap** $H_{\mathrm{me}}^{\mathrm{TS}}$
(Turov & Shavrov 1983). Failing to distinguish whether user-supplied $K_{c1}$ is `stress_free`
or `clamped` double-counts $\Delta K_{c1}^{\mathrm{ms}}$. For room-temperature YIG
($M_s = 1.40\times 10^5\,\mathrm{A\,m^{-1}}$, $C_{11}=2.69\times 10^{11}\,\mathrm{Pa}$,
$C_{12}=1.077\times 10^{11}\,\mathrm{Pa}$, $C_{44}=7.64\times 10^{10}\,\mathrm{Pa}$,
$B_1 = 3.48\times 10^5\,\mathrm{Pa}$, $B_2 = 6.96\times 10^5\,\mathrm{Pa}$), the exact analytical
static-strain Turov–Shavrov effective gap fields are:

| Crystallographic easy/bias axis | `anisotropy_convention="stress_free"` ($K_{c1}^{\mathrm{clamped}}$ adjusted) | `anisotropy_convention="clamped"` (fixed lattice $K_{c1}$) |
|---|---:|---:|
| $\mathbf{m}_0 \parallel [001]$ | $36.040\,\mathrm{A\,m^{-1}}$ | $8.535\,\mathrm{A\,m^{-1}}$ |
| $\mathbf{m}_0 \parallel [111]$ | $17.704\,\mathrm{A\,m^{-1}}$ | $36.040\,\mathrm{A\,m^{-1}}$ |

FullMag v2 therefore requires an explicit `anisotropy_convention` (`"stress_free"` or `"clamped"`)
whenever bidirectional magnetoelasticity coexists with magnetocrystalline anisotropy.

(magnetoelastic-v2-rotational-coupling-contract)=
### Rotational invariance and Melcher magneto-rotational coupling

Because an infinitesimal local lattice rotation $\boldsymbol{\omega}$ rotates the crystal
anisotropy axes relative to the laboratory frame, any magnetically anisotropic solid violates
objectivity ($SO(3)$ rotational invariance) and total angular-momentum conservation unless the
anisotropy energy is evaluated against the rotated crystal axes
$\hat{\mathbf{e}}_u' = \exp(\boldsymbol{\omega})\hat{\mathbf{e}}_u = (\mathbf{I} + \boldsymbol{\omega} + \frac{1}{2}\boldsymbol{\omega}^2)\hat{\mathbf{e}}_u + \mathcal{O}(\omega^3)$
(Tiersten 1964; Brown 1966; Melcher 1972; Maehrlein *et al.* 2018; Xu *et al.* 2020). Expanding
uniaxial anisotropy $w_{\mathrm{uni}}(\mathbf{m}, \hat{\mathbf{e}}_u') = -K_{u1}(\mathbf{m}\cdot\hat{\mathbf{e}}_u')^2$
consistently to **second order in $\boldsymbol{\omega}$** yields

```{math}
:label: eq-mel-rotational-energy-order2
\begin{aligned}
w_{\mathrm{rot}}^{(1)}(\mathbf{m}, \boldsymbol{\omega})
&=
-\frac{\partial w_{\mathrm{ani}}}{\partial m_i}\,\omega_{ij}\,m_j
=
-2 K_{u1}(\mathbf{m}\cdot\hat{\mathbf{e}}_u)\left(m_i \omega_{ij} e_{u,j}\right), \\
w_{\mathrm{rot}}^{(2)}(\mathbf{m}, \boldsymbol{\omega})
&=
-K_{u1}\left[\left(m_i \omega_{ij} e_{u,j}\right)^2
+ (\mathbf{m}\cdot\hat{\mathbf{e}}_u)\left(m_i \omega_{ik}\omega_{kj} e_{u,j}\right)\right],
\end{aligned}
```

with the analogous $\mathcal{O}(\omega^2)$ expansion for cubic anisotropy via
$\tilde{\mathbf{m}}' = \exp(-\boldsymbol{\omega})\tilde{\mathbf{m}}$. Including **both**
$w_{\mathrm{rot}}^{(1)}$ and $w_{\mathrm{rot}}^{(2)}$ is mathematically mandatory: under a rigid
joint rotation $\delta\mathbf{m} = \boldsymbol{\omega}\mathbf{m}$, the first-order term alone
leaves a spurious $\mathcal{O}(\omega^2)$ curvature that destroys the $SO(3)$ Goldstone zero
mode and breaks positive semidefiniteness of the quasistatic tangent operator.

Varying $w_{\mathrm{rot}} = w_{\mathrm{rot}}^{(1)} + w_{\mathrm{rot}}^{(2)}$ produces the
rotational effective magnetic field $\mathbf{H}_{\mathrm{rot}}$ and the **antisymmetric
rotational stress tensor** $\boldsymbol{\sigma}^{\mathrm{rot}}$:

```{math}
:label: eq-mel-rotational-field-and-stress
\mathbf{H}_{\mathrm{rot}}
=
-\frac{1}{\mu_0 M_s}\frac{\partial w_{\mathrm{rot}}}{\partial \mathbf{m}},
\qquad
\sigma_{ij}^{\mathrm{rot},(1)}
=
\frac{\partial w_{\mathrm{rot}}^{(1)}}{\partial \omega_{ij}}
=
\frac{1}{2}\mu_0 M_s\left(H_{\mathrm{ani},i} m_j - H_{\mathrm{ani},j} m_i\right)
=
-\sigma_{ji}^{\mathrm{rot},(1)}.
```

Because $\boldsymbol{\sigma}^{\mathrm{rot}}$ is skew-symmetric ($\sigma_{ij}^{\mathrm{rot}} = -\sigma_{ji}^{\mathrm{rot}}$),
its contribution to the local mechanical torque density satisfies

```{math}
:label: eq-mel-angular-momentum-conservation
\tau_{\mathrm{mech},k}^{\mathrm{rot}}
=
\epsilon_{kij}\,\sigma_{ij}^{\mathrm{rot},(1)}
=
-\mu_0 M_s\,(\mathbf{m} \times \mathbf{H}_{\mathrm{ani}})_k
=
-\tau_{\mathrm{mag},k}^{\mathrm{ani}},
\qquad
\boldsymbol{\tau}_{\mathrm{mag}} + \boldsymbol{\tau}_{\mathrm{mech}} = \mathbf{0},
```

restoring exact conservation of total (spin plus lattice) angular momentum. In ultra-thin films
with perpendicular magnetic anisotropy such as $\mathrm{Ta}/\mathrm{CoFeB}(1.6\,\mathrm{nm})/\mathrm{MgO}$
on $\mathrm{LiNbO}_3$, interference between the symmetric shear-strain field $\mathbf{H}_{\mathrm{mel}}$
and the antisymmetric lattice-rotation field $\mathbf{H}_{\mathrm{rot}}$ produces giant
nonreciprocal Rayleigh SAW attenuation—reaching up to $100\%$ rectification in experiment
(Xu *et al.* 2020).

Two additional rotational effects are explicitly **deferred to v2.1** and fail closed if requested:

- **Barnett / Einstein–de Haas gyromagnetic field** $\mathbf{H}_{\mathrm{Barnett}} = \frac{1}{\gamma}\dot{\boldsymbol{\theta}} = \frac{1}{2\gamma}\nabla\times\dot{\mathbf{u}}$
  (`include_barnett_gyromagnetic=True`), which is $\mathcal{O}(\omega/\omega_0)$ smaller in GHz
  ferromagnets than $K_u$-driven Melcher coupling unless $\gamma\mu_0 M_s \lesssim \omega$ or
  ultra-high-frequency THz phonons are studied;
- **Finite-strain shape-anisotropy surface-normal rotation** (`include_shape_rotation=True`),
  which requires deformed-geometry magnetostatic boundary integrals on $\partial\Omega_{\mathrm{mag}}(\mathbf{u})$.

### Coupled LLG–elastodynamics PDEs and energy-dissipation balance

Combining micromagnetic dynamics on $\Omega_{\mathrm{mag}}$ with momentum balance on
$\Omega_{\mathrm{mech}} \supseteq \Omega_{\mathrm{mag}}$ gives the complete bidirectional PDE system:

```{math}
:label: eq-mel-coupled-pde-system
\begin{aligned}
\frac{\partial \mathbf{m}}{\partial t}
&=
-\frac{\gamma}{1+\alpha^2}\left[
\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}
+ \alpha\,\mathbf{m} \times (\mathbf{m} \times \mathbf{H}_{\mathrm{eff}})
\right]
\qquad \text{in } \Omega_{\mathrm{mag}}, \\
\rho\frac{\partial^2 \mathbf{u}}{\partial t^2}
+ \alpha_M \rho \frac{\partial \mathbf{u}}{\partial t}
&=
\nabla \cdot \boldsymbol{\sigma}^{\mathrm{tot}}
+ \mathbf{f}_{\mathrm{ext}}
+ \mathbf{f}_{\mathrm{th}}
\qquad \text{in } \Omega_{\mathrm{mech}},
\end{aligned}
```

where the total effective magnetic field and total Cauchy–Piola stress tensor are

```{math}
:label: eq-mel-total-field-and-stress
\begin{aligned}
\mathbf{H}_{\mathrm{eff}}
&=
\mathbf{H}_{\mathrm{ex}} + \mathbf{H}_{\mathrm{demag}} + \mathbf{H}_{\mathrm{Zeeman}}
+ \mathbf{H}_{\mathrm{ani}} + \mathbf{H}_{\mathrm{DMI}}
+ \mathbf{H}_{\mathrm{mel}} + \mathbf{H}_{\mathrm{rot}}, \\
\boldsymbol{\sigma}^{\mathrm{tot}}
&=
\boldsymbol{\sigma}^{\mathrm{el}}(\boldsymbol{\varepsilon})
+ \boldsymbol{\sigma}^{\mathrm{visc}}(\dot{\boldsymbol{\varepsilon}})
+ \mathbf{1}_{\Omega_{\mathrm{mag}}}\!\left(\boldsymbol{\sigma}^{\mathrm{mel}}(\mathbf{m}) + \boldsymbol{\sigma}^{\mathrm{rot}}(\mathbf{m}, \boldsymbol{\omega})\right)
+ \boldsymbol{\sigma}^{\mathrm{drive}}
+ \boldsymbol{\sigma}^{\mathrm{th}},
\end{aligned}
```

with divergence convention $(\nabla\cdot\boldsymbol{\sigma})_i = \partial_j \sigma_{ij}$
(note the index order matters for the skew-symmetric rotational stress $\sigma_{ij}^{\mathrm{rot}} = -\sigma_{ji}^{\mathrm{rot}}$:
using $\delta w_{\mathrm{rot}} = \sigma_{ij}^{\mathrm{rot}}\delta\omega_{ij} = \sigma_{ij}^{\mathrm{rot}}\partial_j\delta u_i$
integrates by parts to $-\partial_j\sigma_{ij}^{\mathrm{rot}}\,\delta u_i$, matching
$(\nabla\cdot\boldsymbol{\sigma}^{\mathrm{tot}})_i = \partial_j \sigma_{ij}^{\mathrm{tot}}$).

Taking the inner product of the LLG equation with $-\mu_0 M_s \mathbf{H}_{\mathrm{eff}}$ and the
elastodynamic equation with $\dot{\mathbf{u}}$, and integrating over $\Omega_{\mathrm{mag}}$ and
$\Omega_{\mathrm{mech}}$ respectively, yields the exact **continuous energy-dissipation balance**
for deterministic drives ($\mathbf{f}_{\mathrm{th}} = \mathbf{0}, \boldsymbol{\sigma}^{\mathrm{th}} = \mathbf{0}$):

```{math}
:label: eq-mel-energy-power-balance
\frac{d}{dt}\!\left(
\mathcal{F}[\mathbf{m}, \mathbf{u}]
+ \underbrace{\int_{\Omega_{\mathrm{mech}}} \frac{1}{2}\rho\left\lVert\dot{\mathbf{u}}\right\rVert_2^2\,dV}_{E_{\mathrm{kin,el}}}
\right)
=
-\mathcal{D}_{\mathrm{LLG}}
-\mathcal{D}_{\mathrm{mech}}
+\mathcal{P}_{\mathrm{ext}}
-\oint_{\partial\Omega_{\mathrm{mech}}} \mathbf{S}_{\mathrm{mel}} \cdot \hat{\mathbf{n}}\,dS,
```

with strictly non-negative dissipation rates and exact **magnetoelastic Poynting flux**
$\mathbf{S}_{\mathrm{mel}}$:

```{math}
:label: eq-mel-dissipation-and-poynting
\begin{aligned}
\mathcal{D}_{\mathrm{LLG}}
&=
\int_{\Omega_{\mathrm{mag}}} \frac{\alpha\gamma\mu_0 M_s}{1+\alpha^2}\left\lVert \mathbf{m} \times \mathbf{H}_{\mathrm{eff}} \right\rVert_2^2\,dV \ge 0, \\
\mathcal{D}_{\mathrm{mech}}
&=
\int_{\Omega_{\mathrm{mech}}} \left(\alpha_M \rho \left\lVert\dot{\mathbf{u}}\right\rVert_2^2
+ (\dot{\boldsymbol{\varepsilon}}^{\mathrm{eng}})^\top \boldsymbol{\eta}_V \dot{\boldsymbol{\varepsilon}}^{\mathrm{eng}}\right)dV \ge 0, \\
\mathbf{S}_{\mathrm{mel}}
&=
-\left(\boldsymbol{\sigma}^{\mathrm{tot}}\right)^\top \dot{\mathbf{u}}
- \mathbf{1}_{\Omega_{\mathrm{mag}}}\,2 A_{\mathrm{ex}}\,\dot{\mathbf{m}}\cdot\nabla\mathbf{m},
\end{aligned}
```

and external mechanical plus Zeeman power input
$\mathcal{P}_{\mathrm{ext}} = \int_{\Omega_{\mathrm{mech}}} (\mathbf{f}_{\mathrm{ext}}\cdot\dot{\mathbf{u}} - \boldsymbol{\sigma}^{\mathrm{drive}}:\dot{\boldsymbol{\varepsilon}})\,dV - \int_{\Omega_{\mathrm{mag}}}\mu_0 M_s \mathbf{m}\cdot\dot{\mathbf{H}}_{\mathrm{ext}}\,dV$.
In particular, the cross-coupling powers $\int \boldsymbol{\sigma}^{\mathrm{mel}}:\dot{\boldsymbol{\varepsilon}}\,dV$
and $-\int \mu_0 M_s \mathbf{H}_{\mathrm{mel}}\cdot\dot{\mathbf{m}}\,dV$ sum identically to
$\frac{d}{dt}\mathcal{F}_{\mathrm{mel}}$, proving lossless conservative magnon–phonon energy
exchange when $\alpha = 0$, $\mathcal{D}_{\mathrm{mech}} = 0$, and $\mathcal{P}_{\mathrm{ext}} = 0$.

(magnetoelastic-v2-damping-contract)=
### Mechanical damping models

FullMag v2 defines **five mutually disjoint** mechanical damping models so that mass damping and
viscous strain-rate damping are never accidentally double-counted:

1. **`NoMechanicalDamping` (strict default):** $\alpha_M = 0$, $\boldsymbol{\eta}_V = \mathbf{0}$,
   $\mathcal{D}_{\mathrm{mech}} \equiv 0$. Preserves exact conservative energy exchange in
   undamped benchmarks.
2. **`MassProportionalDamping(alpha_m)`:** body drag $-\alpha_M \rho \dot{\mathbf{u}}$ with
   $\alpha_M \ge 0$ ($\mathrm{s}^{-1}$). Yields frequency-independent modal decay rate
   $\Gamma = \alpha_M / 2$ (equivalently quality factor $Q(\omega) = \omega / \alpha_M$).
3. **`KelvinVoigtDamping`:** anisotropic viscous stress
   $\boldsymbol{\sigma}_V^{\mathrm{visc}} = \boldsymbol{\eta}_V \dot{\boldsymbol{\varepsilon}}^{\mathrm{eng}}$
   with symmetric positive-semidefinite viscosity matrix $\boldsymbol{\eta}_V \succeq 0$
   ($\mathrm{Pa\,s}$). Yielding Akhiezer-like $\Gamma \propto \omega^2$ attenuation ($f \cdot Q = \mathrm{const}$).
   When specified via physical quality-factor products $(fQ_L, fQ_T)$ (for longitudinal and
   transverse acoustic waves, e.g., YIG $fQ_L \approx 10^{14}\,\mathrm{Hz}$), FullMag constructs
   $\boldsymbol{\eta}_V$ by the **congruent SPD transformation**

```{math}
:label: eq-mel-kelvin-voigt-congruent-spd
\boldsymbol{\eta}_V
=
\mathbf{D}\,\mathbf{C}_V\,\mathbf{D},
\qquad
\mathbf{D} = \operatorname{diag}(d_L, d_L, d_L, d_T, d_T, d_T),
\qquad
d_L = \frac{1}{\sqrt{2\pi\,fQ_L}},
\quad
d_T = \frac{1}{\sqrt{2\pi\,fQ_T}}.
```

   Because $\mathbf{D}$ is invertible and diagonal while $\mathbf{C}_V \succ 0$, Sylvester's law of
   inertia guarantees $\boldsymbol{\eta}_V \succ 0$ across **all seven crystal symmetry classes**
   (avoiding indefinite off-diagonal coupling matrices that break naive componentwise scaling)
   while exactly reproducing $\eta_{11} = C_{11}/(2\pi fQ_L)$ and $\eta_{44} = C_{44}/(2\pi fQ_T)$.
4. **`RayleighDamping(alpha_m, beta_k)`:** classical proportional damping
   $\mathbf{D} = \alpha_M \mathbf{M} + \beta_K \mathbf{K}$ (i.e., $\boldsymbol{\eta}_V = \beta_K \mathbf{C}_V$),
   optionally calibrated from a two-frequency damping-ratio window $(\omega_1, \zeta_1), (\omega_2, \zeta_2)$ via

```{math}
:label: eq-mel-rayleigh-two-freq
\alpha_M = \frac{2\omega_1\omega_2(\zeta_1\omega_2 - \zeta_2\omega_1)}{\omega_2^2 - \omega_1^2},
\qquad
\beta_K = \frac{2(\zeta_2\omega_2 - \zeta_1\omega_1)}{\omega_2^2 - \omega_1^2},
```

   validated to ensure $\alpha_M \ge 0$ and $\beta_K \ge 0$.
5. **`CombinedMechanicalDamping(mass, kelvin_voigt)`:** explicit sum of `MassProportionalDamping`
   and full anisotropic `KelvinVoigtDamping`.

(magnetoelastic-v2-thermal-drives-contract)=
### Thermal acoustic Langevin bath and external acoustic/optical drives

#### Fluctuation–Dissipation Theorem for thermal phonons

At finite temperature $T > 0$, thermal lattice fluctuations are coupled to mechanical dissipation
through zero-mean Gaussian white-in-time stochastic stress $\boldsymbol{\sigma}^{\mathrm{th}}$
(paired with Kelvin–Voigt viscosity $\boldsymbol{\eta}_V$) and stochastic body force
$\mathbf{f}_{\mathrm{th}}$ (paired with mass damping $\alpha_M\rho$):

```{math}
:label: eq-mel-fdt-thermal-bath
\begin{aligned}
\left\langle \sigma_{ij}^{\mathrm{th}}(\mathbf{r},t)\,\sigma_{kl}^{\mathrm{th}}(\mathbf{r}',t') \right\rangle
&=
2 k_B T\,\eta_{ijkl}\,\delta(\mathbf{r}-\mathbf{r}')\,\delta(t-t'), \\
\left\langle f_i^{\mathrm{th}}(\mathbf{r},t)\,f_j^{\mathrm{th}}(\mathbf{r}',t') \right\rangle
&=
2 k_B T\,\alpha_M\rho\,\delta_{ij}\,\delta(\mathbf{r}-\mathbf{r}')\,\delta(t-t').
\end{aligned}
```

In discrete cells or quadrature points of volume $V_e$ and step $\Delta t$, the stochastic stress
vector is sampled via the Cholesky factor $\mathbf{L}_\eta \mathbf{L}_\eta^\top = \boldsymbol{\eta}_V$
as $\boldsymbol{\sigma}_{V,e}^{\mathrm{th},n} = \sqrt{\frac{2 k_B T}{V_e \Delta t}}\,\mathbf{L}_\eta \boldsymbol{\xi}_e^n$
with $\boldsymbol{\xi}_e^n \sim \mathcal{N}(\mathbf{0}, \mathbf{I}_6)$ independent across cells and
steps. By classical statistical mechanics, every harmonic eigenmode $n$ (excluding the
$6 N_{\mathrm{free\_comp}}$ zero-frequency rigid-body modes of unconstrained elastic components)
equilibrates to

```{math}
:label: eq-mel-fdt-equipartition
\left\langle E_{\mathrm{kin},n} \right\rangle = \frac{1}{2} k_B T,
\qquad
\left\langle E_{\mathrm{pot},n} \right\rangle = \frac{1}{2} k_B T,
\qquad
\left\langle E_{\mathrm{tot},n} \right\rangle = k_B T.
```

Requesting $T > 0$ under `NoMechanicalDamping` violates the Fluctuation–Dissipation Theorem and
fails closed at the planner boundary (`thermal_acoustic_bath_requires_damping`).

#### External acoustic and ultrafast optical drives

FullMag v2 separates three typed mechanical excitation sources:

- **`InterdigitalTransducerDrive` (IDT):** models SAW generation on piezoelectric substrates
  ($\mathrm{LiNbO}_3$, $\mathrm{ZnO}$) via spatially periodic surface traction or effective
  piezoelectric stress $\sigma_{ij}^{\mathrm{drive}}(\mathbf{r},t) = -e_{kij} E_k^{\mathrm{IDT}}(\mathbf{r},t)$
  under finger electrodes with pitch $\Lambda_{\mathrm{SAW}} = c_{\mathrm{SAW}} / f_0$, apodization
  envelope, and chirp/pulsed waveform.
- **`UltrafastLaserStressDrive` (Thomsen 1986):** models picosecond thermoelastic strain pulses
  excited by femtosecond optical absorption with penetration depth $\zeta$:

```{math}
:label: eq-mel-thomsen-laser-stress
\sigma_{ij}^{\mathrm{drive}}(\mathbf{r},t)
=
-C_{ijkl}\,\alpha_{kl}^{\mathrm{th}}\,\Delta T(\mathbf{r},t),
\qquad
\Delta T(z, t)
=
\frac{(1 - R_{\mathrm{opt}}) F_{\mathrm{abs}}}{C_v\,\zeta}\,e^{-z/\zeta}\,g(t),
```

  where $\alpha_{kl}^{\mathrm{th}}$ is the linear thermal expansion tensor ($\mathrm{K}^{-1}$),
  $F_{\mathrm{abs}}$ is absorbed optical fluence ($\mathrm{J\,m^{-2}}$), $C_v$ is volumetric heat
  capacity ($\mathrm{J\,m^{-3}\,K^{-1}}$), and $g(t)$ is the temporal pulse envelope.
- **`HarmonicAcousticDrive`:** monochromatic, multi-tone, or sinc-broadband volumetric body force
  $\mathbf{f}_{\mathrm{ext}}(\mathbf{r},t)$ or boundary traction $\bar{\mathbf{t}}(\mathbf{r},t)$
  for dispersion mapping and resonant acoustic spectroscopy.

### Analytical magnon–phonon dispersion and anticrossing

For a bulk cubic ferromagnet magnetized along $\hat{\mathbf{z}} \parallel [001]$ with wave vector
$\mathbf{k} = k \hat{\mathbf{z}}$ and uncoupled spin-wave frequency
$\omega_m(k) = \gamma\mu_0(H_0 + H_{\mathrm{ani}} + \frac{2A_{\mathrm{ex}}}{\mu_0 M_s}k^2)$,
linearizing Equations {eq}`eq-mel-coupled-pde-system` yields hybridization between the circularly
polarized magnon mode $m_+ = m_x + i m_y$ and the circularly polarized transverse acoustic (TA)
phonon $u_+ = u_x + i u_y$ of phase speed $c_t = \sqrt{C_{44}/\rho}$ (Kittel 1958):

```{math}
:label: eq-mel-kittel-dispersion
\left(\omega - \omega_m(k)\right)\!\left(\omega^2 - c_t^2 k^2\right)
-
\frac{\gamma B_2^2}{\rho M_s}\,k^2
=
0,
```

while the longitudinal acoustic mode ($u_z$) and opposite-helicity circular TA mode ($u_- = u_x - i u_y$)
decouple at $\mathbf{k} \parallel \mathbf{m}_0$. At the nominal crossing
$\omega_m(k_\times) = c_t k_\times = \omega_\times$, the exact coupled-mode frequency splitting
depends critically on whether the test isolates a single linear TA polarization (1D transverse
shear model) or resolves the full 3D degenerate TA doublet $(u_x, u_y)$:

```{math}
:label: eq-mel-anticrossing-splitting
g_{\mathrm{1D}} = \frac{\lvert B_2\rvert}{2}\sqrt{\frac{\gamma}{\rho M_s c_t^2\,\omega_\times}}\,\omega_\times
= \frac{\lvert B_2\rvert}{2}\sqrt{\frac{\gamma\omega_\times}{\rho M_s c_t^2}},
\qquad
\Delta f_{\mathrm{1D}} = \frac{2 g_{\mathrm{1D}}}{2\pi} = \frac{g_{\mathrm{1D}}}{\pi},
\qquad
\Delta f_{\mathrm{3D}} = \sqrt{2}\,\Delta f_{\mathrm{1D}}.
```

Specifically, in full 3D elastodynamics at $\mathbf{k} \parallel \mathbf{m}_0$, the three-state
basis $(m_+, u_x, u_y)$ yields eigenvalues $\{\omega_\times - \sqrt{2}\,g_{\mathrm{1D}},\, \omega_\times,\, \omega_\times + \sqrt{2}\,g_{\mathrm{1D}}\}$,
producing a bright anticrossing gap $\Delta f_{\mathrm{3D}} = \sqrt{2}\,\Delta f_{\mathrm{1D}}$
plus a dark orthogonal TA mode $u_-$ sitting unshifted at $\omega_\times$. For YIG at
$f_\times = 5.000\,\mathrm{GHz}$ ($c_t = 3843.2\,\mathrm{m\,s^{-1}}$, $B_2 = 6.96\times 10^5\,\mathrm{Pa}$),
$\Delta f_{\mathrm{1D}} = 79.6312\,\mathrm{MHz}$ whereas $\Delta f_{\mathrm{3D}} = 112.6155\,\mathrm{MHz}$
with the dark $\mathrm{TA}_-$ mode at exactly $5.000\,\mathrm{GHz}$.

(physics-magnetoelastic-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf{u}$ | mechanical displacement field | $\mathrm{m}$ |
| $\varepsilon_{ij}$ | symmetric infinitesimal tensor strain | $1$ |
| $\gamma_{ij}$ | engineering shear strain ($2\varepsilon_{ij}$ for $i\neq j$) | $1$ |
| $\omega_{ij}$ | antisymmetric infinitesimal lattice rotation tensor | $1$ |
| $\boldsymbol{\theta}$ | infinitesimal lattice rotation axial vector | $\mathrm{rad}$ |
| $\mathbf{C}_V$ | $6\times 6$ Voigt elastic stiffness matrix | $\mathrm{Pa}$ |
| $\mathbf{C}_{\mathrm{KM}}$ | $6\times 6$ orthonormal Kelvin–Mandel stiffness matrix | $\mathrm{Pa}$ |
| $\rho$ | mass density | $\mathrm{kg\,m^{-3}}$ |
| $\mathbf{R}$ | crystal-to-laboratory proper rotation matrix in $SO(3)$ | $1$ |
| $\mathbf{M}_\sigma$ | $6\times 6$ Bond stress transformation matrix | $1$ |
| $B_1, B_2$ | cubic magnetoelastic coupling constants | $\mathrm{Pa} = \mathrm{J\,m^{-3}}$ |
| $B_1^{\mathrm{hex}}, B_2^{\mathrm{hex}}, B_3^{\mathrm{hex}}, B_4^{\mathrm{hex}}$ | hexagonal four-constant magnetoelastic coefficients | $\mathrm{Pa} = \mathrm{J\,m^{-3}}$ |
| $\lambda_{100}, \lambda_{111}, \lambda_s$ | cubic and isotropic saturation magnetostriction constants | $1$ |
| $w_{\mathrm{el}}, w_{\mathrm{mel}}, w_{\mathrm{rot}}$ | elastic, magnetoelastic, and rotational energy densities | $\mathrm{J\,m^{-3}}$ |
| $\mathbf{H}_{\mathrm{mel}}, \mathbf{H}_{\mathrm{rot}}$ | magnetoelastic and magneto-rotational effective fields | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\sigma}^{\mathrm{el}}, \boldsymbol{\sigma}^{\mathrm{mel}}, \boldsymbol{\sigma}^{\mathrm{rot}}$ | elastic, magnetostrictive, and antisymmetric rotational stress tensors | $\mathrm{Pa}$ |
| $\alpha_M$ | mass-proportional mechanical damping rate | $\mathrm{s^{-1}}$ |
| $\boldsymbol{\eta}_V$ | $6\times 6$ Voigt Kelvin–Voigt viscosity matrix | $\mathrm{Pa\,s}$ |
| $fQ_L, fQ_T$ | longitudinal and transverse acoustic frequency–quality products | $\mathrm{Hz}$ |
| $\mathbf{S}_{\mathrm{mel}}$ | magnetoelastic Poynting energy flux vector | $\mathrm{W\,m^{-2}}$ |
| $k_B T$ | thermal energy scale in Langevin acoustic bath | $\mathrm{J}$ |

(physics-magnetoelastic-assumptions-and-validity)=
## Assumptions and validity

1. **Continuum small-strain kinematics:** $\lVert\nabla\mathbf{u}\rVert_F \ll 1$ (typically
   $10^{-7}$–$10^{-3}$ in GHz acoustic waves and magnetostrictive films). Finite-strain Green–Lagrange
   kinematics and deformed-mesh magnetostatics (`include_shape_rotation`) are outside v2 scope and
   deferred to v2.1.
2. **Linear elasticity and positive-definiteness:** stress–strain linearity holds with strictly
   Born-stable $\mathbf{C}_V \succ 0$ on every elastic material.
3. **Current executable boundary vs. v2 scope:**
   - On `master`, only one-way cubic $B_1/B_2$ prescribed-strain field/energy evaluation executes on
     FEM CPU and FEM GPU. `H_mel` divides by local $M_{s,i}$, non-magnetic nodes ($\Omega_{\mathrm{mech}}\setminus\Omega_{\mathrm{mag}}$)
     contribute zero magnetic field and energy, and no displacement solve is executed.
   - Bidirectional elastodynamics, quasistatic equilibrium solves, 7-class anisotropic elasticity,
     hexagonal 4-constant laws, Melcher rotational coupling, mechanical damping, absorbing layers,
     and thermal acoustic baths are validated in the v2 specification and fail closed on `master`.
4. **Anisotropy renormalization consistency:** combining bidirectional magnetoelasticity with
   magnetocrystalline anisotropy requires declaring `anisotropy_convention` (`"stress_free"` vs.
   `"clamped"`) so $\Delta K_{c1}^{\mathrm{ms}}$ is neither omitted nor double-counted.
5. **Piezoelectric electro-elastic coupling:** direct coupled piezoelectric Gauss-law PDE solves
   ($\nabla\cdot(\mathbf{e}:\boldsymbol{\varepsilon} - \boldsymbol{\epsilon}\nabla\phi)=0$) are
   modeled in v2 through effective stiffened elastic constants $\mathbf{C}_V^{\mathrm{eff}}$ plus
   prescribed `InterdigitalTransducerDrive` traction/stress sources; full self-consistent
   piezoelectric electrostatics is deferred to v2.1.

(physics-magnetoelastic-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR (`master`) | Executable realization (`master`) | Scientific qualification | Exact capability boundary and v2 roadmap |
|---|---|---|---|---|---|
| FDM | CPU | `MechanicsIR` & local reference `h_mel_single_with_ms` / `e_mel_density_single` | partial; full public FDM plan fails closed | unit-tested local formulas only; no end-to-end FDM lane yet | v2 target: Virieux staggered grid (or 4-grid Lebedev for general anisotropy), HEVI IMEX-$z$ `PC2`, AVX-512 + OpenMPI + `oneMKL PARDISO` |
| FDM | GPU | `MechanicsIR` & FP64 energy reduction `reduce_magnetoelastic_energy_fp64` | partial; device branches exist below public planner | no end-to-end executed GPU qualification | v2 target: 3.5D ping-pong shared-memory CUDA kernels, zero host-device transfer residency, `cuDSS` / `GMG` / `SpectralZThomasPCG` |
| FEM | CPU | prescribed-strain object graph (`ElasticMaterial`, `ElasticBody`, `MagnetostrictionLaw`, `MechanicalLoad`, `Magnetoelastic`) | implemented prescribed-strain subset (`compute_magnetoelastic_field`) | field/energy analytical and mesh tests on cubic $B_1/B_2$ prescribed strain | one cubic law and uniform/per-node prescribed strain; v2 adds `MFEM` `SubMesh`, `MITC6/EAS-1` `Prism6`, `Tet10` $\bar{\mathbf{B}}$, `oneMKL PARDISO` / `MUMPS` / `SLEPc` |
| FEM | GPU | same prescribed-strain object graph (`resolve_fem_magnetoelastic_plan`) | implemented prescribed-strain subset (`gpu_magnetoelastic_upload_strain`, `fullmag_cuda_magnetoelastic_field_energy_blocks`) | separate executed-device CPU/GPU parity gate | device Voigt upload and lumped-mass energy kernel; v2 adds `cuDSS` Frozen-Factor PCG, `libCEED` PA + `Hypre 3.1.0` GPU `BoomerAMG`, `CudssModalShift` |

(physics-magnetoelastic-python-api)=
## Python API and stage-first example

The stage-first example below executes against the current `master` Python package, demonstrating
the study setup together with the canonical `MechanicsIR` object constructors (`ElasticMaterial`,
`ElasticBody`, `MagnetostrictionLaw`, `MechanicalLoad`, and `Magnetoelastic`):

```python
# %% Study, execution lane, and magnetic film
import fullmag as fm

nm = 1.0e-9
study = fm.study("magnetoelastic_authoring_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Mechanics graph constructors (canonical ProblemIR authoring boundary)
elastic = fm.ElasticMaterial(
    name="yig_cubic",
    C11=2.69e11,
    C12=1.077e11,
    C44=7.64e10,
    rho=5170.0,
)
substrate_geometry = fm.Box(40 * nm, 20 * nm, 4 * nm, name="substrate_geometry")
substrate = fm.ElasticBody(
    name="substrate",
    geometry=substrate_geometry,
    elastic_material=elastic,
)
law = fm.MagnetostrictionLaw(
    name="yig_b1_b2",
    kind="cubic",
    B1=3.48e5,
    B2=6.96e5,
)
load = fm.MechanicalLoad(
    kind="prescribed_strain",
    strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0),
)
coupling = fm.Magnetoelastic(magnet="film", body=substrate.name, law=law.name)

# %% Inspect canonical ProblemIR records and register stage
ir_coupling = coupling.to_ir()
ir_material = elastic.to_ir()
ir_law = law.to_ir()
ir_load = load.to_ir()
assert ir_coupling["kind"] == "magnetoelastic"
assert ir_material["c11"] == 2.69e11
assert ir_law["b2"] == 6.96e5
assert len(ir_load["strain"]) == 6
study.stages.add_run(stage_id="authoring_boundary", until=1.0e-15)
```

For constructor signatures on `fm.Magnetoelastic`, see {doc}`/python-api/interactions/magnetoelastic`,
{doc}`/python-api/materials/elastic-materials`, and {doc}`/python-api/materials/magnetostriction-laws`.

### Exhaustive Python parameter contract (`master`)

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR mapping |
|---|---|---|---|---|---|---|---|
| `ElasticMaterial.C11` | `float` | required | `Pa` | strictly positive (`> 0`) | cubic longitudinal stiffness constant $C_{11}$ | FEM CPU/GPU IR; full elasticity in v2 | `mechanics.materials[].c11` |
| `ElasticMaterial.C12` | `float` | required | `Pa` | strictly positive (`> 0`) on `master`; full Born SPD in v2 | cubic off-diagonal stiffness constant $C_{12}$ | FEM CPU/GPU IR; full elasticity in v2 | `mechanics.materials[].c12` |
| `ElasticMaterial.C44` | `float` | required | `Pa` | strictly positive (`> 0`) | cubic shear stiffness constant $C_{44}$ | FEM CPU/GPU IR; full elasticity in v2 | `mechanics.materials[].c44` |
| `ElasticMaterial.rho` | `float` | required | `kg/m^3` | strictly positive (`> 0`) | mass density $\rho$ of elastic solid | IR record; active in v2 elastodynamics | `mechanics.materials[].density` |
| `ElasticMaterial.eta_mech` | `float \| None` | `None` | `1` | non-negative (`>= 0`) when provided | legacy dimensionless mechanical damping slot (superseded by typed v2 damping models) | IR record only; fails closed if executed | `mechanics.materials[].mechanical_damping` |
| `MagnetostrictionLaw.kind` | `str` | `"cubic"` | `1` | `"cubic"` or `"isotropic"` (`"hexagonal"` in v2) | symmetry class of magnetoelastic energy density | `"cubic"` on FEM CPU/GPU; `"isotropic"` fails closed | `mechanics.laws[].kind` |
| `MagnetostrictionLaw.B1` | `float \| None` | `None` | `Pa` | required and finite for `"cubic"` | cubic normal-strain coupling constant $B_1$ | FEM CPU/GPU prescribed-strain executable | `mechanics.laws[].b1` |
| `MagnetostrictionLaw.B2` | `float \| None` | `None` | `Pa` | required and finite for `"cubic"` | cubic shear-strain coupling constant $B_2$ | FEM CPU/GPU prescribed-strain executable | `mechanics.laws[].b2` |
| `MagnetostrictionLaw.lambda_s` | `float \| None` | `None` | `1` | required and finite for `"isotropic"` | isotropic saturation magnetostriction $\lambda_s$ | IR authoring only; fails closed at planner | `mechanics.laws[].lambda_s` |
| `MechanicalLoad.strain` | `tuple[float, ...] \| None` | `None` | `1` | length 6 engineering-Voigt vector; finite values | prescribed $(\varepsilon_{11},\varepsilon_{22},\varepsilon_{33},\gamma_{23},\gamma_{13},\gamma_{12})$ | FEM CPU/GPU prescribed-strain executable | `mechanics.loads[].strain` |
| `Magnetoelastic.magnet` | `str` | required | `1` | non-empty reference to a declared ferromagnet | target magnetic domain $\Omega_{\mathrm{mag}}$ | FEM CPU/GPU prescribed-strain executable | `energy[].magnet` |
| `Magnetoelastic.body` | `str` | required | `1` | non-empty reference to a declared `ElasticBody` | host elastic domain $\Omega_{\mathrm{mech}}$ | FEM CPU/GPU prescribed-strain executable | `energy[].body` |
| `Magnetoelastic.law` | `str` | required | `1` | non-empty reference to a declared `MagnetostrictionLaw` | constitutive magnetoelastic coupling law | FEM CPU/GPU prescribed-strain executable | `energy[].law` |

### Planned FullMag v2 Python DSL extensions

In FullMag v2, stage-level bidirectional mechanics attaches through `study.mechanics` with typed
constructors covering all 7 crystal symmetries, crystal orientations, damping models, rotational
invariance, thermal baths, and drives:

| Planned v2 Python symbol | Role | Key fields / invariants |
|---|---|---|
| `ElasticMaterial.isotropic / cubic / hexagonal / trigonal_3m / tetragonal_4mmm / orthorhombic / voigt21` | 7-class Born-validated stiffness constructors | Cholesky $\mathbf{C}_V \succ 0$, optional `orientation: CrystalOrientation` ($SO(3)$ Bond transform) |
| `MagnetostrictionLaw.cubic / cubic_from_lambda / isotropic / hexagonal` | Traceless bidirectional magnetoelastic laws | `B1, B2`, `(lambda_100, lambda_111)`, `lambda_s`, or `(B1_hex, B2_hex, B3_hex, B4_hex)` |
| `RotationalCouplingConfig` | Melcher $\mathcal{O}(\omega^2)$ rotational invariance | `enabled`, `include_second_order=True`, fail-closed `include_barnett_gyromagnetic=False`, `include_shape_rotation=False` |
| `NoMechanicalDamping / MassProportionalDamping / KelvinVoigtDamping / RayleighDamping / CombinedMechanicalDamping` | Five disjoint damping models | `KelvinVoigtDamping.from_fQ(fQ_L, fQ_T)` constructs congruent SPD $\boldsymbol{\eta}_V = \mathbf{D}\mathbf{C}_V\mathbf{D}$ |
| `ThermalAcousticBath(temperature_k, seed)` | FDT stochastic stress & body force | Requires nonzero mechanical damping; fails closed under `NoMechanicalDamping` |
| `InterdigitalTransducerDrive / UltrafastLaserStressDrive / HarmonicAcousticDrive` | Typed acoustic and picosecond optical drives | Surface traction/stress, Thomsen $\Delta T(z,t)$ optical stress, monochromatic/sinc drives |

(physics-magnetoelastic-problem-ir)=
## ProblemIR semantics

On `master`, the canonical energy term (`coupling.to_ir()`) references named records inside
`MechanicsIR` (`crates/fullmag-ir/src/mechanics.rs`):

```json
{
  "energy": [
    {
      "kind": "magnetoelastic",
      "magnet": "film",
      "body": "substrate",
      "law": "yig_b1_b2"
    }
  ],
  "mechanics": {
    "materials": [
      { "name": "yig_cubic", "c11": 2.69e11, "c12": 1.077e11, "c44": 7.64e10, "density": 5170.0 }
    ],
    "bodies": [
      { "name": "substrate", "geometry": "substrate_geometry", "elastic_material": "yig_cubic" }
    ],
    "laws": [
      { "kind": "cubic", "name": "yig_b1_b2", "b1": 3.48e5, "b2": 6.96e5 }
    ],
    "loads": [
      { "kind": "prescribed_strain", "strain": [1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0] }
    ]
  }
}
```

In FullMag v2, `MechanicsIR` extends additively with explicit `coupling_mode`
(`"prescribed_strain" | "quasistatic" | "elastodynamics"`), `anisotropy_convention`
(`"stress_free" | "clamped"`), `ElasticMaterialV2IR` (`symmetry`, 21-entry upper-triangle Voigt
storage, $SO(3)$ `orientation_matrix`, `damping`), `RotationalCouplingIR`, `ThermalAcousticBathIR`,
typed `MechanicalBoundaryConditionV2IR` (8 variants), and `AcousticDriveIR`. Every legacy
`master` `MechanicsIR` document remains strictly deserializable without silent semantic mutation.

(physics-magnetoelastic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent** preserves all authored graph names (`magnet`, `body`, `law`), stiffness
  constants, crystal orientation matrices, magnetostriction coefficients, anisotropy convention,
  damping variant, mechanical loads, and device/precision requests verbatim in `ProblemIR`.
- **Resolved execution** records the selected execution plan (`FemMagnetoelasticPlanIR` and
  `FemMechanicalPlanIR` on `master`, extended with `MechanicsExecutionPlanIR` in v2), the active
  solver lane, floating-point precision, and whether strain is prescribed or solved dynamically.
- **Validation errors** reject missing graph references (`magnet`, `body`, `law`), duplicate
  `Magnetoelastic` terms on the same magnetic body, Voigt vectors whose length differs from 6,
  non-finite coefficients, violations of Born stability ($\mathbf{C}_V \not\succ 0$), non-$SO(3)$
  rotation matrices ($\lVert\mathbf{R}^\top\mathbf{R}-\mathbf{I}\rVert_F > 10^{-12}$ or
  $\det\mathbf{R} \neq +1$), indefinite Kelvin–Voigt viscosity matrices, or $T > 0$ paired with
  `NoMechanicalDamping` (`thermal_acoustic_bath_requires_damping`).
- **Unsupported combinations** fail closed at the planner boundary and are never silently
  converted or dropped: on `master`, this includes `kind="isotropic"` (`lambda_s`),
  `QuasistaticElasticity`, `Elastodynamics`, `prescribed_stress`, `body_force`, and full public
  FDM workflows. In v2, requesting `include_barnett_gyromagnetic=True`,
  `include_shape_rotation=True`, or piezoelectric electro-elastic Gauss solves fails closed with
  explicit v2.1 deferral diagnostics.

(physics-magnetoelastic-implementation-mapping)=
## Implementation mapping

- **Python authoring & IR lowering:** `packages/fullmag-py/src/fullmag/model/energy.py`
  (`class Magnetoelastic`) and `packages/fullmag-py/src/fullmag/model/mechanics.py`
  (`class ElasticMaterial`, `class ElasticBody`, `class MagnetostrictionLaw`,
  `class MechanicalBoundaryCondition`, `class MechanicalLoad`).
- **Canonical IR & planning:** `crates/fullmag-ir/src/mechanics.rs` (`MechanicsIR` and typed
  records) and `crates/fullmag-plan/src/fem.rs` (`resolve_fem_magnetoelastic_plan`) enforce
  prescribed-strain legality and fail-closed diagnostics.
- **Native field/energy kernels (`master`):**
  - Rust FDM reference routines: `crates/fullmag-engine/src/magnetoelastic.rs`
    (`h_mel_single_with_ms`, `e_mel_density_single`).
  - FEM CPU MFEM realization: `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp`
    (`compute_magnetoelastic_field`) halves engineering shear $\gamma_{ij} \mapsto \varepsilon_{ij}$,
    scales by local $M_{s,i}$, masks non-magnetic nodes, and integrates energy with lumped mass.
  - FEM GPU CUDA realization: `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp`
    (`gpu_magnetoelastic_upload_strain`) and `magnetoelastic_kernels.cu`
    (`fullmag_cuda_magnetoelastic_field_energy_blocks`).
  - FDM GPU FP64 reduction branch: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`
    (`reduce_magnetoelastic_energy_fp64`).
- **UI capability boundary:** Control Room support is tracked in {doc}`/frontend/capability-register`;
  parameters without a UI inspector control are authored in Python.

(physics-magnetoelastic-validation)=
## Validation and verification benchmarks

### Current prescribed-strain verification suite (`master`)

- Zero field and zero energy identically for zero strain $\boldsymbol{\varepsilon}^{\mathrm{eng}} = \mathbf{0}$.
- Exact analytical normal-strain components ($B_1$) and factor-of-two engineering-shear verification
  ($B_2$, $\gamma_{ij} = 2\varepsilon_{ij}$).
- Finite-difference directional derivative check $-\frac{1}{\mu_0 M_s V_i}\frac{\partial E_{\mathrm{mel}}}{\partial \mathbf{m}_i} = \mathbf{H}_{\mathrm{mel},i}$ to $10^{-11}$ in FP64.
- Active-mask exclusion of non-magnetic nodes ($\Omega_{\mathrm{sub}}$) and exact equivalence
  between uniform and spatially varying per-node/per-cell strain arrays.
- CPU/GPU parity at matched lumped-mass integration weights.

### Bidirectional FullMag v2 golden verification gates (`G1`–`G8`)

Full bidirectional elastodynamics qualification is governed by eight analytical and coupled
verification gates (detailed quantitatively in {doc}`numerical-methods-and-libraries`):

- **G1 (Free-crystal magnetostrictive equilibrium):** static spontaneous strain
  $\varepsilon_{ii}^{\mathrm{eq}} = -\frac{B_1}{C_{11}-C_{12}}(m_i^2 - \frac{1}{3})$,
  $\gamma_{ij}^{\mathrm{eq}} = -\frac{B_2}{C_{44}}m_i m_j$ under `traction_free` with RBM projection.
- **G2 (Multilayer $\mathrm{Ni}/\mathrm{Al}$ bilayer continuity):** exact interface jump
  $\llbracket\boldsymbol{\sigma}^{\mathrm{tot}}\cdot\hat{\mathbf{n}}\rrbracket = \mathbf{0}$
  with $\partial_x u_x = -4.48228\times 10^{-6}$ and
  $(\sigma_{xx}^{\mathrm{tot}}, \sigma_{yy}^{\mathrm{tot}}, \sigma_{zz}^{\mathrm{tot}}) = (0, +0.443746, -2.971754)\,\mathrm{MPa}$
  in Ni (demonstrating nonzero in-plane total stress despite $\sigma_{xx}^{\mathrm{tot}} = 0$).
- **G3 (Conservative magnon–phonon energy exchange):** $\lvert\Delta E_{\mathrm{tot}}\rvert / E_{\mathrm{exch}} < 10^{-6}$
  at $\alpha = 0$, `NoMechanicalDamping`.
- **G4 (Turov–Shavrov gap and `stress_free` vs. `clamped` check):** exact YIG gap fields
  ($36.040\,\mathrm{A\,m^{-1}}$ vs. $17.704\,\mathrm{A\,m^{-1}}$ under `stress_free`;
  $8.535\,\mathrm{A\,m^{-1}}$ vs. $36.040\,\mathrm{A\,m^{-1}}$ under `clamped`).
- **G5 (Magnon–polaron anticrossing in YIG at $5\,\mathrm{GHz}$):** $\Delta f_{\mathrm{1D}} = 79.6312\,\mathrm{MHz}$
  vs. $\Delta f_{\mathrm{3D}} = 112.6155\,\mathrm{MHz}$ with dark $\mathrm{TA}_-$ mode at $5.000\,\mathrm{GHz}$.
- **G6 (Acoustic impedance transmission across $\mathrm{YIG}/\mathrm{GGG}$):** passive normal-incidence
  amplitude and power transmission $T_{u,v} = 0.8805$, $T_\sigma = 1.1195$, $T_P = 0.9857$.
- **G7 (Melcher rotational coupling and SAW nonreciprocity):** angular-momentum conservation
  $\boldsymbol{\tau}_{\mathrm{mag}} + \boldsymbol{\tau}_{\mathrm{mech}} = \mathbf{0}$, Goldstone
  zero mode to $\mathcal{O}(\omega^2)$, and asymmetric $\pm k$ Rayleigh-wave attenuation.
- **G8 (Thermal acoustic FDT equipartition):** $\langle E_{\mathrm{kin},n}\rangle = \langle E_{\mathrm{pot},n}\rangle = \frac{1}{2}k_B T$
  and $\langle E_{\mathrm{tot},n}\rangle = k_B T$ per harmonic mode.

(physics-magnetoelastic-limitations)=
## Limitations

- On `master`, quasistatic elasticity, bidirectional elastodynamics, anisotropic 7-class elasticity,
  hexagonal 4-constant magnetostriction, Melcher rotational coupling, mechanical damping, absorbing
  layers, and thermal acoustic baths are schema/architecture specifications and are not yet
  executable runtime features.
- Finite-strain kinematics, self-consistent piezoelectric Gauss-law electrostatics, Barnett
  gyromagnetic fields (`include_barnett_gyromagnetic`), and deformed-mesh magnetostatic shape-tilt
  rotation (`include_shape_rotation`) are deferred to v2.1.
- Plasticity, viscoelastic creep beyond Kelvin–Voigt/Rayleigh models, and temperature-dependent
  elastic moduli $C_{ijkl}(T)$ are outside current scope.

(physics-magnetoelastic-scientific-bibliography)=
## Scientific bibliography

1. C. Kittel, "Physical Theory of Ferromagnetic Domains," *Reviews of Modern Physics* **21**(4),
   541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
2. C. Kittel, "Interaction of Spin Waves and Ultrasonic Waves in Ferromagnetic Crystals,"
   *Physical Review* **110**(4), 836–841 (1958),
   [doi:10.1103/PhysRev.110.836](https://doi.org/10.1103/PhysRev.110.836).
3. M. Born and K. Huang, *Dynamical Theory of Crystal Lattices*, Oxford University Press, 1954.
4. F. Mouhat and F.-X. Coudert, "Necessary and sufficient elastic stability conditions in various
   crystal systems," *Physical Review B* **90**(22), 224104 (2014),
   [doi:10.1103/PhysRevB.90.224104](https://doi.org/10.1103/PhysRevB.90.224104).
5. B. A. Auld, *Acoustic Fields and Waves in Solids*, Vols. 1–2, Wiley-Interscience, 1973.
6. W. P. Mason, "Derivation of Magnetostriction and Anisotropic Energies for Hexagonal, Tetragonal,
   and Orthorhombic Crystals," *Physical Review* **96**(2), 302–310 (1954),
   [doi:10.1103/PhysRev.96.302](https://doi.org/10.1103/PhysRev.96.302).
7. A. E. Clark, "Magnetostrictive Rare Earth-Fe2 Compounds," in *Ferromagnetic Materials*, Vol. 1,
   North-Holland, 1980.
8. E. du Trémolet de Lacheisserie, *Magnetostriction: Theory and Applications of
   Magnetoelasticity*, CRC Press, 1993.
9. H. F. Tiersten, "Coupled Magnetomechanical Equations for Magnetically Saturated Insulators,"
   *Journal of Mathematical Physics* **5**(9), 1298–1318 (1964),
   [doi:10.1063/1.1704239](https://doi.org/10.1063/1.1704239).
10. W. F. Brown, *Magnetoelastic Interactions*, Springer-Verlag, Berlin, 1966,
    [doi:10.1007/978-3-642-87396-6](https://doi.org/10.1007/978-3-642-87396-6).
11. R. L. Melcher, "Rotationally Invariant Theory of Spin–Phonon Interactions in Paramagnets,"
    *Physical Review Letters* **28**(3), 165–168 (1972),
    [doi:10.1103/PhysRevLett.28.165](https://doi.org/10.1103/PhysRevLett.28.165).
12. E. A. Turov and V. G. Shavrov, "Broken symmetry and magnetoacoustic effects in ferro- and
    antiferromagnetics," *Soviet Physics Uspekhi* **26**(7), 593–611 (1983),
    [doi:10.1070/PU1983v026n07ABEH004449](https://doi.org/10.1070/PU1983v026n07ABEH004449).
13. C. Thomsen, H. T. Grahn, H. J. Maris, and J. Tauc, "Surface generation and detection of
    phonons by picosecond light pulses," *Physical Review B* **34**(6), 4129–4138 (1986),
    [doi:10.1103/PhysRevB.34.4129](https://doi.org/10.1103/PhysRevB.34.4129).
14. L. Dreher, M. Weiler, M. Pernpeintner, H. Huebl, R. Gross, M. S. Brandt, and
    S. T. B. Goennenwein, "Surface acoustic wave driven ferromagnetic resonance in nickel thin
    films: Theory and experiment," *Physical Review B* **86**(13), 134415 (2012),
    [doi:10.1103/PhysRevB.86.134415](https://doi.org/10.1103/PhysRevB.86.134415).
15. S. Maehrlein, I. Radu, P. Maldonado, A. Paarmann, M. Gensch, A. M. Kalashnikova,
    R. V. Pisarev, M. Wolf, P. M. Oppeneer, J. Barker, and T. Kampfrath, "Dissecting spin-phonon
    equilibration in ferrimagnetic insulators by ultrafast lattice excitation," *Science Advances*
    **4**(7), eaar5164 (2018), [doi:10.1126/sciadv.aar5164](https://doi.org/10.1126/sciadv.aar5164).
16. M. Xu, K. Yamamoto, J. Puebla, K. Baumgaertl, B. Rana, K. Miura, H. Takahashi, D. Grundler,
    S. Maekawa, and Y. Otani, "Nonreciprocal surface acoustic wave propagation via
    magneto-rotation coupling," *Science Advances* **6**(32), eabb1724 (2020),
    [doi:10.1126/sciadv.abb1724](https://doi.org/10.1126/sciadv.abb1724).
17. F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos,
    F. Ciubotaru, and C. Adelmann, "Finite difference magnetoelastic simulator," *Open Research
    Europe* **1**, 35 (2021),
    [doi:10.12688/openreseurope.13302.1](https://doi.org/10.12688/openreseurope.13302.1).
18. F. Vanderveken, J. Mulkers, J. Leliaert, B. Van Waeyenberge, B. Sorée, O. Zografos,
    F. Ciubotaru, and C. Adelmann, "Confined magnetoelastic waves in thin waveguides," *Physical
    Review B* **103**(5), 054439 (2021),
    [doi:10.1103/PhysRevB.103.054439](https://doi.org/10.1103/PhysRevB.103.054439)
    ([arXiv:2011.10326](https://arxiv.org/abs/2011.10326)).
19. P. Flauger, M. Küß, M. K. Steinbauer, F. Bruckner, B. Emhofer, E. Nysten, M. Weiß,
    D. Suess, H. J. Krenner, M. Albrecht, and C. Abert, "Modeling magnetoelastic wave interactions
    in magnetic films and heterostructures: A finite-difference approach," *Physical Review
    Applied* **25**(3) (2026), [doi:10.1103/9txq-sc8f](https://doi.org/10.1103/9txq-sc8f)
    ([arXiv:2509.06007](https://arxiv.org/abs/2509.06007)).
20. A. Rückriegel, P. Kopietz, D. A. Bozhko, A. A. Serga, and B. Hillebrands, "Magnetoelastic
    modes and lifetime of magnons in thin yttrium iron garnet films," *Physical Review B*
    **89**(18), 184413 (2014),
    [doi:10.1103/PhysRevB.89.184413](https://doi.org/10.1103/PhysRevB.89.184413).
21. C. Berk, M. Jaris, W. Yang, S. Dhuey, S. Cabrini, and H. Schmidt, "Strongly coupled
    magnon–phonon dynamics in a single nanomagnet," *Nature Communications* **10**, 2652 (2019),
    [doi:10.1038/s41467-019-10545-x](https://doi.org/10.1038/s41467-019-10545-x).
22. L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Butterworth-Heinemann, 1986.

(physics-magnetoelastic-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Magnetoelastic` | Magnetoelastic coupling interaction term and IR lowering |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticMaterial` | Elastic material constants and density IR authoring |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticBody` | Mechanical body geometry-to-material binding |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MagnetostrictionLaw` | Cubic and isotropic magnetostriction law IR authoring |
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MechanicalLoad` | Prescribed engineering-Voigt strain/stress/body-force load authoring |
| `crates/fullmag-ir/src/mechanics.rs` | `MechanicsIR` | Canonical Rust IR container for mechanics materials, bodies, laws, BCs, and loads |
| `crates/fullmag-plan/src/fem.rs` | `resolve_fem_magnetoelastic_plan` | FEM prescribed-strain legality and fail-closed capability planner |
| `crates/fullmag-engine/src/magnetoelastic.rs` | `h_mel_single_with_ms` | Local FDM reference routine for magnetoelastic effective field |
| `crates/fullmag-engine/src/magnetoelastic.rs` | `e_mel_density_single` | Local FDM reference routine for cubic magnetoelastic energy density |
| `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp` | `compute_magnetoelastic_field` | FEM CPU prescribed-strain field and lumped-mass energy kernel |
| `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp` | `gpu_magnetoelastic_upload_strain` | FEM GPU engineering-Voigt strain upload |
| `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu` | `fullmag_cuda_magnetoelastic_field_energy_blocks` | FEM GPU CUDA prescribed-strain field and energy reduction kernel |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_magnetoelastic_energy_fp64` | FDM GPU FP64 magnetoelastic energy reduction kernel |
| Specification contract (v2) | {ref}`Anisotropic 7-class elasticity <magnetoelastic-v2-anisotropic-elasticity-contract>` | Planned v2 contract for 7-class anisotropic elasticity, Born stability, and Bond rotations |
| Specification contract (v2) | {ref}`Hexagonal 4-constant law <magnetoelastic-v2-hexagonal-contract>` | Planned v2 contract for four-constant hexagonal magnetostriction |
| Specification contract (v2) | {ref}`Melcher rotational coupling <magnetoelastic-v2-rotational-coupling-contract>` | Planned v2 contract for Melcher $\mathcal{O}(\omega^2)$ magneto-rotational coupling |
| Specification contract (v2) | {ref}`Mechanical damping models <magnetoelastic-v2-damping-contract>` | Planned v2 contract for five disjoint mechanical damping models and congruent SPD Kelvin–Voigt |
| Specification contract (v2) | {ref}`Thermal bath and acoustic drives <magnetoelastic-v2-thermal-drives-contract>` | Planned v2 contract for Langevin acoustic FDT bath and IDT/Thomsen/harmonic drives |
