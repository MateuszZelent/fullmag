# ADR 0018: Algorithm-specific relaxation contract

- Status: accepted
- Date: 2026-07-10
- Decision owners: Fullmag physics, runtime, API, and Control Room maintainers
- Canonical physics: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`

## Context

Fullmag currently represents damping-only LLG relaxation and direct energy
minimizers with one shape that always contains LLG dynamics. This permits
meaningless integrator/time controls on PG-BB, NCG, and TPI, allows UI and
Python defaults to drift, and makes stage completion reconstruct solver state
from sampled outputs. The same ambiguity lets nonconservative torques enter a
workflow whose public convergence metric is conservative field torque.

The protected invariants are one Python DSL, one canonical `ProblemIR`, one
planner capability vocabulary, truthful requested/resolved provenance, one
OpenAPI browser contract, and one unified Study inspector.

## Decision

1. `Relaxation` is a conservative-equilibrium workflow. Thermal noise, direct
   spin torques, time-dependent sources, and field contributions without a
   matching energy are rejected.
2. `llg_overdamped` owns optional LLG dynamics and stage-local relaxation time.
   Direct minimizers own no integrator or seconds-valued budget.
3. `StudyIR::Relaxation.dynamics` becomes optional and is present exactly for
   LLG. Legacy time fields migrate only to the canonical LLG relaxation-time
   field; direct-minimizer use is rejected.
4. `max_torque_Apm` is the exact accepted-state
   `max |m cross H_eff|` in A/m. Total RHS norm is a separate `1/s` quantity.
5. Solver/native execution state emits typed completion. Terminal state and
   equilibrium convergence are independent.
6. OpenAPI exposes typed algorithms, capabilities, stop reasons, metric kinds,
   and units. Generated TypeScript drives one capability-gated inspector.
7. TPI remains an explicit CPU development capability and is rejected in
   strict production until its full operator is scientifically qualified.

## Consequences

- Python, IR, planner, runner, native ABI mappings, artifacts, OpenAPI, generated
  frontend types, commands, and inspector drafts change together.
- Existing scripts using `torque_tolerance`, `max_physical_time_s`, or
  `max_pseudotime_s` receive bounded compatibility normalization and warnings;
  canonical exports use only canonical names.
- Fixing numerical units may change trajectories and iteration counts. Parity
  is judged by energy, torque, final state, and observable tolerances, not by
  identical line-search steps.
- A future driven stationary-state workflow requires a separate physics note,
  IR variant, RHS residual, capability row, and UI surface. It is not smuggled
  into `Relaxation`.

## Implementation obligations

- Update `packages/fullmag-py`, `crates/fullmag-ir`, `crates/fullmag-plan`,
  `crates/fullmag-runner`, native FDM/FEM implementations and ABI mappings,
  OpenAPI schemas/generated types, Control Room authoring/runtime models,
  capability matrix, backend architecture docs, and canonical relaxation docs.
- Preserve requested and resolved algorithm/device/mode and compatibility
  normalization in provenance.
- Use resource hooks and generated v2 transport; no direct component fetch or
  duplicated FDM/FEM inspector tree.
- Use container-backed `just` recipes as authoritative FEM build/runtime proof.

## Migration and rollback

Compatibility aliases remain read-only bridges with explicit warnings and
conflict errors. Removal requires an IR-version migration and evidence that
canonical script export and stored scene documents no longer emit them.

If rollout must be reverted, capability gates disable affected direct
minimizers or TPI; the system must not restore approximate torque, silent
fallback, nonconservative relaxation, or `completed` backend failures.

## Tests and validation

- Python-to-IR and UI-to-script round-trip tests for canonical and legacy input;
- planner rejection/capability tests for every algorithm and interaction family;
- analytical and CPU/GPU tests for exact torque and energy derivatives;
- runtime tests for typed completion, failure, nonfinite data, and sparse-output
  independence;
- OpenAPI generation and Control Room default/conditional-field/unit tests;
- managed FEM source, runtime, convergence, consistency, and production gates.
