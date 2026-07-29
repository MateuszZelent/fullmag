---
title: Spatial Parameter Fields
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-spatial-parameter-fields)=
# Spatial Parameter Fields

Spatial parameter fields are optional mesh-aligned values that override the corresponding scalar
material parameter. Cardinality and solver-lane legality are validated downstream. Exchange
stiffness fields are not FDM pair-coefficient lookup tables. The constructor inventory and
canonical `ProblemIR` destinations are owned by {doc}`material`.
