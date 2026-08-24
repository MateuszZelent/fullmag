---
title: FDM Per-Magnet Grids
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-per-magnet-grids)=
# FDM Per-Magnet Grids

Per-magnet native grids are authored with `FDMGrid` values:

```text
fm.FDM(
    default_cell=(4e-9, 4e-9, 1e-9),
    per_magnet={
        "free": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
        "reference": fm.FDMGrid(cell=(4e-9, 4e-9, 1e-9)),
    },
)
```

Keys are nonempty object names. Values must be `FDMGrid` instances with positive SI cell triples.
Local interactions remain native-grid owned. Any nonlocal communication grid and transfer is
configured separately by `FDMDemag`.
