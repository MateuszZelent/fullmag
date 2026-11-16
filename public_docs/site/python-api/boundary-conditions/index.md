---
title: Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-boundary-conditions-root)=
# Boundary Conditions

Boundary conditions constrain the solution at domain boundaries. This family covers periodic
boundary conditions, Floquet boundary conditions for wave problems, and mechanical boundary
conditions for magnetoelastic studies.

```{toctree}
:maxdepth: 1

periodic-boundary-conditions
floquet-boundary-conditions
mechanical-boundary-conditions
```
## Control Room crosswalk

Boundary and constraint policies map across three Control Room surfaces depending on ownership:

- **Periodic & Floquet lattice conditions**: Configured via Python (`periodic-boundary-conditions`, `floquet-boundary-conditions`) and surfaced read-only in active lane / study inspection (`TODO: frontend support` for direct lattice-vector authoring).
- **Absorbing damping boundaries (`ObjectAbsorbingBoundaryPanel`)**: Outer face damping ramps (`faces`, `frame`, `profile`) are editable under `Model Explorer -> Objects -> <object> -> Material / Boundaries`.
- **Frozen-spin magnetization constraints (`FrozenSpinsInspectorPanel`, `Constraint` selection route)**: Object- and region-scoped `FrozenSpins` policies, selection predicates (`SelectionExpressionBuilder`), capture/initial reference modes, stage activation bindings, and `FrozenSpinsOverlay` previews are authored directly under `Model Explorer -> Physics / Constraints` (see Python API definitions in {doc}`../problem/problem` and {doc}`../studies/time-evolution`).

`TODO: frontend support` applies to any mechanical or specialized boundary-condition parameter without a matching editor control; terminal child pages remain authoritative for exact fields. See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

```{image} /_static/images/ui/inspector-physics-couplings-frozen-spins.png
:alt: Control Room Frozen Spins constraint inspector displaying frz_edge_pin, Left Edge Pinning, Enabled toggle, and In region selection for reg_pinning_ring on obj_yig_film
:align: center
:width: 100%
```

## Physics and source scope

This index introduces no independent physical model and no Python constructor contract. Governing equations, exact Python examples, limitations, bibliography, and source-code references are maintained on the linked terminal pages.

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
