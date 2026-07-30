# Stateful stage transitions and demag visualization design

## Goal

A `study` stage changes execution instructions; it does not create a new
physical problem.  Compatible consecutive stages must execute on one live
solver context, preserving the mesh/grid, region mapping, magnetization,
operator and demagnetization caches, device residency, solver statistics, and
the Control Room's selected visualization.

The reported sequence

```python
relax(algorithm="projected_gradient_bb")
relax(algorithm="llg_overdamped", solver="rk23")
```

is therefore one continuous FEM solve whose second stage changes relaxation
control only.  `H_demag` must remain available before, during, and after that
change.

## Evidence and root cause

During the reported second stage, the v2 field resource returned a valid FMVP
v3 `H_demag` payload for the current FEM domain, with `stale_complete` state.
The data plane and binary encoding had not lost the field.

The runtime host calls `InteractiveRuntime::matches_plan` before every stage.
That check compares a normalized full `FemPlanIR`; it removes only
`initial_magnetization`.  Relaxation algorithm, integrator, timestep policy,
and stopping criteria consequently make two otherwise identical stages look
incompatible.  The host destroys and recreates `InteractiveRuntime`, replacing
the native FEM context and its cached demag/operator/display state.  The
resulting missing live publication makes the vector layer appear to disappear.

This contradicts the active architecture plan
`docs/plans/active/stateful-stage-continuation-architecture-2026-06-05-pl.md`:
compatible stages must use `continue_in_place`, not sampled-field export and
runtime reconstruction.

## Scope and non-goals

The first implementation covers compatible FDM and FEM interactive stages,
including FEM CPU and GPU realizations.  It changes no equations, public
Python DSL, ProblemIR schema, OpenAPI schema, mesh format, or field binary
encoding.

It does not make every changed plan hot-reconfigurable.  A mesh/grid,
topology, material, energy-model, demag realization, device/precision, or
backend change remains a real context boundary and must rebuild or use an
explicit state-transfer path with provenance.

## Design

### 1. Separate runtime identity from stage instructions

Add a backend-neutral compatibility predicate exposed through
`InteractiveRuntime` and `InteractiveBackend`, conceptually
`can_continue_with_plan`.  It is distinct from exact `matches_plan`.

Its identity signature includes only state owned by the persistent solver
context:

- backend family, engine, requested/resolved device, and precision;
- FEM mesh/grid identity, topology, region ownership, and active mask;
- material and energy-model coefficients, boundary conditions, demag
  realization, and spatial field/material maps;
- runtime-affecting geometry and domain configuration.

It excludes stage-control data:

- study kind and relaxation algorithm;
- integrator and timestep policy;
- stopping criteria, maximum steps/time, autosave and output cadence;
- display and live-preview cadence;
- stage-local time context where it only controls execution.

The predicate must be implemented by both FDM and FEM interactive runtimes.
An exact plan mismatch remains useful for callers that really require identical
configuration, but it must not decide normal study-stage continuation.

### 2. Reuse the live solver context

`InteractiveRuntimeHost::ensure_runtime_for_problem` uses continuation
compatibility, not full plan equality.  For a compatible plan it keeps the
existing `InteractiveRuntime` object and invokes its normal streaming execute
method with the new stage plan.  The backend then applies the stage's
relaxation/integrator controls while retaining its physical state and native
resources.

No compatible transition uploads `final_magnetization`, rewrites
`initial_magnetization`, or recreates the backend.  These operations remain
for explicit transfer, load, remesh, backend switch, or incompatible context
boundaries only.  The runtime must log whether a stage was continued in place
or rebuilt and why.

### 3. Preserve fields and visualization across the transition

The existing `H_demag` payload remains renderable while the second stage
starts.  `stale_complete` is usable carried data, not a hide instruction.  A
new compatible live sample atomically replaces it.

The stage transition must not clear cached preview fields, active quantity, or
per-target vector visibility.  It may invalidate the resource revision so
clients refetch, but a pending/204 response retains the compatible decoded
buffer.  Normal mesh generation/topology checks remain mandatory; a payload
from another context is never reused.

## Data flow

```text
stage 1 completes
  -> classify stage 1 -> stage 2 as continue_in_place
  -> retain InteractiveRuntime and native backend context
  -> execute stage-2 controls on current magnetization and demag state
  -> keep cached H_demag visible; publish later stage-2 samples normally
  -> atomically replace the vector buffer only with compatible data
```

For an incompatible transition:

```text
classify explicit context boundary
  -> record reason and transfer/rebuild provenance
  -> rebuild only through the existing explicit state-transfer path
  -> do not render a field whose mesh/topology does not match the new context
```

## Tests and acceptance criteria

1. Runner unit tests prove that two plans differing only in relaxation,
   integrator, timestep, limits, and output policy are continuation-compatible,
   while a mesh/material/demag/device change is not.
2. A runner regression executes PG-BB followed by LLG-overdamped/RK23 through
   one `InteractiveRuntime`; the second stage observes the preceding state and
   retains a valid `H_demag` snapshot without recreating the backend.
3. A CLI host regression proves a compatible stage transition does not call
   the runtime factory or upload sampled continuation magnetization; an
   incompatible transition still rebuilds through the explicit boundary path.
4. API/session regression proves transition updates retain the effective
   `H_demag` field source and issue a new revision when a fresh sample arrives.
5. Control Room regression proves `stale_complete` / pending stage transition
   states retain the compatible vector buffer and selected vector visibility.
6. Managed FEM verification runs the bounded two-relax script and confirms
   continuous stage provenance plus a non-empty `H_demag` vector payload after
   the second stage begins.

## Failure semantics

- If continuation compatibility cannot be established, the runtime must not
  silently reuse state.  It takes the explicit transfer/rebuild path and
  records the boundary reason.
- A state transfer without a defined operator is a planning/runtime error, not
  an implicit `initial_magnetization` rewrite.
- A missing or incompatible field payload produces an explicit degraded/error
  state; it never renders field data from another mesh or topology.
