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

Use `Model Explorer -> Objects -> <object> -> Physics` (`PhysicsInteractionPanel`) for core micromagnetic terms (exchange, uniaxial/cubic anisotropy, external Zeeman bias, DMI, and demagnetization), `CouplingInspectorPanel` for inter-region couplings, `FrozenSpinsInspectorPanel` for pinned-spin constraints, and `SpinAuthoringInspector` / `TransportAuthoringInspector` / `SpinInterfaceInspectorPanel` for Slonczewski, Zhang–Li, prescribed SOT, Oersted, and spin-diffusion terms. All panels share `PhysicsInspectorOverview` and gate controls dynamically against active-lane capabilities (`useActiveLaneCapabilities`). Interaction-specific fields absent from the UI panels remain Python-only (`not implemented`); child API pages remain authoritative. See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

```{image} /_static/images/ui/inspector-physics-couplings-frozen-spins.png
:alt: Control Room Frozen Spins constraint inspector displaying frz_edge_pin, Left Edge Pinning, Enabled toggle, and In region selection on obj_yig_film
:align: center
:width: 100%
```

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Spin Transport and SOT/STT torque inspectors
:align: center
:width: 100%
```

## API and source scope

No standalone interaction is defined by this index. Each terminal page gives the exact Python contract, equations or explicit applicability boundary, limitations, bibliography, and source-code references.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
