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

(foundations-conventions-problem-statement)=
<!-- (problem-statement)= -->
## Problem statement

FullMag uses SI units throughout, with no implicit unit conversion. Every solver backend
(FDM CPU, FDM GPU, FEM CPU, FEM GPU) shares the same physical contract. This page defines
the canonical quantities, their symbols, SI units, and the solver field names used to store
them.

(foundations-conventions-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations

### Reduced magnetization

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

(foundations-conventions-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units

| Quantity | Symbol | SI unit | Solver field | Contract |
|---|---|---:|---|---|
| Vacuum permeability | $\mu_0$ | $\mathrm{N\,A^{-2}}$ | constant | exactly $4\pi\times10^{-7}$ |
| Boltzmann constant | $k_B$ | $\mathrm{J\,K^{-1}}$ | constant | exactly $1.380649\times10^{-23}$ |
| Physical magnetization | $\mathbf M$ | $\mathrm{A\,m^{-1}}$ | derived from `m_xyz` and $M_s$ | $\mathbf M=M_s\mathbf m$ |
| Reduced magnetization | $\mathbf{m}$ | $1$ | `m_xyz` | $|\mathbf{m}|=1$ on magnetic DOFs |
| Saturation magnetization | $M_s$ | $\mathrm{A\,m^{-1}}$ | `saturation_magnetisation` | positive on magnetic nodes/cells |
| Exchange stiffness | $A$ | $\mathrm{J\,m^{-1}}$ | `exchange_stiffness` | non-negative |
| Gilbert damping | $\alpha$ | $1$ | `damping`, `alpha_field` | non-negative |
| Reduced gyromagnetic constant | $\gamma_{\mu_0}$ | $\mathrm{m\,(A\,s)^{-1}}$ | `gyromagnetic_ratio` | $\mu_0|\gamma_e|$ |
| Electron gyromagnetic-ratio magnitude | $|\gamma_e|$ | $\mathrm{rad\,(T\,s)^{-1}}$ | physical constant | positive magnitude; the LLG equation carries the sign convention |
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
| Magnetic energy functional | $E$ | $\mathrm{J}$ | term-specific energy reduction | functional of $\mathbf m$ on $\Omega_m$ |
| Conservative field contribution | $\mathbf H_{\mathrm{term}}$ | $\mathrm{A\,m^{-1}}$ | term field buffer | satisfies the documented variational identity |
| Admissible perturbation | $\boldsymbol\eta$ | $1$ | validation/test vector | tangent to $\mathbf m$ |
| Magnetic domain | $\Omega_m$ | $\mathrm{m^3}$ | active magnetic support | excludes non-magnetic airbox support from magnetic reductions |
| Volume element | $\mathrm dV$ | $\mathrm{m^3}$ | quadrature/cell volume | follows the documented discrete metric |
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

(foundations-conventions-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

- The public contract accepts SI values; suspicious magnitudes may warn but are not converted.
- Reduced magnetization is normalized on magnetic degrees of freedom after accepted steps.
- Field-form interactions use $\mathrm{A\,m^{-1}}$; direct RHS torques use $\mathrm{s^{-1}}$.
- Backend precision and storage layout may differ, but units and signs may not.

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

(foundations-conventions-python-api)=
<!-- (python-api)= -->
## Python API

```python
# %% SI material and dynamics in a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("foundation-units")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.solver(gamma=2.211e5, integrator="heun", fix_dt=1.0e-15)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.Ms` | `float` | required | $\mathrm{A\,m^{-1}}$ | positive finite | saturation magnetization | FDM/FEM CPU/GPU subject to planner capability | `materials[].saturation_magnetisation` |
| `Material.A` | `float` | required | $\mathrm{J\,m^{-1}}$ | positive finite | exchange stiffness | FDM/FEM CPU/GPU subject to planner capability | `materials[].exchange_stiffness` |
| `Material.alpha` | `float` | required | $1$ | non-negative finite | Gilbert damping | FDM/FEM CPU/GPU subject to planner capability | `materials[].damping` |
| `LLG.gamma` | `float` | `221100.0` | $\mathrm{m\,(A\,s)^{-1}}$ | positive finite | reduced gyromagnetic constant | FDM/FEM CPU/GPU subject to planner capability | `study.dynamics.gyromagnetic_ratio` |

(foundations-conventions-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR

Material and dynamics values are serialized in SI without conversion. The authored names map to
`materials[]` and `study.dynamics`; planner output adds backend/device/precision resolution rather
than rewriting the values.

(foundations-conventions-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent retains the authored SI values. Resolved execution records backend, device,
precision, and integrator. Validation errors reject non-finite and out-of-domain inputs;
unsupported combinations fail planning without hidden unit conversion or lane fallback.

(foundations-conventions-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization

| Solver | Device | Status | Qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | FP64 structured-grid oracle |
| FDM | GPU | implemented | same SI contract; device parity is a separate gate |
| FEM | CPU | implemented | native MFEM operators consume the shared units |
| FEM | GPU | implemented | shared units; host assembly is not device qualification |

(foundations-conventions-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping

`Material` and `LLG` own Python validation/lowering. FDM and native FEM RHS implementations own
the field-to-time conversion, while interaction modules own term-specific signs, units, and the
energy/field pair used to test the variational identity. Exchange is the representative traced
pair below; every other conservative interaction requires its own term-level trace and test.

(foundations-conventions-validation)=
<!-- (validation)= -->
## Validation

Validate constructor domains, Python-to-IR values, LLG sign and norm preservation, energy-field
directional derivatives, and executed CPU/GPU parity for every qualified lane.

(foundations-conventions-limitations)=
<!-- (limitations)= -->
## Limitations

The shared unit contract does not imply that every interaction or precision is available on every
lane. Planner capabilities and interaction qualification remain authoritative.

(foundations-conventions-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
   [Bibliographic record](https://search.worldcat.org/title/536451).
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
3. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376,
   National Institute of Standards and Technology, 1999.
   [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).

(foundations-conventions-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Material SI validation and lowering | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | public material contract | Python API tests |
| LLG SI validation and lowering | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | dynamics contract | Python API tests |
| Native FEM LLG units | `backends/fem/cpu/mfem/integrators/llg_rhs.cpp` | `llg_rhs_aos` | explicit Gilbert RHS | native LLG tests |
| FDM material/LLG units | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `llg_rhs_from_field` | FDM field-to-RHS conversion | FDM integrator tests |
| FDM exchange field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `exchange_field_add_into_soa` | representative conservative interaction field | FDM exchange derivative tests |
| FDM exchange energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `exchange_energy_from_vectors` | energy paired with the representative FDM field | FDM exchange derivative tests |
| Native FEM exchange field and energy | `backends/fem/cpu/mfem/interactions/exchange_field.cpp` | `compute_exchange_for_magnetization` | representative interaction path returning both observables | native FEM exchange derivative tests |
