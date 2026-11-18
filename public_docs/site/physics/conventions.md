---
title: Physical conventions and units
status: draft
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/llg_conventions.md
---

# Physical conventions and units

FullMag uses SI units exclusively across its Python DSL, `ProblemIR`, solver backends, and
observables. Every interaction page defines exact symbols, signs, coordinate orientation,
magnetization normalization, and limits of validity. See {doc}`foundations/conventions-and-units`
for the authoritative foundation contract and {numref}`fig-fullmag-object-interaction-architecture`
for the end-to-end authoring-to-execution pipeline.

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization $\mathbf{M}/M_s$ ($\|\mathbf{m}\|_2 = 1$) | $1$ |
| $\mathbf{M}$ | dimensional magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}$ | magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{B}$ | magnetic flux density | $\mathrm{T}$ |
| $\mu_0$ | vacuum permeability ($4\pi\times 10^{-7}$) | $\mathrm{N\,A^{-2}}$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant ($\mu_0\lvert\gamma_e\rvert \approx 2.211\times 10^5$) | $\mathrm{m\,(A\,s)^{-1}}$ |
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $t$ | simulation time | $\mathrm{s}$ |
| $f$ | frequency | $\mathrm{Hz}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $\mathbf{J}_c$ | conventional charge-current density ($e > 0$) | $\mathrm{A\,m^{-2}}$ |

## Shared sign and variational conventions

- **Energy-to-field variation**: for every conservative energy contribution $E_k[\mathbf{m}]$,
  the effective field satisfies $\delta E_k[\mathbf{m};\boldsymbol{\eta}] = -\mu_0\int_{\Omega_m} M_s\,\mathbf{H}_k\cdot\boldsymbol{\eta}\,\mathrm{d}V$,
  so Zeeman energy is $E_{\mathrm{Z}} = -\int_{\Omega_m}\mathbf{M}\cdot\mathbf{B}_{\mathrm{ext}}\,\mathrm{d}V$ with $\mathbf{H}_{\mathrm{Z}} = \mathbf{B}_{\mathrm{ext}}/\mu_0$.
- **Direct torques vs. fields**: non-conservative spin torques enter as Gilbert-source rates
  $\mathbf{T}_G$ (in $\mathrm{s^{-1}}$) and are converted once to explicit LLG RHS rates
  $\boldsymbol{\tau}_{\mathrm{direct}} = (\mathbf{T}_G + \alpha\,\mathbf{m}\times\mathbf{T}_G)/(1+\alpha^2)$,
  never disguised as effective fields.
- **Conventional current ($e > 0$)**: electrical current density $\mathbf{J}_c$ and electric
  field $\mathbf{E} = -\nabla V$ follow positive-charge transport sign conventions throughout
  Oersted, spin-transfer torque, and spin-orbit transport modules.

For the complete unit contract, variational derivation, and `ProblemIR` serialization rules, see
{doc}`foundations/conventions-and-units`.

