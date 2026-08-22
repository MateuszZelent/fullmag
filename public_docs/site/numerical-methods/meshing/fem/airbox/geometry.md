---
title: Airbox Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-airbox-geometry)=
# Airbox Geometry

Airbox geometry is defined by mode plus padding or explicit size/centre. The generation layer also
represents `bbox` and `sphere` shapes.

Record requested and realized shape, bounds, all six body-to-boundary clearances, magnetic/air
volumes, and outer marker. A requested sphere can degrade to a box on specific fallback paths; that
change is scientific provenance, not presentation detail.
