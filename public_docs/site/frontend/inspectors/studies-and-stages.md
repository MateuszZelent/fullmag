---
title: Study Authoring, Stages & Interactive Re-Execution
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-inspectors-studies-and-stages)=
# Study Authoring, Stages & Interactive Re-Execution

Selecting **Study**, **Execution**, **Stages**, **Recovery**, or any individual stage node in the
Model Explorer routes the Inspector through `STUDY_RESULTS_START_ROUTES` to the declarative study
specs under `apps/control-room/src/modules/inspector/inspectors/study/` (`StudyRootInspectorPanel`,
`StudyExecutionInspectorPanel`, `StudyStagesInspectorPanel`, `StudyRecoveryInspectorPanel`, and
per-stage `*StageInspectorPanel` components). These panels govern study-wide solver intent
(backend, device, precision, demagnetization toggle, execution mode) and stage-by-stage workflow
editing, initial-state handoff, and interactive Apply-and-Compute execution.

```{image} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Study Stage Hysteresis inspector displaying Study pipeline scope, stage identity metadata, completed execution revision, and valid stage authoring card
:align: center
:width: 100%
```

## Study Overview & Execution Profile (`StudyRootInspectorPanel`, `StudyExecutionInspectorPanel`)

At the study root (`StudyRootSpec.tsx`, `StudyExecutionSpec.tsx`, `StudyGlobalAuthoringModel.ts`),
users inspect and author:

- **Run Control & Compute Scope (`StudyRootInspectorPanel`)**: Choose execution trigger (`Wait for Compute` vs. `Auto-run on Apply`), compute scope (`All enabled stages`, `Up to stage…`, or `Resume from latest checkpoint`), postprocessing triggers (`Compute observables`, `Compute energies`), and solver lifecycle buttons (`Compute`, `Build + Study`, `Pause`, `Resume`, `Skip`, `Stop`).
- **Requested Intent vs. Resolved Capabilities (`StudyExecutionInspectorPanel`)**: Requested backend (`auto`, `fdm`, `fem`), requested device (`auto`, `cpu`, `gpu`), requested precision (`double`, `single`), execution strictness mode, and resolved runtime capabilities (`active_lane`, `algorithms_available`). Requested intent and resolved provenance remain visibly distinct; forcing GPU never silently degrades to CPU.
- **Stage Pipeline Summary (`PipelineStrip`, `StudyStagesInspectorPanel`)**: Ordered stage cards showing validation state, execution status (`stageExecution`), and quick reordering/removal where permitted by the authoring pipeline.
- **Project Runs, Batches & Checkpoints (`ProjectRunsSection`, `ProjectBatchesSection`, `StudyRecoveryInspectorPanel`)**: Tracks durable `SolutionSet` run history, parameter sweep batches, and checkpoint restore/export state (`PERSISTENCE_CHECKPOINTS_PATH`).

```{image} /_static/images/ui/inspector-panel-draft.png
:alt: Staged Geometry inspector showing STATE modified badge, Revert and highlighted Apply buttons, and Draft ready to apply bar
:align: center
:width: 100%
```

## Stage Draft Editor & Specialized Stage Inspectors

Selecting an individual stage routes directly from `STUDY_RESULTS_START_ROUTES` to its specialized
inspector under `inspectors/study/stages/`, backed by `StudyStageDraftEditor.tsx` for staged draft
editing and validation:

| Stage kind | Draft & result inspector components | Primary authored / inspected scope |
|---|---|---|
| `relax` | `RelaxStageInspectorPanel` | Relaxation algorithm, torque/energy tolerance, stage initial state, convergence readout |
| `run` | `RunStageInspectorPanel` | Integration duration, time step / solver scheme, wall-clock runtime |
| `hysteresis` | `HysteresisStageInspectorPanel` | Field sweep schedule, min/max $B$, step count, per-branch relaxation threshold, snapshot history |
| `eigenmodes` | `EigenmodesStageInspectorPanel` | Requested mode count, solver shift/target, Bloch $k$-path parameters, extracted frequencies |
| `frequency_response` | `FrequencyResponseStageInspectorPanel` | Driven harmonic frequency sweep bounds, damping/excitation binding, FMR response curve |
| `fft_response` | `FftResponseStageInspectorPanel` | Sampling rate, window/detrending, excitation source reference |
| `add_field_drive` | `AddFieldDriveStageInspectorPanel` | Dynamic field-drive binding at a specific point in the stage sequence |
| `mask_field_drive` | `MaskFieldDriveStageInspectorPanel` | Masked regional field-drive excitation binding within the stage sequence |
| `antenna_field_solve` | `AntennaFieldSolveStageInspectorPanel` | Read-only pipeline reference pointing back to the canonical antenna definition |
| `table_autosave` / `autosave` | `TableAutosaveStageInspectorPanel`, `AutosaveStageInspectorPanel` | Table observable sampling intervals and spatial field snapshot cadence |
| `save_state` | `SaveStateStageInspectorPanel` | State checkpoint artifact key |
| `change_device` | `ChangeDeviceStageInspectorPanel` | Runtime compute device switch (`cpu` / `gpu`) between stages |

Each editable stage validates locally via `validateStudyStageDraft` and across stage sequence rules
via `validateStudyWorkflow` (catching missing dependencies, incompatible lane algorithms, or invalid
initial states before submission). Stages marked `pipelineNodeId` lock structural ID edits to protect
script provenance while allowing result inspection.

## Initial State, Per-Stage Texture Overrides & Interactive Re-Execution

- **Stage Initial-State Selection (`stageResultInitialState` in `StageInitialStateSelector.model.ts`)**: Lets operators choose `default_for_target` (inherit prior stage), explicit saved state, or re-seeded initial magnetization without rebuilding upstream geometry.
- **Stage Texture Assignments (`StageTextureAssignmentsEditor`)**: Allows per-stage magnetization texture overrides on selected objects or regions.
- **Safe Apply & Run (`executeStageAfterApply` in `studyStageApplyAndRun.ts`)**: Interactive stage re-execution pins `(scene_revision, solver_profile, domain)` before applying changes, applies the stage draft, fetches fresh `sessions/current/status` and `model/readiness`, aborts cleanly if a concurrent Python/UI write mutated `scene_revision` or `changedStudyComputeInput`, reports readiness blockers verbatim, and only then dispatches the stage execution command (`target = current_stage`).

## Selection routes and Python interoperability

- **Selection routes**: `study.root` (`StudyRootInspectorPanel`), `study.execution` (`StudyExecutionInspectorPanel`), `study.stages` (`StudyStagesInspectorPanel`), `study.recovery` (`StudyRecoveryInspectorPanel`), and per-stage `study.stage.*` routes (`RelaxStageInspectorPanel`, `RunStageInspectorPanel`, etc.).
- **Re-execution safety**: Controlled solely by `executeStageAfterApply` and `studyComputeDraftBlockedReason`; dirty invalid drafts block Study Compute until resolved or reset.
- **Python alignment**: Every editable stage mirrors a `study.stages.add_*` builder call in `packages/fullmag-py`. Python-authored workflow stages carrying complex runtime closures render as read-only summaries via `ActionStageFallbackInspectorPanel` rather than overwriting script semantics.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Study overview, run control & pipeline | `apps/control-room/src/modules/inspector/inspectors/study/StudyRootSpec.tsx` | `StudyRootInspectorPanel` |
| Study execution profile & lane intent | `apps/control-room/src/modules/inspector/inspectors/study/StudyExecutionSpec.tsx` | `StudyExecutionInspectorPanel` |
| Study stages manager | `apps/control-room/src/modules/inspector/inspectors/study/StudyStagesSpec.tsx` | `StudyStagesInspectorPanel` |
| Study global backend/device/precision model | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `createStudyGlobalDraft`, `buildStudyGlobalMergePatch` |
| Stage form editor & validation | `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx` | `StudyStageDraftEditor` |
| Stage Apply & Re-Run transaction pin | `apps/control-room/src/modules/inspector/panels/studyStageApplyAndRun.ts` | `executeStageAfterApply` |
| Initial-state resolution model | `apps/control-room/src/modules/inspector/panels/stages/StageInitialStateSelector.model.ts` | `stageResultInitialState` |
