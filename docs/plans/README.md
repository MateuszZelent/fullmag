# Plans Directory

This directory contains implementation plans that move the repository toward the
target application contract described in:

- `docs/specs/fullmag-application-architecture-v2.md`

That spec draft is intended to become the canonical
`docs/specs/fullmag-application-architecture-v2.md`.

## What plans are for

Plans are not long-lived product truth.

They exist to do two things honestly:

1. describe the verified current implementation state,
2. sequence the work needed to reach the target application contract.

If a plan and a spec disagree, the spec wins.
If a plan needs to change the target architecture, update the spec first or in the
same change.

## Reading order

When starting new work, read in this order:

1. `docs/specs/README.md`
2. `docs/specs/fullmag-application-architecture-v2.md`
3. `docs/specs/problem-ir-v0.md`
4. `docs/specs/capability-matrix-v0.md`
5. the relevant `docs/physics/` note
6. the relevant file in `docs/plans/active/`

## Directory policy

- `docs/plans/active/`
  - plans that still drive current work,
  - status documents that explain the gap between current code and target product,
  - subsystem implementation plans subordinate to the target application contract.

- `docs/plans/completed/`
  - archived plans whose main implementation purpose is finished,
  - historical execution documents kept only for traceability.

## Mandatory plan rules

Every active plan must:

1. say clearly what is implemented today and what is still target-only,
2. stay consistent with the target v2 application contract,
3. treat `fullmag script.py` as the main public workflow,
4. treat `session` as the runtime spine,
5. avoid creating a second architectural theory in `docs/plans/`,
6. keep physics-first documentation requirements explicit.

## Move rules

Move a plan from `active/` to `completed/` only when:

1. the main deliverables are implemented,
2. the remaining gaps are no longer the plan's main purpose,
3. the public status in the plan is still honest,
4. the plan is no longer steering current work.

Do not move:

- core architecture specs,
- policy specs,
- physics notes in `docs/physics/`.

## Physics documentation rule

Any plan that changes physics or numerics must be paired with a publication-style
note in `docs/physics/`.

Those notes should follow the tone of the local reference papers:

- `scientific_papers/s41524-025-01893-y.pdf`
- `scientific_papers/5_0024382 -- 4b879d2281db22323be109c1ac0ba334 -- Anna's Archive.pdf`

Minimum expected structure:

1. problem statement and scope,
2. governing equations and SI units,
3. numerical method and discretization,
4. software-design implications,
5. verification and validation,
6. limitations and deferred work.

## Current active plan map

- `active/implementation-status-and-next-plans-2026-03-23.md`
  - current-state audit and sequencing document
- `active/report-alignment-audit-2026-03-24.md`
  - audit of an external repo-state report against the current local worktree
- `active/frontend-architecture.md`
  - control-room and session-driven frontend implementation plan
- `completed/phase-0-1-implementation-plan.md`
  - archived historical baseline for the first executable CPU/FDM slice
- `active/phase-2-gpu-fdm-calibrated-rollout.md`
  - high-level GPU/CUDA rollout plan
- `active/phase-2-gpu-fdm-implementation-playbook.md`
  - detailed GPU/CUDA implementation handoff
- `active/fullmag-local-launcher-and-live-ui-plan-2026-03-25.md`
  - plan for one-command local launch, host-owned live control room, and runtime resolution
- `active/interactive-session-mode-plan-2026-03-25.md`
  - plan for true interactive sessions with command injection, pause/resume/break, and live UI controls
- `active/resource-first-api-endpoint-reference-rollout-2026-04-21.md`
  - plan for the field-complete resource-first endpoint reference, legacy-to-resource mapping, and final control-room cutover backlog
- `active/v2-api-cutover-and-v1-removal-plan-2026-04-25.mdx`
  - plan for generated v2 frontend transport, v2-native backend handlers, and public v1 API removal
- `active/fem-fredkin-koehler-cpu-gpu-general-plan-2026-09-01.md`
  - high-level correctness, validation, CPU scaling, and strict-GPU rollout plan for body-only Fredkin-Koehler demagnetization
- `active/fem-fredkin-koehler-cpu-gpu-implementation-playbook-2026-09-01.md`
  - test-first implementation and refactoring playbook subordinate to the Fredkin-Koehler general plan
