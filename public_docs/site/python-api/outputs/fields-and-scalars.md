---
title: Fields And Scalars
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-fields-and-scalars)=
# Fields And Scalars

## `SaveField(...)`

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `SaveField.field` | `str` | required | $1$ | Canonical field ID. For example, `H_ex` requires `Exchange()`. |
| `SaveField.every` | positive `float` or `"auto"` | required | $\mathrm{s}$ | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. |

## `SaveScalar(...)`

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `SaveScalar.scalar` | `str` | required | $1$ | Canonical scalar ID. For example, `E_ex` requires `Exchange()`. |
| `SaveScalar.every` | positive `float` or `"auto"` | required | $\mathrm{s}$ | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. |
