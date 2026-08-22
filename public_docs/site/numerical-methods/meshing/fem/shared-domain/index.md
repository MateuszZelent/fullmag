---
title: FEM Shared Domain
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-shared-domain-root)=
# FEM Shared Domain

The shared domain is the final conforming geometric asset consumed by native FEM operators. Magnetic
and nonmagnetic regions share geometry but can own different algebraic spaces.

The overview page below gives the complete mathematical contract; the remaining modules separate
assembly, semantic attributes, and fallback governance.

```{toctree}
:maxdepth: 2

../../fem-shared-domain
assembly-and-conformity
selectors-and-attributes
build-modes-and-fallbacks
```
