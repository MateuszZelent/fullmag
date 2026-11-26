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

- Start Screen hub (`/home`), multi-instance tabs (`/session/<slug>`, `?port=`, `/instance/<port>`), Catppuccin Mocha/Latte themes, Ribbon tabs, and seven-tab Explorer (`Model`, `Resources`, `Results`, `Jobs`, `Diagnostics`, `Helper`, `Errors`);
- Semantic Inspector panels (162 declarative spec routes across 4 domain registries), isolated draft editing (`staged`, `liveViewport`, `immediate`), Apply/Reset transactions, and stale-resource semantics;
- FEM object, airbox, and region mesh policies alongside interactive FDM structured-grid sizing (`MeshRootSpec.tsx`) and read-only grid/cell evidence inspectors;
- 3D WebGL viewport (surface projections, clipping, studio lighting/PNG capture, eigenmode overlays, prepared-field previews), 2D planar field map, and interactive charts/playback;
- client state, command palette (`Ctrl+Shift+P`), 12 versioned binary HTTP codecs, live Python presence, and explicit capability boundaries (`capability-register`).

Backend algorithms live under {doc}`../backend/index`; Python constructors and parameters under
{doc}`../python-api/index`.

```{toctree}
:maxdepth: 3

control-room/index
inspectors/index
capability-register
meshing/index
visualization/index
state-and-commands/index
```
