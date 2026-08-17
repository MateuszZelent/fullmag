---
title: Physical Interactions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-root)=
# Physical Interactions

Interactions are the energy and torque contributions that drive magnetization. Each interaction has
**one canonical scientific owner** below; FDM, FEM, CPU and GPU realizations live inside that owner
as an explicit support and qualification matrix, so shared physics is never copied across four
backend pages.

## Catalog

| Interaction | Physical role | Canonical page | Python API |
|---|---|---|---|
| Exchange | Short-range stiffness $A_{\mathrm{ex}}$ | {doc}`exchange/index` | {doc}`../../python-api/interactions/exchange` |
| Demagnetization | Magnetostatic self field | {doc}`demagnetization/index` | {doc}`../../python-api/interactions/demagnetization` |
| Zeeman | External field $\mathbf B_{\mathrm{ext}}$ | {doc}`zeeman/index` | {doc}`../../python-api/interactions/zeeman` |
| Anisotropy | Preferred axes (uniaxial/cubic) | {doc}`anisotropy/index` | uniaxial / {doc}`../../python-api/interactions/uniaxial-anisotropy`, cubic / {doc}`../../python-api/interactions/cubic-anisotropy` |
| Dzyaloshinskii–Moriya | Chiral magnetization textures | {doc}`dmi/index` | {doc}`../../python-api/interactions/interfacial-dmi`, {doc}`../../python-api/interactions/bulk-dmi` |
| Thermal noise | Stochastic Brown field | {doc}`thermal-noise/index` | {doc}`../../python-api/interactions/thermal-noise` |
| Magnetoelastic | Strain coupling to magnetism | {doc}`magnetoelastic/index` | {doc}`../../python-api/interactions/magnetoelastic` |
| Oersted field | Current-generated field | {doc}`oersted-field/index` | {doc}`../../python-api/interactions/oersted-field` |
| Spin-transfer torque | Current-driven torque transfer | {doc}`spin-transfer-torque/index` | {doc}`../../python-api/interactions/spin-transfer-torque` |
| Spin-orbit torque | Spin-Hall / interfacial torque | {doc}`spin-orbit-torque/index` | {doc}`../../python-api/interactions/spin-orbit-torque` |
| Drift-diffusion spin torque | Drift–diffusion spin transport | {doc}`drift-diffusion-spin-torque/index` | {doc}`../../python-api/interactions/drift-diffusion-spin-torque` |
| Inter-region couplings | Cross-interface coupling terms | {doc}`inter-region-couplings/index` | {doc}`../../python-api/interactions/inter-region-couplings` |

## Large-topic subtrees

Demagnetization and DMI grow beyond a single page because each has independently useful scientific
boundaries:

- {doc}`demagnetization/index` — mathematical formulation, boundary conditions, FDM convolution,
  multilayer convolution, FEM Poisson airbox, FEM/BEM, periodic demag, and validation.
- {doc}`dmi/index` — interfacial, bulk, boundary conditions, and validation.

## Realization matrix

Every terminal page documents one row each for FDM CPU, FDM GPU, FEM CPU, and FEM GPU, including
`unsupported`, `planned`, and `not qualified` lanes. Source presence, a compiled binary, or a
skipped test is never promoted to a qualification claim. The numerical algorithm pages that back
several realizations live under {doc}`../../numerical-methods/index`.

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
