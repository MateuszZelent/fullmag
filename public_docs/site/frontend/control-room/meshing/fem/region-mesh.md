---
title: Region Mesh Panel
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-meshing-fem-region-mesh)=
# Region mesh panel

A region mesh policy refines a semantic region owned by one magnetic object. It does not create an
independent solver mesh.

Editable FEM region fields are:

- enable or disable the region mesh override;
- maximum element size;
- minimum element size;
- transition distance;
- local finite-element order where the realized topology supports it.

The panel also displays region membership, mesh-part IDs, scoped quality distributions, and inline
capability diagnostics. Region build actions are withheld when the session is FDM, the region is a
draft without canonical identity, required selectors are unresolved, or a coupling dependency makes
the requested edit illegal.

In an FDM session the same selection displays read-only structured-grid cell membership instead of
FEM refinement controls.
