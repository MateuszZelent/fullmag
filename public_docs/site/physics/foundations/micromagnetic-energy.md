---
title: Micromagnetic energy
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/units.md
---

(public-docs-physics-foundations-micromagnetic-energy)=
# Micromagnetic energy

FullMag solves the Landau–Lifshitz–Gilbert equation for the reduced magnetization
$\mathbf{m} = \mathbf{M}/M_s$ by computing effective fields from physical energy
functionals. This page defines the total energy, its decomposition into interaction terms,
and the variational principle that links energies to effective fields.

## Total energy functional

The total micromagnetic energy is a sum of independent interaction contributions

```{math}
:label: eq-total-energy
E_{\mathrm{tot}}[\mathbf{m}]
=
E_{\mathrm{ex}} + E_{\mathrm{d}} + E_{\mathrm{Z}} + E_{\mathrm{ani}} + E_{\mathrm{DMI}}
+ E_{\mathrm{mel}} + E_{\mathrm{oe}} + \cdots
```

Each term is documented in its own canonical interaction page. Every energy is reported in
joules ($\mathrm{J}$) and integrated over the magnetic domain $\Omega_m$ unless explicitly
documented otherwise.

## Interaction energy summary

| Energy | Physical origin | Typical density | Canonical page |
|---|---|---:|---|
| $E_{\mathrm{ex}}$ | exchange stiffness | $A\,|\nabla\mathbf{m}|^2$ | {doc}`../interactions/exchange/index` |
| $E_{\mathrm{d}}$ | dipole–dipole (demagnetization) | $-\tfrac{1}{2}\mu_0 M_s\mathbf{m}\cdot\mathbf{H}_{\mathrm{d}}$ | {doc}`../interactions/demagnetization/index` |
| $E_{\mathrm{Z}}$ | Zeeman (external field) | $-\mu_0 M_s\mathbf{m}\cdot\mathbf{H}_{\mathrm{ext}}$ | {doc}`../interactions/zeeman/index` |
| $E_{\mathrm{ani}}$ | magnetocrystalline anisotropy | $K_{u1}\sin^2\theta$ (uniaxial) | {doc}`../interactions/anisotropy/index` |
| $E_{\mathrm{DMI}}$ | Dzyaloshinskii–Moriya | $D\,\mathbf{m}\cdot(\nabla\times\mathbf{m})$ (bulk) | {doc}`../interactions/dmi/index` |
| $E_{\mathrm{mel}}$ | magnetoelastic coupling | $B_1\varepsilon_{ii}(m_i^2-\tfrac{1}{3})$ | {doc}`../interactions/magnetoelastic/index` |
| $E_{\mathrm{oe}}$ | Oersted (current-induced) | $-\mu_0 M_s\mathbf{m}\cdot\mathbf{H}_{\mathrm{oe}}$ | {doc}`../interactions/oersted-field/index` |

:::{admonition} Non-conservative interactions
:class: note

Spin-transfer torque (STT), spin-orbit torque (SOT), and thermal noise are **not** derived
from an energy functional. They contribute direct torques
$\boldsymbol{\tau}$ to the LLG right-hand side. See
{doc}`../interactions/spin-transfer-torque/index`,
{doc}`../interactions/spin-orbit-torque/index`, and
{doc}`../interactions/thermal-noise/index`.
:::

## Variational principle: energy to field

Every conservative interaction derives its effective-field contribution from the variational
identity

```{math}
:label: eq-variational-principle
\mathbf{H}_{\mathrm{term}}
=
-\frac{1}{\mu_0 M_s}\frac{\delta E_{\mathrm{term}}}{\delta\mathbf{m}}.
```

This means the directional derivative of the energy satisfies

```{math}
:label: eq-directional-derivative
\delta E_{\mathrm{term}}[\mathbf{m};\boldsymbol{\eta}]
=
-\mu_0\int_{\Omega_m}M_s\,\mathbf{H}_{\mathrm{term}}\cdot\boldsymbol{\eta}\,\mathrm{d}V
```

for all admissible variations $\boldsymbol{\eta}$ tangent to the unit sphere
($\boldsymbol{\eta}\cdot\mathbf{m}=0$).

This variational relation is the definition of the effective field — not a convenience
shortcut. Every interaction page must verify Eq. {eq}`eq-directional-derivative` for its
implemented equations.

## Energy minimization and equilibrium

At thermodynamic equilibrium (zero temperature, zero driving current), the magnetization
minimises the total energy subject to the saturation constraint $|\mathbf{m}|=1$. The
necessary condition is

```{math}
:label: eq-equilibrium-condition
\mathbf{m}\times\mathbf{H}_{\mathrm{eff}} = \mathbf{0}
\quad\text{on }\Omega_m,
```

i.e. the magnetization is everywhere parallel to the effective field. FullMag's relaxation
algorithms (overdamped LLG, direct energy minimizers) converge to states satisfying this
condition within a documented tolerance.

## Domain integration

Energy integration is always over the magnetic domain $\Omega_m$:

- **FDM**: sum over active cells with volume $V_i$ and (optionally) magnetic volume
  fraction $\varphi_i$.
- **FEM**: integration over magnetic elements using the finite-element quadrature rule,
  with non-magnetic (airbox) elements excluded.

The demagnetization field $\mathbf{H}_{\mathrm{d}}$ may be solved on a larger domain
(airbox or open boundary), but the energy integral uses only the magnetic subdomain.

## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $E_{\mathrm{tot}}$ | total micromagnetic energy | $\mathrm{J}$ |
| $E_{\mathrm{term}}$ | individual interaction energy | $\mathrm{J}$ |
| $\mathbf{H}_{\mathrm{eff}}$ | total effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{term}}$ | interaction effective-field contribution | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\eta}$ | admissible magnetization variation | $1$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $V_i$ | discrete cell or element volume | $\mathrm{m^3}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
   [Bibliographic record](https://search.worldcat.org/title/536451).
2. A. Aharoni, *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University
   Press, 2000.
3. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
