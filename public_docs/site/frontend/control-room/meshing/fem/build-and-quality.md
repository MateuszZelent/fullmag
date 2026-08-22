---
title: Mesh Build And Quality Workflow
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-meshing-fem-build-and-quality)=
# Mesh build and quality workflow

The mesh lifecycle is explicit:

```text
authored policy revision
        ↓
validated canonical request
        ↓
build command
        ↓
running build resource
        ↓
completed or failed build report
        ↓
latest successful solver-mesh resource
```

## Commands

| Command | Scope |
|---|---|
| `mesh.build-selected` | selected object's FEM mesh request within the shared-domain workflow |
| `mesh.build-shared-domain` | complete magnetic-plus-air shared-domain build |

A dirty policy is applied before an Apply & Build transaction. A failed apply prevents build
submission. A successful apply without a successful build leaves the current mesh stale.

## Read-only evidence

The quality and history tabs expose:

- requested and effective policy;
- build status, method, fallbacks, and degradation reason;
- element and facet counts by type and region;
- size, volume, Jacobian, SICN, and gamma/radius distributions;
- selector resolution and orphan-entity diagnostics;
- requested and realized layer topology;
- mesh and submesh fingerprints;
- raw report, quality, and size-field JSON.

Histogram hover events may highlight matching mesh elements in the viewport, but the chart never
changes solver state.
