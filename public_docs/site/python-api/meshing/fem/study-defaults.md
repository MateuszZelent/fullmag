---
title: FEM Study Defaults
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-study-defaults)=
# FEM Study Defaults

The typed low-level constructor is:

```text
fm.FEM(order=1, maximum_element_size=20e-9)
```

`hmax=` is an alias for `maximum_element_size=`. The stage-first facade usually captures equivalent
intent through study and object mesh methods. Study defaults have the lowest precedence below
explicit object recipes and mesh-workflow overrides.

`demag_solver_policy` configures the algebraic Poisson solve; it does not change element geometry.
