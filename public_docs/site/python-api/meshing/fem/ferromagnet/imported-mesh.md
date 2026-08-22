---
title: Imported-Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-imported-mesh)=
# Imported-mesh API

A prebuilt mesh can be referenced at study level with `FEM(mesh="...")` or in an object recipe with
`source="..."`.

These fields identify an asset; they do not declare its units, topology, attributes, or validity.
The build/import pipeline still checks element families, order, positive orientation, world-frame
placement, magnetic and air attributes, boundary markers, region ownership, periodic pairing, and
compatibility with the selected backend.

Use object `source` when the asset belongs to one object's mesh policy. Use study-level `FEM.mesh`
when the complete FEM spatial asset is prebuilt. Do not combine an imported topology with
contradictory generated swept or boundary-layer intent.
