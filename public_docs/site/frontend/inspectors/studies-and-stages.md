---
title: Study Authoring, Stages & Interactive Re-Execution
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-inspectors-studies-and-stages)=
# Study Authoring, Stages & Interactive Re-Execution

Selecting **Study** or any stage node under **Stages** in the Model Explorer routes the Inspector to
`StudyInspectorPanel` or `StudyStageInspectorRouter`
(`apps/control-room/src/modules/inspector/panels/`). These panels govern study-wide solver intent
(backend, device, precision, demagnetization toggle, execution mode) and stage-by-stage workflow
editing, initial-state handoff, and interactive Apply-and-Compute execution.

```{image} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Study Stage Hysteresis inspector displaying Study pipeline scope, stage identity metadata, completed execution revision, and valid stage authoring card
:align: center
:width: 100%
```

## Study Overview & Execution Profile (`StudyInspectorPanel`)

At the study root (`StudyInspectorPanel.tsx`, `StudyGlobalAuthoringModel.ts`, `StudyExecutionProfileSection.tsx`),
users inspect and author:

- **Requested Intent vs. Resolved Capabilities**: Requested backend (`auto`, `fdm`, `fem`), requested device (`auto`, `cpu`, `gpu`), requested precision (`double`, `single`), execution strictness mode, and resolved runtime capabilities (`active_lane`, `algorithms_available`). Requested intent and resolved provenance remain visibly distinct; forcing GPU never silently degrades to CPU.
- **Stage Pipeline Summary (`StudyPipelineSection`)**: Ordered list of stage cards (`StudyStageCard`) showing validation state, execution status (`stageExecution`), and quick reordering/removal where permitted by the authoring pipeline.
- **Project Runs, Batches & Checkpoints (`ProjectRunsSection`, `ProjectBatchesSection`)**: Tracks durable `SolutionSet` run history, parameter sweep batches, and checkpoint restore/export state (`PERSISTENCE_CHECKPOINTS_PATH`).

```{image} /_static/images/ui/inspector-panel-draft.png
:alt: Staged Geometry inspector showing STATE modified badge, Revert and highlighted Apply buttons, and Draft ready to apply bar
:align: center
:width: 100%
```

## Stage Draft Editor & Specialized Stage Inspectors

Selecting an individual stage routes through `StudyStageInspectorRouter.tsx` and
`StudyStageDraftEditor.tsx`, combining editable stage inputs (when not locked to a read-only
external script pipeline reference) with stage-specific execution/result inspection under
`panels/stages/`:

| Stage kind | Draft & result inspector components | Primary authored / inspected scope |
|---|---|---|
| `relax` | `RelaxStageInspector` | Relaxation algorithm, torque/energy tolerance, stage initial state, convergence readout |
| `run` | `RunStageInspector` | Integration duration, time step / solver scheme, wall-clock runtime |
| `hysteresis` | `HysteresisStageInspector`, `HysteresisStageDraftFields` | Field sweep schedule, min/max $B$, step count, per-branch relaxation threshold, snapshot history |
| `eigenmodes` | `EigenmodesStageInspector` | Requested mode count, solver shift/target, Bloch $k$-path parameters, extracted frequencies |
| `frequency_response` | `FrequencyResponseStageInspector` | Driven harmonic frequency sweep bounds, damping/excitation binding, FMR response curve |
| `fft_response` | `FftResponseStageInspector` | Sampling rate, window/detrending, excitation source reference |
| `add_field_drive` | `AddFieldDriveStageInspector` | Dynamic field-drive binding at a specific point in the stage sequence |
| `antenna_field_solve` | `AntennaFieldSolveStageInspector` | Read-only pipeline reference pointing back to the canonical antenna definition |
| `table_autosave` / `autosave` | `TableAutosaveStageInspector`, `AutosaveStageInspector`, `StageAutosaveSection` | Table observable sampling intervals and spatial field snapshot cadence |
| `save_state` | `SaveStateStageInspector` | State checkpoint artifact key |
| `change_device` | `ChangeDeviceStageInspector` | Runtime compute device switch (`cpu` / `gpu`) between stages |

Each editable stage validates locally via `validateStudyStageDraft` and across stage sequence rules
via `validateStudyWorkflow` (catching missing dependencies, incompatible lane algorithms, or invalid
initial states before submission). stages marked `pipelineNodeId` lock structural ID edits to protect
script provenance while allowing result inspection.

## Initial State, Per-Stage Texture Overrides & Interactive Re-Execution

- **Stage Initial-State Selector (`StageInitialStateSelector`)**: Lets operators choose `default_for_target` (inherit prior stage), explicit saved state, or re-seeded initial magnetization without rebuilding upstream geometry.
- **Stage Texture Assignments (`StageTextureAssignmentsEditor`)**: Allows per-stage magnetization texture overrides on selected objects or regions.
- **Safe Apply & Run (`executeStageAfterApply` in `studyStageApplyAndRun.ts`)**: Interactive stage re-execution pins `(scene_revision, solver_profile, domain)` before applying changes, applies the stage draft, fetches fresh `sessions/current/status` and `model/readiness`, aborts cleanly if a concurrent Python/UI write mutated `scene_revision` or `changedStudyComputeInput`, reports readiness blockers verbatim, and only then dispatches the stage execution command (`target = current_stage`).

Screenshots illustrate the interface; they are not runtime or physics qualification evidence.

## Control Room crosswalk

- **Selection routes**: `study` (`StudyInspectorPanel`) and `study-stage` (`StudyStageInspectorRouter`).
- **Re-execution safety**: Controlled solely by `executeStageAfterApply` and `studyComputeDraftBlockedReason`; dirty invalid drafts block Study Compute until resolved or reset.

## Python/API crosswalk

- Every editable stage mirrors a `study.stages.add_*` builder call in `packages/fullmag-py`.
- Python-authored workflow stages carrying complex runtime closures render cleanly as `UnsupportedStageInspector` (`inspection-only` / `TODO: frontend support`) rather than corrupting script semantics.

## Physics and bibliography scope

This page documents stage authoring, validation UI, and revision-pinned command submission; time integrators, energy minimization schemes, and eigenvalue algorithms are specified in the numerical-methods documentation.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Study overview & execution profile | `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx` | `StudyInspectorPanel`, `useStudyInspectorPanelController` |
| Study global backend/device/precision model | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `createStudyGlobalDraft`, `buildStudyGlobalMergePatch` |
| Per-stage inspector router | `apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx` | `StudyStageInspectorRouter` |
| Stage form editor & validation | `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx` | `StudyStageDraftEditor` |
| Stage Apply & Re-Run transaction pin | `apps/control-room/src/modules/inspector/panels/studyStageApplyAndRun.ts` | `executeStageAfterApply` |
| Initial state & texture overrides | `apps/control-room/src/modules/inspector/panels/stages/StageInitialStateSelector.tsx` | `StageInitialStateSelector` |
