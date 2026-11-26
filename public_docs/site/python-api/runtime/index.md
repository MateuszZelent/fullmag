---
title: Runtime
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-root)=
# Runtime

The runtime selects and executes a backend and device for the study. This family covers runtime
selection (`RuntimeSelection`, `ExecutionContext`, `study.stages.change_device`,
`ParallelExecutionPolicy`), backend policy (`BackendTarget`, `DeviceTarget`, `ExecutionMode`,
`ExecutionPrecision`, `FdmPrecisionPolicy`, `ExecutionProfile`, `ComputeResources`), the batch
simulation lifecycle (`Simulation`), interactive live sessions (`fm.connect()`), result reading
(`Result`), published artifacts (`FieldState`, `OutputStorage`, `load_field_state`,
`save_field_state`), and provenance records that keep requested intent separated from resolved
execution.

- **Batch / stage-first execution**: Author `fm.study(...)` and `study.stages.add_*`, lower to
  `ProblemIR`, and run reproducibly via the container CLI or {doc}`simulation`.
- **Interactive live execution**: Attach directly to a running FullMag instance via {doc}`live-session`
  (`fm.connect()`, `fm.relax()`, `fm.run()`, `fm.field()`, `fm.sweep()`, `fm.export_script()`) while
  Control Room inspects the shared session live.
- **Hardware acceleration and performance**: For algorithmic details, GPU precision policies, and
  solver benchmarks across FDM and FEM CPU/GPU lanes, see {ref}`numerical-methods-performance`.

```{toctree}
:maxdepth: 1

runtime-selection
backend-policy
simulation
live-session
results
artifacts
provenance
```
