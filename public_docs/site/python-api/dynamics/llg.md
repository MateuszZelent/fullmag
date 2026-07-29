---
title: LLG
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-llg)=
# LLG

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `LLG.gamma` | `float` | `221100.0` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Positive finite gyromagnetic ratio used by the H-field LLG convention. |
| `LLG.integrator` | `str` | `"auto"` | $1$ | Canonical supported integrator identifier or `auto`; planner and runtime legality are validated explicitly. |
| `LLG.fixed_timestep` | `float \| None` | `None` | $\mathrm{s}$ | Positive fixed step when supplied; mutually constrained with adaptive stepping. |
| `LLG.adaptive_timestep` | `AdaptiveTimestep \| None` | `None` | — | Optional adaptive-step contract. |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | — | Optional field-refresh policy. |
