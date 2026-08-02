# Fullmag Table Expression System Design

Status: proposed for implementation  
Date: 2026-08-02  
Scope: canonical table expressions, global/object magnetization averages, TXT, v2 table resources, Analysis, Telemetry, Python DSL, ProblemIR, and backend validation.

## Goal

Make every value written to a table or shown as scalar telemetry the result of one explicit, typed table expression evaluated by one backend-neutral observable contract. The default `m` must be the global average over all active ferromagnetic material. An expression such as `disk.m` must add a separate, correctly weighted object average and must never replace or silently redefine the global value.

The design is intentionally analogous to MuMax3 `TableAdd(Quantity)`: the default table owns global `m`, vector quantities expand into components, and scoped quantities are explicitly added. MuMax3's reference behavior is that magnetization averages over the magnetic geometry, while `m.Region(...)` is a separate scoped average; Amumax documents unchanged solver/results behavior relative to its MuMax3 fork.

## Physical contract

The public `m` quantity is reduced magnetization and is dimensionless. For every scope $S$:

\[
\langle \mathbf m \rangle_S =
\frac{\int_{\Omega_S} M_s(\mathbf r)\,\mathbf m(\mathbf r)\,dV}
{\int_{\Omega_S} M_s(\mathbf r)\,dV}.
\]

For a constant $M_s$, this is the ordinary volume average and therefore matches the MuMax3 interpretation. With spatially varying $M_s$, the moment-weighted definition is the physical normalized total magnetic moment. The denominator is the saturation moment of the requested scope, not the airbox volume.

Rules:

- The global scope is the union of all active ferromagnetic material. Airbox, nonmagnetic regions, and inactive mesh support are excluded.
- An object scope contains the physical cells/elements owned by that object. It is not the set of unique node IDs and is not a node-count average.
- FEM shared nodes are integrated through element contributions or a scope-specific lumped measure. A shared node is allowed to contribute to multiple object scopes only through the element measure belonging to each object; it must not be counted once per object node list.
- An active cell/node with a finite zero magnetization vector contributes zero to the numerator and its positive measure remains in the denominator. Zero vectors must never be silently dropped.
- Non-finite state values, non-finite/negative measures, or a non-positive denominator are hard observable errors for an executable requested expression. They must not become a plausible numeric zero.
- Components are `mx`, `my`, and `mz`; `magnitude` is $\lVert\langle\mathbf m\rangle_S\rVert$, not $\langle\lVert\mathbf m\rVert\rangle_S$.
- Physical magnetization $\mathbf M$ in $\mathrm{A\,m^{-1}}$ is a separate future quantity and must not be represented by `m` columns.

## Public table-expression model

The current scalar string list remains readable as a compatibility input, but it is lowered immediately into typed expressions. New authoring uses quantity handles:

```python
study = fm.TimeEvolution(
    dynamics=fm.LLG(fixed_timestep=1e-13),
    outputs=[],
).table_autosave(t_sampl=1e-12)

# Global m is already part of the default table.
study = study.tableadd(disk.m)
study = study.tableadd(disk.m.comp("y"))
study = study.tableadd(fm.E_total)
```

The canonical spelling is `tableadd`, with `table_add` as a Python-style alias. `study.tableadd(disk.m)` expands to three columns; adding `disk.m.comp("y")` is rejected as a duplicate if `disk.m` already expanded the y component. The global `m` handle remains available as `fm.m` and is the default expression, not a per-object fallback.

The expression set supports:

| Expression | Expansion | Scope | Unit |
|---|---|---|---|
| `fm.m` | `mx`, `my`, `mz` | global | `1` |
| `fm.m.comp("y")` | `my` | global | `1` |
| `disk.m` | `disk.mx`, `disk.my`, `disk.mz` | object `disk` | `1` |
| `disk.m.comp("y")` | `disk.my` | object `disk` | `1` |
| `disk.m.magnitude()` | `disk.magnitude` | object `disk` | `1` |
| `fm.E_total` | `e_total` | global | `J` |

Object column IDs are derived from stable object IDs, never display labels. Labels may use the object name, but renaming an object must update the canonical identity through the normal authoring/IR migration rules.

`TableAutosave.quantities` remains accepted for existing scripts. Its canonical lowering creates global expressions for existing scalar IDs. `extra_quantities` becomes an additive expression list. The default global columns `step`, `t`, `mx`, `my`, `mz`, `e_total`, and `max_torque` remain present unless a future explicit table policy introduces an opt-out; adding expressions never removes them.

## ProblemIR

`TableAutosaveIR` gains a typed expression list while retaining `quantities` for backward-compatible deserialization:

```json
{
  "kind": "table_autosave",
  "table_id": "default",
  "sample_period_s": 1e-12,
  "quantities": ["step", "t", "mx", "my", "mz", "e_total", "max_torque"],
  "expressions": [
    {
      "kind": "magnetization_average",
      "quantity": "m",
      "scope": "object",
      "object_id": "disk",
      "component": "y",
      "reduction": "magnetic_moment"
    }
  ]
}
```

The planner resolves every expression against the scene and realized mesh before execution. It rejects unknown object IDs, non-magnetic objects, duplicate expanded columns, unsupported backend realizations, and scopes with no positive magnetic measure. Requested expression intent and resolved scope/weighting remain visible in provenance.

## Runtime ownership and one-source rule

The runner introduces a `TableExpressionPlan` and `TableSample`. The plan owns expanded column metadata and requested scopes. A `TableSample` contains the accepted solver coordinate, global scalar values, and evaluated expression values keyed by canonical column ID.

`TableStore`, TXT autosave, Zarr/HDF5 autosave, live scalar publication, API table rows, and result table export consume `TableSample`. They must not independently recompute magnetization.

`StepStats.mx/my/mz` are populated from the same global reduction used to fill the global table expressions. `per_object_scalars` is no longer a source for table values. It may remain as a compatibility/read-model cache only when its values were produced by the same scoped reduction and carry the same step, time, scope, and reduction metadata.

Telemetry behavior is explicit:

- the main Footer magnetization panel always reads the latest global table sample;
- an object panel reads an explicitly selected object expression;
- missing object data is shown as unavailable with a source/error state;
- no object average is substituted into the global panel.

## Backend realization

### FDM

The FDM observable reducer receives the active magnetic-cell mask, per-cell $M_s$, cell volume, and current `m`. Global reduction includes every active magnetic cell. Object expressions use the realized object/region mask and the same weight formula. CPU reference, compiled CPU, CUDA FP64, and CUDA FP32 publish the same semantic result; precision/device differences are reported as execution provenance, not as different formulas.

### Native FEM CPU

The native FEM observable owner creates scope-specific integration weights from the realized element ownership and MFEM lumped measure. It uses the element marker/object mapping and material $M_s$ field. The existing global `step_metrics.cpp` reduction is the global implementation seed. The existing C ABI node-list arithmetic average is not reused for table/object expressions and must be removed from the authoritative path.

### Native FEM GPU

The GPU observable owner uses the same scope contract with separate CUDA reductions. Global and requested object scopes reduce weighted component integrals and moment denominators, then divide once in the publication layer. The GPU realization must include active zero vectors in the denominator and match the CPU reduction on identical typed mesh/state inputs.

### Reference and preview lanes

Rust FEM/FDM reference and preview lanes may implement the contract for tests and non-production previews, but their weighting and provenance must be explicit. They cannot overwrite production native results or be presented as native qualification.

## API and frontend contract

`TableColumnMeta` gains explicit `scope`, optional `object_id`, `expression_id`, and `weighting` fields. Existing `unit`, `dimension`, `component`, and `reduction` remain authoritative. `mx/my/mz` metadata is:

```text
scope = global
unit = 1
dimension = normalized_magnetization
reduction = average
weighting = magnetic_moment
```

Object columns carry the same unit/dimension and `scope=object`, with the stable object ID. The v2 table resource remains the HTTP source of truth; websocket events only invalidate revisions. Binary row values are unchanged in layout except for the expanded column metadata and additional expression columns.

The frontend continues to consume typed resource hooks. Analysis renders the returned columns without arithmetic. Footer uses the global scalar table sample and renders scope/source metadata so a validation comparison can prove that both values have identical `step`, `time`, `backend`, and `expression_id`.

TXT headers and `schema.json` must include expression ID, scope, object ID, reduction, weighting, and unit. A bare `mx` header without this metadata is not sufficient for a scientific artifact.

## Validation gates

The implementation is not complete until all gates pass:

1. Pure reducer tests compare hand-calculated global and object values for uniform and varying $M_s$, nonuniform FEM measures, shared nodes, inactive/air regions, and finite zero vectors.
2. Expression expansion tests verify vector-to-component columns, component selection, magnitude semantics, duplicate rejection, stable object IDs, and legacy string round-trip.
3. Python-to-ProblemIR-to-Python round-trip preserves expression identity, scope, object ID, and weighting.
4. Runner tests prove TXT, in-memory table rows, live scalar rows, and result artifacts receive identical values for identical `(step, time, expression_id)`.
5. API tests prove table resources expose the same values and metadata; object metrics cannot silently replace global rows.
6. Control Room tests prove Analysis and Footer display the same global sample and label object values separately.
7. Native FEM CPU/GPU source contracts prove both use scope-specific weighted reductions, not node-count arithmetic. Managed/container `just` recipes provide the native build/runtime route.
8. A managed validation run compares global `mx/my/mz` and selected object columns against an independently computed reference from saved field/mesh/material data. The comparison reports absolute and relative tolerances and is required before using the table for solver validation.
9. Existing standard-problem validation artifacts are regenerated only after the new table contract passes; old artifacts are not silently reinterpreted.

## Non-goals

- This change does not add a new physical interaction or alter the solver equations.
- It does not make UI chart decimation responsible for numerical reduction.
- It does not use object node lists as a permanent approximation.
- It does not claim native GPU correctness from source or unit tests alone.
- It does not delete unrelated dirty worktree changes.
