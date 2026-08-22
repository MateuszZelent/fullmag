---
title: Refinement API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-refinement)=
# Refinement API

`PerObjectMeshRecipe` groups local refinement into explicit scopes.

## Bulk and automatic sizing

`maximum_element_size`, `minimum_element_size`, `size_factor`, `size_from_curvature`,
`curvature_factor`, `growth_rate`, `narrow_regions`, `narrow_region_resolution`, and
`smoothing_steps`.

## Interface, edge, and corner sizing

Canonical object-policy JSON additionally supports interface maximum size and thickness, transition
distance and growth, edge maximum size/thickness/transition, and corner maximum size/extent/
transition. A transition distance may be a positive SI length or the supported semantic value
`airbox_boundary`.

## Explicit fields and operation sequence

- `size_fields`: ordered list of backend size-field payloads;
- `operations`: ordered `MeshOperation` values;
- operation kinds: `free_tetrahedral`, `boundary_layers`, `refine`, `adapt`, `swept`, and
  `size_field`.

Unknown or unsupported operations must be reported as ignored, degraded, or rejected; their mere
presence in serialized JSON is not proof of execution.
