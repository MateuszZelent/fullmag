# Workflow: physics-first-gate

## Purpose

Mandatory gate before implementing any physics-facing or numerics-facing change.

## Steps

1. Identify the feature or semantic change.
2. Run `physics-publication`.
3. Check the note against `docs/physics/TEMPLATE.md`.
4. Make Python API, UI authoring, script-export, and `ProblemIR` impact explicit.
5. Run `problem-ir-design`.
6. Run `capability-matrix-check`.
7. Only then begin implementation work.

## Exit criteria

- the physics note exists and is complete,
- Python API, UI authoring, and `ProblemIR` impact are explicit,
- capability, runtime-selection, and validation implications are explicit.
