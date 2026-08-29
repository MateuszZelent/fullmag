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
## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
