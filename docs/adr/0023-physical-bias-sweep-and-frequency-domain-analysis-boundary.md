# ADR 0023: Physical bias sweep and frequency-domain analysis boundary

- Status: accepted
- Date: 2026-08-11
- Governing physics:
  `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`

## Context

Frequency-domain validation previously allowed three concepts to drift
together: the physical field supplied to each solve, an analytical Kittel
reference, and the Results presentation over modal or driven artifacts. That
made it possible to describe an analytical sample list as if it were a
physical field sweep, or to treat a Results view as another solver path.

The current public DSL, `ProblemIR`, planner and runner have an explicit
`BiasFieldSweep` contract. The analytical Kittel model remains useful, but only
after a physical solve. CPU and GPU production readiness remains
`source_visible / unvalidated` until current-snapshot managed evidence exists.

## Decision

### Physical sweep

`BiasFieldSweep.samples_a_per_m` is a physics-owned input in SI
$\mathrm{A\,m^{-1}}$. Its declared ordering, equilibrium policy and
continuation seed are canonical `ProblemIR`. Planning preserves those fields
as requested intent and records resolved execution separately for every sample.
Forced CPU or GPU requests never change a field sample or silently fall back.

The field-sweep writer freezes
`scan_axis.coordinate="bias_field_a_per_m"` and sample
`bias_field_a_per_m`. `mu0_H` is a display conversion in tesla, not another
physical input.

### Derived validation and analysis

Kittel comparison and FMR peak detection are derived postsolve
validation/analysis. They may consume completed physical artifacts but may not
set the field, equilibrium, operator, spectral target, solver lane, acceptance
status or provenance signature.

### Results ownership

Results is a view and analysis surface over versioned `modal_eigen` and
`driven_response` artifacts. It is not a third solver family and cannot
promote either product's capability. Modal and driven products retain distinct
planner, runtime, artifact and qualification status.

## Consequences

- Python export, `ProblemIR`, planner diagnostics and artifacts preserve the
  authored bias samples and per-sample requested/resolved execution.
- Oracle metadata that influences a physical input fails closed.
- UI/Results may compare Kittel/FMR-derived quantities only after loading the
  corresponding physical artifacts.
- Source presence, round-trip tests and source-level native assembly do not
  create `executable_scope` or `validated_scope`.

## Implementation obligations

The following paths are the required implementation map. A change to this
decision is incomplete if it changes the stated semantics without the
corresponding owner and focused contract test.

| Concern | Required code owner | Required focused test or artifact |
|---|---|---|
| Public sweep and canonical script round-trip | `packages/fullmag-py/src/fullmag/model/eigen.py` (`BiasFieldSweep`), `packages/fullmag-py/src/fullmag/world.py` (`eigenmodes_stage`) and `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `packages/fullmag-py/tests/test_problem_ir.py::test_eigenmodes_bias_field_sweep_serializes_declared_si_samples`; `packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_study_stage_builder_bias_field_sweep_roundtrips_cpu_and_gpu_intent` |
| Canonical physical request and legality | `crates/fullmag-ir/src/study.rs` (`BiasFieldSweepIR`) and `crates/fullmag-ir/src/lib.rs` (`ProblemIR::validate`) | `crates/fullmag-ir/tests/ir_tests.rs::eigenmodes_bias_field_sweep_deserializes_and_rejects_invalid_physical_samples` |
| Planner requested/resolved execution and fail-closed legality | `crates/fullmag-plan/src/lib.rs` | `crates/fullmag-plan/src/tests.rs::{fem_eigen_bias_field_sweep_plans_declared_samples_with_resolved_execution,fem_eigen_bias_field_sweep_kittel_metadata_requires_sample_field_mapping,fem_eigen_bias_field_sweep_rejects_relax_each_previous_seed}` |
| Per-sample lifecycle and Kittel isolation | `crates/fullmag-runner/src/fem_eigen.rs` (`execute_bias_field_sweep`, `validate_bias_field_sweep_oracle_contract`) | in-module tests `bias_field_sweep_continuation_uses_previous_accepted_equilibrium` and `bias_field_sweep_kittel_oracle_request_fails_closed` |
| Field-sweep artifact contract | `crates/fullmag-runner/src/eigen/artifacts.rs` (`field_sweep_axis`, `build_frequency_domain_field_sweep_artifact`, `write_frequency_domain_field_sweep_artifact`) | in-module tests `field_sweep_builder_does_not_fabricate_bias_field_from_kittel_metadata` and `field_sweep_writer_binds_to_published_spectrum_and_branches_bytes`; generated runtime artifact `eigen/field_sweep.v1.json` |
| Native FEM boundary | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp` and `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` (`assemble_native_magnetic_a_qq`, `assemble_poisson_airbox_shared_domain_payload`) | native shared-domain source tests; runner remains orchestration, ABI, provenance and artifact owner, not a second FEM assembly owner |

The canonical documentation and generated-contract map is:

- governing note and source map:
  `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` and
  `docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json`;
- artifact names and provenance:
  `docs/specs/frequency-domain-artifacts-v2.md` and
  `eigen/field_sweep.v1.json`;
- non-promotional availability state:
  `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`,
  `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json`,
  `docs/specs/capability-matrix-v0.json` and
  `docs/specs/capability-matrix-v0.md`.

This ADR authorizes no screen-shaped API and no generated-client contract
change. The existing Results surface remains resource-first through
`crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`,
`apps/control-room/src/kernel/api/generated/openapi-v2.json` and
`apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`; a future
change to those generated artifacts must first update the canonical API source
and add its resource/API tests. Results must not add a hidden modal/driven
dispatch or use the absence of a generated-field change to infer qualification.

Capability and readiness matrices remain `source_visible / unvalidated` until
fresh ABI-matched managed CPU/GPU evidence, convergence, parity, performance
and release gates pass.

## Validation

- Python and `ProblemIR` tests cover SI samples, ordering, equilibrium policy,
  continuation seed, exact Gamma, x/y-periodic/open-z, strict double execution
  and script round-trip.
- Runner tests prove per-sample lifecycle and fail-closed Kittel influence.
- Artifact tests freeze `bias_field_a_per_m` and `mu0_H`.
- Production promotion separately requires managed CPU/GPU runtime, physical
  sweep convergence, original-block residuals, parity, device and release
  evidence.

## Migration and rollback

Readers may continue to accept historical analytical validation metadata, but
it is never upgraded into a physical sweep. New writes use
`BiasFieldSweepIR` and the frozen field-sweep axis. Rollback may hide the
derived analysis view; it must not restore oracle-driven physical inputs or
make Results a solver.
