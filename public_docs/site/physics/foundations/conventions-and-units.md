---
title: Conventions and units
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/units.md
---

(public-docs-physics-foundations-conventions-and-units)=
# Conventions and units

FullMag uses SI units throughout, with no implicit unit conversion. Every solver backend
(FDM CPU, FDM GPU, FEM CPU, FEM GPU) shares the same physical contract. This page defines
the canonical quantities, their symbols, SI units, and the solver field names used to store
them.

## Reduced magnetization

The solver state variable is the reduced (normalised) magnetization

```{math}
:label: eq-reduced-magnetization
\mathbf{m} = \frac{\mathbf{M}}{M_s},
\qquad |\mathbf{m}| = 1
```

on every magnetic degree of freedom after each accepted integration step. $\mathbf{M}$ is
the magnetization in $\mathrm{A\,m^{-1}}$ and $M_s$ is the saturation magnetization in
$\mathrm{A\,m^{-1}}$. Non-magnetic nodes (FEM airbox, visualization padding) may carry
auxiliary values, but they must not contribute to the magnetic right-hand side unless an
interaction explicitly documents that behaviour.

## Gyromagnetic ratio

FullMag internally stores the *reduced* gyromagnetic constant

```{math}
:label: eq-gamma-mu0
\gamma_{\mu_0}
= \mu_0\,|\gamma_e|
\approx 2.211\times10^{5}\;\mathrm{m\,(A\,s)^{-1}},
```

where $|\gamma_e| \approx 1.761\times10^{11}\;\mathrm{rad\,(T\,s)^{-1}}$ is the magnitude
of the electron gyromagnetic ratio and
$\mu_0 = 4\pi\times10^{-7}\;\mathrm{N\,A^{-2}}$ is the vacuum permeability.

:::{admonition} Legacy field name
:class: note

The native FEM ABI field `gyromagnetic_ratio` carries $\gamma_{\mu_0}$ in
$\mathrm{m\,(A\,s)^{-1}}$, **not** the electron gyromagnetic ratio in
$\mathrm{rad\,(T\,s)^{-1}}$. New code and documentation should prefer the explanatory name
$\gamma_{\mu_0}$.
:::

## Canonical quantity table

| Quantity | Symbol | SI unit | Solver field | Contract |
|---|---|---:|---|---|
| Vacuum permeability | $\mu_0$ | $\mathrm{N\,A^{-2}}$ | constant | exactly $4\pi\times10^{-7}$ |
| Boltzmann constant | $k_B$ | $\mathrm{J\,K^{-1}}$ | constant | exactly $1.380649\times10^{-23}$ |
| Reduced magnetization | $\mathbf{m}$ | $1$ | `m_xyz` | $|\mathbf{m}|=1$ on magnetic DOFs |
| Saturation magnetization | $M_s$ | $\mathrm{A\,m^{-1}}$ | `saturation_magnetisation` | positive on magnetic nodes/cells |
| Exchange stiffness | $A$ | $\mathrm{J\,m^{-1}}$ | `exchange_stiffness` | non-negative |
| Gilbert damping | $\alpha$ | $1$ | `damping`, `alpha_field` | non-negative |
| Reduced gyromagnetic constant | $\gamma_{\mu_0}$ | $\mathrm{m\,(A\,s)^{-1}}$ | `gyromagnetic_ratio` | $\mu_0|\gamma_e|$ |
| Uniaxial anisotropy constants | $K_{u1},K_{u2}$ | $\mathrm{J\,m^{-3}}$ | `ku1`, `ku2` | sign distinguishes easy-axis from easy-plane |
| Cubic anisotropy constants | $K_{c1},K_{c2},K_{c3}$ | $\mathrm{J\,m^{-3}}$ | `kc1`, `kc2`, `kc3` | crystal axes finite, normalised, mutually orthogonal |
| Interfacial DMI constant | $D_i$ | $\mathrm{J\,m^{-2}}$ | `D` | module documents thin-film-effective or surface-boundary realization |
| Bulk DMI constant | $D_b$ | $\mathrm{J\,m^{-2}}$ | `D` | module documents unit conversion used by discretization |
| Current density | $\mathbf{J}$ | $\mathrm{A\,m^{-2}}$ | `current_density` | STT / Oersted inputs |
| Free-layer thickness | $t_F$ | $\mathrm{m}$ | `stt_thickness` | Slonczewski STT scaling |
| Temperature | $T$ | $\mathrm{K}$ | `temperature` | thermal field disabled at $T=0$ |
| Time step | $\Delta t$ | $\mathrm{s}$ | `dt` | accepted step size |
| Effective field terms | $\mathbf{H}_{\ast}$ | $\mathrm{A\,m^{-1}}$ | `h_eff_xyz`, `H_ex`, … | field observables |
| Energy terms | $E_{\ast}$ | $\mathrm{J}$ | `E_ex`, `E_d`, … | global scalar unless documented otherwise |
| Direct torque terms | $\boldsymbol{\tau}_{\ast}$ | $\mathrm{s^{-1}}$ | torque RHS buffers | added directly to $\mathrm{d}\mathbf{m}/\mathrm{d}t$ |

## Energy–field variational relation

For any magnetic energy functional $E[\mathbf{m}]$ reported in joules, the associated
effective-field contribution must satisfy the variational identity

```{math}
:label: eq-energy-field-relation
\delta E[\mathbf{m};\boldsymbol{\eta}]
=
-\mu_0\int_{\Omega_m}M_s\,\mathbf{H}_{\mathrm{term}}\cdot\boldsymbol{\eta}\,\mathrm{d}V
```

for all tangent perturbations $\boldsymbol{\eta}$ with
$\boldsymbol{\eta}\cdot\mathbf{m}=0$.

FEM and FDM implementations may discretize the integral differently (lumped mass, quadrature
rules, mass-matrix projection), but every validation test must state the mass, lumping,
projection, and boundary policy used for the comparison.

## Field vs. direct-torque convention

FullMag distinguishes two paths for physical contributions:

1. **Field-form** interactions contribute additively to $\mathbf{H}_{\mathrm{eff}}$
   in $\mathrm{A\,m^{-1}}$. The LLG integrator converts them to
   $\mathrm{d}\mathbf{m}/\mathrm{d}t$ through the cross-product form.

2. **Direct-torque** interactions write $\boldsymbol{\tau}$ in $\mathrm{s^{-1}}$
   directly to the right-hand side. They are **not** re-interpreted as fields.

Mixing a direct RHS torque with a field-scale prefactor is forbidden. Each interaction
module documents which path it uses.

## Geometry coordinates

All geometry coordinates are interpreted in metres. The Python authoring path emits SI
geometry natively. The native FEM mesh importer does not independently attach a unit tag to
coordinates, so the authoring contract is the source of truth for coordinate scale.

## Backend universality

FDM CPU, FDM GPU, FEM CPU, and FEM GPU share this physical contract. Their differences are
limited to:

- spatial discretization (structured grid vs. unstructured mesh),
- operator application (stencil vs. sparse matrix vs. partial assembly),
- linear-solver realization (direct, iterative, Hypre, libCEED),
- floating-point precision (FP64 mandatory for reference; FP32 available on select GPU lanes),
- memory residency and transfer policy,
- performance telemetry.

The planner and native create paths must reject unsupported combinations before the solver
starts.

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
   [Bibliographic record](https://search.worldcat.org/title/536451).
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
3. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376,
   National Institute of Standards and Technology, 1999.
   [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).
## Control Room crosswalk

No dedicated equation editor exists. Use the applicable Geometry, Material, Physics, or Stage panel. Status: `inspection-only` for the scientific explanation. frontend support is not implemented applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.
## Source-code index

- Public Python and lowering sources are linked by the applicable terminal API page. Runtime realization is in the relevant `backends/fdm` or `backends/fem` lane; frontend ownership is `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` where a live control exists.

