---
title: Problem IR
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-problem-ir)=
# Problem IR

`problem.to_ir(...)` validates and lowers authoring objects; it does not select a concrete CPU or
GPU runtime. The planner resolves execution later from `backend_policy`, installed capabilities,
and requested execution context.

Python normalization preserves requested intent in `ProblemIR`. Backend, device, precision, and
the concrete numerical realization are resolved later and must appear as resolved execution in
provenance. Constructor and lowering validation errors are raised before planning; capability
validation rejects unsupported combinations instead of rewriting the authored model. Authored
FDM and FEM hints are preserved and do not claim which backend actually ran.

Interaction pages retain the minimal executable JSON subset needed to explain their own lowering.
For example, {doc}`../../physics/exchange` owns the Exchange-specific `energy_terms`, material
coefficient, observable, and discretization mapping rather than duplicating the general model here.
