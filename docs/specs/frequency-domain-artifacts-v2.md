# Frequency-domain artifacts v2

Status: reference contract
Applies to: FEM eigen, dispersion, Analyze UI, v2 API resources

## Purpose

Frequency-domain artifacts must carry enough semantic information for the
frontend, Python post-processing, and regression tests to use them without
guessing file layout or reconstructing physics from labels.

The canonical artifact family is:

```text
artifacts/eigen/spectrum.v2.json
artifacts/eigen/branches.v2.json
artifacts/eigen/dispersion.csv
artifacts/eigen/modes/sample_XXXX_mode_YYYY.json
artifacts/response/magnetic_response_sweep.v1.json
artifacts/response/magnetic_response_sweep.v2.json
artifacts/mesh/periodic_pairs.v1.json
```

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
- eigenvalue real and imaginary components,
- `norm`,
- `max_amplitude`,
- `residual_norm`,
- `residual_linf`,
- `tangent_leakage_mean_abs`,
- `tangent_leakage_max_abs`,
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

## modes/sample_XXXX_mode_YYYY.json

Required fields:

- `schema_version`,
- `solver_model`,
- `sample_index`,
- `raw_mode_index`,
- optional `branch_id`,
- `frequency_real_hz`,
- `frequency_imag_hz`,
- `angular_frequency_rad_per_s`,
- `normalization`,
- `damping_policy`,
- `mode_field_id`,
- `mode_field_resource_key`,
- `residual_norm`,
- `residual_linf`,
- `tangent_leakage_mean_abs`,
- `tangent_leakage_max_abs`,
- `k_vector`,
- `mode_field_sample_count`,
- `amplitude_summary`,
- `component_summary`.

Mode metadata must not inline large vector arrays such as `real`, `imag`,
`amplitude`, or `phase`. Reconstructed physical vectors live in
`eigen/mode_fields/sample_XXXX/mode_YYYY/vector.bin` and are exposed through
the data-plane field resource referenced by `mode_field_resource_key`.
`residual_norm` and `residual_linf` are the generalized eigen residual norms
reported by the producing solver for the exported mode. Tangent leakage
diagnostics are the mean and max absolute `m0 dot dm` over the exported real
and imaginary mode vectors, and must be emitted whenever the solver
reconstructs physical mode vectors.

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
response/field_payloads/frequency_0000/vector_xyz.bin
```

Each point should include:

- `frequency_index`,
- `frequency_hz`,
- `angular_frequency_rad_per_s`,
- `max_response_amplitude` or `response_amplitude`,
- `phase_rad`,
- `absorbed_power_density`,
- `relative_residual_l2_norm`,
- `excitation_provenance`,
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

## response/diagnostics.v1.json

This artifact records driven-response solver diagnostics. Native FEM production
writers must include the matrix-free/GMRES diagnostics used to distinguish the
production CPU slice from dense validation artifacts.

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
- `tangent_leakage`.

For the native FEM magnetic driven-response slice, the canonical 3D
visualization payload metadata is:

```json
{
  "payload_encoding": "f64_interleaved_real_imag_xyz",
  "binary_layout": "complex_f64_pairs_little_endian",
  "value_kind": "complex_spatial_vector",
  "component_basis": "global_xyz",
  "component_count": 3,
  "components": ["x", "y", "z"]
}
```

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

The binary file stores little-endian `f64` values as interleaved complex pairs:

```text
x_re, x_im, y_re, y_im, z_re, z_im, x_re, x_im, y_re, y_im, z_re, z_im, ...
```

`complex_pair_count` is the number of complex spatial components in the file.
For three XYZ components per magnetic node, `complex_pair_count = 3 *
magnetic_node_count`. `payload_value_count` is the number of scalar `f64` values
and must equal `2 * complex_pair_count`. When `field_payload_path` is not null,
the binary file size must equal `payload_value_count * 8` bytes.

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
  "payload_path": "response/field_payloads/frequency_0000/vector_xyz.bin"
}
```

`field_resource_id` is the data-plane field id used by
`/v2/sessions/current/data/fields/{field_id}/samples/vector`. `payload_path`
must match the corresponding `response_field_payload_paths[]` entry in
`magnetic_response_sweep.v2.json`.

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
