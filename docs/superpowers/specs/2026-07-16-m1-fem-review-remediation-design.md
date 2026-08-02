# M1 FEM review remediation design

## Scope

Close the remaining M1 FEM steady charge-spin transport review findings without
changing the supported physics lane: FEM CPU, double precision, strict mode,
one-way coupling, conforming H1 P1, transparent interfaces.

## Canonical semantics

`ResolvedFemSpinTransportIR` remains the executable descriptor and preserves
the resolved charge and spin element masks, explicit insulating boundary
attribute sets, transparent interface identities, and the optional authored
drift-diffusion torque target identity and element mask. These values are
resolved once by the planner and are repeated in execution provenance so that
the native request cannot erase authored intent.

The descriptor uses the independent evidence axes from the capability matrix:

- `capability_status = reference_executable`;
- `implementation_state = executable`;
- `validation_state = algebra_validated`;
- the bounded validation scope remains explicit.

## Whole-plan preflight

Execution has two phases. The first phase validates every resolved transport
plan, validates unique module and current-source bindings against the canonical
`FemPlanIR.current_modules`, checks the complete charge definition against the
resolved descriptor, materializes every native request, and constructs
provenance. It performs no native ABI call. The second phase invokes the native
solver only after the complete first phase succeeds.

## Canonical quantity publication

There is one `FieldSnapshot` carrier. It stores flattened `Vec<f64>` values and
mandatory typed metadata: component count, component order, location, scope,
and revision. `FieldSnapshot::from_vec3` provides surgical compatibility for
existing vector producers. Construction and artifact writing reject zero
component counts and value lengths that are not divisible by the component
count.

The five transport quantities are appended to
`ExecutedRun.field_snapshots`, not auxiliary-only summaries. Revisions are
monotonic within the executed run. The existing field artifact resource and v2
data-plane reader remain authoritative; the transport summary JSON remains
supplementary diagnostics.

## Runtime structure and provenance

The steady-transport runtime is split into focused modules:

- ABI request flattening and native solve;
- descriptor/current-source validation and all-plan preflight;
- canonical quantity publication;
- provenance construction.

Transport provenance adds `runtime_family` and uses typed optional fallback
and degradation records. The successful strict M1 path publishes neither.

## Verification

Tests first cover semantic preservation, current-source duplicates and
contradictions, all-plan preflight ordering without ABI entry, scalar/vector/
tensor snapshot shape and revisions, canonical artifact publication, evidence
vocabulary, and provenance serialization. Final proof uses the repository's
managed container-backed `just` gate from the task brief.
