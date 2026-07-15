# ADR 0019: Spin transport and prescribed SOT semantics

- Status: proposed
- Date: 2026-07-15
- Decision owners: Fullmag physics, runtime, API, and Control Room maintainers
- Canonical physics: `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`, `docs/physics/0970-spin-hall-drift-diffusion-transport.md`, `docs/physics/0980-dynamic-current-and-oersted-coupling.md`
- Runtime contract: `docs/specs/spin-transport-runtime-contract-v1.md`

## Context

Fullmag currently exposes Zhang–Li and Slonczewski STT, algebraic SOT,
prescribed-current transport, and Oersted realizations through contracts that
do not yet share one complete sign, unit, source-binding, stage-time, ABI, and
provenance model. In particular, a local algebraic SOT can be mistaken for a
solved Spin Hall Effect, flat native descriptors can lose typed ownership,
signed current can be reduced to a magnitude, and current-derived torque and
Oersted fields can observe different source states.

The target product also needs steady one-way spin drift-diffusion, reciprocal
quasistatic charge-spin transport, and transient spin accumulation without
creating backend-specific public models. The protected invariants are one
Python DSL, one `SceneDocument` authoring model, one versioned `ProblemIR`, one
planner capability vocabulary, truthful requested/resolved execution, one
resource-first OpenAPI v2 contract, and one unified workspace.

## Decision

### 1. Prescribed SOT and solved SHE are distinct capabilities

The canonical public local-torque name is `PrescribedSpinOrbitTorque`.
`SpinOrbitTorque` and `spin_orbit_torque` remain read compatibility aliases
with deprecation metadata. Canonical Python and scene export always use
`PrescribedSpinOrbitTorque` / `prescribed_sot`.

Prescribed SOT consumes an authored signed scalar and polarization or a named
current source plus fixed drive direction and interface normal. It does not
solve charge or spin transport and must never advertise a SHE solver
capability. SHE/iSHE belong to `SpinTransportModuleIR`; transport-derived
torque belongs to `DriftDiffusionSpinTorque` and consumes a named solve.

Migrated `SpinOrbitTorque` payloads keep
`formula_version=prescribed_sot.legacy_fullmag.v0`. Canonical export changes
the class name but explicitly retains that formula, including the historical
absolute current, missing `gamma0`/rate conversion, and lack of Gilbert-source
transform. Only an explicit upgrade command with confirmed signed drive data
may create `prescribed_sot.fullmag.v1`; ordinary reading/export never changes
an old trajectory silently.

The runtime schema is a formula-discriminated union. The v1 variant alone
requires signed drives and nonzero unit axes. The legacy-v0 compatibility
variant retains a raw possibly-zero polarization plus either the raw scalar
consumed through `abs` or a source consumed through `norm(J)`. It is accepted
only with migration-origin metadata and may be read/re-exported losslessly, but
cannot be created by new Python/UI authoring.
Canonical Python round-trip uses the migration-origin-gated
`PrescribedSpinOrbitTorque.from_legacy_v0(...)` compatibility classmethod;
the ordinary constructor remains v1-only.

### 2. Signs, indices, and units are frozen once

`e>0`; `J_c` is signed conventional current. `gamma_e>0` has angular-frequency
unit `s^-1 T^-1`; `gamma0=mu0*gamma_e` applies to `H` in `A/m`. Interface
normals are oriented state and are preserved in provenance.

`mu_s` is the full spin-voltage splitting in `V`, with channel potentials
`V +/- mu_s/2`. `Q_ia` is charge-equivalent spin current in `A/m^2`; the first
index is flow direction and the second spin polarization. Published tensor
components use row-major `Q_ia`. Backends may not transpose this contract.

Direct torques are stored as Gilbert-source rates `T_G` in `1/s`. One shared
formula converts them exactly once to explicit RHS form. A backend may not mix
Gilbert-source, already transformed RHS, and field-in-`A/m` representations.

The legacy Slonczewski `fixed_layer_position` adapter preserves
`top/omitted -> +|J|` and `bottom -> -|J|` by deriving `stack_normal` from the
nonzero uniform current direction. Zero or direction-nonuniform sources fail
closed; geometry axes and averaged directions are not substitutes.

### 3. Source binding is named and single-owner

Current transport owns the committed `V_electric` and `J_charge` state. Spin
transport, Zhang–Li/Slonczewski/prescribed SOT, and Oersted consume the same
named `J_charge` revision. Spin transport owns `spin_potential` and
`spin_current_tensor`; transport torque consumes that named spin solution.
Consumers do not reconstruct or independently solve their source.

Source envelopes belong to the current source, not separately to each
consumer. A general Oersted solve requires an explicit closed circuit or
versioned return-path extension; an open truncated current is rejected.
Every `TimeEnvelope` value is a dimensionless multiplier (`1`) applied to a
dimensionful base drive. Tabulated envelopes require time in seconds and a
dimensionless value column; they cannot hide current or voltage units.

Slonczewski execution resolves exactly one versioned realization:
`slonczewski_thin_layer_homogenized.v1` with explicit thickness conversion or
`slonczewski_interface_flux.v1` with an oriented surface weak functional. The
resolved plan retains the choice; a backend may not infer one from mesh shape.

### 4. Coupling cadence is milestone-specific and stage-consistent

`CurrentTransport.coupling` is the sole public owner. Spin transport derives
its resolved coupling from its named current source; Python, UI, SceneDocument,
and normalized `SpinTransportModuleIR` do not expose a second independently
authorable value. A legacy duplicate is removed only if equal and otherwise
fails closed.

M1 is one-way quasistatic: charge drives spin, torque, and Oersted without
spin-to-charge feedback. Strict execution evaluates the common source,
Oersted, steady spin solve, and torque at every required LLG stage time and
stage magnetization.

M2 is reciprocal/bidirectional quasistatic. Charge and spin solve one coupled
nonlinear constitutive system at every required stage. Nonconvergence or failed
balance rejects the outer LLG step; the last iterate is not accepted.

M3 is transient spin transport with physical positive spin capacitance `C_s`.
Its production baseline is a coupled IMEX scheme with common rollback of
magnetization, charge, spin, Oersted, cache, histories, and revisions.
Transient spin may not be attached to explicit DP45 as an algebraic field.

FSAL reuse and cache reuse require exact accepted time, state, source, mesh,
operator, and formula revisions. Rejected evaluations never advance committed
or field revisions.

### 5. Oersted energy has two explicit semantics

When `J_c` is independent of magnetization, the instantaneous external Zeeman
term is `oersted_zeeman_energy`, contains no factor `1/2`, and may contribute to
`E_total` with `energy_semantics=external_zeeman`.

When M2 makes `J_c=J_c(m)`, the same integral is a diagnostic work snapshot,
`oersted_zeeman_work_snapshot`, with
`energy_semantics=coupled_diagnostic_nonvariational`. It is excluded from
`E_total`, conservative minimizers, and field-by-energy differentiation.

### 6. Existing quantity identifiers remain stable

`V_electric`, `J_charge`, `H_oe`, `torque_stt`, and `torque_sot` are preserved
exactly. New component quantities supplement rather than replace aggregate
IDs. `spin_current_tensor` is a nine-component rank-2 quantity with explicit
flow/spin axis metadata, not a vector.

### 7. ProblemIR and native plan ABI migrate explicitly

The target `ProblemIR` version is exactly `0.3.0`. Its standard reader accepts
current `0.3.0` and previous public `0.2.0`; writers emit only `0.3.0`.
Historical `0.1.0` requires the explicit, audited chain
`0.1.0 -> 0.2.0 -> 0.3.0` and is not silently accepted by the normal reader.

Native spin transport uses new independent descriptor families with exact
`abi_version=1` and `struct_version=1` for both FDM and FEM. These values start
at one because the current wide time-domain descriptors are unversioned; the
unrelated FEM frequency-domain ABI version 12 is not reused. Descriptors also
carry exact `struct_size`, validated before any field access.

Readers support exactly `0.3.0` and previous public `0.2.0`; writers emit only
canonical `0.3.0`. Legacy flat `stt_*` and
`sot_*` fields are accepted only by a dedicated old-ABI input adapter and lower
to typed torque vectors. Legacy Zhang–Li behavior keeps an explicit legacy
formula version; upgrading results is an opt-in migration. Incomplete
placeholder drift-diffusion cannot be migrated without domains, materials,
boundaries, and source binding and therefore fails closed.

ABI or structure-version/size mismatch fails before execution. Removing
compatibility readers requires a later ADR and usage/migration evidence.

Solver defaults are part of the versioned runtime contract, not backend
library defaults. The contract freezes per-milestone/lane/precision engines,
preconditioners, iteration limits, physical residual normalizations,
FP64/qualified-FP32 tolerances, Picard defaults, and unsupported single lanes.

Formula, operator, realization, and engine identifiers occupy disjoint
namespaces. The single normative registry is runtime-contract section 8.1;
physics notes, defaults, plan provenance, capability evidence, and legacy notes
must use its exact spellings.

### 8. Execution and capability claims are truthful and scoped

Every plan and artifact preserves requested and resolved discretization,
device, precision, mode, runtime, engine, formula/operator versions, and
validation scope. Strict requested GPU execution has no CPU solver or
GPU-to-CPU fallback. Extended fallback is legal only when explicitly supported
and is visible in provenance. Unsupported paths fail closed.

Capability status uses the canonical vocabulary and is workload-, lane-, BC-,
precision-, and version-scoped. Prescribed SOT never promotes SHE. An
executable source path, a build, or one algebra test cannot promote another
backend or mark a workload `validated`.

## Consequences

- Existing algebraic SOT scripts remain readable but canonical exports change
  name and emit migration diagnostics.
- Correcting signs, gyromagnetic prefactors, Gilbert conversion, and source
  time may change trajectories; legacy formula versions preserve reproducible
  old results while explicit migration enables canonical v1.
- FDM and FEM keep independent numerical operators and CPU/GPU realizations,
  but share typed physics descriptors, source identities, quantities, and
  provenance.
- Current/spin workflows own numerical state; torque and Oersted are consumers;
  the integrator owns cadence and atomic rollback but no transport physics.
- OpenAPI v2 exposes typed scene projections, revision-aware diagnostics, and
  existing binary field resources. It does not add heavy fields to status or
  create an alternate UI persistence model.
- M2 Oersted work snapshots no longer masquerade as conservative energy.

## Implementation obligations

1. Complete and accept physics notes 0960–0980 before solver implementation.
2. Implement the schemas, revisions, rollback, solver telemetry, residency,
   quantities, artifacts, checkpoints, and migration rules in the runtime
   contract.
3. Propagate the canonical name and typed modules through Python, SceneDocument,
   ProblemIR, planner, native descriptors, runner, OpenAPI, generated types,
   resource hooks, and canonical script export.
4. Add capability rows separately for direct torques, charge transport, steady
   and transient spin transport, direct/inverse SHE, interfaces, dynamic
   Oersted, and one-way/bidirectional coupling.
5. Keep `status.capabilities` as the Control Room gating source and preserve one
   Explorer/Inspector/ribbon/viewport architecture for FDM and FEM.
6. Use managed, container-backed repository `just` recipes as authoritative
   FEM/MFEM/CUDA/hypre/libCEED build and runtime proof.

## Migration and rollback

Rollout proceeds through independently gated M0–M3 milestones. Capability
registration controls availability; incomplete milestones remain semantic-only
or unsupported. Rollback disables the affected canonical capability while
retaining read-only inspection and compatibility deserialization. It must not
restore silent sign conversion, hidden CPU fallback, stale source reuse,
non-atomic coupled updates, or the claim that prescribed SOT solved SHE.

Compatibility aliases remain until a later ADR names their release removal
boundary and proves stored scenes and scripts round-trip through canonical
export without semantic loss.

## Tests and validation

- symbolic and vector sign/unit/Gilbert oracles for all torque families;
- legacy/canonical Python, scene, ProblemIR, ABI, and script round-trip;
- planner strict/extended rejection and requested/resolved provenance;
- stage-time, FSAL, final-refresh, coupled rejection, and rollback tests;
- analytic charge/spin/interface/Oersted oracles and FDM/FEM convergence;
- CPU/GPU double parity, independent FP32 qualification, and strict GPU
  residency/transfer audits;
- quantity-ID, tensor-order, energy-semantic, freshness, artifact, and restart
  tests;
- OpenAPI generation, typed resource mutation/invalidation, UI gating,
  authoring/export/inspection, and browser smoke;
- workload-scoped managed-runtime evidence before any `validated` promotion.
