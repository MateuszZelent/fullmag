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
- `residual_norm`,
- `residual_linf`,
- `tangent_leakage_mean_abs`,
- `tangent_leakage_max_abs`,
- `k_vector`,
- `real`,
- `imag`,
- `amplitude`,
- `phase`.

Mode fields are reconstructed physical vectors. `residual_norm` and
`residual_linf` are the generalized eigen residual norms reported by the
producing solver for the exported mode. Tangent leakage diagnostics are the
mean and max absolute `m0 dot dm` over the exported real and imaginary mode
vectors, and must be emitted whenever the solver reconstructs physical mode
vectors.

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
- `susceptibility_tensor` as `[re, im]` pairs,
- `absorbed_power_density`,
- `residual_l2_norm`,
- `relative_residual_l2_norm`,
- `tangent_leakage` diagnostic status,
- `excitation_provenance`,
- `sweep_reuse` provenance.

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
