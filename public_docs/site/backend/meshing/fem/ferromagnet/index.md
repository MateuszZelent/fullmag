---
title: Ferromagnet Meshes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-root)=
# Ferromagnet meshes

Magnetic bodies have their own topology and refinement requirements, distinct from the airbox.
Each implemented or represented mode is documented separately.

```{toctree}
:maxdepth: 2

free-tetrahedral
thin-film-tetrahedral
swept-prism
swept-hex
boundary-layers
imported-mesh
refinement
```

| Mode | Principal use | Critical evidence |
|---|---|---|
| free tetrahedral | general three-dimensional geometry | geometry conformity, quality and refinement convergence |
| thin-film tetrahedral | thin bodies without strict layered prisms | resolved thickness and aspect-ratio quality |
| swept prism | exact layer count through thickness | layer planes and prism–pyramid–tetra transition certificate |
| swept hex | represented hexahedral sweep | explicit capability; no production claim from schema alone |
| boundary layer | selected surface/curve-normal resolution | selector and transition conformity |
| imported mesh | external/prebuilt asset | units, orientation, attributes and compatibility |

The final shared-domain build may constrain or reject an object-local topology request. Requested
mode and realized element families remain separate report fields.
