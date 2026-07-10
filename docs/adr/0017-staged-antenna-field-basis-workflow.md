# ADR 0017: Staged antenna field-basis workflow

- Status: proposed
- Date: 2026-07-10
- Decision makers: Fullmag core
- Governing physics: `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
- Detailed design: `docs/superpowers/specs/2026-07-10-microwave-antenna-field-basis-design.md`

## Context

Fullmag already contains an unfinished antenna API and a runner-side
`mqs_2p5d_az` approximation. The current approximation evaluates infinite
rectangular strip fields and cannot represent a CPW whose width changes along
the current-flow direction. The existing UI creates a box-backed prescribed
Zeeman mask, which is useful as a MuMax-style source but does not calculate the
field of a conductor.

The required workflow has two distinct computations:

1. solve the three-dimensional conductor current and magnetic-field basis once;
2. use that immutable basis in one or more LLG stages with different current
   waveforms.

Hiding the first computation inside the LLG runner would make cache identity,
failure, progress, requested/resolved execution, and scientific provenance
uninspectable. Conflating the conductor-backed source with a prescribed field
mask would also allow the product to claim geometry-derived fields when none
were solved.

The protected Fullmag invariants are one Python DSL, one `ProblemIR`, one
planner capability vocabulary, one resource-first OpenAPI v2 contract, one
unified workspace, and explicit requested intent versus resolved execution.

## Decision

### 1. Two source families remain physically separate

Fullmag will expose:

- `SolvedAntennaDrive`: a drive referencing a versioned field-basis artifact
  produced from three-dimensional conductor geometry;
- `RegionalFieldDrive`: a prescribed spatial magnetic field multiplied by a
  waveform, equivalent to the existing `prescribed_zeeman_mask` intent.

No planner or runtime may silently replace one family with the other.

### 2. Antenna precomputation is a first-class study stage

`StudyIR::AntennaFieldSolve` owns conductor meshing, current solve,
normalization, magnetic-field evaluation, target projection, progress,
diagnostics, and artifact publication.

Downstream `TimeEvolution` or `FrequencyResponse` stages reference a concrete
stage output. They reject missing, stale, failed, or incompatible outputs. An
LLG RHS may not start a hidden antenna solve.

### 3. The MVP field model is Tier 1 quasistatics

The first production implementation solves

```text
div(sigma grad V) = 0
J = -sigma grad V
H_1A = three-dimensional Biot-Savart(J_1A)
H_ant(r,t) = I(t) H_1A(r)
```

for explicit signal and return-current terminal groups. It is normalized to
1 A and supports multiple independent port modes.

Harmonic MQS and full-wave Maxwell are separate future capability families.
Tier 1 does not claim impedance, S-parameters, delivered-power normalization,
skin/proximity effects, propagation phase, reflection, radiation, or magnetic
backreaction.

### 4. FEM owns the field solve; FDM and FEM consume the result

The first production field solve belongs under `backends/fem` and uses the
MFEM/hypre CPU lane. The first magnetic-field realization is adaptive 3D
Biot-Savart target evaluation, avoiding a mandatory airbox solve.

FDM and FEM time-domain backends consume the same backend-neutral field-basis
artifact through separate target projections and runtime realizations. An FEM
precompute followed by an FDM LLG run is explicit cross-discretization state
transfer with provenance, not an implicit hybrid backend.

The Rust runner owns orchestration, ABI calls, cache, artifacts, and
provenance. Production field-solve numerics do not remain in
`crates/fullmag-runner/src/antenna_fields.rs`.

### 5. Cache and staleness exclude waveform state

The artifact separates:

- `current_solution_signature`;
- `field_solution_signature`;
- `target_projection_signature`.

Geometry, conductivity, ports, conductor mesh, field sampling, or target
topology invalidate the corresponding signatures. Peak current and waveform
do not invalidate the spatial solve. Equilibrium magnetization invalidates only
derived transverse-field and source-spectrum products.

### 6. `H_ant` remains the canonical applied antenna field

ADR 0004's `H_ant` id and A/m unit remain unchanged. The UI may display
`mu0 * H_ant` in T or mT, but it must not overload `B_ext` or rename the stored
quantity. Solved current density and electric potential use separate
conductor-domain resources.

### 7. OpenAPI v2 and the unified workspace expose the same lifecycle

The stage appears in `simulation/stages/execution`. Solution manifests live in
the `data` family; field vectors, slices, and projections use the binary data
plane. Analysis products live in the `analysis` family. HTTP v2 remains the
source of truth and websocket messages only invalidate changed resources or
report command lifecycle.

The control room keeps one Explorer, Inspector, ribbon, command registry, and
viewport tree for FDM and FEM. A dedicated active-only `field-map` center
surface displays heatmaps, contours, slices, projections, and probes. It does
not create a second application shell or keep the 3D WebGL viewport mounted in
the background.

## Consequences

### Positive

- A constricted or tapered CPW changes the solved current and source k-spectrum.
- Expensive spatial precomputation is reused across many waveforms and LLG runs.
- Failures, stale state, backend resolution, current balance, and convergence
  are inspectable.
- The same source artifact can drive FDM and FEM with explicit projection
  provenance.
- A future harmonic/full-wave solver can produce a different artifact
  realization without redefining the LLG source contract.

### Negative

- Tier 1 requires a conductor mesh and terminal authoring even when downstream
  LLG uses FDM.
- Biot-Savart target evaluation can be expensive without later hierarchical or
  GPU acceleration.
- The field-basis artifact and target projections require new storage,
  revision, and cache lifecycle.
- Users must understand that one static spatial basis is an approximation over
  a waveform bandwidth.

### Neutral

- `RegionalFieldDrive` remains the fastest path for authored masks and FMR.
- The existing `mqs_2p5d_az` payload remains readable during migration but is
  isolated as `legacy_infinite_strip_biot_savart` provenance and is not offered
  by new UI commands.

## Implementation obligations

1. Complete the physics and validation gates in note 0950 before promoting a
   lane.
2. Add typed Python and `ProblemIR` contracts for layouts, width stations,
   port modes, field-solve stages, solution references, and the two drive
   families.
3. Add planner capability decisions for field solve and drive consumption
   separately.
4. Add `antenna_field_solution.v1` manifests with heavy binary child resources.
5. Add native FEM CPU workflow ownership under `backends/fem`, then separate
   FDM/FEM CPU/GPU consumption paths.
6. Preserve requested/resolved field-solve and downstream execution records.
7. Add OpenAPI v2 resources, generated transport/types, `ControlRoomApi`,
   resource hooks, codecs, and domain adapters together.
8. Add dedicated Explorer/Inspector nodes for layout, conductors, ports, field
   solve, drive, solution, and provenance.
9. Add active-only field-map and analysis surfaces with bounded data and
   explicit teardown.
10. Add analytical, convergence, parity, API, round-trip, lifecycle, and
    publication-aligned spin-wave benchmarks.

## Migration and removal plan

1. Deserialize old antenna payloads without `model` as the current compatibility
   model only; emit a migration diagnostic.
2. Rename its resolved provenance to `legacy_infinite_strip_biot_savart`.
3. Keep old constant-width `MicrostripAntenna` and `CPWAntenna` constructors as
   adapters to endpoint width stations.
4. Migrate `prescribed_zeeman_mask` to the canonical regional-drive model while
   preserving script and scene round-trip.
5. Remove the legacy solver from public authoring after two consecutive minor
   releases can read old scenes and export the canonical replacement.
6. Remove runner-side production antenna numerics once the native field-solve
   workflow and compatibility conversion are both covered by regression tests.

Rollback disables registration/capability of `AntennaFieldSolve` and
`SolvedAntennaDrive` while retaining read-only artifact inspection and the
independent `RegionalFieldDrive`. Rollback must not route solved sources to a
prescribed mask.

## Validation

- IR and Python round-trip tests cover variable-width CPW and legacy payloads.
- Planner tests cover stage ordering, missing/stale solutions, forced-lane
  rejection, and requested/resolved provenance.
- Native FEM tests cover H1 conduction, terminal balance, mesh convergence,
  and adaptive Biot-Savart evaluation.
- FDM/FEM CPU/GPU tests cover field-basis consumption and waveform parity.
- Managed native FEM runtime evidence uses container-backed `just` recipes.
- API tests cover resource ownership, OpenAPI generation, ETag/304, command
  lifecycle, binary corruption, and invalidation scope.
- UI tests cover every Explorer-to-Inspector mapping, layout/port validation,
  staleness reasons, field-map lifecycle, and script export.
- Browser smoke proves active-only center surfaces and a healthy 3D WebGL
  context when the 3D surface is selected.
