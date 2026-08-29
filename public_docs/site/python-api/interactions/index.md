---
title: Interactions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-root)=
# Interactions

These pages document constructor parameters, validation, stage-first authoring, ProblemIR lowering, and fail-closed capability behavior for public interactions.

```{toctree}
:maxdepth: 1

exchange
demagnetization
zeeman
uniaxial-anisotropy
cubic-anisotropy
interfacial-dmi
bulk-dmi
thermal-noise
magnetoelastic
oersted-field
spin-transfer-torque
spin-orbit-torque
drift-diffusion-spin-torque
inter-region-couplings
```
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Physics` for interaction controls exposed by `PhysicsInteractionPanel`. Interaction-specific fields absent from that panel are `TODO: frontend support`; the child API page remains authoritative. See {doc}`/frontend/capability-register`.

## API and source scope

No standalone interaction is defined by this index. Each terminal page gives the exact Python contract, equations or explicit applicability boundary, limitations, bibliography, and source-code references.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
