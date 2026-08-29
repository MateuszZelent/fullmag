---
title: Frontend
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-root)=
# Frontend

The Frontend branch documents the browser Control Room as a client of the canonical FullMag
resources and commands. It does not redefine solver physics or claim that a displayed preview is the
solver mesh.

Use this branch for:

- Explorer and Inspector navigation;
- draft editing, Apply/Revert transactions, and stale-resource semantics;
- FEM object, airbox, and region mesh panels;
- FDM read-only structured-grid inspection;
- mesh build commands, progress resources, quality reports, and viewport feedback;
- Python round-trip and authored-versus-effective values.

Backend algorithms are documented under {doc}`../backend/index`; Python constructors and parameters
under {doc}`../python-api/index`.

The frontend support boundary for every Python/API entry is tracked in
{doc}`capability-register`. Each API page must link its exact Control Room path
there, or record a `TODO: frontend support` item when the corresponding UI
transaction does not exist.

```{toctree}
:maxdepth: 3

control-room/index
capability-register
meshing/index
visualization/index
state-and-commands/index
```
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
