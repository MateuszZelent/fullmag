---
title: Magnetoelastic interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0700-shared-magnetoelastic-semantics.md
---

(public-docs-physics-interactions-magnetoelastic)=
# Magnetoelastic interaction

Magnetoelastic coupling models the bidirectional interaction between magnetization dynamics
and mechanical deformation in ferromagnetic solids. It is essential for magnetostrictive
actuators, spin-wave–strain coupling, and stress-induced anisotropy in thin films.

(mel-problem-statement)=
## Physical problem

A ferromagnetic material deforms spontaneously when magnetized (magnetostriction) and its
magnetic anisotropy changes under applied stress (inverse magnetostriction). In FullMag,
both effects are captured by a single magnetoelastic coupling energy term that couples the
reduced magnetization $\mathbf{m}$ to the elastic displacement field $\mathbf{u}$.

The total energy with magnetoelastic coupling is

```{math}
:label: eq-mel-total-energy
E_{\mathrm{tot}}
=
E_{\mathrm{mag}}[\mathbf{m}]
+ E_{\mathrm{el}}[\mathbf{u}]
+ E_{\mathrm{mel}}[\mathbf{m},\mathbf{u}],
```

where $E_{\mathrm{mag}}$ contains the standard micromagnetic contributions,
$E_{\mathrm{el}}$ is the elastic strain energy, and $E_{\mathrm{mel}}$ is the coupling.

(mel-governing-equations)=
## Governing equations

### Elastic energy

```{math}
:label: eq-mel-elastic-energy
E_{\mathrm{el}}
=
\frac{1}{2}\int_\Omega
(\boldsymbol{\varepsilon}-\boldsymbol{\varepsilon}^{\mathrm{mag}})
:\mathbf{C}:
(\boldsymbol{\varepsilon}-\boldsymbol{\varepsilon}^{\mathrm{mag}})
\,\mathrm{d}V,
```

where $\boldsymbol{\varepsilon}(\mathbf{u})$ is the small-strain tensor and
$\boldsymbol{\varepsilon}^{\mathrm{mag}}(\mathbf{m})$ is the magnetostrictive eigenstrain.

### Strain–displacement relation (small strain)

```{math}
:label: eq-mel-strain
\varepsilon_{ij}
=
\frac{1}{2}\left(\frac{\partial u_i}{\partial x_j}+\frac{\partial u_j}{\partial x_i}\right).
```

### Constitutive law

```{math}
:label: eq-mel-constitutive
\sigma_{ij} = C_{ijkl}(\varepsilon_{kl}-\varepsilon_{kl}^{\mathrm{mag}}).
```

For cubic symmetry, the stiffness tensor in Voigt notation has three independent constants:
$C_{11}$, $C_{12}$, $C_{44}$. For isotropic symmetry:
$C_{11}=\lambda+2\mu$, $C_{12}=\lambda$, $C_{44}=\mu$.

### Magnetostrictive eigenstrain — cubic symmetry

```{math}
:label: eq-mel-eigenstrain-cubic-diag
\varepsilon^{\mathrm{mag}}_{ii}
=
\frac{3}{2}\lambda_{100}\left(m_i^2-\frac{1}{3}\right),
```

```{math}
:label: eq-mel-eigenstrain-cubic-off
\varepsilon^{\mathrm{mag}}_{ij}
=
\frac{3}{2}\lambda_{111}\,m_i\,m_j
\qquad (i\neq j).
```

### B1/B2 coupling formulation

The magnetoelastic energy density in the $B_1$/$B_2$ formulation using tensor strain is

```{math}
:label: eq-mel-b1b2-density
e_{\mathrm{mel}}
=
B_1\left[\varepsilon_{11}(m_1^2-\tfrac{1}{3})
+\varepsilon_{22}(m_2^2-\tfrac{1}{3})
+\varepsilon_{33}(m_3^2-\tfrac{1}{3})\right]
+2B_2(\varepsilon_{12}m_1m_2+\varepsilon_{13}m_1m_3+\varepsilon_{23}m_2m_3),
```

with coupling constants

```{math}
:label: eq-mel-b1b2-constants
B_1 = -\frac{3}{2}\lambda_{100}(C_{11}-C_{12}),
\qquad
B_2 = -3\lambda_{111}C_{44}.
```

:::{admonition} Strain convention
:class: note

The factor $2$ in front of $B_2$ arises because $\varepsilon_{ij}$ are *tensor* (symmetric)
strain components. In the engineering-shear convention ($\gamma_{ij}=2\varepsilon_{ij}$), the
equivalent formula has no explicit factor of $2$.
:::

### Magnetoelastic effective field

The variational derivative of $E_{\mathrm{mel}}$ with respect to $\mathbf{m}$ produces

```{math}
:label: eq-mel-field
\mathbf{H}_{\mathrm{mel}}
=
-\frac{1}{\mu_0 M_s}\frac{\delta E_{\mathrm{mel}}}{\delta\mathbf{m}}.
```

For cubic $B_1$/$B_2$ coupling, the first component is

```{math}
:label: eq-mel-field-component
H_{\mathrm{mel},1}
=
-\frac{1}{\mu_0 M_s}
\left[2B_1\varepsilon_{11}m_1+2B_2(\varepsilon_{12}m_2+\varepsilon_{13}m_3)\right],
```

with cyclic permutations for components 2 and 3.

### Mechanical equilibrium

```{math}
:label: eq-mel-equilibrium
\nabla\cdot\boldsymbol{\sigma} = \mathbf{0}
\qquad\text{(quasistatic)},
```

or for full elastodynamics:

```{math}
:label: eq-mel-elastodynamics
\rho\ddot{\mathbf{u}} = \nabla\cdot\boldsymbol{\sigma}+\mathbf{f}.
```

(mel-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\mathbf{u}$ | displacement | $\mathrm{m}$ |
| $\boldsymbol{\varepsilon}$ | strain tensor | $1$ |
| $\boldsymbol{\varepsilon}^{\mathrm{mag}}$ | magnetostrictive eigenstrain | $1$ |
| $\boldsymbol{\sigma}$ | stress tensor | $\mathrm{Pa}$ |
| $\mathbf{C}$ | elastic stiffness tensor | $\mathrm{Pa}$ |
| $C_{11},C_{12},C_{44}$ | cubic elastic constants | $\mathrm{Pa}$ |
| $\rho$ | mass density | $\mathrm{kg\,m^{-3}}$ |
| $B_1,B_2$ | magnetoelastic coupling constants | $\mathrm{Pa}$ |
| $\lambda_{100},\lambda_{111}$ | magnetostriction constants | $1$ |
| $\lambda_s$ | isotropic saturation magnetostriction | $1$ |
| $\mathbf{H}_{\mathrm{mel}}$ | magnetoelastic effective field | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm{mel}}$ | magnetoelastic coupling energy | $\mathrm{J}$ |
| $E_{\mathrm{el}}$ | elastic strain energy | $\mathrm{J}$ |

(mel-assumptions-and-validity)=
## Assumptions and validity

- Small strain ($\|\boldsymbol{\varepsilon}\|\ll 1$) — no geometric nonlinearity.
- Linear elasticity (Hookean constitutive law).
- Saturated magnetization ($|\mathbf{m}|=1$).
- Crystal orientation defaults to the lab frame; optional rotation for oriented grains.
- No thermal effects on the elastic response.
- Total strain = elastic + magnetostrictive (additive decomposition).

(mel-python-api)=
## Python authoring and canonical ProblemIR

### Complete, copyable example

```python
# %% Imports
import fullmag as fm

nm = 1e-9

# %% Elastic material and body
mat_el = fm.ElasticMaterial(
    name="CoFe_elastic",
    C11=2.41e11,  # Pa
    C12=1.46e11,  # Pa
    C44=1.12e11,  # Pa
    rho=8900.0,   # kg/m³
)
geom = fm.Box(size=(200 * nm, 100 * nm, 10 * nm), name="strip")
body = fm.ElasticBody(name="solid1", geometry=geom, elastic_material=mat_el)

# %% Magnetostriction law
law = fm.MagnetostrictionLaw(name="CoFe_ms", kind="cubic", B1=-6.95e6, B2=-5.62e6)

# %% Magnetic material and ferromagnet
material = fm.Material(name="CoFe", Ms=1.2e6, A=15e-12, alpha=0.01)
magnet = fm.Ferromagnet(
    name="mag1",
    geometry=geom,
    material=material,
    m0=fm.texture.uniform((1.0, 0.0, 0.0)),
)

# %% Problem with magnetoelastic coupling
problem = fm.Problem(
    name="magnetoelastic_strip",
    magnets=[magnet],
    elastic_bodies=[body],
    magnetostriction_laws=[law],
    energy=[fm.Exchange(), fm.Demag(), fm.Magnetoelastic(magnet="mag1", body="solid1", law="CoFe_ms")],
    study=fm.TimeEvolution(dynamics=fm.LLG()),
)
```

### Parameter reference — Magnetoelastic

| Python | Type | Default | SI unit | Validation | ProblemIR |
|---|---|---|---|---|---|
| `magnet` | `str` | `required` | — | must name a `Ferromagnet` | `energy_terms[].magnet` |
| `body` | `str` | `required` | — | must name an `ElasticBody` | `energy_terms[].body` |
| `law` | `str` | `required` | — | must name a `MagnetostrictionLaw` | `energy_terms[].law` |

### Execution modes

The energy term `Magnetoelastic` is always the same; the planner selects the mechanical
solve mode based on the study and dynamics specification:

| Mode | State variables | Mechanical solve | Use case |
|---|---|---|---|
| Prescribed strain/stress | $\mathbf{m}$ | none | stress-induced anisotropy |
| Quasistatic elasticity | $\mathbf{m},\mathbf{u}$ | $\nabla\cdot\boldsymbol{\sigma}=0$ | magnetostrictive actuation |
| Elastodynamics | $\mathbf{m},\mathbf{u},\mathbf{v}$ | $\rho\ddot{\mathbf{u}}=\nabla\cdot\boldsymbol{\sigma}$ | spin-wave / acoustic coupling |

(mel-discrete-realization)=
## Discrete realization by solver and device

### FDM

Collocated grid, same as the magnetization grid. Strain via central differences. Ghost-cell
or traction closure for free-surface Neumann BC. CG iterative solver for quasistatic
elasticity.

See `docs/physics/0710-fdm-magnetoelastic-small-strain.md` for the full FDM treatment.

### FEM

$U_h \subset [H^1(\Omega_s)]^d$ for displacement. Standard Galerkin weak form for
elasticity. MFEM + libCEED + hypre linear solve. Transfer operators between magnetic and
mechanical meshes.

See `docs/physics/0720-fem-magnetoelastic-small-strain-mfem-gpu.md` for the full FEM
treatment.

(mel-validation)=
## Validation status

| Lane | Status |
|---|---|
| FDM CPU | Draft implementation; not production-qualified |
| FDM GPU | Deferred |
| FEM CPU | Draft implementation; not production-qualified |
| FEM GPU | Deferred |

### Planned validation checks

1. **Derivative consistency**: finite-difference check
   $-\delta E_{\mathrm{mel}}/\delta\mathbf{m} \leftrightarrow \mathbf{H}_{\mathrm{mel}}$
   with tolerance $< 10^{-6}$.
2. **Zero coupling**: $B_1=B_2=0 \Rightarrow \mathbf{H}_{\mathrm{mel}}=0$,
   $E_{\mathrm{mel}}=0$.
3. **Stress consistency**: $\boldsymbol{\sigma}=\mathbf{C}:(\boldsymbol{\varepsilon}-\boldsymbol{\varepsilon}^{\mathrm{mag}})$ verified pointwise.
4. **Cross-backend comparison**: FDM vs FEM for Box geometry.

(mel-limitations)=
## Known limitations

- Magnetoelastic coupling is in draft status — not production-qualified on any backend.
- Finite strain / large deformation is out of scope.
- Nonlinear constitutive laws are not supported.
- No thermodynamic coupling.
- No interface magnetoelastic coupling (inter-body).
- Full elastodynamics CFL / stability analysis is pending.
- CUDA GPU acceleration for the mechanical solver is deferred.

(mel-scientific-bibliography)=
## Scientific bibliography

1. Y. C. Shu, M. P. Lin, and K. C. Wu, "Micromagnetic modeling of magnetostrictive
   materials under intrinsic stress," *Mechanics of Materials* **36**(10), 975 (2004).
2. C. Y. Liang *et al.*, "Finite difference magnetoelastic simulator," *npj Computational
   Materials* (2023). [doi:10.1038/s41524-023-01073-w](https://doi.org/10.1038/s41524-023-01073-w).
3. C. M. Pfeiler, M. Ruggeri, B. Stiftner *et al.*, "A decoupled, convergent and fully
   linear algorithm for the Landau–Lifshitz–Gilbert equation with magnetoelastic effects,"
   arXiv:2309.00605 (2023).
4. L. Exl *et al.*, "Micromagnetic energy and variational principles," in *Computational
   Micromagnetics*, Springer, 2019.

(mel-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python term | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Magnetoelastic` | constructor and IR | Python |
| Elastic material | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticMaterial` | elastic constants | Python |
| Elastic body | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class ElasticBody` | body definition | Python |
| FDM physics | `docs/physics/0710-fdm-magnetoelastic-small-strain.md` | — | FDM design | internal |
| FEM physics | `docs/physics/0720-fem-magnetoelastic-small-strain-mfem-gpu.md` | — | FEM design | internal |
