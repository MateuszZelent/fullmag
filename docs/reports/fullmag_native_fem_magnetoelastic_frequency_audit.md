# Fullmag Native FEM Magnetoelastic and Frequency Audit

Status: implementation audit and remediation routing document
Last updated: 2026-05-20
Source report: `docs/reports/20.05.2026/backend_deep_report.md`

## Purpose

This audit records the backend state behind the 2026-05-20 deep report and
turns it into a repository-local decision record. It separates semantic support
from executable support so future work does not accidentally advertise driven
frequency response, two-way magnetoelasticity, frequency-domain elastodynamics,
or coupled magnon-phonon eigenmodes before the solver stack exists.

## Scope

Covered layers:

- public Python/API/IR study semantics;
- Rust planner legality and rejection policy;
- runtime capability payloads;
- native FEM ownership boundaries;
- frequency-domain artifacts and Analyze UI contracts;
- magnetoelastic prescribed-strain versus bidirectional mechanics.

This document does not certify production readiness for any new solver family.
Production readiness requires the acceptance gates in the implementation plan
and patch specs.

## Current Architecture State

Fullmag is moving in the right backend-neutral direction: public problems are
expressed above the implementation backend, and FDM/FEM/CPU/GPU are selected by
planning and runtime resolution. The weak point is still native FEM execution:
several FEM concepts pass through central descriptor and context paths, which
makes it too easy to add physics by widening a bridge rather than by adding an
operator family with explicit ownership, validation, and capability metadata.

Target split:

```text
physics/operators -> discretization/study -> execution backend
```

New physics must land behind this split. Compatibility fields in wide native FEM
descriptors may remain during migration, but they must have documented owners
and removal conditions.

## Native FEM State

Native FEM has executable slices for established magnetic terms, demag models,
and time-domain workflows. Executor availability is not production
qualification. The native FEM qualification overlay still requires
operator-level validation, benchmark evidence, and clear runtime provenance for
any named workload.

The remediation path is to move toward subsystem records:

```text
Interaction descriptors
Mechanics descriptors
Study descriptors
Solver descriptors
Observable descriptors
Runtime descriptors
```

No new mechanics or frequency-domain solver should be implemented by adding
hidden behavior to central bridge points.

## Frequency-Domain State

Existing foundations:

- linearized LLG frequency-domain conventions;
- FEM eigenmode and dispersion artifact contracts;
- v2 spectrum, branch, dispersion, and mode artifacts;
- Analyze UI/API assumptions for modal data;
- semantic public `StudyIR::FrequencyResponse` contract in this branch.

The executable path is incomplete. Current public planners must reject
`StudyIR::FrequencyResponse` execution with a semantic-only diagnostic until a
driven frequency-domain backend exists. Dense CPU reference eigenmodes remain a
validation MVP, not the scalable production answer for large FEM meshes.

## Magnetoelastic State

Current executable magnetoelasticity is prescribed-strain oriented. It can
contribute `H_mel`, but it does not solve elastic equilibrium and feed
`u`, `eps`, and `sigma` back into the magnetic problem as a validated two-way
mechanics loop.

The capability payload must keep these booleans explicit and false for current
engines:

- `supports_frequency_response`
- `supports_coupled_magnetoelastic_quasistatic`
- `supports_coupled_magnetoelastic_elastodynamic`
- `supports_frequency_domain_elastodynamics`
- `supports_coupled_eigenmodes`

Prescribed-strain `H_mel` and magnetic-only FEM eigen support must not be read
as any of those solver families.

## Semantics Versus Execution

- Semantic IR may exist before a solver exists.
- Planners must reject semantic-only execution explicitly.
- Runtime capabilities must advertise deferred features as false.
- Docs and UI labels must not describe semantic-only features as executable.
- Acceptance gates must move a feature from semantic-only to executable.

## Risks

Technical risks:

- extending wide native FEM descriptors instead of splitting ownership;
- adding coupled mechanics to hot paths without persistent solver state;
- treating dense reference eigen solves as production scale;
- capability drift between planner, runner, docs, and UI;
- hidden host/device synchronization in future GPU paths.

Physics risks:

- using prescribed strain as evidence of two-way magnetoelasticity;
- solving unconstrained three-component frequency-domain eigenvectors as final
  physical modes;
- omitting rigid-body constraints in quasistatic elasticity;
- mixing quasistatic and elastodynamic mechanics under one capability bit;
- reporting coupled magnon-phonon hybridization without a coupled operator.

## Audit Decisions

1. Do not develop new backend physics without operator contracts and explicit
   capability metadata.
2. Do not implement full harmonic magnon-phonon response before magnetic-only
   frequency response and quasistatic bidirectional mechanics are in place.
3. Do not describe native FEM as production qualified without operator-level
   validation, benchmarks, and runtime proof for the named workload.

## Evidence To Keep Current

When this audit is updated, verify these current-state sources:

- `crates/fullmag-ir/src/study.rs`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-runner/src/capabilities.rs`
- `packages/fullmag-py/src/fullmag/model/study.py`
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/capability-matrix-v0.json`
