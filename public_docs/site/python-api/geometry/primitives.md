---
title: Primitives
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-primitives)=
# Primitives

## `Box(...)`

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `Box.size_or_x` | three floats, scalar, or `None` | `None` | $\mathrm{m}$ | Positional tuple or first scalar length; mutually exclusive with conflicting `size=`. |
| `Box.y` | `float \| None` | `None` | $\mathrm{m}$ | Positional $L_y$ when scalar `size_or_x` is used. |
| `Box.z` | `float \| None` | `None` | $\mathrm{m}$ | Positional $L_z$ when scalar `size_or_x` is used. |
| `Box.size` | three positive floats | required in keyword form | $\mathrm{m}$ | Full box lengths $(L_x,L_y,L_z)$. The positional alternatives are `Box((Lx,Ly,Lz))` or `Box(Lx,Ly,Lz)`; they must not conflict with `size=`. |
| `Box.name` | `str` | `"box"` | $1$ | Non-empty geometry identity. |
