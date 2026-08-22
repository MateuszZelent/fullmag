---
title: FEM Region Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-regions)=
# FEM Region Mesh API

Object-owned regions can carry a local mesh policy with maximum/minimum element size, transition
distance, order, priority, and realization policy.

Region policy participates in the same shared-domain mesh; it does not create an independent
overlapping submesh. Conflicts are resolved by explicit priority/conflict policy and recorded in the
realization report.
