---
title: Material
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-material)=
# Material

`Material(...)` defines scalar material parameters and optional mesh-aligned parameter fields.

| Python | Type | Default | SI unit | Validation and meaning | ProblemIR |
|---|---|---|---|---|---|
| `Material.name` | `str` | `required` | $1$ | Non-empty material identity referenced by magnets. | `materials[].name` |
| `Material.Ms` | `float` | `required` | $\mathrm{A\,m^{-1}}$ | Finite and positive saturation magnetization. | `materials[].saturation_magnetisation` |
| `Material.A` | `float` | `required` | $\mathrm{J\,m^{-1}}$ | Finite and positive bulk exchange stiffness; unusual-SI values outside $[10^{-14},10^{-8}]$ warn. | `materials[].exchange_stiffness` |
| `Material.alpha` | `float` | `required` | $1$ | Finite non-negative Gilbert damping. | `materials[].damping` |
| `Material.Ku1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Finite signed first-order uniaxial anisotropy. | `materials[].uniaxial_anisotropy` |
| `Material.Ku2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Finite signed second-order uniaxial anisotropy. | `materials[].uniaxial_anisotropy_k2` |
| `Material.anisU` | three floats or `None` | `None` | $1$ | Finite three-vector defining the uniaxial axis; normalization and legality are checked downstream. | `materials[].anisotropy_axis` |
| `Material.Kc1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | First cubic-anisotropy coefficient; suspicious-SI values warn. | `materials[].cubic_anisotropy_kc1` |
| `Material.Kc2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Second cubic-anisotropy coefficient; suspicious-SI values warn. | `materials[].cubic_anisotropy_kc2` |
| `Material.Kc3` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Third cubic-anisotropy coefficient; suspicious-SI values warn. | `materials[].cubic_anisotropy_kc3` |
| `Material.anisC1` | three floats or `None` | `None` | $1$ | Finite first cubic-anisotropy axis. | `materials[].cubic_anisotropy_axis1` |
| `Material.anisC2` | three floats or `None` | `None` | $1$ | Finite second cubic-anisotropy axis. | `materials[].cubic_anisotropy_axis2` |
| `Material.Dind` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | Finite interfacial-DMI material coefficient; it does not enable DMI by itself. | `materials[].interfacial_dmi` |
| `Material.Dbulk` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Finite bulk-DMI material coefficient; it does not enable DMI by itself. | `materials[].bulk_dmi` |
| `Material.Ms_field` | `list[float] \| None` | `None` | $\mathrm{A\,m^{-1}}$ | Optional spatial values overriding scalar `Ms`; mesh cardinality and lane legality are checked downstream. | `materials[].ms_field` |
| `Material.A_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-1}}$ | Optional spatial values overriding scalar `A`; not an FDM pair-coefficient lookup table. | `materials[].a_field` |
| `Material.alpha_field` | `list[float] \| None` | `None` | $1$ | Optional mesh-aligned damping values; cardinality and lane support are checked downstream. | `materials[].alpha_field` |
| `Material.Ku_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Ku1` values. | `materials[].ku_field` |
| `Material.Ku2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Ku2` values. | `materials[].ku2_field` |
| `Material.Kc1_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Kc1` values. | `materials[].kc1_field` |
| `Material.Kc2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Kc2` values. | `materials[].kc2_field` |
| `Material.Kc3_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial `Kc3` values. | `materials[].kc3_field` |
| `Material.Dind_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-2}}$ | Optional spatial interfacial-DMI values. | `materials[].dind_field` |
| `Material.Dbulk_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | Optional spatial bulk-DMI values. | `materials[].dbulk_field` |

See {doc}`spatial-parameter-fields` for the spatial-field semantics separated from this constructor inventory.
