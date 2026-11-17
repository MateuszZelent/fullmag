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
for the authoritative foundation contract and {ref}`fig-fullmag-object-interaction-architecture`
for the end-to-end authoring-to-execution pipeline.

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf{m}$ | reduced magnetization $\mathbf{M}/M_s$ ($\|\mathbf{m}\|_2 = 1$) | $1$ |
| $\mathbf{M}$ | dimensional magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}$ | magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{B}$ | magnetic flux density | $\mathrm{T}$ |
| $\mu_0$ | vacuum permeability ($4\pi\times 10^{-7}$) | $\mathrm{N\,A^{-2}}$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant ($\mu_0|\gamma_e|\approx 2.211\times 10^5$) | $\mathrm{m\,(A\,s)^{-1}}$ |
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

The project-wide convention is maintained in docs/physics/llg_conventions.md and
docs/physics/0000-physics-documentation-standard.md. Public pages may summarize it, but may not
introduce a second sign or unit convention.
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Geometry` or `Material` as named by the linked API page. Status: `partial`. frontend support is not implemented applies to physical parameters without a matching control. See {doc}`/frontend/capability-register`; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is not applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.
## Source-code index

- Public Python and lowering sources are linked by the applicable terminal API page. Runtime realization is in the relevant `backends/fdm` or `backends/fem` lane; frontend ownership is `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` where a live control exists.

