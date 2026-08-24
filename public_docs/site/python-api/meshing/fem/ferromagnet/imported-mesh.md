---
title: Imported-Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-imported-mesh)=
# Imported-Mesh API

At study level, use `FEM(..., mesh="path-or-asset")`. At object level, use the recipe `source`
field.

Import requests do not bypass validation. Units, element family/order, orientation, attributes,
boundaries, periodic metadata, and backend compatibility are checked when the asset is extracted.
