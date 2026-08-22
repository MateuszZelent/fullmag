---
title: FEM Meshing Backend
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-root)=
# FEM meshing backend

FEM meshing resolves magnetic bodies, nonmagnetic exterior, interfaces, periodic pairs, local size
fields, and topology requests into one extracted solver mesh.

```{toctree}
:maxdepth: 3

shared-domain/index
ferromagnet/index
airbox/index
quality-and-provenance
```

The backend pipeline is:

```text
canonical geometry and mesh intent
        ↓
resolved per-scope targets and selectors
        ↓
CAD/OCC assembly and Gmsh fields
        ↓
volume and boundary mesh generation
        ↓
native extraction and semantic validation
        ↓
content-addressed solver mesh and reports
```

Meshing is normally host-side even when the final solver runs on a GPU. GPU qualification additionally
requires support for every realized element family, order, interaction, and auxiliary operator.
