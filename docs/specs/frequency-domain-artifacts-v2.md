# Frequency-domain artifacts v2

Status: reference contract
Applies to: FEM eigen, dispersion, Analyze UI, v2 API resources

## Purpose

Frequency-domain artifacts must carry enough semantic information for the
frontend, Python post-processing, and regression tests to use them without
guessing file layout or reconstructing physics from labels.

The canonical artifact family is:

```text
artifacts/frequency_domain/manifest.v1.json
artifacts/eigen/diagnostics/solver.v1.json
artifacts/eigen/spectrum.v2.json
artifacts/eigen/branches.v2.json
artifacts/eigen/dispersion.csv
artifacts/eigen/modes/sample_XXXX/mode_YYYY.json
artifacts/eigen/mode_fields.zarr/
artifacts/response/diagnostics/solver.v1.json
artifacts/response/magnetic_response_sweep.v1.json
artifacts/response/magnetic_response_sweep.v2.json
artifacts/response/field_payloads.zarr/
artifacts/mesh/periodic_pairs.v1.json
```

## Storage format policy

JSON is the control-plane format only. Frequency-domain JSON artifacts may
carry schema versions, small summaries, provenance, diagnostics, resource
keys, and links, but must not become the default storage format for large
numerical arrays.

The default heavy-data format for new frequency-domain artifacts is a Zarr
directory store:

- modal mode fields: `eigen/mode_fields.zarr`,
- driven response field payloads: `response/field_payloads.zarr`,
- future dense response maps over `(k, f, component)`,
- future multi-mode amplitude/phase tensors.

HDF5/H5 is an allowed alternate backend or export format when the runtime
environment already provides an HDF5 stack and the API can expose the same
resource semantics. HDF5/H5 must not change the public resource identity:
Control Room consumes named v2 resources and data-plane field endpoints, not
backend-specific file paths.

Raw `*.bin` payloads and JSON-heavy payloads are compatibility formats. New
writers may keep them for migration tests, small smoke fixtures, or
backward-compatible readers. Production-size mode fields and response fields
should be written to Zarr by default, with compression enabled for chunked
floating-point arrays.

Legacy artifacts may remain readable, but new dispersion UI and API surfaces
must prefer the v2 family.

## spectrum.v2.json

Required fields:

- `schema_version = "eigen_spectrum.v2"`,
- `solver_model`,
- `sample_count`,
- `samples[]`.

Each sample must include:

- `sample_index`,
- `label` when the sample is a high-symmetry point,
- `k_vector` in `rad/m`,
- `path_s` in `rad/m`,
- `segment_index`,
- `t_in_segment`,
- `modes[]`.

Each mode summary must include:

- `raw_mode_index`,
- optional `branch_id`,
- `mode_field_id`,
- `mode_field_resource_key`,
- `frequency_real_hz`,
- `frequency_imag_hz`,
- `angular_frequency_rad_per_s`,
- `omega_rad_s`,
- eigenvalue real and imaginary components,
- `norm`,
- `max_amplitude`,
- `residual_norm`,
- `residual_absolute_l2`,
- `residual_relative_l2`,
- `residual_linf`,
- `mass_norm`,
- `tangent_leakage_mean_abs`,
- `tangent_leakage_max_abs`,
- `gamma_rad_s_T`,
- `gamma0_rad_s_per_A_m`,
- `mu0_T_m_per_A`,
- `dominant_polarization`,
- `k_vector`.

## branches.v2.json

Required fields:

- `schema_version = "eigen_branches.v2"`,
- `solver_model`,
- `branches[]`.

Each branch must include:

- `branch_id`,
- optional `label`,
- `points[]`.

Each point must include:

- `sample_index`,
- `raw_mode_index`,
- `frequency_real_hz`,
- `frequency_imag_hz`,
- `tracking_confidence`,
- optional `overlap_prev`.

Branch identity must be tracked by modal overlap or a stricter future tracking
method. It must not be inferred only from sorted frequency order.

## dispersion.csv

The CSV header must include:

```text
sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score
```

`branch_id` may be empty only when no branch tracking artifact exists.
`residual_norm` may be empty only for solver paths that explicitly report the
diagnostic as unavailable.

## modes/sample_XXXX/mode_YYYY.json

Required fields:

- `schema_version`,
- `solver_model`,
- `sample_index`,
- `raw_mode_index`,
- optional `branch_id`,
- `frequency_real_hz`,
- `frequency_imag_hz`,
- `angular_frequency_rad_per_s`,
- `omega_rad_s`,
- `normalization`,
- `damping_policy`,
- `mode_field_id`,
- `mode_field_resource_key`,
- `residual_norm`,
- `residual_absolute_l2`,
- `residual_relative_l2`,
- `residual_linf`,
- `mass_norm`,
- `tangent_leakage_mean_abs`,
- `tangent_leakage_max_abs`,
- `gamma_rad_s_T`,
- `gamma0_rad_s_per_A_m`,
- `mu0_T_m_per_A`,
- `k_vector`,
- `mode_field_sample_count`,
- `amplitude_summary`,
- `component_summary`.

Mode metadata must not inline large vector arrays such as `real`, `imag`,
`amplitude`, or `phase`. Reconstructed physical vectors live in
`eigen/mode_fields.zarr` by default and are exposed through the data-plane
field resource referenced by `mode_field_resource_key`.

The canonical Zarr group layout for modal fields is:

```text
eigen/mode_fields.zarr/
  sample_XXXX/
    mode_YYYY/
      vector_xyz_complex
```

`vector_xyz_complex` stores chunked floating-point values with logical shape
`[node, component, complex]`, where `component = x|y|z` and
`complex = real|imag`. The preferred dtype is `float64` for production
validation and `float32` only when the run provenance explicitly records a
qualified single-precision execution. The array must be compressed by the Zarr
codec configured for the runtime. If a compatibility `vector.bin` file exists,
it is a derived/export payload, not the authoritative production store.

`residual_norm` is the legacy alias for `residual_absolute_l2`. The dense
oracle path must also emit:

- `residual_relative_l2 = ||K u - lambda M u||_2 / (||K u||_2 + |lambda| ||M u||_2)`,
- `mass_norm = u^T M u`,
- `omega_rad_s = 2*pi*frequency_hz`,
- SI constants `gamma_rad_s_T`, `gamma0_rad_s_per_A_m`, and `mu0_T_m_per_A`,
  where `gamma0_rad_s_per_A_m = mu0_T_m_per_A * gamma_rad_s_T`.

Tangent leakage diagnostics are the mean and max absolute `m0 dot dm` over the
exported real and imaginary mode vectors, and must be emitted whenever the
solver reconstructs physical mode vectors.

## eigen/metadata/eigen_summary.json

The dense reference oracle summary must include:

- `solver_diagnostics.dense_reference_oracle`,
- `solver_diagnostics.constants.{gamma_rad_s_T,gamma0_rad_s_per_A_m,mu0_T_m_per_A}`,
- `solver_diagnostics.orthogonality[]` with
  `lhs_mode_index`, `rhs_mode_index`, and `mass_inner_product`.

## frequency_domain/manifest.v1.json

The manifest is the entry point for UI and post-processing discovery. Modal
eigen manifests must include:

- `schema_version = "frequency_domain_manifest.v1"`,
- `analysis_family = "magnetic_frequency_domain"`,
- `study_product = "modal_eigen"`,
- `stage_kind = "eigenmodes"`,
- `physics.analysis_family = "magnetic_frequency_domain"`,
- `physics.phase_convention` as either `exp_i_omega_t` or
  `exp_minus_i_omega_t`,
- `physics.frequency_units = "Hz"`,
- `physics.field_units = "dimensionless_delta_m"`,
- `physics.normalization`,
- `artifacts.spectrum_v2_path = "eigen/spectrum.v2.json"`,
- `artifacts.branches_v2_path = "eigen/branches.v2.json"`,
- `artifacts.dispersion_csv_path = "eigen/dispersion.csv"`,
- `artifacts.solver_diagnostics_path = "eigen/diagnostics/solver.v1.json"`,
- `artifacts.mode_metadata_paths[]`,
- `resources.mode_field_resources[]`.

Driven response manifests must include:

- `schema_version = "frequency_domain_manifest.v1"`,
- `analysis_family = "magnetic_frequency_domain"`,
- `study_product = "driven_response"`,
- `stage_kind = "frequency_response"`,
- `physics.analysis_family = "magnetic_frequency_domain"`,
- `physics.phase_convention`,
- `physics.frequency_units = "Hz"`,
- `physics.field_units = "dimensionless_delta_m"`,
- `artifacts.solver_diagnostics_path = "response/diagnostics/solver.v1.json"`.

The manifest must always distinguish the two study products with
`study_product = "modal_eigen"` or `study_product = "driven_response"`.
UI labels must use `Eigenmodes` for `modal_eigen` and `Frequency Response` for
`driven_response`; clients must not collapse them into one generic
"frequency-domain solver" label.

Reference modal manifest:

```json
{
  "schema_version": "frequency_domain_manifest.v1",
  "analysis_family": "magnetic_frequency_domain",
  "study_product": "modal_eigen",
  "stage_kind": "eigenmodes",
  "phase_convention": "exp_i_omega_t",
  "frequency_units": "Hz",
  "field_units": "dimensionless_delta_m"
}
```

Reference driven manifest:

```json
{
  "schema_version": "frequency_domain_manifest.v1",
  "analysis_family": "magnetic_frequency_domain",
  "study_product": "driven_response",
  "stage_kind": "frequency_response",
  "phase_convention": "exp_i_omega_t",
  "frequency_units": "Hz",
  "field_units": "dimensionless_delta_m"
}
```

## eigen/diagnostics/solver.v1.json

Modal solver diagnostics live at `eigen/diagnostics/solver.v1.json` and must
describe the modal `modal_eigen` solve only.

When the modal target is `frequency_window`, solver diagnostics must also
publish the resolved window search contract:

- `requested_window_hz = [frequency_min_hz, frequency_max_hz]`,
- `resolved_search_window_hz = [min_guarded_hz, max_guarded_hz]`,
- `window_completeness.{policy,status,certification_method,additional_modes_may_exist}`,
- `subwindows[]` with requested/search bounds, shift, iteration totals,
  candidate/accepted counts, residual max, and a modal `stop_reason`.

The allowed completeness policies are `best_effort` and `certified_count`.
The allowed statuses are `not_certified`, `certified`,
`partial_convergence`, `truncated_by_requested_count`, and
`window_exhausted`. Subwindow stop reasons must use the modal solver vocabulary
(`converged`, `window_exhausted`, `partial_convergence`, `max_iterations`,
`linear_solve_failed`, `residual_not_met`, `cancelled`,
`capability_missing`, or `operator_invalid`), never a generic `completed`.

## response/diagnostics/solver.v1.json

Driven solver diagnostics live at `response/diagnostics/solver.v1.json` and
must describe the driven `driven_response` solve only.

## response/magnetic_response_sweep.v1.json

This artifact is the driven magnetic-only response sweep contract. The current
runner writer can emit it for dense field-driven validation payloads, and the v2
API can expose an already-written artifact at
`GET /v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1`. The
Control Room client entry point is the generated path literal plus
`ControlRoomApi.analysis.frequencyResponse.magneticSweepV1()` facade, with
`useMagneticResponseSweepResource()` as the optional artifact resource hook for
analysis surfaces; consumers should not duplicate the route string. Runtime execution remains gated until an
executable response backend is validated. Missing optional response artifacts
must return diagnostic 404 responses; clients must not synthesize empty response
curves as success.

Required fields:

- `schema_version = "magnetic_response_sweep.v1"`,
- `backend_engine_id`,
- `solver_model`,
- `damping_policy`,
- `lane_classification`,
- `matrix_layout`,
- `excitation_kind`,
- `si_units`,
- `point_count`,
- `points[]`.

Each point must include:

- `frequency_hz`,
- `angular_frequency_rad_per_s`,
- `m_complex` as `[re, im]` pairs,
- `response_amplitude`,
- `response_phase`,
- `component_response_amplitude`,
- `component_response_phase`,
- `susceptibility_tensor` as `[re, im]` pairs,
- `susceptibility_tensor_provenance`, including whether the value is a full
  tensor or a drive-projected scalar response,
- `absorbed_power_density`,
- `absorbed_power_density_provenance`,
- `residual_l2_norm`,
- `relative_residual_l2_norm`,
- `tangent_leakage` diagnostic status,
- `excitation_provenance`,
- `sweep_reuse` provenance.

`excitation_provenance` must include `kind` and `phase_rad`. For the public
`FrequencyResponse` contract, `phase_rad` is the global harmonic drive phasor
phase applied to the real excitation field vector before solving
`(i omega B - L) q = f`.

`sweep_reuse` must include `operator_template_reused`. The first point may set
`warm_start = null`. Later points may report
`warm_start.kind = "previous_frequency_response"` and
`source_frequency_rad_per_s`; warm-start residual fields are optional and may be
`null` when the backend does not expose a separate warm-start residual
diagnostic.

## response/magnetic_response_sweep.v2.json

This artifact is the resource-first driven-response sweep contract used by the
Control Room for charts, frequency-point inspectors, and 3D response-field
selection. It may be produced by the dense validation runner or by the native
MFEM production writer, but both producers must expose the same navigation
shape.

Required fields:

- `schema_version = "magnetic_response_sweep.v2"`,
- `solve_kind = "direct_harmonic_response"`,
- `complete`,
- `completed_frequency_point_count`,
- `frequency_point_artifact_paths[]`,
- `response_field_payload_paths[]`,
- `points[]`.

`frequency_point_artifact_paths.length` and
`response_field_payload_paths.length` must equal
`completed_frequency_point_count`. Every listed path is relative to the run
artifact root and must resolve to an existing artifact when the sweep is marked
complete. The first entries must follow the canonical layout:

```text
response/frequency_points/frequency_0000.json
response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0
```

`point_count` is the number of published point rows and must equal
`completed_frequency_point_count`. The full requested sweep size belongs to
`response/progress.v1.json.total_frequency_points`, so interrupted runs can
publish `point_count < total_frequency_points`.

Each point should include:

- `frequency_index`,
- `frequency_hz`,
- `angular_frequency_rad_per_s`,
- `max_response_amplitude` or `response_amplitude`,
- `phase_rad`,
- `absorbed_power_density`,
- `relative_residual_l2_norm`,
- `excitation_provenance`,
- `sweep_reuse`,
- `response_field_payload_path`,
- `frequency_point_artifact_path`,
- `response_tangent_field_payload_path` when the point artifact declares
  `tangent_field_payload_path`.

When `response_tangent_field_payload_path` is present, it must equal the
`tangent_field_payload_path` declared by the corresponding
`response/frequency_points/frequency_XXXX.json` artifact. It is a diagnostic
raw tangent-frame payload reference, not the canonical 3D visualization payload.

Native writers may omit per-point `frequency_index` when `points[]` order is
identical to the top-level path arrays. In that case consumers must derive the
frequency index from the point row index. Consumers must not infer field payload
identity from display labels.

`phase_rad` is the scalar charting phase for the selected or dominant response
component at the frequency point. `response_phase` is the scalar phase paired
with the dominant or maximum-amplitude component. Full per-component phases
must be carried by `component_response_phase[]` and the complex field payloads.

## response solver diagnostics fields

This artifact records driven-response solver diagnostics. Native FEM production
writers must include the matrix-free/GMRES diagnostics used to distinguish the
production CPU slice from dense validation artifacts.

`response/diagnostics.v1.json` is a compatibility export only. New manifests
must reference `response/diagnostics/solver.v1.json` through
`artifacts.solver_diagnostics_path`, and clients must treat the nested solver
diagnostics path as canonical.

Required fields for native FEM production response diagnostics:

- `schema_version = "frequency_domain_response_diagnostics.v1"`,
- `status`,
- `complete`,
- `assembled_mfem_operator_solver = false`,
- `dense_block_real_solver = false`,
- `matrix_free_solver = true`,
- `krylov_solver = "gmres"`,
- `completed_frequency_point_count`,
- `max_abs_response`,
- `residual_l2_norm`,
- `relative_residual_l2_norm`.

When the response uses k = 0 static-periodic boundary conditions, diagnostics
must also include:

- `static_periodic_projection = true`,
- `static_periodic_node_pair_count`,
- `static_periodic_frame_max_mismatch`,
- `static_periodic_drive_max_mismatch`.

`static_periodic_node_pair_count` must be positive when
`static_periodic_projection` is true. Frame and drive mismatch diagnostics must
be finite non-negative SI-free residuals; production smoke artifacts should keep
both below the verifier tolerance used by
`scripts/verify_fem_frequency_domain_runtime_artifacts.py`.

For non-periodic response runs, writers may either omit the `static_periodic_*`
fields or set `static_periodic_projection = false` with zero pair count and
finite zero mismatches. Consumers must not interpret these fields as nonzero-k
Floquet/Bloch support.

## response/cancel_requested.v1.json

This artifact records the moment a driven-response sweep observed a cancellation
request. It is distinct from the final interrupted `response/progress.v1.json`
so the UI can explain that a user/runtime stop request was seen before the
solver wrote its final partial bundle.

Interrupted response sweeps must write this artifact. Completed, unavailable,
or never-started response sweeps may omit it.

Required fields:

- `schema_version = "frequency_domain_sweep_progress.v1"`,
- `status = "cancel_requested"`,
- `state = "cancel_requested"`,
- `complete = false`,
- `total_frequency_points`,
- `completed_frequency_points`,
- `written_frequency_point_artifacts`,
- `partial_artifacts_available`.

`completed_frequency_points`, `written_frequency_point_artifacts`, and
`partial_artifacts_available` must match the final interrupted
`response/progress.v1.json` checkpoint. The API resource is
`/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1`,
while the artifact path on disk is `response/cancel_requested.v1.json`.

`frequency_domain/manifest.v1.json` links this artifact explicitly:

- `artifacts.response_cancel_requested_v1_path =
  "response/cancel_requested.v1.json"` for interrupted response sweeps,
- `resources.response_cancel_requested_resource_key =
  "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1"`
  for interrupted response sweeps.

Both manifest fields are `null` for completed and unavailable response sweeps.

## response/frequency_points/frequency_XXXX.json

This artifact is the per-frequency response point descriptor. It is the source
of truth for binary response-field payload metadata. API and UI consumers must
not infer component semantics from payload byte length or display labels.

Required fields:

- `schema_version = "frequency_response_point.v1"`,
- `frequency_index`,
- `frequency_hz`,
- `field_payload_path`,
- `payload_encoding`,
- `binary_layout`,
- `value_kind`,
- `component_basis`,
- `component_count`,
- `components[]`,
- `complex_pair_count`,
- `payload_value_count`,
- `available_views[]`,
- `default_view`,
- `default_phase_rad`.

Native frequency-response point descriptors must also mirror the corresponding
sweep-point response series, residuals, and summary observables so that a point
inspector can render without having to refetch or denormalize the full sweep
table:

- `angular_frequency_rad_per_s`,
- `m_complex`,
- `response_amplitude`,
- `response_phase`,
- `phase_rad`,
- `component_response_amplitude`,
- `component_response_phase`,
- `susceptibility_tensor`,
- `susceptibility_tensor_provenance`,
- `absorbed_power_density`,
- `absorbed_power_density_provenance`,
- `residual_l2_norm`,
- `relative_residual_l2_norm`,
- `residual_source`,
- `tangent_leakage`,
- `excitation_provenance`,
- `sweep_reuse`.

`excitation_provenance` and `sweep_reuse` must match the corresponding
`magnetic_response_sweep.v2.json.points[]` row. Point inspectors and API
resource handlers may load a single frequency point without the full sweep, so
drive phasor provenance and operator-template/warm-start reuse provenance must
be self-contained in the point artifact.

For the native FEM magnetic driven-response slice, the canonical 3D
visualization payload metadata is:

```json
{
  "storage_format": "zarr",
  "zarr_store_path": "response/field_payloads.zarr",
  "zarr_array_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex",
  "zarr_chunk_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
  "zarr_dtype": "<f8",
  "zarr_shape": [1234, 3, 2],
  "zarr_chunk_shape": [1234, 3, 2],
  "zarr_compressor": null,
  "field_payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
  "compatibility_binary_payload_path": "response/field_payloads/frequency_0000/vector_xyz.bin",
  "payload_encoding": "f64_interleaved_real_imag_xyz",
  "binary_layout": "complex_f64_pairs_little_endian",
  "value_kind": "complex_spatial_vector",
  "component_basis": "global_xyz",
  "component_count": 3,
  "components": ["x", "y", "z"]
}
```

`zarr_array_path` identifies the logical Zarr array directory. `zarr_chunk_path`
and `field_payload_path` identify the concrete chunk read by the binary
data-plane resource. JSON resources must expose both so UI inspectors can show
storage provenance while the field codec reads a single bounded payload.

Production native FEM writers may also include:

- `tangent_field_payload_path`,
- `tangent_payload_encoding = "f64_interleaved_real_imag_tangent"`,
- `tangent_value_kind = "complex_tangent_vector"`,
- `tangent_component_basis = "local_tangent_frame"`,
- `tangent_component_count = 2`,
- `tangent_components = ["tangent_e1", "tangent_e2"]`,
- `tangent_complex_pair_count`,
- `tangent_payload_value_count`.

These tangent fields are diagnostic/raw-solver payloads. UI 3D overlays must
use the canonical `field_payload_path` spatial XYZ payload unless they
explicitly implement tangent-frame reconstruction.

The canonical Zarr array stores chunked floating-point values with logical
shape `[node, component, complex]`, where `component = x|y|z` and
`complex = real|imag`. Compatibility binary exports store little-endian `f64`
values as interleaved complex pairs:

```text
x_re, x_im, y_re, y_im, z_re, z_im, x_re, x_im, y_re, y_im, z_re, z_im, ...
```

`complex_pair_count` is the number of complex spatial components in the file.
For three XYZ components per magnetic node, `complex_pair_count = 3 *
magnetic_node_count`. `payload_value_count` is the number of scalar `f64` values
and must equal `2 * complex_pair_count`. When `storage_format = "zarr"`, the
Zarr array metadata and chunks are authoritative, and `payload_value_count` is a
consistency check against the declared logical shape. When a compatibility
binary `field_payload_path` is not null, the binary file size must equal
`payload_value_count * 8` bytes.

`available_views[]` must include at least:

- `real`,
- `imag`,
- `abs` or `amplitude`,
- `phase`,
- `phase_rotated_real`.

`default_view` should be `phase_rotated_real` for 3D visualization because it
allows a static phase slider and animation by varying `phase_rad`.

Manifest `resources.response_field_resources[]` entries must be resource
descriptors, not bare payload paths:

```json
{
  "frequency_index": 0,
  "field_resource_id": "analysis:frequency-response:frequency-0000",
  "payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
  "zarr_array_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex",
  "zarr_chunk_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0"
}
```

`field_resource_id` is the data-plane field id used by
`/v2/sessions/current/data/fields/{field_id}/samples/vector`. `payload_path`
must match the corresponding chunk-level `response_field_payload_paths[]` entry
in `magnetic_response_sweep.v2.json`. The array directory remains available via
`zarr_array_path` for storage inspection and provenance.

## periodic_pairs.v1.json

Periodic pair diagnostics are mesh artifacts, not UI-only state. The artifact
must include:

- `schema_version = "periodic_pairs.v1"`,
- `pairs[]`,
- each `pair_id`,
- source and destination markers,
- expected translation,
- paired node count,
- unpaired source and destination counts,
- residual diagnostics,
- validation status.

The v2 API resource for the same contract is:

```text
/v2/sessions/current/meshing/mesh/periodic_pairs.v1
```

## Frontend contract

Analyze UI must:

- use `path_s` as the dispersion x-axis,
- show high-symmetry labels from sample labels,
- use `branches.v2.json` for branch grouping when present,
- fall back to raw mode grouping only when branch tracking is absent,
- propagate click selection as `{ branchId, sampleIndex, rawModeIndex }`,
- load mode artifacts by `sample_index` and `raw_mode_index`.

## API contract

The v2 API must expose:

- spectrum v2,
- branches v2,
- dispersion CSV,
- periodic pair diagnostics.

Missing optional artifacts should produce explicit `404` responses with
diagnostic messages, not silent empty plots.
