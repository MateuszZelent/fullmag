---
title: FEM Study Defaults
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-study-defaults)=
# FEM study defaults

The typed study-level constructor is:

```text
fm.FEM(
    order,
    maximum_element_size=None,
    *,
    hmax=None,
    mesh=None,
    demag_solver_policy=None,
)
```

| Field | Unit | Contract |
|---|---:|---|
| `order` | 1 | integer greater than or equal to one |
| `maximum_element_size` | m | required positive default unless `hmax` is supplied |
| `hmax` | m | compatibility alias; equal simultaneous values only |
| `mesh` | 1 | nonempty imported/prebuilt mesh reference when present |
| `demag_solver_policy` | 1 | algebraic Poisson/demag policy; not mesh geometry |

Study defaults are the lowest-precedence object target. Explicit object recipes and mesh-workflow
overrides replace them in their scope. Airbox sizing is resolved independently.
