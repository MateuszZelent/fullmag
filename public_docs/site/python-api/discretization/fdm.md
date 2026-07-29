---
title: FDM
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-fdm)=
# FDM

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `FDM.cell` | three positive floats or `None` | `None` | $\mathrm{m}$ | Canonical uniform cell size; it also becomes `default_cell` when supplied. |
| `FDM.default_cell` | three positive floats or `None` | `None` | $\mathrm{m}$ | Default cell size when per-magnet grids are present. |
| `FDM.per_magnet` | mapping or `None` | `None` | — | Optional explicit per-magnet FDM grids. |
| `FDM.demag` | `FDMDemag \| None` | `None` | — | Demagnetization hint. |
| `FDM.boundary_correction` | `str \| None` | `None` | $1$ | Optional `T0`/`T1`-family sub-cell policy. Support differs by precision and device. |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | $1$ | Optional lower bound $\varphi_{\mathrm{floor}}$ with strict domain $0<\varphi_{\mathrm{floor}}<1$. |
| `FDM.boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | Optional T1 distance floor $\delta_{\min}\geq0$; zero is accepted. |
