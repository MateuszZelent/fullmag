---
title: Time Evolution
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-time-evolution)=
# Time Evolution

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `TimeEvolution.dynamics` | `LLG` | required | — | Time-domain equation and integrator settings. |
| `TimeEvolution.outputs` | sequence | required | — | Sampling requests. An empty sequence is valid. |
| `TimeEvolution.table_autosave` | `TableAutosave \| None` | `None` | — | Optional tabular autosave policy. |
