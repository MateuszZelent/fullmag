# ADR 0019: Regional field drive and stage-time semantics

- Status: accepted
- Date: 2026-07-15
- Decision makers: Fullmag core
- Governing physics: `docs/physics/0920-regional-time-domain-field-drive.md`
- Implementation plan: `docs/audits/2026-07-15-fem-pbc-time-domain-field-drive-implementation-plan.md`

## Context

Fullmag has a compatibility model named `prescribed_zeeman_mask` inside the
antenna-source family, while the existing solved-antenna work defines a
physically different conductor-backed field basis. The old model is visible in
authoring, preview, and quantity catalogues but is not wired consistently into
all time-domain RHS paths, especially native FEM. Existing time-dependent
interactions also do not provide one canonical stage-local versus absolute
clock and event contract across FDM, FEM, CPU, and GPU.

Conflating a prescribed field with a solved antenna misstates the physics.
Evaluating a dynamic field only at accepted-step start destroys the order of
Runge--Kutta methods. Allowing a nonperiodic basis to be averaged across a
static-PBC class changes the authored excitation silently.

## Decision

### 1. Regional and solved sources are separate

Fullmag introduces `RegionalFieldDrive` for an authored spatial field times a
waveform. `SolvedAntennaDrive` continues to reference a field-basis artifact
from the conductor workflow. No planner or runtime may substitute either
family for the other.

`AntennaFieldSource(model="prescribed_zeeman_mask")` is import-only
compatibility input. It migrates deterministically to `RegionalFieldDrive` and
records migration provenance. New Python and UI export never emits it.

### 2. Quantities remain physically distinct

`H_drive` in A/m is the canonical instantaneous regional field used by LLG.
`B_drive` is the display conversion `mu0 H_drive`. `E_drive` and `eden_drive`
are its Zeeman energy and density. `H_ant` remains the instantaneous
`SolvedAntennaDrive` field. Static `H_ext` remains a separate equilibrium term.

### 3. Stage activation and clocks are explicit

Every study stage has a stable unique `stage_id`. A regional drive activates
either for all time-evolution stages or an explicit list of stage ids. It is
not active in relax/minimize stages unless explicitly requested, and a dynamic
waveform is invalid in a minimizer.

Every waveform declares `stage_local` or `absolute` time origin. Stage-local
time is `t_abs-stage_start`; it is the default. The runtime preserves stage
start time and requested activation in plan and provenance.

### 4. Waveforms form a closed serializable catalogue

The executable catalogue is constant, sinusoidal, rectangular pulse,
piecewise-linear, and normalized sinc pulse. Raw Python/JavaScript callbacks
are not public semantics. All executable lanes use the same definitions,
boundary behavior, event times, and golden values.

Every explicit RK substage evaluates the waveform at `t_n+c_i dt`. Pulse
edges, PWL knots, stage boundaries, and output times cap steps exactly. Events
invalidate FSAL and cached RHS state.

### 5. Target and profile are distinct

Targets select global, magnetic object, or magnetic region ownership. Spatial
profiles provide uniform, analytic sinc, or a geometry predicate with an
optional envelope. A nonmagnetic geometry-mask object never becomes a magnetic
target implicitly.

### 6. Production discretization stays with its backend

FDM uses deterministic cell-volume averages. Native FEM P1 uses a lumped-L2
projection with deterministic adaptive tetrahedral quadrature. The Rust
planner resolves and validates semantic descriptors, ownership markers,
activation, capability, and periodic topology; production FEM quadrature and
basis construction belong under `backends/fem`.

Native FEM places runtime storage in the Zeeman interaction subsystem. It does
not add physics to `mfem_bridge.cpp` or loose cross-cutting state to `Context`.
The same instantaneous buffer and revision feed RHS composition, energy, and
quantity readback.

### 7. Static PBC is fail-closed

For `k=0` PBC, projected basis values must match in every periodic node class
within the documented tolerance. A mismatch fails materialization with a
diagnostic. Averaging mismatched values is forbidden. Direct nonzero Bloch
phase remains a separate Bloch/Floquet capability.

### 8. Capability and execution are explicit

Python, UI, ProblemIR, planner, runner, OpenAPI, and provenance use the same
capability vocabulary. A lane is `source_visible`, `executable`, or `validated`
only when the corresponding evidence exists. Forced unsupported execution
fails before solver start. No CPU/GPU or regional/antenna semantic fallback is
hidden; requested and resolved execution are both recorded.

### 9. Gamma and finite-k have separate qualification

One periodic cell with a compatible homogeneous drive qualifies Gamma
response. Finite-k propagation uses an open supercell/waveguide, a localized
source, absorber qualification, uniform physical probes, and `S(k,f)`.
Time-domain finite-k does not claim to replace infinite-crystal Bloch
dispersion.

## Consequences

Positive:

- public authoring states the actual physical approximation;
- waveform-only changes reuse immutable spatial bases;
- relaxation-to-dynamics transfer and clocks are reproducible;
- solver, energy, and displayed field share one runtime realization;
- PBC and unsupported lanes fail rather than change intent;
- Gamma and propagation benchmarks have physically honest claims.

Trade-offs:

- native FEM needs a versioned target/profile descriptor and production
  projection subsystem;
- exact event landing constrains adaptive steppers;
- higher-order FEM and single-precision GPU require separate future gates;
- old antenna plans and scenes require a one-way migration adapter.

## Migration

1. Deserialize the old mask and immediately normalize it to regional-drive
   semantics with `migrated_from="prescribed_zeeman_mask"`.
2. Keep old payload readers for two minor releases after canonical export is
   available.
3. Mark regional-drive clauses in the 2026-07-10 antenna plans superseded by
   this ADR; solved-antenna clauses remain unchanged.
4. Remove compatibility authoring only after repository fixtures and released
   scenes round-trip through the migration adapter.

## Validation

Acceptance requires all gates in physics note 0920 and the implementation
plan, including managed container-backed native FEM evidence, cross-language
waveform parity, projection refinement, RK order, PBC certificates, API/UI
round-trip, and separate Gamma/finite-k benchmarks.

## Rollback

Rollback disables registration and capability exposure for
`RegionalFieldDrive`. It does not reactivate `prescribed_zeeman_mask` as a new
authoring model, alias `H_drive` to `H_ant`, or classify unvalidated code as
executable.
