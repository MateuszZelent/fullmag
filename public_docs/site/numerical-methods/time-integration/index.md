---
title: Time Integration
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-time-integration-root)=
# Time Integration

This page reserves the public documentation location for the time-integration methods reference.

Time integration advances the semi-discrete Landau--Lifshitz--Gilbert (LLG) system in
physical time. Fullmag keeps the LLG equation and its units independent of the selected
integrator; the method selects the temporal approximation, step acceptance policy, and
field-refresh schedule.

The current public contract exposes fixed-step Heun/RK4 and adaptive RK23/RK45 families,
with `auto` as a planner-selected request. FEM and FDM implementations are not assumed
equivalent merely because they share a method name: the pages below state the actual lane,
precision, field-evaluation, and validation boundary.

```{toctree}
:maxdepth: 1

explicit-runge-kutta
adaptive-stepping
tangent-plane-methods
```
