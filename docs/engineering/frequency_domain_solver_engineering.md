# Frequency-Domain Solver Engineering

Status: staged engineering plan
Last updated: 2026-05-20
Related plan: `docs/plans/fullmag_magnetoelastic_frequency_implementation_plan.md`

## Technical Scope

This document turns the physics and patch specs into implementation work. The
goal is staged backend work with capability flags, artifacts, tests, and
benchmark evidence at each promotion point.

The current branch covers the MR-A contract slice: first-class semantic
frequency response, semantic-only planner rejection, explicit deferred runtime
capabilities, and documentation. Later MRs must build execution on top of this
contract rather than bypassing it.

## Backlog Per Crate

### `crates/fullmag-ir`

- Own public study semantics.
- Validate `StudyIR::FrequencyResponse` independently of backend availability.
- Keep frequency sweep values finite and positive.
- Keep equilibrium, excitation, damping, normalization, and spin-wave boundary
  fields explicit.

### `crates/fullmag-plan`

- Own legality and backend selection.
- Reject semantic-only response execution explicitly until a backend lane is
  executable.
- Reject unsupported dynamic demag, mechanics, periodic, or transfer-operator
  combinations before runtime launch.

### `crates/fullmag-runner`

- Own runtime capability payloads and dispatch.
- Expose separate booleans for response, quasistatic coupling, elastodynamic
  coupling, frequency-domain elastodynamics, and coupled eigenmodes.
- Keep unsupported booleans false for every current engine.
- Flip a boolean only in the MR that also adds backend execution, tests,
  artifacts, docs, and benchmark evidence for the named lane.

### `crates/fullmag-api`

- Preserve capability payload compatibility.
- Expose requested versus resolved backend information.
- Return explicit missing-artifact diagnostics rather than empty success
  payloads for future response resources.

### `packages/fullmag-py`

- Own ergonomic authoring objects.
- Validate Python `FrequencyResponse` arguments before exporting IR.
- Keep runtime script stage kind as `frequency_response`.
- Keep examples honest about semantic-only status until execution exists.

## Backlog Per Backend

### FDM CPU reference

- Remains useful for semantic validation and future small magnetic-only response
  reference tests.
- Must not advertise coupled mechanics or frequency-domain elastodynamics.

### FDM CUDA

- Can later execute magnetic-only response only after a validated GPU operator
  exists.
- Must report precision, device, residuals, and host/device synchronization
  behavior for production labels.

### FEM CPU native

- First target for scalable magnetic eigen via assembled operators and
  PETSc/SLEPc.
- First target for quasistatic mechanics because CPU debugging and residual
  introspection are required before GPU promotion.
- Must keep mechanics ownership outside central bridge accumulation points.

### FEM native GPU

- Follows CPU contracts after operator semantics and artifacts are stable.
- Requires explicit no-hidden-host-sync and no-hot-loop-allocation gates before
  production labels.

## API And ABI Changes

The wide native FEM compatibility descriptor may remain during migration, but
new solver families should converge on split descriptors:

```text
fullmag_fem_problem_desc
fullmag_fem_mesh_desc
fullmag_fem_material_desc
fullmag_fem_interaction_desc
fullmag_fem_mechanics_desc
fullmag_fem_frequency_study_desc
fullmag_fem_solver_desc
fullmag_fem_runtime_desc
fullmag_fem_observable_desc
```

Descriptor rules:

- study descriptors select time, eigen, or frequency-response workflow;
- mechanics descriptors select prescribed strain, quasistatic elasticity, or
  elastodynamics;
- solver descriptors state linear solver, preconditioner, tolerance, iteration
  cap, and reuse policy;
- observable descriptors state names, units, tensor layout, and artifact schema.

## Solve Stack

- Magnetic eigen: dense reference for small validation problems; the current
  runner warns on dense O(n^3) solves above roughly 3,000 effective DOF and uses
  a transitional CPU sparse LOBPCG lane above 5,000 effective DOF when the
  problem is real-valued. The scalar-projected path now materializes an
  `AssembledScalarOperator` with a PETSc/SLEPc binding descriptor for the
  assembled symmetric generalized tangent operator. PETSc/SLEPc EPS with
  shift-invert remains the production-sized CPU FEM target before any scalable
  capability promotion.
- Driven magnetic response: block-real or complex harmonic solve with residual
  per frequency and reusable sweep state. The current runner now contains an
  initial dense block-real primitive in `eigen::response_block_real` for
  `K - omega^2 M + i omega C`; it returns complex response amplitudes plus
  absolute/relative residual norms. The same module now has a field-driven
  sweep wrapper that emits per-frequency amplitude, phase, field-work
  absorbed-power diagnostic, scalar susceptibility, and residual metrics, while
  rejecting empty sweeps, non-positive/non-finite frequencies, and non-finite
  complex excitations before diagnostics are emitted. It also carries
  previous-frequency response provenance for later warm-started iterative lanes,
  including the source frequency and residual quality of that candidate; dense LU
  still does not claim reusable factorization or preconditioner state. It can now
  build and write a serializable `response/magnetic_response_sweep.v1.json`
  payload with schema version, SI units, backend engine id, solver model, damping
  policy, lane classification, Hz/rad-s frequency metadata, response vectors,
  susceptibility tensor, absorbed-power diagnostic, residuals, excitation
  provenance, sweep reuse, and an explicit tangent-leakage diagnostic status. It
  remains a local validation primitive, not an executable
  `StudyIR::FrequencyResponse` backend, runtime-integrated artifact writer, API
  resource, or capability promotion.
- Quasistatic mechanics: assemble stiffness once, refresh RHS from
  magnetization and loads, warm-start displacement, export residuals.
- Elastodynamics: add mass and damping matrices explicitly and keep damping
  policy in IR and artifacts.
- Coupled systems: assemble block operators only after independent magnetic and
  mechanical blocks pass validation.

## Preconditioners

Initial CPU policies:

- magnetic eigen: SLEPc shift-invert with documented linear solve policy;
- driven response: GMRES or equivalent Krylov method with reusable preconditioner;
- quasistatic mechanics: CG for SPD constrained systems, GMRES for nonsymmetric
  extensions, AMG/Jacobi/none as explicit policies;
- coupled harmonic response: block preconditioner with separate magnetic and
  mechanical approximations.

The selected policy must appear in artifacts and benchmark records.

## GPU Plan

1. Match CPU artifact schema.
2. Match physics gates under documented workload tolerances.
3. Report device, precision, and transfer policy.
4. Pass no-hidden-host-sync checks for hot paths.
5. Keep CPU fallback explicit in requested/resolved backend metadata.

## Frontend And CLI

- Authoring UI can expose semantic frequency-response settings.
- Run buttons must respect capability diagnostics.
- Analyze views must not synthesize missing response artifacts.
- Artifact fetch failures should show diagnostic messages.
- CLI examples for semantic-only studies can serialize IR but must not claim
  runtime execution.

## Test Matrix

MR-A contract tests:

```bash
cargo test -p fullmag-ir frequency_response_round_trips_as_first_class_study
cargo test -p fullmag-plan frequency_response_is_first_class_ir_but_not_executable_yet
cargo test -p fullmag-runner capabilities
cargo check -p fullmag-api
cargo check -p fullmag-cli
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k "frequency_response or eigenmodes_serializes_floquet"
python3 -m json.tool docs/specs/capability-matrix-v0.json
```

Future native gates:

```bash
cmake --build <native-build-dir> --target <native-fem-target>
ctest --test-dir <native-build-dir> -R "fem|frequency|magnetoelastic" --output-on-failure
```

Replace angle-bracket values with the active native build environment before
release evidence is recorded.

## Benchmark Matrix

| Feature | Correctness case | Scaling case |
|---|---|---|
| magnetic eigen | exchange-only reciprocal dispersion | increasing FEM DOF count with SLEPc residuals |
| driven magnetic response | single resonance under field drive | multi-frequency sweep with preconditioner reuse |
| quasistatic mechanics | clamped bar or patch test | accepted-step repeated RHS refresh |
| elastodynamics | harmonic beam or acoustic mode | sweep across mechanical resonance |
| coupled eigenmodes | synthetic weak-coupling anticrossing | coupled branch tracking under mesh refinement |

Benchmark records must include engine id, hardware, DOF count, mode or frequency
count, tolerance, iteration counts, wall time, residuals, and artifact paths.

## MR Schedule

- MR-A: semantic IR, planner rejection, capability flags, docs.
- MR-B: scalable magnetic-only FEM eigen CPU lane.
- MR-C: driven magnetic-only frequency response.
- MR-D: mechanics execution core and quasistatic solve.
- MR-E: bidirectional magnetoelastic accepted-step integration.
- MR-F: harmonic elastodynamics.
- MR-G: coupled magnon-phonon response and eigenmodes.
- MR-H: Control Room Analyze, CLI examples, production baselines.

## Release Gates

A release note may call a feature executable only when the corresponding runtime
capability bit is true for the named engine, unsupported engines still return
false, planner and runtime agree on requested/resolved engine ids, artifacts
include schema and residuals, numerical gates pass, benchmark records exist, and
frontend/API/CLI surfaces show the same capability status.
