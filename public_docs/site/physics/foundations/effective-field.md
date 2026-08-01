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

The effective field $\mathbf{H}_{\mathrm{eff}}$ is the central quantity that drives
magnetization dynamics in FullMag. It is not a physical magnetic field in the sense of
Maxwell's equations; it is the variational derivative of the total micromagnetic energy with
respect to the reduced magnetization, expressed in $\mathrm{A\,m^{-1}}$.

## Definition

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

Each term derives from the corresponding energy functional via

```{math}
:label: eq-heff-variational
\mathbf{H}_{\mathrm{term}}
=
-\frac{1}{\mu_0 M_s}\frac{\delta E_{\mathrm{term}}}{\delta\mathbf{m}}.
```

All field contributions are expressed in $\mathrm{A\,m^{-1}}$ and added to a single
effective-field buffer before the LLG integrator evaluates the cross-product torque.

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

Not every physical interaction contributes a field. Spin-transfer torque (STT) and
spin-orbit torque (SOT) are non-conservative: they cannot be written as
$-\delta E/(\mu_0 M_s \delta\mathbf{m})$. Instead, they contribute a direct torque
$\boldsymbol{\tau}$ in $\mathrm{s^{-1}}$ that is added to the right-hand side of the LLG
equation *after* the field-driven torque:

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

## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{H}_{\mathrm{eff}}$ | total effective field | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\tau}_{\mathrm{direct}}$ | total direct torque | $\mathrm{s^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{m}$ | reduced magnetization | $1$ |

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
