# 03 - Artifacts, Resources, Runtime, Provenance

## Current State

Current artifact contract:

- `docs/specs/frequency-domain-artifacts-v2.md` documents eigen spectrum, branches, dispersion, and response sweep artifacts.
- `crates/fullmag-runner/src/dispatch.rs` writes v2 eigen artifacts for path eigensolves.
- `crates/fullmag-runner/src/fem_eigen.rs` writes legacy spectrum and mode artifacts.
- `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs` serves current eigen artifacts from the active workspace artifact directory.
- `crates/fullmag-api/src/router_v2/handlers/analysis/response.rs` serves a magnetic response sweep artifact if one exists.

Current runtime limitations:

- Frequency-domain result discovery is endpoint-by-endpoint, not manifest-driven.
- The UI cannot discover all available modes, branches, response observables, field payloads, and diagnostics from one resource.
- Mode metadata and mode vector payload ownership are not separated enough for scalable 3D visualization.
- Frequency response has an API endpoint but no executable solver-created artifact in the standard path.
- There is no realtime invalidation family specifically for frequency-domain analysis artifacts.

## Target State

Frequency-domain results must behave like versioned runtime resources:

- A run creates a manifest indexing every frequency-domain artifact.
- Spectrum, branches, dispersion, modes, response sweeps, frequency points, diagnostics, and field payloads are discoverable.
- Heavy mode and response fields are exposed through the data plane as field-like resources.
- JSON artifacts carry metadata, small summaries, provenance, diagnostics, and links.
- Realtime invalidation tells the UI when manifest, spectrum, mode table, response sweep, diagnostics, or field payload revisions changed.
- Every result references requested intent and resolved execution reality.

## Canonical Artifact Set

Eigen artifacts:

```text
eigen/spectrum.v2.json
eigen/branches.v2.json
eigen/dispersion.csv
eigen/diagnostics.v2.json
eigen/modes/sample_0000/mode_0000.json
eigen/modes/sample_0000/mode_0001.json
eigen/modes/sample_0001/mode_0000.json
eigen/mode_fields/sample_0000/mode_0000/vector.bin
```

Driven-response artifacts:

```text
response/magnetic_response_sweep.v1.json
response/magnetic_response_sweep.v2.json
response/frequency_points/frequency_0000.json
response/frequency_points/frequency_0001.json
response/field_payloads/frequency_0000/vector.bin
response/diagnostics.v1.json
```

Version sequence:

- `response/magnetic_response_sweep.v1.json` remains the first executable driven-response artifact because the current API and facade can already expose it.
- `response/magnetic_response_sweep.v2.json` is added only after response field payloads, frequency-point metadata, or manifest links require a schema bump.
- Consumers must prefer v2 when it is present and fall back to v1 with a degraded/provenance badge.
- Producers must not silently change v1 semantics to carry v2-only fields.

Manifest:

```text
frequency_domain/manifest.v1.json
```

Legacy artifacts to keep until UI migration is complete:

```text
eigen/spectrum.json
eigen/modes/mode_0000.json
eigen/metadata/eigen_summary.json
eigen/branches.json
eigen/dispersion/branch_table.csv
eigen/dispersion/path.json
```

## Manifest Schema

The manifest must be the UI entrypoint for frequency-domain results.

Required top-level fields:

```json
{
  "schema_version": "frequency_domain_manifest.v1",
  "revision": "string",
  "session_id": "string",
  "run_id": "string",
  "stage_id": "string",
  "stage_kind": "eigenmodes | frequency_response | combined",
  "created_at": "ISO-8601",
  "requested_execution": {},
  "resolved_execution": {},
  "physics": {},
  "artifacts": {},
  "resources": {},
  "diagnostics": {},
  "capabilities": {}
}
```

`stage_kind="combined"` means one run produced both modal eigen artifacts and driven response artifacts, either because two stages ran in one command batch or because a workflow such as FMR intentionally records modal and response products together. It must not mean one solver produced both result families.

Required `requested_execution` fields:

- `calculation_mode`
- `backend`
- `device`
- `precision`
- `execution_mode`
- `ui_mode`
- `operator`
- `include_demag`
- `damping_policy`
- `equilibrium_source`
- `k_sampling`
- `outputs`

Required `resolved_execution` fields:

- `backend`
- `device`
- `precision`
- `engine`
- `native_backend`
- `reference_or_production`
- `container_image`
- `build_features`
- `demag_realization`
- `solver_library`
- `solver_algorithm`

Required `physics` fields:

- `analysis_family`
- `llg_gamma0_si`
- `llg_alpha`
- `phase_convention`
- `frequency_units`
- `field_units`
- `normalization`
- `spin_wave_bc`
- `periodic_or_floquet`
- `equilibrium_residual_summary`
- `fmr_reference_model` when the calculation mode is FMR
- `k_path_summary` when the calculation mode is dispersion
- `response_map_axes` when the calculation mode is response map

Required `artifacts` fields:

- `spectrum_v2_path`
- `branches_v2_path`
- `dispersion_csv_path`
- `eigen_diagnostics_v2_path`
- `response_sweep_v1_path`
- `response_sweep_v2_path`
- `response_diagnostics_v1_path`
- `response_progress_v1_path`
- `mode_metadata_paths`
- `frequency_point_paths`

Required `diagnostics` additions for k = 0 static-periodic driven response:

- `static_periodic_projection`
- `static_periodic_node_pair_count`
- `static_periodic_frame_max_mismatch`
- `static_periodic_drive_max_mismatch`

When `static_periodic_projection=true`, `static_periodic_node_pair_count` must
be positive and both mismatch diagnostics must be finite and below the runtime
artifact verifier tolerance. These fields describe zero-phase static periodic
projection only; they do not imply nonzero-k Floquet/Bloch support.

Required `resources` fields:

- `spectrum_resource_key`
- `branches_resource_key`
- `dispersion_resource_key`
- `eigen_diagnostics_resource_key`
- `response_sweep_resource_key`
- `response_progress_resource_key`
- `response_diagnostics_resource_key`
- `mode_field_resources`
- `response_field_resources`

## Mode Metadata Schema

Mode JSON must be small enough for inspector use and must not carry large vector arrays.

Required fields:

- `schema_version`
- `revision`
- `sample_index`
- `sample_label`
- `raw_mode_index`
- `branch_id`
- `mode_id`
- `frequency_hz`
- `omega_rad_s`
- `imag_frequency_hz`
- `damping_rate_hz`
- `k_vector`
- `path_s`
- `normalization`
- `phase_convention`
- `mode_field_id`
- `mode_field_resource_key`
- `amplitude_summary`
- `component_summary`
- `localization_summary`
- `diagnostics`
- `provenance`

Diagnostics inside each mode:

- `residual_norm`
- `relative_residual_norm`
- `orthogonality_score`
- `tangent_leakage_max`
- `tangent_leakage_rms`
- `normalization_error`
- `converged`
- `iteration_count`

## Mode Field Resource Contract

Mode and response fields must be field-like resources.

Resource registration:

```json
{
  "field_id": "analysis:eigen:stage-1:sample-0000:mode-0003",
  "source_family": "analysis/eigen",
  "quantity": "delta_m",
  "value_kind": "complex_vector",
  "domain_id": "mesh-or-domain-id",
  "mesh_scope": "magnetic",
  "components": ["x", "y", "z"],
  "available_views": ["real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
  "resource_key": "/v2/sessions/current/data/fields/analysis:eigen:stage-1:sample-0000:mode-0003/samples/vector"
}
```

The binary payload must support query parameters:

- `view=real`
- `view=imag`
- `view=abs`
- `view=amplitude`
- `view=phase`
- `view=phase_rotated_real`
- `phase_rad=number`
- `component=x|y|z|norm|vector`
- `scope_kind=object|region|mesh_part|full`
- `scope_id=string`
- `sample_index=0` for compatibility with the field data resource shape

Rules:

- The API may compute `phase_rotated_real` server-side or send complex components with a documented binary layout.
- When the backend or resource layer exposes client-side modal animation data,
  the resource metadata must declare the complex storage layout explicitly:
  `real_imag` or `amplitude_phase`. `amplitude_phase` means every vector
  component carries magnitude and phase in radians, sufficient for the
  inspector/viewport to reconstruct
  `Re(amplitude * exp(i * (modePhaseRad + visualizationPhaseRad)))` without
  re-running the solver.
- The selected mode inspector must treat `amplitude_phase` as a first-class
  layout for animation, not as a lossy derived scalar view. The user-facing
  `amplitude` and `phase` views remain static display modes; only
  `phase_rotated_real` consumes `visualizationPhaseRad`.
- `abs` and `amplitude` are accepted aliases for complex-vector magnitude. The UI may label the user-facing control as amplitude, but the resource API must accept both values.
- The viewport must know the layout from resource metadata, not from hardcoded mode assumptions.
- Resource keys must include enough query state to avoid stale cache collisions.
- The field resource must carry revision information tied to the manifest revision and mode payload revision.

## Runtime Events

Current state:

- Control Room already has realtime invalidation infrastructure for resources.
- Frequency-domain artifacts do not have a dedicated invalidation vocabulary.

Target event families:

```text
analysis.frequency_domain.manifest.updated
analysis.eigen.spectrum.updated
analysis.eigen.branches.updated
analysis.eigen.dispersion.updated
analysis.eigen.mode.updated
analysis.eigen.diagnostics.updated
analysis.frequency_response.sweep.updated
analysis.frequency_response.frequency_point.updated
data.field.analysis_mode.updated
```

Instructions:

1. Emit `manifest.updated` whenever any frequency-domain result set is created, replaced, or deleted.
2. Emit specific artifact events for incremental updates during long k-path or long sweep runs.
3. Include resource keys and revisions in event payloads.
4. Keep event payloads thin; do not embed spectrum rows or mode arrays in realtime events.
5. Ensure late subscribers can recover by fetching the manifest.

Verification:

- Realtime invalidation tests update resource revisions after artifact writes.
- UI hook tests simulate invalidation and refetch only affected resources.

## Long-Running Sweep Progress And Cancellation

Driven response sweeps and k-path modal runs may run for many frequency or k samples. They need an explicit operational contract before production use.

Progress contract:

- The command status reports total work units and completed work units.
- Modal k-path work units are k samples.
- Driven sweep work units are frequency points.
- Future response-map work units are `(k_sample, frequency_point)` pairs.
- Each completed work unit may update a partial artifact and emit a targeted resource invalidation.
- Partial artifacts must carry `complete=false` until the full run finishes.

Cancellation contract:

- UI stop/cancel command propagates through command queue, Rust runner, and native backend.
- Native backend polls an interrupt token between frequency points, k samples, and long iterative solver iterations where feasible.
- Cancellation maps to native FFI status `interrupted`.
- Interrupted runs preserve completed partial artifacts but mark manifest and diagnostics as interrupted.
- UI must show interrupted state, completed point count, and whether partial artifacts are usable.

Partial artifact rules:

- Write each frequency-point metadata file atomically.
- Update `response/magnetic_response_sweep.v1.json` or v2 summary only after the point file is durable.
- Update manifest revision after every durable partial result.
- Never expose a partially written JSON file as a successful resource.

Verification:

- Unit test cancellation before first point.
- Unit test cancellation after N frequency points.
- Resource hook test shows partial sweep with `complete=false`.
- Browser smoke can cancel a long fixture and still inspect completed points.

## Runtime Command Model

Required commands:

```text
study.add-eigenmodes-stage
study.add-frequency-response-stage
study.run-frequency-domain-stage
analysis.eigen.open-spectrum
analysis.eigen.open-dispersion
analysis.eigen.select-mode
analysis.eigen.plot-mode-3d
analysis.eigen.set-mode-3d-phase
analysis.eigen.set-mode-3d-animation
analysis.eigen.clear-mode-3d
analysis.frequency-domain.clear-3d-overlay
analysis.frequency-response.open-sweep
analysis.frequency-response.select-frequency-point
analysis.frequency-response.plot-response-field-3d
analysis.frequency-domain.export-artifacts
```

Command rules:

- Stage-run commands submit solver work.
- Analysis open/select/plot commands are UI commands and must not trigger solver recomputation.
- Plotting a mode in 3D changes visualization state to use the mode field resource.
- Setting mode 3D phase updates only the active overlay
  `visualizationPhaseRad` for the currently displayed mode; it does not mutate
  the physical mode phase in the complex eigenvector or metadata.
- Setting mode 3D animation toggles visualization-only phase animation and records `animationRateHz`; it must not mutate artifacts or enqueue solver work.
- `analysis.eigen.clear-mode-3d` clears only the active eigen-mode overlay.
- `analysis.frequency-domain.clear-3d-overlay` clears any active frequency-domain overlay, including eigen-mode and driven-response field overlays.
- Clearing an overlay releases the visualization target and resource subscription.
- Export commands copy or package existing artifacts only.

## Provenance Contract

Every frequency-domain artifact must include:

- Python DSL source hash if available.
- ProblemIR hash.
- Plan hash.
- Mesh asset ID and generation ID.
- Equilibrium source and artifact hash.
- Requested backend/device/precision.
- Resolved backend/device/precision.
- Solver engine.
- Native library versions where available.
- Container image or build fingerprint.
- Demag realization.
- Boundary condition realization.
- Phase convention.
- Damping policy.
- Normalization.
- Capability snapshot.
- Validation status.

Rules:

- Requested `auto` values must not disappear after resolution.
- Explicit GPU request must be visible even if it fails.
- Reference solver results must say `reference`, not `production`.
- Dense GPU helper results must say `dense_reference` unless the backend team formally promotes them.

## Testing Plan

Backend artifact tests:

- Eigen single-k run writes manifest, spectrum, at least one mode metadata file, diagnostics, and mode field registration.
- Eigen k-path run writes manifest, spectrum, branches, dispersion, mode metadata for selected samples, and branch tracking diagnostics.
- Frequency response run writes manifest, sweep, frequency point metadata, response diagnostics, and response field registration.
- Unsupported paths write failure diagnostics only when a run artifact directory exists; they must not write fake successful spectra.

API tests:

- Manifest endpoint returns 404 before any result exists.
- Manifest endpoint returns eigen-only manifest.
- Manifest endpoint returns response-only manifest.
- Manifest endpoint returns combined manifest.
- Mode metadata endpoint returns no large vector arrays.
- Field vector endpoint returns binary content type and stable cache headers.

Frontend resource tests:

- Manifest hook handles missing resource as `null`.
- Spectrum hook refetches on `analysis.eigen.spectrum.updated`.
- Mode hook uses sample and raw mode index in the resource key.
- Mode field hook changes key when phase changes.
- Mode animation hook advances only the active overlay phase and stops on overlay clear, selected mode change, missing mode-field resource, and inspector unmount.
- Response sweep hook does not refetch when unrelated mesh resources update.

## Acceptance Gate

This layer is complete only when:

- UI can discover frequency-domain results from the manifest without hardcoded artifact guesses.
- Mode metadata and mode vector data are separated.
- Existing v2 eigen endpoints continue to work.
- Frequency response artifacts are solver-created for supported paths.
- Realtime invalidation can update charts and 3D overlays without status polling.
