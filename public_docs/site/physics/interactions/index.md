---
title: Physical Interactions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-root)=
# Physical Interactions

FullMag documents each interaction once as a canonical physical contract, with solver/device realization and qualification boundaries stated on the interaction page.

```{figure} /_static/diagrams/interactions-taxonomy-energy-vs-torque.svg
:alt: Taxonomy of all 12 Fullmag physical interactions grouped into local energy densities, differential operators with natural boundary conditions, nonlocal magnetostatic and Oersted operators, stochastic thermal Brown field, and direct non-conservative spin torques entering the explicit LLG right-hand side.
:width: 100%
:name: fig-interactions-taxonomy-energy-vs-torque
:figclass: fm-physics-figure

Taxonomy of Fullmag's 12 physical interactions grouped by variational role, operator locality, natural boundary laws, and how each module enters the LLG equation: conservative field contributions ($\mathcal{K}_{\mathrm{field}} \to \mathbf{H}_{\mathrm{eff}}$ in $\mathrm{A\,m^{-1}}$), stochastic Brown fluctuations ($\mathbf{H}_{\mathrm{th}}$), or direct current-driven spin torques ($\boldsymbol{\tau}_{\mathrm{direct}}$ in $\mathrm{s^{-1}}$; reviewed in Abert 2019, [CC-BY PDF](https://link.springer.com/content/pdf/10.1140/epjb/e2019-90599-6.pdf) / [arXiv:1810.12365](https://arxiv.org/abs/1810.12365)).
```

## Overview by equation-of-motion role

| Interaction | Variational / RHS Role | Canonical Python Entrypoints | Primary Coupled / Boundary Contract |
|---|---|---|---|
| {doc}`zeeman/index` | Local field $\mathbf{H}_{\mathrm{Z}} = \mathbf{B}_{\mathrm{ext}}/\mu_0$ | `Zeeman`, `StaticFieldMap` | Prescribed external flux density $\mathbf{B}_{\mathrm{ext}}$ ($\mathrm{T}$) |
| {doc}`anisotropy/index` | Local field $\mathbf{H}_{\mathrm{u}}, \mathbf{H}_{\mathrm{c}}$ | `UniaxialAnisotropy`, `CubicAnisotropy` | Negative-power uniaxial & orthonormal crystal conventions |
| {doc}`magnetoelastic/index` | Local strain-coupled field $\mathbf{H}_{\mathrm{mel}}$ | `Magnetoelastic`, `ElasticBody` | Engineering-Voigt strain $\boldsymbol{\varepsilon}^{\mathrm{eng}}$; mechanical BCs |
| {doc}`exchange/index` | Differential field $\mathbf{H}_{\mathrm{ex}}$ | `Exchange` | Natural free-surface Neumann $A\partial_n\mathbf{m}=\mathbf{0}$ |
| {doc}`dmi/index` | Differential chiral field $\mathbf{H}_{\mathrm{DMI}}$ | `InterfacialDMI`, `RotatedInterfacialDMI`, `BulkDMI` | Chiral boundary twist $2A\partial_{\boldsymbol{\nu}}\mathbf{m} + D[(\hat{\mathbf{n}}\times\boldsymbol{\nu})\times\mathbf{m}]=\mathbf{0}$ |
| {doc}`inter-region-couplings/index` | Interface link / surface energy $\Gamma_{ab}$ | `study.couplings.exchange`, `.rkky`, `.interlayer_exchange` | Harmonic region exchange $A_{ab}$ vs. bilinear/biquadratic $J_1, J_2$ |
| {doc}`demagnetization/index` | Nonlocal magnetostatic field $\mathbf{H}_{\mathrm{d}}$ | `Demag` | Open FFT / multilayer, FEM airbox (Dirichlet/Robin), FEM–BEM, PBC |
| {doc}`oersted-field/index` | Current-generated field $\mathbf{H}_{\mathrm{oe}}$ | `OerstedCylinder`, `OerstedField` | Analytic Ampère cylinder vs. closed `CurrentTransport` Biot–Savart |
| {doc}`thermal-noise/index` | Stochastic field $\mathbf{H}_{\mathrm{th}}$ | `ThermalNoise` | FDT variance with bare $\gamma_0$; disables RK FSAL reuse |
| {doc}`spin-transfer-torque/index` | Direct spin torque $\mathbf{T}_{\mathrm{SL},G}, \mathbf{T}_{\mathrm{ZL},G}$ | `SlonczewskiSTT`, `ZhangLiSTT` | Single Gilbert-to-explicit RHS conversion |
| {doc}`spin-orbit-torque/index` | Direct local torque $\mathbf{T}_{\mathrm{SOT},G}$ | `PrescribedSpinOrbitTorque` | `SignedScalarDrive` / `VectorCurrentDrive`; no transport mesh |
| {doc}`drift-diffusion-spin-torque/index` | Solved transport torque $\mathbf{T}_{\mathrm{tr},G}$ | `CurrentTransport`, `SpinDriftDiffusion`, `DriftDiffusionSpinTorque` | M1 one-way vs. M2 reciprocal $(V, \boldsymbol{\mu}_s)$ with mixing interfaces |

```{toctree}
:maxdepth: 1

exchange/index
demagnetization/index
zeeman/index
anisotropy/index
dmi/index
thermal-noise/index
magnetoelastic/index
oersted-field/index
spin-transfer-torque/index
spin-orbit-torque/index
drift-diffusion-spin-torque/index
inter-region-couplings/index
```
