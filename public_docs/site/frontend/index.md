---
title: Frontend
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-root)=
# Frontend

FullMag's user interface is the **Control Room** (`apps/control-room`), a modular Next.js 16 and
React 19 browser workspace that unifies FDM and FEM micromagnetic authoring, live solver control,
and multi-dimensional post-processing. It acts as a client of canonical FullMag resources and
commands without redefining solver physics or claiming that viewport rendering substitutes for
mesh certification or solver qualification.

```{image} /_static/images/ui/control-room-workspace-overview.png
:alt: FullMag Control Room v2 workspace overview showing Start/Session tabs, Contextual Ribbon, Explorer, 3D Viewport, Semantic Inspector, and Footer Dock
:align: center
:width: 100%
```

Use this branch for:

- Start Screen hub (`/home`), multi-instance tabs (`/session/<slug>`, `?port=`, `/instance/<port>`), Catppuccin Mocha/Latte themes, Ribbon tabs, and five-tab Explorer (`Model`, `Resources`, `Results`, `Jobs`, `Diagnostics`);
- Semantic Inspector panels, isolated draft editing (`staged`, `liveViewport`, `immediate`), Apply/Reset transactions, and stale-resource semantics;
- FEM object, airbox, and region mesh policies alongside read-only FDM structured-grid inspection;
- 3D WebGL viewport (surface projections, clipping, studio lighting/PNG capture, eigenmode overlays), 2D planar field map, and interactive charts/playback;
- client state, command palette (`Ctrl+Shift+P`), binary HTTP codecs, live Python presence, and explicit capability boundaries (`capability-register`).

Backend algorithms live under {doc}`../backend/index`; Python constructors and parameters under
{doc}`../python-api/index`. Screenshots illustrate the interface; they are not runtime or physics
qualification evidence.

```{toctree}
:maxdepth: 3

control-room/index
inspectors/index
capability-register
meshing/index
visualization/index
state-and-commands/index
```
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked {doc}`/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
