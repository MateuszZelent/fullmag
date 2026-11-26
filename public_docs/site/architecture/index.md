---
title: FullMag architecture
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/fullmag-application-architecture-v2.md
---

(public-docs-architecture-root)=
# FullMag architecture

FullMag is one micromagnetic and spintronic platform built around a canonical backend-neutral
physical model (`ProblemIR`) and explicit execution realizations across FDM CPU/GPU, FEM CPU/GPU,
and multiphysics/antenna backends. This section documents:

- {doc}`product` — the product surfaces, repository crates, and end-to-end simulation lifecycle;
- {doc}`ui-architecture` — the modular Next.js 16 / React 19 Control Room, 162-route declarative
  inspectors, Three.js viewport workers, and ECharts analysis surfaces;
- {doc}`semantic-model` — `ProblemIR`, `ExecutionPlanIR`, and domain contracts that keep physical
  meaning independent of solver implementation;
- {doc}`runtime` — the Docker Compose DEV two-service runtime, OpenAPI v2 control plane, 12
  versioned binary HTTP codecs, live Python presence, memory preflight, and Zarr attestation;
- {doc}`planner-and-capabilities` — `strict` vs. `auto` lane resolution, opt-in material physics,
  and fail-closed GPU capability/budget guards;
- {doc}`provenance` — requested-versus-resolved provenance structs, solver receipts, and
  reproducibility guarantees.

For algorithmic acceleration mechanisms and verified hardware benchmarks across these architectural
boundaries, see {ref}`numerical-methods-performance`.

```{toctree}
:maxdepth: 2

product
ui-architecture
semantic-model
runtime
planner-and-capabilities
provenance
```
