---
title: Airbox Grading
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-airbox-grading)=
# Airbox grading

The airbox normally uses fine elements near magnetic interfaces and progressively coarser elements
toward the outer boundary.

The resolved policy includes:

- near-field `airbox_hmin`;
- far-field `airbox_hmax`;
- geometric, linear, or automatic grading;
- maximum element growth rate;
- curvature and narrow-region controls;
- interaction with object interface, edge, and corner fields.

For a geometric target, successive layer scales are conceptually related by $h_{n+1}=r h_n$, but
Gmsh conformity and overlapping fields determine the realized distribution. The build report must
therefore publish measured size statistics by air, interface, and magnetic scope.

An airbox study independently varies mesh resolution, exterior extent, outer closure, and Poisson
solver tolerance. Changing all of them at once prevents attribution of error.
