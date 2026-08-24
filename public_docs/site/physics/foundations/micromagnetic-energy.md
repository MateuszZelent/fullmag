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

(micromagnetic-energy-problem-statement)=
<!-- (problem-statement)= -->
## Problem statement

FullMag solves the Landau–Lifshitz–Gilbert equation for the reduced magnetization
$\mathbf{m} = \mathbf{M}/M_s$ by computing effective fields from physical energy
functionals. This page defines the total energy, its decomposition into interaction terms,
and the variational principle that links energies to effective fields.

(micromagnetic-energy-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations

### Total energy functional

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

Spin-transfer torque (STT), spin-orbit torque (SOT), and Brown thermal noise are **not** derived
from the deterministic micromagnetic energy functional, but they do not share one numerical path.
STT/SOT contribute Gilbert-source or direct RHS torques in $\mathrm{s^{-1}}$. Brown noise is a
stochastic effective field $\mathbf H_{\mathrm{th}}$ in $\mathrm{A\,m^{-1}}$ and passes through
the LLG field cross products; it has no standalone deterministic contribution to `e_total`. See
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

This variational relation defines the **conservative** effective-field subset. It does not apply
to the sampled Brown field or to direct source torques. Every conservative interaction page must
verify Eq. {eq}`eq-directional-derivative` for its implemented equations.

## Energy minimization and equilibrium

At thermodynamic equilibrium (zero temperature, zero driving current), the magnetization
minimises the total energy subject to the saturation constraint $|\mathbf{m}|=1$. The
necessary condition is

```{math}
:label: eq-equilibrium-condition
\mathbf{m}\times\mathbf{H}_{\mathrm{eff}} = \mathbf{0}
\quad\text{on }\Omega_m,
```

i.e. the magnetization is everywhere parallel to the effective field. FullMag relaxation
algorithms target this condition and report explicit stopping evidence; convergence and energy
monotonicity are qualified separately for each algorithm and backend.

## Domain integration

Energy integration is always over the magnetic domain $\Omega_m$:

- **FDM**: sum over active cells with volume $V_i$ and (optionally) magnetic volume
  fraction $\varphi_i$.
- **FEM**: integration over magnetic elements using the finite-element quadrature rule,
  with non-magnetic (airbox) elements excluded.

The demagnetization field $\mathbf{H}_{\mathrm{d}}$ may be solved on a larger domain
(airbox or open boundary), but the energy integral uses only the magnetic subdomain.

(micromagnetic-energy-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $E_{\mathrm{tot}}$ | total micromagnetic energy | $\mathrm{J}$ |
| $E_{\mathrm{ex}},E_{\mathrm d},E_{\mathrm Z},E_{\mathrm{ani}},E_{\mathrm{DMI}},E_{\mathrm{mel}},E_{\mathrm{oe}}$ | energy contributions shown in the total-energy sum | $\mathrm J$ |
| $E_{\mathrm{term}}$ | individual interaction energy | $\mathrm{J}$ |
| $\mathbf{H}_{\mathrm{eff}}$ | total effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{term}}$ | conservative interaction effective-field contribution | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{th}}$ | stochastic Brown field excluded from deterministic total energy | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol\tau_{\mathrm{direct}}$ | non-field STT/SOT RHS contribution | $\mathrm{s^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\boldsymbol{\eta}$ | admissible magnetization variation | $1$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $\mathrm dV$ | magnetic-domain volume element | $\mathrm{m^3}$ |
| $V_i$ | discrete cell or element volume | $\mathrm{m^3}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |

(micromagnetic-energy-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

- Energy reductions include magnetic support only; FEM airbox elements are excluded.
- Conservative terms own an energy-field variational identity in their documented discrete metric.
- Brown thermal noise is a stochastic field, but has no standalone deterministic energy reduction.
- Non-conservative direct torques are excluded from $E_{\mathrm{tot}}$.
- Availability of a term or reduction is backend-, stage-, and device-dependent.

(micromagnetic-energy-python-api)=
<!-- (python-api)= -->
## Python API

```python
# %% Request total energy in a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("energy-foundation")
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
study.demag()
study.stages.add_relax(
    stage_id="relax", dt=1.0e-15, max_steps=10, tolT=1.0e-6
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(every_steps=1, quantities=["step", "e_total"])
    )
)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `TableAutosave.quantities` | `Sequence[str] \| None` | default registry | $1$ | non-empty supported scalar identifiers | scalar columns including `e_total` | lane-dependent; planner checks materialization | `study.stages[].autosave.table.quantities` |

(micromagnetic-energy-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR

The interaction list records authored interactions, including energy-bearing terms and separately
typed non-energy stochastic/source terms, while the output request records `e_total`. The scalar
reduction includes only contributions with a defined energy contract; Brown noise and direct
torques are excluded. ProblemIR does not cache a numerical energy value. Planner/runtime provenance
records the resolved backend, device, precision, support, enabled terms, and materialization path.

(micromagnetic-energy-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent preserves interaction and quantity identifiers. Resolved execution preserves the
actual reduction support and lane. Validation errors reject unknown quantities or malformed
interaction inputs; unsupported combinations fail without substituting zero energy or silently
changing backend.

(micromagnetic-energy-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization

| Solver | Device | Status | Qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | active-cell volume-weighted reference reductions |
| FDM | GPU | implemented | enabled device reductions; executed-device parity remains separate |
| FEM | CPU | implemented | magnetic-support quadrature/lumped reductions |
| FEM | GPU | implemented | same energy convention with explicit reduction/residency provenance |

(micromagnetic-energy-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping

FDM field evaluation owns the cell energy sum. Native FEM step metrics aggregate enabled
interaction energies. `TableAutosave` and the quantity registry own the public scalar request.

(micromagnetic-energy-validation)=
<!-- (validation)= -->
## Validation

Validate analytical uniform states, finite-difference directional derivatives, magnetic-support
masking, per-term and total sums, relaxation stopping evidence, and executed CPU/GPU parity.

(micromagnetic-energy-limitations)=
<!-- (limitations)= -->
## Limitations

The catalog above does not imply every term is implemented or materializable on every lane.
Interaction pages and planner capabilities are authoritative.

(micromagnetic-energy-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
   [Bibliographic record](https://search.worldcat.org/title/536451).
2. A. Aharoni, *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University
   Press, 2000.
3. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(micromagnetic-energy-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| FDM total energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `total_energy_from_vectors_ws` | active-cell conservative energy sum | FDM energy/derivative tests |
| Native FEM energy aggregation | `backends/fem/cpu/mfem/runtime/step_metrics.cpp` | `fill_common_step_metrics` | aggregates enabled interaction energies | native step-metric tests |
| Scalar request | `packages/fullmag-py/src/fullmag/model/study.py` | `class TableAutosave` | validates and lowers quantity/cadence | autosave tests |
| Quantity evaluation | `crates/fullmag-quantities/src/registry.rs` | `evaluate_by_name` | resolves canonical scalar identifiers | quantity registry tests |
| Brown thermal field separation | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `thermal_field_add_into_soa` | adds stochastic field noise without an energy reduction | thermal variance/replay tests |
