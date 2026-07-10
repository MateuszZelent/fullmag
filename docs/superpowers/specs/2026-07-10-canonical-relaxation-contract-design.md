# Canonical Relaxation Contract Repair Design

- Status: approved for implementation
- Date: 2026-07-10
- Baseline: current worktree on `salvage/mixed-fem-viewport-35232294`
- Canonical physics: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Audit evidence: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`

## Objective

Repair every publicly reachable Fullmag relaxation algorithm and its end-to-end
contract so physical equilibrium, energy minimization, torque telemetry,
stopping, Python authoring, ProblemIR, planning, runtime provenance, OpenAPI,
and the Control Room inspector describe the same behavior.

The implementation covers FDM and FEM, CPU and GPU, `llg_overdamped`,
`projected_gradient_bb`, `nonlinear_cg`, and the development-only
`tangent_plane_implicit` lane. It does not add a driven steady-state workflow.

## Approved decisions

### 1. Relaxation is conservative

`Relaxation` rejects thermal noise, direct spin torques, time-dependent fields,
and any field contribution without matching line-search energy. Static Oersted
is allowed only on a lane with proven field-energy parity. A future
`DrivenSteadyState` workflow will own nonconservative stationary solves.

### 2. Algorithm families own different controls

`llg_overdamped` owns optional LLG dynamics, integrator, fixed/adaptive step,
damping override, and stage-local `max_relaxation_time_s`.

PG-BB, NCG, and TPI are direct minimizers. They reject dynamics, integrator,
`dt`, damping override, and all seconds-valued budgets. Their line-search step
has unit `m/A` and is exposed only as an algorithm diagnostic.

`StudyIR::Relaxation.dynamics` becomes optional with validation requiring it
exactly for LLG. The planner resolves no integrator for direct minimizers.

### 3. Exact torque is authoritative

`max_torque_Apm` is exactly `max |m cross H_eff|` in `A/m`, computed on the
accepted state with fresh fields. No convergence path reconstructs it from
`max_dm_dt`, and exact zero is not an availability sentinel. `max_torque_T` is
the auxiliary `mu0` conversion. Total dynamic RHS is a separate `1/s` metric.

### 4. Solver state owns completion

The execution loop/native backend that observes a stop condition emits the
typed completion. Artifact sampling never reconstructs stop reason or elapsed
time. Every terminal relax stage has one reason. Budget exhaustion is terminal
but not converged; nonfinite values, line-search exhaustion, and backend errors
fail the stage.

### 5. Numerical repairs are cross-lane

- FDM CUDA PG-BB/NCG use `mu0 Ms V` Armijo, BB, and CG products matching CPU.
- FDM native CUDA exact torque is preserved by the Rust wrapper.
- FDM multilayer executes every advertised tableau or narrows capability.
- FEM PG-BB/NCG use dimensionally consistent energy metrics and
  mass-plus-exchange preconditioners.
- FEM TPI stays development-only and strict-production-disabled until its
  complete operator-action validation passes.
- FEM nonfinite telemetry fails instead of becoming zero.
- CUDA and MFEM implementations publish truthful, distinct realizations.

### 6. One public contract reaches Python and UI

Canonical defaults are `1e-4 A/m` and `50_000` steps. Python and Rust reject
NaN/Inf. Explicit `None` remains explicit. Deprecated aliases normalize once
and are not re-exported.

OpenAPI exposes typed algorithms, stop reasons, metric kinds, units, and
capabilities. Generated TypeScript drives Control Room capability gating.
The inspector conditionally renders controls by algorithm, removes inapplicable
fields from drafts, removes `euler`, displays torque in A/m plus T, and
round-trips the canonical script/scene shape.

## Architecture and ownership

### Canonical physics and semantic model

- `docs/physics/0580-canonical-relaxation-equilibrium-contract.md` owns the
  equations, units, legality, and qualification contract.
- `packages/fullmag-py` owns public authoring and canonical script export.
- `crates/fullmag-ir` owns normalized semantic representation and typed
  completion/metric vocabulary.
- `crates/fullmag-plan` owns legality and requested-to-resolved capability.

### Runtime and backends

- FDM/FEM backends own exact fields, energy, torque, numerical iteration, and
  accepted-state metrics.
- Native FEM owns its relaxation algorithms and native completion state.
- Rust runner owns dispatch, ABI mapping, live resources, artifacts, and
  provenance without reimplementing FEM optimizer mathematics.
- Generic completion helpers consume authoritative completion; they do not
  infer it from sampled rows.

### API and Control Room

- OpenAPI v2 is the executable browser contract.
- Generated transport/types are regenerated, never edited.
- API facade/resource hooks remain the only module data path.
- Inspector state is a local draft transaction; committed study state remains
  the model resource.
- Capability resources gate algorithms and controls without separate FDM/FEM
  UI trees.

## Migration policy

1. Add canonical `max_relaxation_time_s` and optional relaxation dynamics.
2. Accept legacy `max_physical_time_s`/`max_pseudotime_s` only as deprecated
   LLG aliases when no canonical field conflicts.
3. Reject legacy time fields for direct minimizers.
4. Keep `torque_tolerance` as a deprecated A/m alias for
   `torque_tolerance_apm`.
5. Normalize stage metric IDs to typed `max_torque_apm` while retaining scalar
   field name `max_torque_Apm` for compatibility.
6. Preserve requested legacy input and normalization warnings in provenance;
   export only canonical names.
7. Treat TPI as an extended CPU development capability; strict mode rejects.

## Failure behavior

- Illegal interaction/algorithm combinations fail in Python where possible and
  again in IR/planner validation.
- Unsupported backend/device/mode combinations fail with a capability reason.
- Automatic fallback is allowed only where the capability matrix explicitly
  permits it and preserves requested/resolved intent.
- Nonfinite torque, energy, gradient, adaptive error, or solver residual fails.
- Numerical stagnation above configured equilibrium thresholds is not
  convergence.
- A terminal failure remains failed in run status, stage completion, API,
  artifacts, and UI.

## Implementation work packages

### A. Semantic spine

Update physics-facing defaults and validation, optional dynamics, canonical
time field, typed metric/stop vocabulary, planner legality, and capability
exposure. This package establishes compile-time contracts before backend or UI
changes rely on them.

### B. Exact telemetry and completion

Remove torque fallback/sentinels, propagate exact zero, reject nonfinite native
values, separate RHS norm, move stop ownership to execution state, and persist
generic completion/provenance.

### C. FDM numerical repair

Repair CUDA direct-minimizer energy products, preserve native torque, make
multilayer integrator claims truthful, enforce fresh fields, and add CPU/CUDA
physics parity tests.

### D. FEM numerical repair

Complete the existing worktree derivative-metric patch, repair PG-BB/NCG
preconditioner scales, disable TPI in strict production, add manufactured TPI
operator tests, correct telemetry accounting/provenance, and add nonfinite
guards. Container-backed `just` recipes are authoritative.

### E. API and Control Room

Update OpenAPI sources, regenerate TypeScript, expose capability/metric units,
repair authoring import/export/defaults, conditionally render controls, and
render completion/convergence/failure truthfully.

### F. Qualification and documentation reconciliation

Update `0500`, `0510`, `0530`, capability matrix, backend masterplan, and
validation artifacts. Run analytical, cross-lane, managed-runtime, API, Python,
and browser gates. TPI remains development until every promotion gate passes.

## Verification model

Every behavioral fix follows red-green-refactor. A test must fail for the
identified defect before production code changes. Existing tests that encode
the wrong contract are replaced only after the new failing assertion proves
the desired behavior.

Required evidence classes:

- analytical formula/unit oracle;
- focused regression reproducing the bug;
- cross-lane CPU/GPU comparison where both lanes are supported;
- public Python/IR/planner/API/UI round-trip;
- container-managed FEM runtime evidence;
- final requirement-by-requirement completion audit.

Passing source-string or smoke tests alone cannot qualify physics.

## Non-goals

- implementing `DrivenSteadyState`;
- adding manifold L-BFGS;
- adding GPU TPI;
- hybrid relaxation;
- unrelated frequency-domain or viewport refactors;
- preserving numerically identical trajectories after correcting wrong units.

## Acceptance criteria

1. Every public relax algorithm has explicit legal controls and capability.
2. Every supported lane implements the documented algorithm or rejects it.
3. `max_torque_Apm` is exact, fresh, finite, and unit-consistent everywhere.
4. Direct minimizer line search is dimensionally correct for heterogeneous
   material/mesh weights.
5. Nonconservative relaxation requests are rejected before execution.
6. Every terminal stage has truthful status, convergence, reason, metric, unit,
   threshold, and provenance.
7. Python, canonical script export, ProblemIR, planner, OpenAPI, generated TS,
   commands, and Control Room round-trip one semantic representation.
8. Defaults are identical across every authoring surface.
9. TPI has one truthful development status and no strict-production path.
10. All required focused, full-suite, managed FEM, and browser checks pass, with
    unrelated pre-existing failures separately evidenced.
