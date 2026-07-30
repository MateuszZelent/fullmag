# Mesh failure diagnostics

## Goal

When shared-domain mesh preparation fails, Fullmag must state the failing phase
and the actionable, sanitized reason instead of exposing only
`Shared-domain mesh build failed`.

## Contract

- `summary` remains the stable error-class message: `Shared-domain mesh build
  failed`.
- A new optional `detail` on the preparation failure carries a bounded,
  sanitized diagnostic. For a Python mesh-build event it includes the phase and
  the emitted exception text.
- The same detail is appended to the preparation error log entry. The CLI and
  Control Room therefore report the same cause.
- The v2 simulation-preparation resource serializes the detail with the
  existing preparation failure. HTTP remains the source of truth; the existing
  realtime revision event only invalidates that resource.

## Sanitization

Diagnostic detail must not expose local filesystem paths, control characters,
or unbounded mesher output. The bridge will use a dedicated sanitizer with a
fixed length limit. If sanitization removes the reason entirely, the stable
summary remains available and `detail` is omitted.

## Data flow

`asset_pipeline.py` already emits `mesh_build_failed` with `phase` and
`error`. The Python bridge retains a sanitized diagnostic in
`PythonMeshPreparationUpdate::Failed`. The live-workspace projection passes it
to `SimulationPreparationState`, which owns the public failure snapshot and
the log-tail entry. Deferred mesh-failure projection follows the same mapping.

## Verification

1. A bridge unit test proves a postprocessing failure produces a bounded,
   sanitized phase-qualified detail and rejects a path-containing raw value.
2. A live-workspace test proves the failure snapshot and error log contain the
   same diagnostic detail.
3. An API route test proves the v2 preparation resource serializes the detail.
4. Existing generic summary and error-code assertions remain unchanged.

## Scope

This changes only failure observability. It neither changes mesh generation nor
adds an artifact containing raw Gmsh stderr.
