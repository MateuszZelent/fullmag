---
title: Effective field
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/units.md
---

(public-docs-physics-foundations-effective-field)=
# Effective field

(effective-field-problem-statement)=
<!-- (problem-statement)= -->
## Problem statement

The effective field $\mathbf{H}_{\mathrm{eff}}$ is the field-form quantity that drives
magnetization dynamics in FullMag. It is expressed in $\mathrm{A\,m^{-1}}$ and may combine
conservative variational fields, prescribed external fields, and the stochastic Brown thermal
field. Only the conservative subset is defined by a total-energy derivative.

(effective-field-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations

The effective field is the superposition of all field-form interaction contributions

```{math}
:label: eq-heff-composition
\mathbf{H}_{\mathrm{eff}}
=
\mathbf{H}_{\mathrm{ex}}
+ \mathbf{H}_{\mathrm{d}}
+ \mathbf{H}_{\mathrm{ext}}
+ \mathbf{H}_{\mathrm{ani}}
+ \mathbf{H}_{\mathrm{DMI}}
+ \mathbf{H}_{\mathrm{oe}}
+ \mathbf{H}_{\mathrm{mel}}
+ \mathbf{H}_{\mathrm{th}}
+ \cdots
```

Each **conservative** contribution derives from its corresponding energy functional via

```{math}
:label: eq-heff-variational
\mathbf{H}_{\mathrm{term}}
=
-\frac{1}{\mu_0 M_s}\frac{\delta E_{\mathrm{term}}}{\delta\mathbf{m}}.
```

Deterministic prescribed fields enter the same field path and may own a documented Zeeman-energy
term. The stochastic Brown field $\mathbf H_{\mathrm{th}}$ has no standalone deterministic energy
in `e_total`; it is sampled in $\mathrm{A\,m^{-1}}$ from the fluctuation-dissipation contract and
then passed through the LLG field torque. All field-form contributions are added before the
integrator evaluates the cross products.

## Interaction field summary

| Field | Physical origin | SI unit | Interaction page |
|---|---|---:|---|
| $\mathbf{H}_{\mathrm{ex}}$ | exchange stiffness | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/exchange/index` |
| $\mathbf{H}_{\mathrm{d}}$ | demagnetization (dipolar) | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/demagnetization/index` |
| $\mathbf{H}_{\mathrm{ext}}$ | external Zeeman field | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/zeeman/index` |
| $\mathbf{H}_{\mathrm{ani}}$ | magnetocrystalline anisotropy | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/anisotropy/index` |
| $\mathbf{H}_{\mathrm{DMI}}$ | Dzyaloshinskii–Moriya | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/dmi/index` |
| $\mathbf{H}_{\mathrm{oe}}$ | Oersted (current-induced) | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/oersted-field/index` |
| $\mathbf{H}_{\mathrm{mel}}$ | magnetoelastic coupling | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/magnetoelastic/index` |
| $\mathbf{H}_{\mathrm{th}}$ | stochastic thermal (Brown) | $\mathrm{A\,m^{-1}}$ | {doc}`../interactions/thermal-noise/index` |

## Direct-torque contributions

Not every physical interaction contributes a field. Spin-transfer torque (STT) and spin-orbit
torque (SOT) are non-conservative: they cannot be written as
$-\delta E/(\mu_0 M_s \delta\mathbf{m})$. Their formula-version contract supplies a Gilbert-source
or already-resolved direct RHS torque in $\mathrm{s^{-1}}$ outside the effective-field buffer. For
the direct-RHS form,

```{math}
:label: eq-direct-torque-rhs
\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}\bigg|_{\mathrm{total}}
=
\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}\bigg|_{\mathrm{LLG}(\mathbf{H}_{\mathrm{eff}})}
+
\boldsymbol{\tau}_{\mathrm{direct}}
```

where

```{math}
:label: eq-tau-direct-sum
\boldsymbol{\tau}_{\mathrm{direct}}
=
\boldsymbol{\tau}_{\mathrm{Slonc}}
+ \boldsymbol{\tau}_{\mathrm{ZL}}
+ \boldsymbol{\tau}_{\mathrm{SOT}}
+ \cdots
```

Mixing the two paths — e.g. adding a direct-torque amplitude to $\mathbf{H}_{\mathrm{eff}}$
without the LLG cross-product conversion — is forbidden.

## Effective-field composition in solver code

The effective-field buffer is composed by the integrator at every Runge–Kutta stage. The
composition order is not physically significant (addition is commutative), but every
interaction module must:

1. document its **field or torque** convention,
2. state its **energy convention** and the exact sign,
3. verify the **variational identity** $\delta E = -\mu_0\int M_s\mathbf{H}\cdot\delta\mathbf{m}\,\mathrm{d}V$,
4. zero its contribution on **non-magnetic nodes** or cells.

(effective-field-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{H}_{\mathrm{eff}}$ | total effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ex}},\mathbf H_{\mathrm d},\mathbf H_{\mathrm{ext}},\mathbf H_{\mathrm{ani}},\mathbf H_{\mathrm{DMI}},\mathbf H_{\mathrm{oe}},\mathbf H_{\mathrm{mel}}$ | deterministic field-form contributions shown in the composition equation | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{th}}$ | stochastic Brown thermal field; no standalone deterministic energy | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{term}}$ | conservative interaction field contribution | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm{term}}$ | conservative interaction energy functional | $\mathrm J$ |
| $\boldsymbol{\tau}_{\mathrm{direct}}$ | total non-field RHS torque | $\mathrm{s^{-1}}$ |
| $\boldsymbol\tau_{\mathrm{Slonc}},\boldsymbol\tau_{\mathrm{ZL}},\boldsymbol\tau_{\mathrm{SOT}}$ | direct-torque components shown in the source sum | $\mathrm{s^{-1}}$ |
| $t$ | physical time | $\mathrm s$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{m}$ | reduced magnetization | $1$ |

(effective-field-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

- $M_s$ is positive on magnetic degrees of freedom; non-magnetic support contributes no LLG RHS.
- Conservative terms satisfy the stated variational identity in their documented discrete metric.
- The Brown thermal contribution is a stochastic field in $\mathrm{A\,m^{-1}}$, not a direct
  torque and not a standalone contribution to deterministic `e_total`.
- Direct torques are already in $\mathrm{s^{-1}}$ and are not added to the field buffer.
- Availability of an individual term is interaction-, stage-, backend-, and device-dependent.

(effective-field-python-api)=
<!-- (python-api)= -->
## Python API

```python
# %% Request the composed field in a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("effective-field-foundation")
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
    fm.StageAutosave(fields=[fm.FieldAutosave("H_eff", every_steps=1)])
)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FieldAutosave.quantity` | `str` | required | $1$ | known field identifier; exactly one cadence is required | field to materialize | lane-dependent; planner rejects unavailable fields | `study.stages[].autosave.fields[].quantity` |

(effective-field-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR

The energy/interaction list records requested field-form terms, while output requests retain
`"quantity": "H_eff"`. The planner resolves which contributions and materialization paths are
legal for the selected lane; it does not serialize a hand-composed field vector into ProblemIR.

(effective-field-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent preserves interaction and output identities. Resolved execution records backend,
device, precision, support, and materialization. Validation errors reject malformed output requests
or missing prerequisites; unsupported combinations fail closed without zero substitution or hidden
CPU fallback.

(effective-field-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization

| Solver | Device | Status | Qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | deterministic host composition over active cells |
| FDM | GPU | implemented | device-resident composition where enabled; executed-device parity is separate |
| FEM | CPU | implemented | MFEM interaction fields compose on the resolved magnetic support |
| FEM | GPU | implemented | same physical sum with explicit residency/transfer provenance |

(effective-field-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping

The FDM engine and native FEM interaction layer own field composition. `FieldAutosave` owns the
public materialization request; the quantity catalog and planner own availability.

(effective-field-validation)=
<!-- (validation)= -->
## Validation

Validate individual field signs and units, conservative variational derivatives, Brown-field
variance/replay, additive composition, non-magnetic masking, requested quantity legality, and
executed CPU/GPU parity per lane.

(effective-field-limitations)=
<!-- (limitations)= -->
## Limitations

The composition equation is a catalog of possible terms, not a promise that every term is
available simultaneously on every backend. Interaction pages and planner capabilities are
authoritative.

(effective-field-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(effective-field-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| FDM field composition | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `effective_field_into_soa_ws` | composes enabled FDM field terms | FDM field/integrator tests |
| Native FEM field composition | `backends/fem/cpu/mfem/interactions/effective_field.cpp` | `compute_effective_fields_for_magnetization` | composes native FEM interaction fields | native interaction tests |
| Direct-torque separation | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `llg_rhs_from_fields_with_direct_torques_into` | adds direct RHS torques after field evaluation | torque/integrator tests |
| Brown thermal field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `thermal_field_add_into_soa` | samples and adds stochastic field-form noise | thermal variance/replay tests |
| Public field request | `packages/fullmag-py/src/fullmag/model/study.py` | `class FieldAutosave` | validates field identity and cadence | autosave tests |
