---
title: Swept-Prism Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-prism)=
# Swept-prism mesh API

A complete explicit recipe uses:

```text
fm.PerObjectMeshRecipe(
    mesh_strategy="swept_prism",
    through_thickness_elements=2,
    through_thickness_distribution="fixed",
    through_thickness_element_ratio=1.0,
    through_thickness_symmetric=False,
    sweep_face_meshing="triangular",
    topology="prismatic",
    sweep_direction="auto",
    element_family="prism",
    transition_policy="pyramid_to_tetrahedra",
    exact_layer_count=True,
    order=1,
)
```

The high-level `mesh.thin_film(... topology="prismatic" ...)` helper fills the same required fields.
Contradictory or incomplete layered recipes fail immediately.

In the reviewed Control Room scope, exact prism authoring is enabled only when the capability matrix
advertises mixed P1, prism sweep, pyramid transition, and exact layer counts 1, 2, and 3. Python can
represent other positive layer counts, but execution remains backend-capability-dependent.
