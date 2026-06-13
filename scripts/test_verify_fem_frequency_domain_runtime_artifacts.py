#!/usr/bin/env python3
"""Unit tests for FEM frequency-domain runtime artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_frequency_domain_runtime_artifacts.py"


def write_frequency_domain_fixture(
    root: Path,
    *,
    omit_component_basis: bool = False,
    omit_component_count: bool = False,
    omit_complex_pair_count: bool = False,
    omit_payload_value_count: bool = False,
    available_views_override: list[str] | None = None,
    complex_pair_count: int = 3,
    payload_value_count: int = 6,
    payload_size: int = 48,
    write_response_fields: bool = True,
    include_tangent_payload: bool = True,
    tangent_payload_size: int = 32,
    tangent_component_basis: str = "local_tangent_frame",
    omit_tangent_component_count: bool = False,
    omit_tangent_complex_pair_count: bool = False,
    omit_tangent_payload_value_count: bool = False,
    tangent_complex_pair_count: int = 2,
    tangent_payload_value_count: int = 4,
    omit_sweep_tangent_link: bool = False,
    sweep_tangent_link_override: str | None = None,
    omit_manifest_point_paths: bool = False,
    manifest_point_paths_override: list[str] | None = None,
    omit_manifest_field_resources: bool = False,
    manifest_field_resources_override: list[dict[str, object]] | None = None,
    omit_manifest_cancel_requested_links: bool = False,
    omit_sweep_excitation_provenance: bool = False,
    omit_sweep_v2_excitation_provenance: bool = False,
    omit_sweep_v2_sweep_reuse: bool = False,
    omit_point_excitation_provenance: bool = False,
    omit_point_sweep_reuse: bool = False,
    omit_sweep_v2_phase_rad: bool = False,
    omit_sweep_v2_angular_frequency: bool = False,
    omit_sweep_v2_response_amplitude: bool = False,
    omit_sweep_v2_point_count: bool = False,
    omit_sweep_reuse: bool = False,
    omit_sweep_v1_point_count: bool = False,
    omit_sweep_v1_si_units: bool = False,
    omit_progress_schema_version: bool = False,
    omit_cancel_requested_artifact: bool = False,
    emitted_frequency_point_count: int = 2,
    progress_total_frequency_points: int = 2,
    progress_completed_frequency_points: int = 2,
    progress_written_frequency_point_artifacts: int = 2,
    progress_status: str = "ready",
    progress_complete: bool = True,
    progress_state: str = "completed",
    omit_diagnostics_krylov_solver: bool = False,
    diagnostics_status: str = "ready",
    diagnostics_complete: bool = True,
    diagnostics_matrix_free_solver: bool = True,
    diagnostics_completed_frequency_point_count: int = 2,
    include_static_periodic_diagnostics: bool = False,
    static_periodic_projection: bool = True,
    static_periodic_node_pair_count: int | None = 1,
    static_periodic_frame_max_mismatch: float = 0.0,
    static_periodic_drive_max_mismatch: float = 0.0,
    manifest_static_periodic_node_pair_count: int | None = None,
    manifest_status: str = "ready",
    manifest_complete: bool = True,
    omit_manifest_schema_version: bool = False,
    manifest_completed_frequency_count: int = 2,
    manifest_legacy_completed_frequency_count: int | None = None,
    manifest_written_frequency_point_artifacts: int = 2,
    sweep_v2_point_count: int | None = None,
    sweep_operator_template_reused: bool = True,
    sweep_excitation_kind: str = "field",
    sweep_excitation_phase_rad: float = 0.0,
    sweep_v2_phase_rad: float = 0.0,
    sweep_v1_backend_engine_id: str = "native_fem_mfem",
    sweep_v1_lane_classification: str = "fem_cpu_production",
    manifest_reference_or_production: str = "production",
    manifest_production_native_solver_available: bool = True,
    manifest_validation_artifact: bool = False,
    manifest_phase_convention: str = "exp_i_omega_t",
    omit_manifest_created_at: bool = False,
    omit_manifest_physics: bool = False,
    omit_static_periodic_mesh_artifact: bool = False,
    response_zarr_root_preferred_container_override: str | None = None,
) -> None:
    (root / "response" / "frequency_points").mkdir(parents=True)
    for index in range(emitted_frequency_point_count):
        if write_response_fields:
            (
                root
                / "response"
                / "field_payloads.zarr"
                / f"frequency_{index:04d}"
                / "vector_xyz_complex"
            ).mkdir(parents=True)
            (root / "response" / "field_payloads" / f"frequency_{index:04d}").mkdir(
                parents=True
            )
    (root / "frequency_domain").mkdir(parents=True)
    if write_response_fields and emitted_frequency_point_count > 0:
        (root / "response" / "field_payloads.zarr" / ".zgroup").write_text(
            json.dumps({"zarr_format": 2})
        )
        (root / "response" / "field_payloads.zarr" / ".zattrs").write_text(
            json.dumps(
                {
                    "fullmag_kind": "frequency_domain_response_field_store",
                    "schema_version": 1,
                    "preferred_container": (
                        response_zarr_root_preferred_container_override
                        if response_zarr_root_preferred_container_override is not None
                        else "zarr"
                    ),
                    "quantity_ids": ["dynamic_response"],
                    "compatibility_binary_exports": True,
                }
            )
        )

    point_paths: list[str] = []
    payload_paths: list[str] = []
    sweep_points: list[dict[str, object]] = []
    for index in range(emitted_frequency_point_count):
        point_path = f"response/frequency_points/frequency_{index:04d}.json"
        zarr_array_path = (
            f"response/field_payloads.zarr/frequency_{index:04d}/vector_xyz_complex"
        )
        payload_path = f"{zarr_array_path}/0.0.0"
        compatibility_payload_path = f"response/field_payloads/frequency_{index:04d}/vector_xyz.bin"
        tangent_payload_path = f"response/field_payloads/frequency_{index:04d}/vector.bin"
        frequency_hz = float(index + 1) * 1.0e9
        angular_frequency_rad_per_s = frequency_hz * 6.283185307179586
        point_paths.append(point_path)
        if write_response_fields:
            payload_paths.append(payload_path)
        sweep_reuse = {
            "operator_template_reused": sweep_operator_template_reused,
            "warm_start": None
            if index == 0
            else {
                "kind": "previous_frequency_response",
                "source_frequency_rad_per_s": float(index) * 1.0e9 * 6.283185307179586,
                "residual_l2_norm": None,
                "relative_residual_l2_norm": None,
            },
        }
        point = {
            "schema_version": "frequency_response_point.v1",
            "frequency_index": index,
            "frequency_hz": frequency_hz,
            "angular_frequency_rad_per_s": angular_frequency_rad_per_s,
            "field_payload_path": payload_path if write_response_fields else None,
            "m_complex": [[1.0, 0.0], [0.0, 0.0]],
            "response_amplitude": 1.0,
            "response_phase": 0.0,
            "phase_rad": 0.0,
            "component_response_amplitude": [1.0, 0.0],
            "component_response_phase": [0.0, 0.0],
            "absorbed_power_density": 0.0,
            "absorbed_power_density_provenance": {
                "kind": "drive_projected_absorption_proxy",
                "basis": "local_tangent_drive",
                "full_power_density": False,
            },
            "susceptibility_tensor": [[1.0, 0.0]],
            "susceptibility_tensor_provenance": {
                "kind": "drive_projected_scalar",
                "basis": "local_tangent_drive",
                "component_pair_count": 1,
                "full_tensor": False,
            },
            "tangent_leakage": {
                "status": "evaluated",
                "mean_abs_m0_dot_delta_m": 0.0,
                "max_abs_m0_dot_delta_m": 0.0,
            },
            "residual_l2_norm": 0.0,
            "relative_residual_l2_norm": 0.0,
            "residual_source": "matrix_free_gmres",
            "excitation_provenance": {
                "kind": sweep_excitation_kind,
                "phase_rad": sweep_excitation_phase_rad,
            },
            "sweep_reuse": sweep_reuse,
        }
        if omit_point_excitation_provenance and index == 0:
            del point["excitation_provenance"]
        if omit_point_sweep_reuse and index == 0:
            del point["sweep_reuse"]
        if write_response_fields:
            zarr_sample_count = complex_pair_count // 3
            point.update(
                {
                    "payload_encoding": "f64_interleaved_real_imag_xyz",
                    "binary_layout": "complex_f64_pairs_little_endian",
                    "value_kind": "complex_spatial_vector",
                    "component_basis": "global_xyz",
                    "component_count": 3,
                    "components": ["x", "y", "z"],
                    "complex_pair_count": complex_pair_count,
                    "payload_value_count": payload_value_count,
                    "storage_format": "zarr",
                    "zarr_store_path": "response/field_payloads.zarr",
                    "zarr_array_path": zarr_array_path,
                    "zarr_chunk_path": payload_path,
                    "zarr_dtype": "<f8",
                    "zarr_shape": [zarr_sample_count, 3, 2],
                    "zarr_chunk_shape": [max(zarr_sample_count, 1), 3, 2],
                    "zarr_compressor": None,
                    "compatibility_binary_payload_path": compatibility_payload_path,
                    "available_views": [
                        "complex",
                        "real",
                        "imag",
                        "abs",
                        "amplitude",
                        "phase",
                        "phase_rotated_real",
                    ],
                    "default_view": "phase_rotated_real",
                    "default_phase_rad": 0.0,
                }
            )
            if omit_component_basis and index == 0:
                del point["component_basis"]
            if omit_component_count and index == 0:
                del point["component_count"]
            if omit_complex_pair_count and index == 0:
                del point["complex_pair_count"]
            if omit_payload_value_count and index == 0:
                del point["payload_value_count"]
            if available_views_override is not None and index == 0:
                point["available_views"] = available_views_override
        if write_response_fields and include_tangent_payload:
            point.update(
                {
                    "tangent_field_payload_path": tangent_payload_path,
                    "tangent_payload_encoding": "f64_interleaved_real_imag_tangent",
                    "tangent_value_kind": "complex_tangent_vector",
                    "tangent_component_basis": tangent_component_basis,
                    "tangent_component_count": 2,
                    "tangent_components": ["tangent_e1", "tangent_e2"],
                    "tangent_complex_pair_count": tangent_complex_pair_count,
                    "tangent_payload_value_count": tangent_payload_value_count,
                }
            )
            if omit_tangent_component_count and index == 0:
                del point["tangent_component_count"]
            if omit_tangent_complex_pair_count and index == 0:
                del point["tangent_complex_pair_count"]
            if omit_tangent_payload_value_count and index == 0:
                del point["tangent_payload_value_count"]
        (root / point_path).write_text(json.dumps(point))
        if write_response_fields:
            (root / payload_path).write_bytes(b"\0" * payload_size)
            (root / compatibility_payload_path).write_bytes(b"\0" * payload_size)
            (root / zarr_array_path / ".zarray").write_text(
                json.dumps(
                    {
                        "zarr_format": 2,
                        "shape": [zarr_sample_count, 3, 2],
                        "chunks": [max(zarr_sample_count, 1), 3, 2],
                        "dtype": "<f8",
                        "compressor": None,
                        "fill_value": 0.0,
                        "order": "C",
                        "filters": None,
                        "dimension_separator": ".",
                    }
                )
            )
        if write_response_fields and include_tangent_payload:
            (root / tangent_payload_path).write_bytes(b"\0" * tangent_payload_size)
        sweep_points.append(
            {
                "frequency_index": index,
                "frequency_point_artifact_path": point_path,
                "response_field_payload_path": payload_path if write_response_fields else None,
                "storage_format": "zarr" if write_response_fields else None,
                "zarr_store_path": "response/field_payloads.zarr"
                if write_response_fields
                else None,
                "zarr_array_path": zarr_array_path if write_response_fields else None,
                "zarr_chunk_path": payload_path if write_response_fields else None,
                "zarr_dtype": "<f8" if write_response_fields else None,
                "zarr_shape": [zarr_sample_count, 3, 2]
                if write_response_fields
                else None,
                "zarr_chunk_shape": [max(zarr_sample_count, 1), 3, 2]
                if write_response_fields
                else None,
                "zarr_compressor": None if write_response_fields else None,
                "compatibility_binary_payload_path": compatibility_payload_path
                if write_response_fields
                else None,
                "frequency_hz": point["frequency_hz"],
                "angular_frequency_rad_per_s": angular_frequency_rad_per_s,
                "m_complex": [[1.0, 0.0], [0.0, 0.0]],
                "response_amplitude": 1.0,
                "response_phase": 0.0,
                "phase_rad": 0.0,
                "component_response_amplitude": [1.0, 0.0],
                "component_response_phase": [0.0, 0.0],
                "absorbed_power_density": 0.0,
                "absorbed_power_density_provenance": {
                    "kind": "drive_projected_absorption_proxy",
                    "basis": "local_tangent_drive",
                    "full_power_density": False,
                },
                "susceptibility_tensor": [[1.0, 0.0]],
                "susceptibility_tensor_provenance": {
                    "kind": "drive_projected_scalar",
                    "basis": "local_tangent_drive",
                    "component_pair_count": 1,
                    "full_tensor": False,
                },
                "tangent_leakage": {
                    "status": "evaluated",
                    "mean_abs_m0_dot_delta_m": 0.0,
                    "max_abs_m0_dot_delta_m": 0.0,
                },
                "residual_l2_norm": 0.0,
                "relative_residual_l2_norm": 0.0,
                "residual_source": "matrix_free_gmres",
                "sweep_reuse": sweep_reuse,
            }
        )
        if not omit_sweep_v2_angular_frequency:
            sweep_points[-1]["angular_frequency_rad_per_s"] = angular_frequency_rad_per_s
        else:
            del sweep_points[-1]["angular_frequency_rad_per_s"]
        if not omit_sweep_v2_response_amplitude:
            sweep_points[-1]["response_amplitude"] = 1.0
        else:
            del sweep_points[-1]["response_amplitude"]
        if not omit_sweep_v2_phase_rad:
            sweep_points[-1]["phase_rad"] = sweep_v2_phase_rad
        else:
            del sweep_points[-1]["phase_rad"]
        if not omit_sweep_v2_excitation_provenance:
            sweep_points[-1]["excitation_provenance"] = {
                "kind": sweep_excitation_kind,
                "phase_rad": sweep_excitation_phase_rad,
            }
        if omit_sweep_v2_sweep_reuse and index == 0:
            del sweep_points[-1]["sweep_reuse"]
        if write_response_fields and include_tangent_payload and not omit_sweep_tangent_link:
            sweep_points[-1]["response_tangent_field_payload_path"] = (
                sweep_tangent_link_override or tangent_payload_path
            )

    sweep_v1_point: dict[str, object] = {"residual_source": "matrix_free_gmres"}
    if not omit_sweep_excitation_provenance:
        sweep_v1_point["excitation_provenance"] = {
            "kind": sweep_excitation_kind,
            "phase_rad": sweep_excitation_phase_rad,
        }
    if not omit_sweep_reuse:
        sweep_v1_point["sweep_reuse"] = {
            "operator_template_reused": sweep_operator_template_reused,
            "warm_start": None,
        }
    sweep_v1: dict[str, object] = {
        "schema_version": "magnetic_response_sweep.v1",
        "backend_engine_id": sweep_v1_backend_engine_id,
        "solver_model": "matrix_free_gmres",
        "damping_policy": "linearized_llg_tangent",
        "lane_classification": sweep_v1_lane_classification,
        "matrix_layout": "matrix_free_block_real",
        "excitation_kind": "uniform_field",
        "points": [dict(sweep_v1_point) for _ in range(emitted_frequency_point_count)],
    }
    if not omit_sweep_v1_si_units:
        sweep_v1["si_units"] = {"frequency": "Hz", "angular_frequency": "rad/s"}
    if not omit_sweep_v1_point_count:
        sweep_v1["point_count"] = emitted_frequency_point_count
    (root / "response" / "magnetic_response_sweep.v1.json").write_text(
        json.dumps(sweep_v1)
    )
    (root / "response" / "magnetic_response_sweep.v2.json").write_text(
        json.dumps(
            {
                "schema_version": "magnetic_response_sweep.v2",
                "solve_kind": "direct_harmonic_response",
                "complete": progress_complete,
                "completed_frequency_point_count": progress_completed_frequency_points,
                "frequency_point_artifact_paths": point_paths,
                "response_field_payload_paths": payload_paths,
                "points": sweep_points,
            }
            | (
                {}
                if omit_sweep_v2_point_count
                else {
                    "point_count": (
                        emitted_frequency_point_count
                        if sweep_v2_point_count is None
                        else sweep_v2_point_count
                    )
                }
            )
        )
    )
    progress: dict[str, object] = {
        "schema_version": "frequency_domain_sweep_progress.v1",
        "status": progress_status,
        "complete": progress_complete,
        "state": progress_state,
        "total_frequency_points": progress_total_frequency_points,
        "completed_frequency_points": progress_completed_frequency_points,
        "written_frequency_point_artifacts": progress_written_frequency_point_artifacts,
        "partial_artifacts_available": emitted_frequency_point_count > 0,
        "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
    }
    if omit_progress_schema_version:
        del progress["schema_version"]
    (root / "response" / "progress.v1.json").write_text(json.dumps(progress))
    if progress_status == "interrupted" and not omit_cancel_requested_artifact:
        cancel_requested = {
            **progress,
            "status": "cancel_requested",
            "state": "cancel_requested",
            "complete": False,
        }
        (root / "response" / "cancel_requested.v1.json").write_text(
            json.dumps(cancel_requested)
        )
    diagnostics: dict[str, object] = {
        "schema_version": "frequency_domain_response_diagnostics.v1",
        "status": diagnostics_status,
        "complete": diagnostics_complete,
        "assembled_mfem_operator_solver": False,
        "dense_block_real_solver": False,
        "matrix_free_solver": diagnostics_matrix_free_solver,
        "krylov_solver": "gmres",
        "completed_frequency_point_count": diagnostics_completed_frequency_point_count,
        "max_abs_response": 1.0,
        "residual_l2_norm": 0.0,
        "relative_residual_l2_norm": 0.0,
    }
    if omit_diagnostics_krylov_solver:
        del diagnostics["krylov_solver"]
    if include_static_periodic_diagnostics:
        diagnostics["static_periodic_projection"] = static_periodic_projection
        if static_periodic_node_pair_count is not None:
            diagnostics["static_periodic_node_pair_count"] = static_periodic_node_pair_count
        diagnostics["static_periodic_frame_max_mismatch"] = static_periodic_frame_max_mismatch
        diagnostics["static_periodic_drive_max_mismatch"] = static_periodic_drive_max_mismatch
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))
    if include_static_periodic_diagnostics and not omit_static_periodic_mesh_artifact:
        (root / "mesh").mkdir(parents=True)
        (root / "mesh" / "periodic_pairs.v1.json").write_text(
            json.dumps(
                {
                    "schema_version": "periodic_pairs.v1",
                    "source": "native_fem_frequency_domain_static_periodic",
                    "pair_count": static_periodic_node_pair_count or 0,
                    "paired_node_count": (static_periodic_node_pair_count or 0) * 2,
                    "unpaired_source_count": 0,
                    "unpaired_destination_count": 0,
                    "validation_status": "ok",
                    "tolerance_m": 0.0,
                    "max_translation_residual_m": 0.0,
                    "residual_diagnostics": {
                        "max_translation_residual_m": 0.0,
                        "static_periodic_frame_max_mismatch": static_periodic_frame_max_mismatch,
                        "static_periodic_drive_max_mismatch": static_periodic_drive_max_mismatch,
                    },
                    "pairs": [
                        {
                            "pair_id": "static-periodic-0000",
                            "source_marker": "node:0",
                            "destination_marker": "node:1",
                            "node_a": 0,
                            "node_b": 1,
                            "expected_translation_m": [1.0e-9, 0.0, 0.0],
                            "translation_m": [1.0e-9, 0.0, 0.0],
                            "paired_node_count": 2,
                            "unpaired_source_count": 0,
                            "unpaired_destination_count": 0,
                            "translation_residual_m": 0.0,
                            "phase_rad": 0.0,
                            "validation_status": "ok",
                        }
                    ]
                    if static_periodic_node_pair_count
                    else [],
                }
            )
        )
    manifest_field_resources = [
        {
            "frequency_index": index,
            "field_resource_id": f"analysis:frequency-response:frequency-{index:04d}",
            "payload_path": payload_path,
        }
        for index, payload_path in enumerate(payload_paths)
    ]
    manifest_cancel_requested_artifact_path = (
        "response/cancel_requested.v1.json" if manifest_status == "interrupted" else None
    )
    manifest_cancel_requested_resource_key = (
        "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1"
        if manifest_status == "interrupted"
        else None
    )
    manifest: dict[str, object] = {
        "schema_version": "frequency_domain_manifest.v1",
        "created_at": "1970-01-01T00:00:00Z",
        "stage_kind": "frequency_response",
        "status": manifest_status,
        "complete": manifest_complete,
        "requested_execution": {
            "solve_equation": "(i omega B - L) q = f",
            "solve_kind": "direct_harmonic_response",
            "study_kind": "frequency_response",
            "write_response_fields": write_response_fields,
        },
        "resolved_execution": {
            "engine": "native_fem_mfem_frequency_domain_cpu",
            "native_backend": "native_mfem_matrix_free",
            "reference_or_production": manifest_reference_or_production,
            "solver_library": "native_gmres",
            "solver_model": "matrix_free_gmres",
            "solve_kind": "direct_harmonic_response",
        },
        "artifacts": {
            "response_cancel_requested_v1_path": manifest_cancel_requested_artifact_path,
            "response_map_v1_path": None,
            "response_map_v2_path": None,
            "frequency_point_paths": (
                manifest_point_paths_override
                if manifest_point_paths_override is not None
                else point_paths
            ),
        },
        "physics": {
            "analysis_family": "frequency_domain",
            "llg_gamma0_si": 221276.0,
            "llg_alpha": 0.01,
            "phase_convention": manifest_phase_convention,
            "frequency_units": "Hz",
            "field_units": "A_per_m",
            "normalization": "linear_response_tangent",
            "spin_wave_bc": {
                "kind": "static_periodic" if include_static_periodic_diagnostics else "open",
            },
            "periodic_or_floquet": include_static_periodic_diagnostics,
        },
        "capabilities": {
            "production_solver_available": True,
            "production_native_solver_available": manifest_production_native_solver_available,
            "validation_artifact": manifest_validation_artifact,
        },
        "diagnostics": {
            "completed_frequency_point_count": manifest_completed_frequency_count,
            "written_frequency_point_artifacts": manifest_written_frequency_point_artifacts,
        },
        "resources": {
            "response_sweep_resource_key": (
                "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep"
            ),
            "response_cancel_requested_resource_key": manifest_cancel_requested_resource_key,
            "response_map_resource_key": None,
            "response_field_resources": (
                manifest_field_resources_override
                if manifest_field_resources_override is not None
                else manifest_field_resources
            ),
        },
    }
    if omit_manifest_point_paths:
        artifacts = manifest["artifacts"]
        assert isinstance(artifacts, dict)
        del artifacts["frequency_point_paths"]
    if manifest_legacy_completed_frequency_count is not None:
        manifest_diagnostics = manifest["diagnostics"]
        assert isinstance(manifest_diagnostics, dict)
        del manifest_diagnostics["completed_frequency_point_count"]
        manifest_diagnostics["completed_frequency_count"] = (
            manifest_legacy_completed_frequency_count
        )
    if omit_manifest_field_resources:
        resources = manifest["resources"]
        assert isinstance(resources, dict)
        del resources["response_field_resources"]
    if omit_manifest_cancel_requested_links:
        artifacts = manifest["artifacts"]
        resources = manifest["resources"]
        assert isinstance(artifacts, dict)
        assert isinstance(resources, dict)
        del artifacts["response_cancel_requested_v1_path"]
        del resources["response_cancel_requested_resource_key"]
    if omit_manifest_created_at:
        del manifest["created_at"]
    if omit_manifest_physics:
        del manifest["physics"]
    if include_static_periodic_diagnostics:
        artifacts = manifest["artifacts"]
        assert isinstance(artifacts, dict)
        artifacts["periodic_pairs_v1_path"] = "mesh/periodic_pairs.v1.json"
        manifest_diagnostics = manifest["diagnostics"]
        assert isinstance(manifest_diagnostics, dict)
        manifest_diagnostics["static_periodic_projection"] = static_periodic_projection
        if static_periodic_node_pair_count is not None:
            manifest_diagnostics["static_periodic_node_pair_count"] = (
                static_periodic_node_pair_count
                if manifest_static_periodic_node_pair_count is None
                else manifest_static_periodic_node_pair_count
            )
        manifest_diagnostics["static_periodic_frame_max_mismatch"] = (
            static_periodic_frame_max_mismatch
        )
        manifest_diagnostics["static_periodic_drive_max_mismatch"] = (
            static_periodic_drive_max_mismatch
        )
    if omit_manifest_schema_version:
        del manifest["schema_version"]
    (root / "frequency_domain" / "manifest.v1.json").write_text(json.dumps(manifest))


def run_validator(
    root: Path,
    *,
    require_static_periodic: bool = False,
    allow_interrupted: bool = False,
    allow_unavailable: bool = False,
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(VALIDATOR)]
    if require_static_periodic:
        command.append("--require-static-periodic")
    if allow_interrupted:
        command.append("--allow-interrupted")
    if allow_unavailable:
        command.append("--allow-unavailable")
    command.append(str(root))
    return subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def write_unavailable_frequency_domain_fixture(root: Path) -> None:
    (root / "response").mkdir(parents=True)
    (root / "frequency_domain").mkdir(parents=True)
    (root / "response" / "progress.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "frequency_domain_sweep_progress.v1",
                "status": "unavailable",
                "complete": False,
                "state": "unavailable",
                "total_frequency_points": 2,
                "completed_frequency_points": 0,
                "written_frequency_point_artifacts": 0,
                "partial_artifacts_available": False,
                "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
            }
        )
    )
    (root / "response" / "diagnostics.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "frequency_domain_response_diagnostics.v1",
                "status": "unavailable",
                "complete": False,
                "solver_kind": "production_unavailable",
                "requested_frequency_count": 2,
                "completed_frequency_point_count": 0,
                "written_frequency_point_artifacts": 0,
            }
        )
    )
    (root / "frequency_domain" / "manifest.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "frequency_domain_manifest.v1",
                "revision": "unavailable-v1",
                "created_at": "1970-01-01T00:00:00Z",
                "session_id": "native-validation",
                "run_id": "native-validation",
                "stage_id": "frequency-response-production",
                "stage_kind": "frequency_response",
                "status": "unavailable",
                "complete": False,
                "requested_execution": {
                    "solve_equation": "(i omega B - L) q = f",
                    "solve_kind": "direct_harmonic_response",
                    "study_kind": "frequency_response",
                    "frequency_count": 2,
                    "write_response_fields": True,
                },
                "resolved_execution": {
                    "backend_engine_id": "native_fem_mfem",
                    "engine": "native_fem_mfem_frequency_domain",
                    "native_backend": "native_mfem_unavailable",
                    "reference_or_production": "production",
                    "solver_library": "unavailable",
                    "solver_model": "production_unavailable",
                    "solve_kind": "direct_harmonic_response",
                    "solver_kind": "production_unavailable",
                    "requested_execution_lane": "production_cpu",
                    "lane_classification": "fem_cpu_production",
                    "production_solver": True,
                },
                "physics": {
                    "analysis_family": "frequency_domain",
                    "llg_gamma0_si": 2.211e5,
                    "llg_alpha": 0.01,
                    "phase_convention": "exp_i_omega_t",
                    "frequency_units": "Hz",
                    "field_units": "A_per_m",
                    "normalization": "linear_response_tangent",
                    "spin_wave_bc": {"kind": "open"},
                    "periodic_or_floquet": False,
                },
                "artifacts": {
                    "response_diagnostics_v1_path": "response/diagnostics.v1.json",
                    "response_progress_v1_path": "response/progress.v1.json",
                    "response_cancel_requested_v1_path": None,
                    "response_map_v1_path": None,
                    "response_map_v2_path": None,
                    "frequency_point_paths": [],
                },
                "resources": {
                    "response_progress_resource_key": "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
                    "response_diagnostics_resource_key": "/v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1",
                    "response_cancel_requested_resource_key": None,
                    "response_map_resource_key": None,
                    "response_field_resources": [],
                },
                "diagnostics": {
                    "requested_frequency_count": 2,
                    "completed_frequency_point_count": 0,
                    "written_frequency_point_artifacts": 0,
                },
                "capabilities": {
                    "validation_solver_available": True,
                    "production_solver_available": False,
                    "production_native_solver_available": False,
                    "validation_artifact": False,
                    "dynamic_demag_k_available": False,
                    "floquet_response_available": False,
                    "gpu_available": False,
                },
            }
        )
    )


def test_validator_accepts_tangent_field_payload_metadata(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_unavailable_bundle_with_explicit_flag(tmp_path: Path) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_unavailable_bundle_without_explicit_flag(tmp_path: Path) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "--allow-unavailable" in (result.stderr + result.stdout)


def test_validator_rejects_unavailable_manifest_missing_resource_keys(
    tmp_path: Path,
) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["resources"]["response_progress_resource_key"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "manifest.resources.response_progress_resource_key" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_unavailable_manifest_missing_diagnostics_artifact_ref(
    tmp_path: Path,
) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["artifacts"]["response_diagnostics_v1_path"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "manifest.artifacts.response_diagnostics_v1_path" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_unavailable_manifest_missing_response_map_refs(
    tmp_path: Path,
) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["artifacts"]["response_map_v1_path"]
    del manifest["resources"]["response_map_resource_key"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "manifest.artifacts.response_map_v1_path" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_unavailable_manifest_missing_physics(tmp_path: Path) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["physics"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "manifest.physics" in (result.stderr + result.stdout)


def test_validator_rejects_unavailable_manifest_missing_requested_execution(
    tmp_path: Path,
) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["requested_execution"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "manifest.requested_execution" in (result.stderr + result.stdout)


def test_validator_rejects_unavailable_manifest_missing_capability_snapshot(
    tmp_path: Path,
) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["capabilities"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "manifest.capabilities" in (result.stderr + result.stdout)


def test_validator_rejects_unavailable_diagnostics_missing_requested_frequency_count(
    tmp_path: Path,
) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    del diagnostics["requested_frequency_count"]
    diagnostics_path.write_text(json.dumps(diagnostics))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "diagnostics.requested_frequency_count" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_unavailable_requested_frequency_count_mismatch(
    tmp_path: Path,
) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["frequency_count"] = 3
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode != 0
    assert "requested frequency count" in (result.stderr + result.stdout)


def test_validator_accepts_missing_optional_tangent_payload(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, include_tangent_payload=False)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_response_points_without_field_payloads_when_not_requested(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path, write_response_fields=False)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_empty_susceptibility_tensor(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    sweep_path = tmp_path / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    sweep["points"][0]["susceptibility_tensor"] = []
    sweep_path.write_text(json.dumps(sweep))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "susceptibility_tensor" in (result.stderr + result.stdout)


def test_validator_rejects_not_evaluated_tangent_leakage(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    sweep_path = tmp_path / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    sweep["points"][0]["tangent_leakage"] = {"status": "not_evaluated"}
    sweep_path.write_text(json.dumps(sweep))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_leakage.status" in (result.stderr + result.stdout)


def test_validator_rejects_point_sweep_observable_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["susceptibility_tensor"] = [[2.0, 0.0]]
    point_path.write_text(json.dumps(point))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "susceptibility_tensor does not match" in (result.stderr + result.stdout)


def test_validator_rejects_missing_point_complex_series(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    del point["m_complex"]
    point_path.write_text(json.dumps(point))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "m_complex" in (result.stderr + result.stdout)


def test_validator_rejects_point_sweep_response_series_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["component_response_amplitude"] = [2.0, 0.0]
    point_path.write_text(json.dumps(point))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "component_response_amplitude does not match" in (result.stderr + result.stdout)


def test_validator_accepts_exp_minus_i_omega_t_phase_convention(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        manifest_phase_convention="exp_minus_i_omega_t",
    )

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_unknown_phase_convention(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        manifest_phase_convention="exp_plus_i_k_dot_r",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.physics.phase_convention" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_excitation_provenance(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_excitation_provenance=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "excitation_provenance" in (result.stderr + result.stdout)


def test_validator_rejects_sweep_excitation_provenance_without_field_kind(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, sweep_excitation_kind="source")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "excitation_provenance.kind" in output
    assert "field" in output


def test_validator_rejects_missing_sweep_reuse(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_reuse=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep_reuse" in (result.stderr + result.stdout)


def test_validator_rejects_sweep_reuse_without_operator_template_reuse(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, sweep_operator_template_reused=False)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "operator_template_reused" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_v1_point_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v1_point_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep_v1.point_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_v1_si_units(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v1_si_units=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep_v1.si_units" in (result.stderr + result.stdout)


def test_validator_accepts_three_frequency_complete_sweep(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        emitted_frequency_point_count=3,
        progress_total_frequency_points=3,
        progress_completed_frequency_points=3,
        progress_written_frequency_point_artifacts=3,
        diagnostics_completed_frequency_point_count=3,
        manifest_completed_frequency_count=3,
        manifest_written_frequency_point_artifacts=3,
        sweep_v2_point_count=3,
    )

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_non_native_sweep_backend(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path, sweep_v1_backend_engine_id="runner.dense_block_real_validation"
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep_v1.backend_engine_id" in (result.stderr + result.stdout)


def test_validator_rejects_non_production_sweep_lane(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, sweep_v1_lane_classification="fem_cpu_validation")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep_v1.lane_classification" in (result.stderr + result.stdout)


def test_validator_rejects_missing_progress_schema_version(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_progress_schema_version=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "progress.schema_version" in (result.stderr + result.stdout)


def test_validator_rejects_mismatched_progress_work_units(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, progress_total_frequency_points=1)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "progress.total_frequency_points" in (result.stderr + result.stdout)


def test_validator_rejects_missing_diagnostics_krylov_solver(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_diagnostics_krylov_solver=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "diagnostics.krylov_solver" in (result.stderr + result.stdout)


def test_validator_rejects_non_matrix_free_diagnostics(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, diagnostics_matrix_free_solver=False)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "diagnostics.matrix_free_solver" in (result.stderr + result.stdout)


def test_validator_accepts_static_periodic_diagnostics(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, include_static_periodic_diagnostics=True)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_required_static_periodic_diagnostics(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, include_static_periodic_diagnostics=True)

    result = run_validator(tmp_path, require_static_periodic=True)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_missing_static_periodic_mesh_artifact(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_static_periodic_diagnostics=True,
        omit_static_periodic_mesh_artifact=True,
    )

    result = run_validator(tmp_path, require_static_periodic=True)

    assert result.returncode != 0
    assert "mesh/periodic_pairs.v1.json" in (result.stderr + result.stdout)


def test_validator_rejects_missing_required_static_periodic_diagnostics(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path)

    result = run_validator(tmp_path, require_static_periodic=True)

    assert result.returncode != 0
    assert "static-periodic diagnostics were required" in (result.stderr + result.stdout)


def test_validator_rejects_static_periodic_projection_without_pair_count(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_static_periodic_diagnostics=True,
        static_periodic_node_pair_count=None,
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "static_periodic_node_pair_count" in (result.stderr + result.stdout)


def test_validator_rejects_static_periodic_projection_with_nonfinite_mismatch(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_static_periodic_diagnostics=True,
        static_periodic_frame_max_mismatch=float("nan"),
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "static_periodic_frame_max_mismatch" in (result.stderr + result.stdout)


def test_validator_rejects_static_periodic_manifest_count_mismatch(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_static_periodic_diagnostics=True,
        manifest_static_periodic_node_pair_count=2,
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.diagnostics.static_periodic_node_pair_count" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_interrupted_artifacts_without_explicit_flag(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        emitted_frequency_point_count=1,
        progress_completed_frequency_points=1,
        progress_written_frequency_point_artifacts=1,
        progress_status="interrupted",
        progress_complete=False,
        progress_state="interrupted",
        diagnostics_status="interrupted",
        diagnostics_complete=False,
        diagnostics_completed_frequency_point_count=1,
        manifest_status="interrupted",
        manifest_complete=False,
        manifest_completed_frequency_count=1,
        manifest_written_frequency_point_artifacts=1,
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "--allow-interrupted" in (result.stderr + result.stdout)


def test_validator_accepts_interrupted_partial_sweep_with_completed_point(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        emitted_frequency_point_count=1,
        progress_completed_frequency_points=1,
        progress_written_frequency_point_artifacts=1,
        progress_status="interrupted",
        progress_complete=False,
        progress_state="interrupted",
        diagnostics_status="interrupted",
        diagnostics_complete=False,
        diagnostics_completed_frequency_point_count=1,
        manifest_status="interrupted",
        manifest_complete=False,
        manifest_completed_frequency_count=1,
        manifest_written_frequency_point_artifacts=1,
    )

    result = run_validator(tmp_path, allow_interrupted=True)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_interrupted_sweep_before_first_point(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        emitted_frequency_point_count=0,
        progress_completed_frequency_points=0,
        progress_written_frequency_point_artifacts=0,
        progress_status="interrupted",
        progress_complete=False,
        progress_state="interrupted",
        diagnostics_status="interrupted",
        diagnostics_complete=False,
        diagnostics_completed_frequency_point_count=0,
        manifest_status="interrupted",
        manifest_complete=False,
        manifest_completed_frequency_count=0,
        manifest_written_frequency_point_artifacts=0,
    )

    result = run_validator(tmp_path, allow_interrupted=True)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_interrupted_sweep_without_cancel_requested_artifact(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        emitted_frequency_point_count=1,
        omit_cancel_requested_artifact=True,
        progress_completed_frequency_points=1,
        progress_written_frequency_point_artifacts=1,
        progress_status="interrupted",
        progress_complete=False,
        progress_state="interrupted",
        diagnostics_status="interrupted",
        diagnostics_complete=False,
        diagnostics_completed_frequency_point_count=1,
        manifest_status="interrupted",
        manifest_complete=False,
        manifest_completed_frequency_count=1,
        manifest_written_frequency_point_artifacts=1,
    )

    result = run_validator(tmp_path, allow_interrupted=True)

    assert result.returncode != 0
    assert "response/cancel_requested.v1.json" in (result.stderr + result.stdout)


def test_validator_rejects_interrupted_manifest_without_cancel_requested_links(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        emitted_frequency_point_count=1,
        omit_manifest_cancel_requested_links=True,
        progress_completed_frequency_points=1,
        progress_written_frequency_point_artifacts=1,
        progress_status="interrupted",
        progress_complete=False,
        progress_state="interrupted",
        diagnostics_status="interrupted",
        diagnostics_complete=False,
        diagnostics_completed_frequency_point_count=1,
        manifest_status="interrupted",
        manifest_complete=False,
        manifest_completed_frequency_count=1,
        manifest_written_frequency_point_artifacts=1,
    )

    result = run_validator(tmp_path, allow_interrupted=True)

    assert result.returncode != 0
    assert "manifest.artifacts.response_cancel_requested_v1_path" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_interrupted_written_count_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        emitted_frequency_point_count=1,
        progress_completed_frequency_points=1,
        progress_written_frequency_point_artifacts=0,
        progress_status="interrupted",
        progress_complete=False,
        progress_state="interrupted",
        diagnostics_status="interrupted",
        diagnostics_complete=False,
        diagnostics_completed_frequency_point_count=1,
        manifest_status="interrupted",
        manifest_complete=False,
        manifest_completed_frequency_count=1,
        manifest_written_frequency_point_artifacts=0,
    )

    result = run_validator(tmp_path, allow_interrupted=True)

    assert result.returncode != 0
    assert "written_frequency_point_artifacts" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_v2_excitation_provenance(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v2_excitation_provenance=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "sweep.points[0].excitation_provenance" in output


def test_validator_rejects_missing_sweep_v2_sweep_reuse(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v2_sweep_reuse=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "sweep.points[0].sweep_reuse" in output


def test_validator_rejects_missing_point_excitation_provenance(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_point_excitation_provenance=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "response/frequency_points/frequency_0000.json.excitation_provenance" in output


def test_validator_rejects_missing_point_sweep_reuse(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_point_sweep_reuse=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "response/frequency_points/frequency_0000.json.sweep_reuse" in output


def test_validator_rejects_missing_sweep_v2_phase_rad(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v2_phase_rad=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep.points[0].phase_rad" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_v2_angular_frequency(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v2_angular_frequency=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep.points[0].angular_frequency_rad_per_s" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_v2_response_amplitude(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v2_response_amplitude=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep.points[0].response_amplitude" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_v2_point_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_v2_point_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep.point_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_frequency_domain_manifest_schema(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_manifest_schema_version=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.schema_version" in (result.stderr + result.stdout)


def test_validator_rejects_missing_manifest_created_at(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_manifest_created_at=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.created_at" in (result.stderr + result.stdout)


def test_validator_rejects_missing_manifest_physics(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_manifest_physics=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.physics" in (result.stderr + result.stdout)


def test_validator_rejects_progress_manifest_status_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, manifest_status="interrupted")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "manifest.status" in output or "progress.status vs manifest.status" in output


def test_validator_rejects_diagnostics_progress_count_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, diagnostics_completed_frequency_point_count=1)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "diagnostics.completed_frequency_point_count" in output


def test_validator_rejects_manifest_progress_count_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, manifest_completed_frequency_count=1)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "manifest.diagnostics.completed_frequency_point_count" in output


def test_validator_accepts_legacy_manifest_completed_frequency_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        manifest_legacy_completed_frequency_count=2,
    )

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_reference_manifest_execution(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, manifest_reference_or_production="reference")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.resolved_execution.reference_or_production" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_manifest_without_native_production_capability(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path, manifest_production_native_solver_available=False
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.capabilities.production_native_solver_available" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_validation_artifact_manifest(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, manifest_validation_artifact=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.capabilities.validation_artifact" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_nonfinite_sweep_v2_phase_rad(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, sweep_v2_phase_rad=float("nan"))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep.points[0].phase_rad" in (result.stderr + result.stdout)


def test_validator_rejects_nonfinite_sweep_excitation_phase(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, sweep_excitation_phase_rad=float("nan"))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "excitation_provenance.phase_rad" in (result.stderr + result.stdout)


def test_validator_rejects_missing_component_basis(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_component_basis=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "component_basis" in (result.stderr + result.stdout)


def test_validator_rejects_missing_component_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_component_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "component_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_required_available_view(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        available_views_override=["complex", "real", "imag", "abs", "amplitude", "phase"],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "available_views" in output
    assert "phase_rotated_real" in output


def test_validator_rejects_missing_complex_view(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        available_views_override=["real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "available_views" in output
    assert "complex" in output


def test_validator_rejects_missing_abs_or_amplitude_view(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        available_views_override=["complex", "real", "imag", "phase", "phase_rotated_real"],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "available_views" in output
    assert "abs" in output
    assert "amplitude" in output


def test_validator_rejects_payload_size_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, payload_size=24)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "size" in (result.stderr + result.stdout)


def test_validator_rejects_payload_value_count_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, payload_value_count=10)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "payload_value_count" in (result.stderr + result.stdout)


def test_validator_rejects_response_zarr_root_container_drift(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        response_zarr_root_preferred_container_override="json",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_payloads.zarr/.zattrs.preferred_container" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_missing_complex_pair_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_complex_pair_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "complex_pair_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_payload_value_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_payload_value_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "payload_value_count" in (result.stderr + result.stdout)


def test_validator_rejects_complex_pair_count_overflow(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, complex_pair_count=sys.maxsize + 1)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "complex_pair_count" in output or "payload_value_count" in output


def test_validator_rejects_tangent_payload_size_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, tangent_payload_size=24)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    output = result.stderr + result.stdout
    assert "tangent" in output
    assert "size" in output


def test_validator_rejects_tangent_payload_value_count_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, tangent_payload_value_count=6)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_payload_value_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_tangent_component_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_tangent_component_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_component_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_tangent_complex_pair_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_tangent_complex_pair_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_complex_pair_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_tangent_payload_value_count(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_tangent_payload_value_count=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_payload_value_count" in (result.stderr + result.stdout)


def test_validator_rejects_tangent_complex_pair_count_overflow(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, tangent_complex_pair_count=sys.maxsize + 1)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_complex_pair_count" in (result.stderr + result.stdout)


def test_validator_rejects_invalid_tangent_component_basis(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, tangent_component_basis="global_xyz")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_component_basis" in (result.stderr + result.stdout)


def test_validator_rejects_missing_sweep_tangent_link(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_sweep_tangent_link=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "response_tangent_field_payload_path" in (result.stderr + result.stdout)


def test_validator_rejects_mismatched_sweep_tangent_link(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        sweep_tangent_link_override="response/field_payloads/frequency_0000/wrong.bin",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "response_tangent_field_payload_path" in (result.stderr + result.stdout)


def test_validator_rejects_missing_manifest_frequency_point_paths(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_manifest_point_paths=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.artifacts.frequency_point_paths" in (result.stderr + result.stdout)


def test_validator_rejects_mismatched_manifest_frequency_point_paths(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        manifest_point_paths_override=["response/frequency_points/frequency_0000.json"],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.artifacts.frequency_point_paths" in (result.stderr + result.stdout)


def test_validator_rejects_missing_manifest_response_field_resources(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_manifest_field_resources=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.resources.response_field_resources" in (result.stderr + result.stdout)


def test_validator_rejects_missing_response_field_payload_paths_when_requested(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path)
    sweep_path = tmp_path / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    sweep["response_field_payload_paths"] = []
    sweep_path.write_text(json.dumps(sweep))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "sweep.response_field_payload_paths length" in (result.stderr + result.stdout)


def test_validator_rejects_mismatched_manifest_response_field_resources(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        manifest_field_resources_override=[
            {
                "frequency_index": 0,
                "field_resource_id": "analysis:frequency-response:frequency-0000",
                "payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
            },
        ],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.resources.response_field_resources" in (result.stderr + result.stdout)


def test_validator_rejects_manifest_response_field_resource_id_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        manifest_field_resources_override=[
            {
                "frequency_index": 0,
                "field_resource_id": "analysis:frequency-response:frequency-9999",
                "payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
            },
            {
                "frequency_index": 1,
                "field_resource_id": "analysis:frequency-response:frequency-0001",
                "payload_path": "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0",
            },
        ],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_resource_id" in (result.stderr + result.stdout)


def test_validator_rejects_manifest_response_field_payload_path_mismatch(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        manifest_field_resources_override=[
            {
                "frequency_index": 0,
                "field_resource_id": "analysis:frequency-response:frequency-0000",
                "payload_path": "response/field_payloads/frequency_0000/wrong.bin",
            },
            {
                "frequency_index": 1,
                "field_resource_id": "analysis:frequency-response:frequency-0001",
                "payload_path": "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0",
            },
        ],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "payload_path" in (result.stderr + result.stdout)


def test_validator_rejects_flattened_response_zarr_shape(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["zarr_shape"] = [3, 2]
    point_path.write_text(json.dumps(point))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "zarr_shape" in (result.stderr + result.stdout)
