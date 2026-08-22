---
title: FEM Build and Quality API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-build-and-quality)=
# FEM Build and Quality API

A production script separates authoring from materialization:

```text
study.build_domain_mesh()
```

Quality requests are authored on object recipes with `compute_quality` and
`per_element_quality`. The resulting mesh report contains requested/resolved topology, operations,
fallbacks, region markers, element families, layer data, quality distributions, and mesh identity.

Do not reconstruct the realized mesh from the Python request after the run; retain the generated
asset and provenance.
