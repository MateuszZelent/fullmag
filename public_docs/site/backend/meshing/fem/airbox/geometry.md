---
title: Airbox Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-airbox-geometry)=
# Airbox geometry

The exterior can be requested through automatic padding or explicit size and centre. The typed
meshing layer represents box and sphere shapes; the realized build report records the actual shape
and bounds.

Required evidence includes:

- magnetic bounding box and all six magnetic-to-outer clearances;
- requested padding factor or explicit SI dimensions;
- requested and actual airbox shape;
- magnetic, air, and total domain volumes;
- connected air region and conforming magnetic-air interface;
- external boundary marker coverage;
- fallback or degradation reason.

A requested sphere may degrade to a bounding box on a geometry/fallback path that cannot preserve
spherical shared-domain construction. Strict mode rejects that change when shape is part of the
scientific contract.
