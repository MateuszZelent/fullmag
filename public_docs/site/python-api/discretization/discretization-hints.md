---
title: Discretization Hints
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-discretization-hints)=
# Discretization Hints

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `DiscretizationHints.fdm` | `FDM \| None` | `None` | — | FDM-specific hint; it does not force FDM when backend selection remains `auto`. |
| `DiscretizationHints.fem` | `FEM \| None` | `None` | — | FEM-specific hint; it does not force FEM when backend selection remains `auto`. |
| `DiscretizationHints.hybrid` | `Hybrid \| None` | `None` | — | Optional hybrid hint. |
