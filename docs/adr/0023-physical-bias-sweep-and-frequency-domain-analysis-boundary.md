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

## Scoped extension: constant first-order uniaxial source identity

The source equilibrium and its modal consumer must bind the same signed Ku
and canonical rank-one axis. The material builder keeps the existing v1
serialization and namespace exactly for requests without Ku; requests with
Ku use `EquilibriumMaterialSignaturePreimage.v2`. The unit axis is normalized,
its first nonzero component is positive, and signed zero is canonicalized.
The v2 preimage includes Ku in SI and all existing material fields. Both
relaxation and eigen plans use this single builder. Previously rejected Ku
requests have no valid historical v1 handoff to migrate; an old source cannot
be reinterpreted as a Ku source. This is a scoped provenance extension, not
a new execution lane or a promotion of backend readiness.

The equilibrium observer uses the typed uniaxial interaction so its field
and energy stay separate from Zeeman. Native CPU assembly uses the constrained
energy derivative and total accepted-field curvature in note 0831. Uniform Ms,
constant first-order Ku and a global axis define this increment. Spatial Ku,
second-order/cubic/surface terms and DMI remain gated. Public planner guards
stay until end-to-end identity, field, payload and managed scientific checks
are available. FDM/GPU, OpenAPI and frontend contracts receive no extension.

Owners: `crates/fullmag-runner/src/fem/equilibrium_identity.rs`,
`eigen_equilibrium.rs`, `eigen_shared_domain.rs`, native shared-domain operator,
and `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.
Rust regression sources must exercise Ku/axis mutations, equivalent axes,
producer/consumer equality, legacy v1 bytes and unsupported material views.
Native unit compilation remains prohibited by the current repository rule;
source checks do not replace managed build/runtime evidence. Rollback may
keep Ku planner-gated but must not reuse a Ku-free handoff for Ku.

### Ku-aware static field certificates

Keep the Ku-free CertifiedFemEquilibriumFields.v1 serialization and digest.
Ku requests publish v2 with a mandatory separate h_anisotropy_a_per_m view,
a separate digest namespace and exact native CPU decomposition order.
Unknown schemas or schema/view/material mismatches fail closed. The measured
H_eff is verified, never replaced by a synthesized sum. The v2 refresh
certificate binds the anisotropy comparison and both field digests; filenames
match their actual versions. Existing v1 refresh bytes remain unchanged.
The shared Rust envelope supports these versioned records and validators
require coherent schema/optional-field pairs. This is an internal compatibility
reader, owned by runner types and equilibrium validation; no public Ku
capability or GPU readiness is promoted by it.

Required owners: runner types, native state_io linearization copy, relaxation
finalize/refresh producer, eigen handoff and field consumers, and the runtime
artifact validator. Required regressions cover legacy bytes, independent v2
binary digest, missing/forged anisotropy, shape/nonfinite errors and measured
field decomposition. Native unit compilation remains prohibited; runtime
qualification is still required before promotion.

### Canonical versus raw material artifacts

The user-authorized bounded Ku route adds equilibrium_artifact.v8 and
LinearizationState.v7. Their material_signature and native material_snapshot_id
use the existing canonical equilibrium_material_signature. A separate
material_provenance_signature hashes the raw MaterialIR of the materialization
plan, explicitly scoped as materialization_plan. The identity kind is
canonical_equilibrium_material.v2. Provided v8 records preserve their own
source raw provenance; newly generated states bind the current plan's raw
hash. Equivalent axes may differ in raw hashes but must share physical identity.

Ku-free writes retain v7/v6 and historical digest preimages. Legacy records
cannot be reinterpreted as Ku sources. All acceptance, completion, field,
mesh, phase and content-digest gates remain. Actual schemas determine paths
and single-/multi-sample manifest keys. Owners are the shared-domain producer,
equilibrium loader, native artifact/manifest producers, Python verifier and
COMSOL state readers. Compatibility readers are retained for archived records;
rollback keeps Ku gated rather than relabeling artifacts. This extension does
not change public Ku legality or assert native CPU/GPU qualification.
