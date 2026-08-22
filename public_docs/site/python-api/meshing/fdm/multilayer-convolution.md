---
title: FDM Multilayer Grid API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-multilayer-convolution)=
# FDM multilayer grid API

`FDMDemag` controls the nonlocal common-grid strategy for multiple magnets.

| Field | Default | Accepted values / validation |
|---|---:|---|
| `strategy` | `auto` | `auto`, `single_grid`, `multilayer_convolution` |
| `mode` | `auto` | `auto`, `two_d_stack`, `three_d` |
| `common_cells` | `None` | positive integer triple; incompatible with `two_d_stack` |
| `common_cells_xy` | `None` | positive integer pair; only `auto` or `two_d_stack` |
| `common_cell_size` | `None` | positive SI triple; mutually exclusive with explicit counts |
| `explain` | `True` | request plan explanation; not a physical parameter |

Example constructor syntax:

```text
fm.FDMDemag(
    strategy="multilayer_convolution",
    mode="two_d_stack",
    common_cells_xy=(512, 512),
)
```

The removed `allow_single_grid_fallback` argument raises an error. Select the intended strategy
explicitly.
