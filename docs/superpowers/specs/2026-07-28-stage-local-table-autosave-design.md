# Stage-local Table Autosave Design

## Status

- Date: 2026-07-28
- Status: approved design, awaiting written-spec review
- Scope: public Python stage builder, ProblemIR stage pipeline, Rust validation,
  runtime materialization, and canonical script round-trip
- Physics contract: `docs/physics/0910-table-autosave-observables.md`

## Problem

Declarative scripts currently configure table autosave as a pipeline action:

```python
study.stages.tableautosave(every_steps=10, quantities=[...])
study.stages.add_relax(...)
```

The action mutates global builder state for subsequent stages. This makes the
sampling owner implicit and ordering-sensitive. A real FEM relaxation script
that declared `tableautosave` before `add_relax` lowered its base problem as a
time-evolution study with accepted-step cadence. ProblemIR then correctly
rejected that base study with:

```text
sampling.table_autosave.every_steps is only valid for relaxation studies
```

The cadence is physically meaningful for the relaxation stage, not for the
pipeline's temporary base problem. The public API must express that ownership
directly.

## Decision

`StudyStagesBuilder.add_relax()` will return a stage-specific
`RelaxStageBuilder`. Calling `tableautosave()` on that result attaches the
configuration only to the relaxation stage just created:

```python
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=50_000,
    tol=7.957747154594767,
).tableautosave(
    every_steps=10,
    quantities=[
        "step",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "e_total",
        "max_torque_T",
    ],
)
```

The table is enabled when the stage begins and restored to the preceding
pipeline configuration when the stage ends. It does not leak into the next
stage.

## Public Python API

### Relaxation stage handle

`add_relax()` returns `RelaxStageBuilder`. The handle identifies exactly one
captured stage and exposes:

```python
RelaxStageBuilder.tableautosave(
    *,
    every_steps: int,
    quantities: Sequence[str] | None = None,
    table_id: str = "default",
) -> RelaxStageBuilder
```

Rules:

- `every_steps` is required and must be a positive integer.
- A physical-time cadence is not accepted on a relaxation-stage handle.
- Calling `tableautosave()` twice on the same handle is rejected rather than
  silently replacing the first declaration.
- The method returns the same handle so future stage-local configuration can
  remain fluent without changing ownership.
- Adding a later stage through `study.stages` remains supported; the handle is
  not a replacement for the pipeline builder.

### Compatibility surface

`study.stages.tableautosave(...)` remains temporarily executable as a
persistent pipeline configuration action. It emits a `DeprecationWarning`
directing relaxation users to `add_relax(...).tableautosave(...)`.

Existing serialized pipeline actions remain readable and executable. This
change does not reinterpret old artifacts as stage-local configuration.

The canonical script exporter emits stage-local syntax when table autosave is
owned by one stage. It emits the legacy pipeline action only while round-
tripping an explicitly persistent legacy action.

## Internal Python Representation

`CapturedStage` gains optional stage-local table-autosave data. The stage
handle stores a stable reference or index plus the allocated `stage_id`; it
must verify that it still addresses the same captured stage before replacing
the immutable record.

Attaching stage-local autosave must not mutate `_state._table_autosave`.
Therefore `_build_problem()` remains a neutral base problem unless persistent
pipeline sampling was explicitly requested.

The loader and scene-document paths preserve the stage-local field. UI and
Python authoring lower to the same pipeline representation.

## ProblemIR and Materialization

The stage pipeline representation owns the stage-local sampling override. A
relax primitive carries an optional table-autosave configuration whose cadence
is validated against that primitive's relaxation semantics.

Materialization expands the override into explicit lifecycle actions:

1. save the currently effective table configuration,
2. enable the stage-local table immediately before the relaxation stage,
3. execute the relaxation stage,
4. restore the saved configuration immediately afterward.

The restoration action is emitted even when the previous configuration was
disabled. Runtime failure inside the relaxation stage terminates execution;
restoration is a materialized ownership boundary for subsequent stages, not an
exception-recovery mechanism.

Base `ProblemIR.study.sampling.table_autosave` remains reserved for sampling
owned by that concrete base study. Rust must not infer relaxation semantics
merely because a later pipeline contains a relaxation stage.

## Validation

Validation is applied at the owner:

- relaxation stage: positive `every_steps` only,
- time-evolution stage: simulation-time cadence only,
- base study: cadence must match the concrete `StudyIR` variant,
- persistent pipeline actions: retain their existing validation and explicit
  lifecycle semantics,
- unsupported or ambiguous cadence fails closed.

This preserves the physical distinction between accepted minimizer steps and
simulation time. No tolerance, solver, or backend behavior changes.

## Runtime and Provenance

The runtime continues using the existing table-autosave configuration and
accepted-state sampling implementation. It receives explicit enable/restore
actions and does not need to infer scope.

Provenance identifies the owning `stage_id` for stage-local configuration.
Stored table rows and resource APIs remain unchanged. FEM and FDM use the same
public quantity and cadence semantics.

## OpenAPI and Control Room

No table row transport change is required. If pipeline authoring resources
expose stage configuration, their generated types gain the optional
stage-local table-autosave field. The UI must render it under the owning stage
and export the canonical fluent Python syntax.

Realtime invalidation, table resources, binary rows, and chart lifecycle are
unchanged.

## Error Handling

Errors must identify the stage and cadence owner. Examples:

```text
relax stage 'relax' tableautosave.every_steps must be a positive integer
relax stage 'relax' already has table autosave configured
physical-time table autosave is not valid for relax stage 'relax'
```

The interactive launcher must surface the underlying preparation error in the
terminal before it enters the failed-workspace wait loop. This observability
correction is part of the implementation because the current summary hides the
root cause in interactive mode.

## Tests and Acceptance Criteria

1. The SP4 FEM scenario uses the approved fluent syntax and materializes
   without the `only valid for relaxation studies` error.
2. Python construction rejects zero, negative, non-integer, and time-based
   relaxation cadence.
3. Python-to-IR serialization associates autosave with the named relaxation
   stage and leaves base-study sampling unset.
4. ProblemIR serde round-trip preserves stage ownership.
5. Rust validation accepts stage-local relaxation cadence and rejects it on a
   time-evolution stage.
6. Materialization produces enable, relax, and restore ordering.
7. A following stage does not inherit the relaxation table configuration.
8. Persistent legacy pipeline actions still round-trip and execute with a
   deprecation warning at Python authoring time.
9. Canonical script export emits
   `study.stages.add_relax(...).tableautosave(...)` for stage-local ownership.
10. Interactive preparation failures print their underlying error before the
    Control Room remains open.
11. Focused Python, ProblemIR, CLI materialization, runner, and script-export
    tests pass.
12. The managed FEM runtime builds through the repository `just` route, and a
    headless SP4 preparation reaches solver initialization on the GPU lane.

## Non-goals

- Changing table row formats or table resource endpoints.
- Changing relaxation convergence criteria or numerical tolerances.
- Making table autosave a backend-specific FEM feature.
- Removing support for existing serialized persistent actions in this change.
- Generalizing all possible stage-local configuration before a concrete need.

## Migration

The SP4 scenario and canonical examples migrate to stage-local syntax. The
legacy persistent method remains during a documented compatibility window.
Removal requires a separate migration decision with repository-wide script
and artifact evidence.
