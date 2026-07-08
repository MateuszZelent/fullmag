#!/usr/bin/env python3
"""Unit tests for FEM frequency-domain runtime artifact validation."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_frequency_domain_runtime_artifacts.py"


def graph_preconditioner_relaxation_for_variant(variant: str) -> float:
    return 0.05 if variant == "graph_demag_coarse" else 0.0


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
    omit_progress_json: bool = False,
    omit_manifest_progress_links: bool = False,
    omit_cancel_requested_artifact: bool = False,
    emitted_frequency_point_count: int = 2,
    progress_total_frequency_points: int = 2,
    progress_completed_frequency_points: int = 2,
    progress_written_frequency_point_artifacts: int = 2,
    progress_status: str = "ready",
    progress_complete: bool = True,
    progress_state: str = "completed",
    omit_diagnostics_krylov_solver: bool = False,
    omit_diagnostics_matrix_form: bool = False,
    omit_diagnostics_phasor_convention: bool = False,
    diagnostics_status: str = "ready",
    diagnostics_complete: bool = True,
    diagnostics_matrix_free_solver: bool = True,
    diagnostics_completed_frequency_point_count: int = 2,
    include_static_periodic_diagnostics: bool = False,
    include_floquet_phase_projection: bool = False,
    omit_floquet_basis_transport_policy: bool = False,
    floquet_basis_transport_policy: str = "tangent_frame_identity",
    floquet_tangent_frame_max_mismatch: float = 0.0,
    floquet_tangent_transport_max_nonunitarity: float = 0.0,
    omit_floquet_pair_artifact: bool = False,
    omit_floquet_metadata: bool = False,
    omit_floquet_k_vector_metadata: bool = False,
    floquet_k_vector_rad_per_m: list[float] | None = None,
    response_amplitude: float = 1.0,
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
    execution_lane: str = "production_cpu",
    manifest_engine: str = "native_fem_mfem_frequency_domain_cpu",
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
            "response_amplitude": response_amplitude,
            "response_phase": 0.0,
            "phase_rad": 0.0,
            "component_response_amplitude": [response_amplitude, 0.0],
            "component_response_phase": [0.0, 0.0],
            "absorbed_power_density": 0.0,
            "absorbed_power_density_provenance": {
                "kind": "drive_projected_absorption_proxy",
                "basis": "local_tangent_drive",
                "physical_power_density": False,
                "units": "proxy_not_W_per_m3",
                "requires_mu0_ms_factor": True,
                "ms_factor_applied": False,
                "normalization": "0.5*omega*imag(sum(response*conj(drive)))/tangent_dof_count",
                "absolute_value_applied": False,
                "full_power_density": False,
            },
            "susceptibility_tensor": [[1.0, 0.0]],
            "susceptibility_tensor_provenance": {
                "kind": "drive_projected_scalar",
                "basis": "local_tangent_drive",
                "component_pair_count": 1,
                "full_tensor": False,
                "response_quantity": "delta_m_over_h_drive",
                "response_units": "m/A",
                "dimensionless_si_susceptibility": False,
                "requires_ms_for_chi_si": True,
                "ms_factor_applied": False,
                "normalization": "sum(response*conj(drive))/sum(abs(drive)^2)",
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
                "response_amplitude": response_amplitude,
                "response_phase": 0.0,
                "phase_rad": 0.0,
                "component_response_amplitude": [response_amplitude, 0.0],
                "component_response_phase": [0.0, 0.0],
                "absorbed_power_density": 0.0,
                "absorbed_power_density_provenance": {
                    "kind": "drive_projected_absorption_proxy",
                    "basis": "local_tangent_drive",
                    "physical_power_density": False,
                    "units": "proxy_not_W_per_m3",
                    "requires_mu0_ms_factor": True,
                    "ms_factor_applied": False,
                    "normalization": "0.5*omega*imag(sum(response*conj(drive)))/tangent_dof_count",
                    "absolute_value_applied": False,
                    "full_power_density": False,
                },
                "susceptibility_tensor": [[1.0, 0.0]],
                "susceptibility_tensor_provenance": {
                    "kind": "drive_projected_scalar",
                    "basis": "local_tangent_drive",
                    "component_pair_count": 1,
                    "full_tensor": False,
                    "response_quantity": "delta_m_over_h_drive",
                    "response_units": "m/A",
                    "dimensionless_si_susceptibility": False,
                    "requires_ms_for_chi_si": True,
                    "ms_factor_applied": False,
                    "normalization": "sum(response*conj(drive))/sum(abs(drive)^2)",
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
        "current_frequency_hz": (
            float(progress_completed_frequency_points) * 1.0e9
            if progress_completed_frequency_points > 0
            else None
        ),
        "partial_artifacts_available": emitted_frequency_point_count > 0,
        "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
    }
    if not omit_progress_json:
        progress["progress_json"] = json.dumps(
            {
                "schema_version": "frequency_domain_sweep_progress.v1",
                "status": progress_status,
                "complete": progress_complete,
                "state": progress_state,
                "total_frequency_points": progress_total_frequency_points,
                "completed_frequency_points": progress_completed_frequency_points,
                "written_frequency_point_artifacts": progress_written_frequency_point_artifacts,
                "current_frequency_hz": progress["current_frequency_hz"],
                "partial_artifacts_available": emitted_frequency_point_count > 0,
                "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
            }
        )
    if omit_progress_schema_version:
        del progress["schema_version"]
    if omit_progress_json:
        progress.pop("progress_json", None)
    (root / "response" / "progress.v1.json").write_text(json.dumps(progress))
    if progress_status == "interrupted" and not omit_cancel_requested_artifact:
        cancel_requested = {
            **progress,
            "status": "cancel_requested",
            "state": "cancel_requested",
            "complete": False,
        }
        if isinstance(cancel_requested.get("progress_json"), str):
            cancel_progress_json = json.loads(cancel_requested["progress_json"])
            cancel_progress_json.update(
                {
                    "status": "cancel_requested",
                    "complete": False,
                    "state": "cancel_requested",
                }
            )
            cancel_requested["progress_json"] = json.dumps(cancel_progress_json)
        (root / "response" / "cancel_requested.v1.json").write_text(
            json.dumps(cancel_requested)
        )
    diagnostics: dict[str, object] = {
        "schema_version": "frequency_domain_response_diagnostics.v1",
        "status": diagnostics_status,
        "complete": diagnostics_complete,
        "matrix_form": "iomega_B_minus_L",
        "phasor_convention": manifest_phase_convention,
        "requested_execution_lane": execution_lane,
        "resolved_execution_lane": execution_lane,
        "validation_fallback_used": False,
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
    if omit_diagnostics_matrix_form:
        del diagnostics["matrix_form"]
    if omit_diagnostics_phasor_convention:
        del diagnostics["phasor_convention"]
    if include_static_periodic_diagnostics:
        diagnostics["static_periodic_projection"] = static_periodic_projection
        if static_periodic_node_pair_count is not None:
            diagnostics["static_periodic_node_pair_count"] = static_periodic_node_pair_count
        diagnostics["static_periodic_frame_max_mismatch"] = static_periodic_frame_max_mismatch
        diagnostics["static_periodic_drive_max_mismatch"] = static_periodic_drive_max_mismatch
    if include_floquet_phase_projection:
        floquet_k = (
            [1.0e6, 0.0, 0.0]
            if floquet_k_vector_rad_per_m is None
            else floquet_k_vector_rad_per_m
        )
        floquet_pair_translation = [1.0e-6, 0.0, 0.0]
        floquet_pair_phase = -sum(
            float(component) * float(translation)
            for component, translation in zip(floquet_k, floquet_pair_translation)
        )
        diagnostics["floquet_phase_projection"] = True
        diagnostics["floquet_real_imag_mixing"] = True
        if not omit_floquet_basis_transport_policy:
            diagnostics["basis_transport_policy"] = floquet_basis_transport_policy
        diagnostics["floquet_tangent_frame_max_mismatch"] = (
            floquet_tangent_frame_max_mismatch
        )
        diagnostics["floquet_tangent_transport_max_nonunitarity"] = (
            floquet_tangent_transport_max_nonunitarity
        )
        diagnostics["operator_terms_included"] = ["exchange", "zeeman"]
        diagnostics["exchange_edge_count"] = 1
        if not omit_floquet_metadata:
            diagnostics["floquet_periodic_pair_count"] = 1
            if not omit_floquet_k_vector_metadata:
                diagnostics["floquet_k_vector_rad_per_m"] = floquet_k
    (root / "response" / "diagnostics").mkdir(parents=True, exist_ok=True)
    (root / "response" / "diagnostics" / "solver.v1.json").write_text(
        json.dumps(diagnostics)
    )
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
    if include_floquet_phase_projection and not omit_floquet_pair_artifact:
        (root / "mesh").mkdir(parents=True, exist_ok=True)
        (root / "mesh" / "periodic_pairs.v1.json").write_text(
            json.dumps(
                {
                    "schema_version": "periodic_pairs.v1",
                    "source": "native_fem_frequency_domain_floquet_phase_projection",
                    "pair_count": 1,
                    "paired_node_count": 2,
                    "unpaired_source_count": 0,
                    "unpaired_destination_count": 0,
                    "validation_status": "ok",
                    "tolerance_m": 0.0,
                    "max_translation_residual_m": 0.0,
                    "residual_diagnostics": {
                        "max_translation_residual_m": 0.0,
                        "floquet_phase_loop_max_residual": 0.0,
                        "floquet_tangent_frame_max_mismatch": (
                            floquet_tangent_frame_max_mismatch
                        ),
                        "floquet_tangent_transport_max_nonunitarity": (
                            floquet_tangent_transport_max_nonunitarity
                        ),
                    },
                    "basis_transport_policy": floquet_basis_transport_policy,
                    "pairs": [
                        {
                            "pair_id": "x_faces",
                            "source_marker": "node:0",
                            "destination_marker": "node:1",
                            "node_a": 0,
                            "node_b": 1,
                            "expected_translation_m": floquet_pair_translation,
                            "translation_m": floquet_pair_translation,
                            "paired_node_count": 2,
                            "unpaired_source_count": 0,
                            "unpaired_destination_count": 0,
                            "translation_residual_m": 0.0,
                            "phase_rad": floquet_pair_phase,
                            "basis_transport_policy": floquet_basis_transport_policy,
                            "validation_status": "ok",
                        }
                    ],
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
        "analysis_family": "magnetic_frequency_domain",
        "study_product": "driven_response",
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
            "engine": manifest_engine,
            "native_backend": "native_mfem_matrix_free",
            "requested_execution_lane": execution_lane,
            "resolved_execution_lane": execution_lane,
            "lane_classification": sweep_v1_lane_classification,
            "reference_or_production": manifest_reference_or_production,
            "solver_library": "native_gmres",
            "solver_model": "matrix_free_gmres",
            "solve_kind": "direct_harmonic_response",
        },
        "artifacts": {
            "solver_diagnostics_path": "response/diagnostics/solver.v1.json",
            "response_diagnostics_v1_path": "response/diagnostics/solver.v1.json",
            "response_progress_v1_path": "response/progress.v1.json",
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
                "kind": "floquet"
                if include_floquet_phase_projection
                else "static_periodic"
                if include_static_periodic_diagnostics
                else "open",
            },
            "periodic_or_floquet": include_static_periodic_diagnostics
            or include_floquet_phase_projection,
        },
        "capabilities": {
            "production_solver_available": True,
            "production_native_solver_available": manifest_production_native_solver_available,
            "validation_artifact": manifest_validation_artifact,
            "dynamic_demag_k_available": False,
        },
        "diagnostics": {
            "completed_frequency_point_count": manifest_completed_frequency_count,
            "written_frequency_point_artifacts": manifest_written_frequency_point_artifacts,
            "requested_execution_lane": execution_lane,
            "resolved_execution_lane": execution_lane,
            "validation_fallback_used": False,
        },
        "resources": {
            "response_sweep_resource_key": (
                "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep"
            ),
            "response_diagnostics_resource_key": "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
            "response_progress_resource_key": "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
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
    if omit_manifest_progress_links:
        artifacts = manifest["artifacts"]
        resources = manifest["resources"]
        assert isinstance(artifacts, dict)
        assert isinstance(resources, dict)
        del artifacts["response_progress_v1_path"]
        del resources["response_progress_resource_key"]
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
    if include_floquet_phase_projection:
        artifacts = manifest["artifacts"]
        assert isinstance(artifacts, dict)
        if not omit_floquet_pair_artifact:
            artifacts["periodic_pairs_v1_path"] = "mesh/periodic_pairs.v1.json"
        manifest_diagnostics = manifest["diagnostics"]
        assert isinstance(manifest_diagnostics, dict)
        manifest_diagnostics["floquet_phase_projection"] = True
        manifest_diagnostics["floquet_real_imag_mixing"] = True
        if not omit_floquet_basis_transport_policy:
            manifest_diagnostics["basis_transport_policy"] = (
                floquet_basis_transport_policy
            )
        manifest_diagnostics["floquet_tangent_frame_max_mismatch"] = (
            floquet_tangent_frame_max_mismatch
        )
        manifest_diagnostics["floquet_tangent_transport_max_nonunitarity"] = (
            floquet_tangent_transport_max_nonunitarity
        )
        manifest_diagnostics["exchange_edge_count"] = 1
        if not omit_floquet_metadata:
            manifest_diagnostics["floquet_periodic_pair_count"] = 1
            if not omit_floquet_k_vector_metadata:
                manifest_diagnostics["floquet_k_vector_rad_per_m"] = floquet_k
    if omit_manifest_schema_version:
        del manifest["schema_version"]
    (root / "frequency_domain" / "manifest.v1.json").write_text(json.dumps(manifest))


def run_validator(
    root: Path,
    *,
    require_static_periodic: bool = False,
    require_floquet_phase_projection: bool = False,
    require_production_gpu: bool = False,
    require_periodic_airbox_gpu_unsupported: bool = False,
    require_floquet_airbox_gpu_unsupported: bool = False,
    require_periodic_airbox_cpu_demag_solved: bool = False,
    require_accepted_periodic_mesh_certificate: bool = False,
    require_m5_equilibrium_provenance: bool = False,
    require_frozen_magnetic_submesh: bool = False,
    parity_reference: Path | None = None,
    floquet_reciprocal_reference: Path | None = None,
    airbox_reference: Path | None = None,
    require_min_frequency_points: int | None = None,
    require_response_peak: bool = False,
    require_interior_response_peak: bool = False,
    require_field_payloads_for_frequency_points: bool = False,
    require_derived_peak_mode: bool = False,
    allow_interrupted: bool = False,
    allow_unavailable: bool = False,
    allow_solve_error: bool = False,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(VALIDATOR)]
    if require_static_periodic:
        command.append("--require-static-periodic")
    if require_floquet_phase_projection:
        command.append("--require-floquet-phase-projection")
    if require_production_gpu:
        command.append("--require-production-gpu")
    if require_periodic_airbox_gpu_unsupported:
        command.append("--require-periodic-airbox-gpu-unsupported")
    if require_floquet_airbox_gpu_unsupported:
        command.append("--require-floquet-airbox-gpu-unsupported")
    if require_periodic_airbox_cpu_demag_solved:
        command.append("--require-periodic-airbox-cpu-demag-solved")
    if require_accepted_periodic_mesh_certificate:
        command.append("--require-accepted-periodic-mesh-certificate")
    if require_m5_equilibrium_provenance:
        command.append("--require-m5-equilibrium-provenance")
    if require_frozen_magnetic_submesh:
        command.append("--require-frozen-magnetic-submesh")
    if parity_reference is not None:
        command.extend(["--compare-reference", str(parity_reference)])
    if floquet_reciprocal_reference is not None:
        command.extend(
            ["--compare-floquet-reciprocal-reference", str(floquet_reciprocal_reference)]
        )
    if airbox_reference is not None:
        command.extend(["--compare-airbox-reference", str(airbox_reference)])
    if require_min_frequency_points is not None:
        command.extend(["--require-min-frequency-points", str(require_min_frequency_points)])
    if require_response_peak:
        command.append("--require-response-peak")
    if require_interior_response_peak:
        command.append("--require-interior-response-peak")
    if require_field_payloads_for_frequency_points:
        command.append("--require-field-payloads-for-frequency-points")
    if require_derived_peak_mode:
        command.append("--require-derived-peak-mode")
    if allow_interrupted:
        command.append("--allow-interrupted")
    if allow_unavailable:
        command.append("--allow-unavailable")
    if allow_solve_error:
        command.append("--allow-solve-error")
    command.append(str(root))
    return subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env={**os.environ, **env} if env is not None else None,
    )


def set_periodic_airbox_flux_residual(root: Path, value: float) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["delta_phi_flux_max_residual"] = value
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["delta_phi_flux_max_residual"] = value
    manifest["physics"]["delta_phi_flux_max_residual"] = value
    manifest_path.write_text(json.dumps(manifest))

    for point_path in sorted((root / "response" / "frequency_points").glob("frequency_*.json")):
        point = json.loads(point_path.read_text())
        point["demag_contribution"]["delta_phi_flux_max_residual"] = value
        point_path.write_text(json.dumps(point))


def mutate_periodic_mesh_certificate_copies(
    root: Path,
    field_name: str,
    value: object,
) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["input_preflight"]["periodic_mesh_certificate"][field_name] = value
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["input_preflight"]["periodic_mesh_certificate"][
        field_name
    ] = value
    manifest_path.write_text(json.dumps(manifest))

    for point_path in sorted((root / "response" / "frequency_points").glob("frequency_*.json")):
        point = json.loads(point_path.read_text())
        point["demag_contribution"]["input_preflight"]["periodic_mesh_certificate"][
            field_name
        ] = value
        point_path.write_text(json.dumps(point))


def mark_fixture_as_gpu_dynamic_demag(root: Path, *, source: str | None) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["operator_terms_included"] = ["exchange", "zeeman", "demag"]
    if source is None:
        diagnostics.pop("demag_tangent_operator_source", None)
    else:
        diagnostics["demag_tangent_operator_source"] = source
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["operator_terms_included"] = ["exchange", "zeeman", "demag"]
    if source is None:
        manifest["diagnostics"].pop("demag_tangent_operator_source", None)
    else:
        manifest["diagnostics"]["demag_tangent_operator_source"] = source
    manifest_path.write_text(json.dumps(manifest))


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
                "current_frequency_hz": None,
                "partial_artifacts_available": False,
                "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
                "progress_json": json.dumps(
                    {
                        "schema_version": "frequency_domain_sweep_progress.v1",
                        "status": "unavailable",
                        "complete": False,
                        "state": "unavailable",
                        "total_frequency_points": 2,
                        "completed_frequency_points": 0,
                        "written_frequency_point_artifacts": 0,
                        "current_frequency_hz": None,
                        "partial_artifacts_available": False,
                        "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
                    }
                ),
            }
        )
    )
    unavailable_diagnostics = {
        "schema_version": "frequency_domain_response_diagnostics.v1",
        "status": "unavailable",
        "complete": False,
        "solver_kind": "production_unavailable",
        "requested_frequency_count": 2,
        "completed_frequency_point_count": 0,
        "written_frequency_point_artifacts": 0,
    }
    (root / "response" / "diagnostics").mkdir(parents=True, exist_ok=True)
    (root / "response" / "diagnostics" / "solver.v1.json").write_text(
        json.dumps(unavailable_diagnostics)
    )
    (root / "response" / "diagnostics.v1.json").write_text(
        json.dumps(unavailable_diagnostics)
    )
    (root / "frequency_domain" / "manifest.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "frequency_domain_manifest.v1",
                "analysis_family": "magnetic_frequency_domain",
                "study_product": "driven_response",
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
                    "solver_diagnostics_path": "response/diagnostics/solver.v1.json",
                    "response_diagnostics_v1_path": "response/diagnostics/solver.v1.json",
                    "response_progress_v1_path": "response/progress.v1.json",
                    "response_cancel_requested_v1_path": None,
                    "response_map_v1_path": None,
                    "response_map_v2_path": None,
                    "frequency_point_paths": [],
                },
                "resources": {
                    "response_progress_resource_key": "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
                    "response_diagnostics_resource_key": "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
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


def write_periodic_airbox_gpu_unavailable_fixture(root: Path) -> None:
    write_unavailable_frequency_domain_fixture(root)
    progress_path = root / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress.update(
        {
            "written_frequency_point_artifacts": 2,
            "partial_artifacts_available": True,
        }
    )
    progress_json = json.loads(progress["progress_json"])
    progress_json["written_frequency_point_artifacts"] = 2
    progress_json["partial_artifacts_available"] = True
    progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.update(
        {
            "requested_execution_lane": "production_gpu",
            "resolved_execution_lane": "unavailable",
            "unsupported_reason": "periodic_airbox_dynamic_demag_gpu_unsupported",
            "validation_fallback_used": False,
            "dense_block_real_solver": False,
            "periodic_airbox_coupled_block_solver": False,
            "mfem_coupled_block_assembly": False,
            "requested_magnetostatic_bc": "periodic_airbox_k0",
            "resolved_magnetostatic_bc": "periodic_airbox_k0",
            "magnetic_periodic_constraint_set_count": 1,
            "magnetostatic_periodic_constraint_set_count": 1,
            "delta_m_tangent_dof_count": 6,
            "delta_phi_dof_count": 3,
            "magnetostatic_periodic_node_pair_count": 3,
            "written_frequency_point_artifacts": 2,
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["revision"] = "periodic-airbox-gpu-unavailable-v1"
    manifest["unsupported_reason"] = "periodic_airbox_dynamic_demag_gpu_unsupported"
    manifest["requested_execution"]["frequency_count"] = 2
    manifest["resolved_execution"].update(
        {
            "requested_execution_lane": "production_gpu",
            "resolved_execution_lane": "unavailable",
            "lane_classification": "fem_gpu_production",
        }
    )
    manifest["physics"].update(
        {
            "spin_wave_bc": {"kind": "periodic"},
            "periodic_or_floquet": True,
            "requested_magnetostatic_bc": "periodic_airbox_k0",
            "resolved_magnetostatic_bc": "periodic_airbox_k0",
            "magnetic_periodic_constraint_set_count": 1,
            "magnetostatic_periodic_constraint_set_count": 1,
            "delta_m_tangent_dof_count": 6,
            "delta_phi_dof_count": 3,
            "magnetostatic_periodic_node_pair_count": 3,
            "coupled_complex_dof_count": 9,
        }
    )
    manifest["artifacts"]["periodic_pairs_v1_path"] = "mesh/periodic_pairs.v1.json"
    manifest["artifacts"]["frequency_point_paths"] = [
        "response/frequency_points/frequency_0000.json",
        "response/frequency_points/frequency_0001.json",
    ]
    manifest["diagnostics"].update(
        {
            "requested_execution_lane": "production_gpu",
            "resolved_execution_lane": "unavailable",
            "unsupported_reason": "periodic_airbox_dynamic_demag_gpu_unsupported",
            "validation_fallback_used": False,
            "periodic_airbox_coupled_block_solver": False,
            "mfem_coupled_block_assembly": False,
            "requested_magnetostatic_bc": "periodic_airbox_k0",
            "resolved_magnetostatic_bc": "periodic_airbox_k0",
            "magnetic_periodic_constraint_set_count": 1,
            "magnetostatic_periodic_constraint_set_count": 1,
            "delta_m_tangent_dof_count": 6,
            "delta_phi_dof_count": 3,
            "magnetostatic_periodic_node_pair_count": 3,
            "written_frequency_point_artifacts": 2,
        }
    )
    manifest["capabilities"].update(
        {
            "validation_fallback_used": False,
            "gpu_available": True,
        }
    )
    manifest_path.write_text(json.dumps(manifest))

    (root / "mesh").mkdir(parents=True, exist_ok=True)
    (root / "mesh" / "periodic_pairs.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "periodic_pairs.v1",
                "source": "native_fem_frequency_domain_unavailable",
                "validation_status": "unavailable",
                "unsupported_reason": "periodic_airbox_dynamic_demag_gpu_unsupported",
                "pair_count": 3,
                "paired_node_count": 6,
                "pairs": [
                    {
                        "pair_id": "magnetostatic-delta-phi-0000",
                        "pair_family": "magnetostatic_delta_phi",
                        "unknown_family": "delta_phi",
                    }
                ],
            }
        )
    )
    (root / "response" / "frequency_points").mkdir(parents=True, exist_ok=True)
    for index in range(2):
        (root / "response" / "frequency_points" / f"frequency_{index:04d}.json").write_text(
            json.dumps(
                {
                    "schema_version": "frequency_domain_point.v1",
                    "frequency_index": index,
                    "frequency_hz": float(index + 1) * 1.0e9,
                    "status": "unavailable",
                    "complete": False,
                    "requested_magnetostatic_bc": "periodic_airbox_k0",
                    "resolved_magnetostatic_bc": "periodic_airbox_k0",
                    "delta_m_tangent_dof_count": 6,
                    "delta_phi_dof_count": 3,
                    "coupled_complex_dof_count": 9,
                    "m_complex": None,
                    "demag_contribution": {
                        "status": "unavailable",
                        "delta_phi_complex": None,
                        "h_demag_complex": None,
                        "energy_density": None,
                        "operator_source": "unassembled_mfem_periodic_airbox_coupled_block",
                        "mfem_coupled_block_assembly": False,
                        "unsupported_reason": "periodic_airbox_dynamic_demag_gpu_unsupported",
                    },
                }
            )
        )


def write_floquet_airbox_gpu_unavailable_fixture(root: Path) -> None:
    write_periodic_airbox_gpu_unavailable_fixture(root)
    reason = "floquet_airbox_dynamic_demag_gpu_unsupported"
    floquet_k = [1.0e6, 0.0, 0.0]

    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.update(
        {
            "unsupported_reason": reason,
            "requested_magnetostatic_bc": "floquet_airbox",
            "resolved_magnetostatic_bc": "floquet_airbox",
            "floquet_k_vector_rad_per_m": floquet_k,
            "floquet_periodic_pair_count": 1,
            "delta_phi_flux_validation_status": "not_evaluated",
            "delta_phi_flux_validation_reason": reason,
            "written_frequency_point_artifacts": 0,
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["revision"] = "floquet-airbox-gpu-unavailable-v1"
    manifest["unsupported_reason"] = reason
    manifest["physics"].update(
        {
            "spin_wave_bc": {
                "kind": "floquet",
                "pair_ids": ["x_faces"],
                "k_vector_rad_per_m": floquet_k,
                "phase_convention": "exp_minus_i_k_dot_delta_r",
            },
            "periodic_or_floquet": True,
            "requested_magnetostatic_bc": "floquet_airbox",
            "resolved_magnetostatic_bc": "floquet_airbox",
        }
    )
    manifest["diagnostics"].update(
        {
            "unsupported_reason": reason,
            "requested_magnetostatic_bc": "floquet_airbox",
            "resolved_magnetostatic_bc": "floquet_airbox",
            "floquet_k_vector_rad_per_m": floquet_k,
            "floquet_periodic_pair_count": 1,
            "delta_phi_flux_validation_status": "not_evaluated",
            "delta_phi_flux_validation_reason": reason,
            "written_frequency_point_artifacts": 0,
        }
    )
    manifest["artifacts"]["frequency_point_paths"] = []
    manifest_path.write_text(json.dumps(manifest))

    periodic_pairs_path = root / "mesh" / "periodic_pairs.v1.json"
    periodic_pairs = json.loads(periodic_pairs_path.read_text())
    periodic_pairs.update(
        {
            "source": "native_fem_frequency_domain_floquet_airbox_unavailable",
            "unsupported_reason": reason,
            "floquet_k_vector_rad_per_m": floquet_k,
            "phase_convention": "exp_minus_i_k_dot_delta_r",
        }
    )
    periodic_pairs["pairs"] = [
        {
            "pair_id": "magnetostatic-delta-phi-0000",
            "pair_family": "magnetostatic_delta_phi",
            "unknown_family": "delta_phi",
            "phase_rad": -0.04,
            "translation_m": [40e-9, 0.0, 0.0],
            "expected_translation_m": [40e-9, 0.0, 0.0],
            "phase_validation_status": "ok",
            "delta_phi_flux_validation_status": "not_evaluated",
        }
    ]
    periodic_pairs_path.write_text(json.dumps(periodic_pairs))

    progress_path = root / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress["written_frequency_point_artifacts"] = 0
    progress_json = json.loads(progress["progress_json"])
    progress_json["written_frequency_point_artifacts"] = 0
    progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    for point_path in sorted((root / "response" / "frequency_points").glob("frequency_*.json")):
        point = json.loads(point_path.read_text())
        point.update(
            {
                "requested_magnetostatic_bc": "floquet_airbox",
                "resolved_magnetostatic_bc": "floquet_airbox",
                "floquet_k_vector_rad_per_m": floquet_k,
            }
        )
        point["demag_contribution"].update(
            {
                "operator_source": "unassembled_mfem_floquet_airbox_coupled_block",
                "unsupported_reason": reason,
            }
        )
        point_path.write_text(json.dumps(point))


def write_periodic_airbox_cpu_demag_solved_fixture(
    root: Path,
    *,
    frequency_point_count: int = 1,
    exchange_edge_count: int = 4,
) -> None:
    write_frequency_domain_fixture(
        root,
        emitted_frequency_point_count=frequency_point_count,
        progress_total_frequency_points=frequency_point_count,
        progress_completed_frequency_points=frequency_point_count,
        progress_written_frequency_point_artifacts=frequency_point_count,
        diagnostics_completed_frequency_point_count=frequency_point_count,
        manifest_completed_frequency_count=frequency_point_count,
        manifest_written_frequency_point_artifacts=frequency_point_count,
        sweep_v2_point_count=frequency_point_count,
    )
    progress_path = root / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress["demag_mode"] = "periodic_airbox_k0"
    progress.update(
        {
            "native_frequency_index": max(frequency_point_count - 1, 0),
            "native_iteration_count": 4,
            "native_max_iterations_for_frequency": 8,
            "native_current_frequency_solve_fraction": 1.0,
            "native_residual_l2_norm": 1.0e-9,
            "native_relative_residual_l2_norm": 1.0e-9,
            "native_converged": True,
        }
    )
    progress_json = (
        json.loads(progress["progress_json"])
        if isinstance(progress.get("progress_json"), str)
        else {
            "schema_version": "frequency_domain_sweep_progress.v1",
            "state": progress.get("state"),
            "total_frequency_points": progress.get("total_frequency_points"),
            "completed_frequency_points": progress.get("completed_frequency_points"),
            "written_frequency_point_artifacts": progress.get(
                "written_frequency_point_artifacts"
            ),
            "current_frequency_hz": progress.get("current_frequency_hz"),
            "partial_artifacts_available": progress.get(
                "partial_artifacts_available"
            ),
            "latest_artifact_manifest_path": progress.get(
                "latest_artifact_manifest_path"
            ),
        }
    )
    progress_json["demag_mode"] = "periodic_airbox_k0"
    progress_json.update(
        {
            "native_frequency_index": progress["native_frequency_index"],
            "native_iteration_count": progress["native_iteration_count"],
            "native_max_iterations_for_frequency": progress[
                "native_max_iterations_for_frequency"
            ],
            "native_current_frequency_solve_fraction": progress[
                "native_current_frequency_solve_fraction"
            ],
            "native_residual_l2_norm": progress["native_residual_l2_norm"],
            "native_relative_residual_l2_norm": progress[
                "native_relative_residual_l2_norm"
            ],
            "native_converged": progress["native_converged"],
        }
    )
    progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    preconditioner_kind = (
        "mfem_tangent_graph_demag_coarse_right"
        if exchange_edge_count > 0
        else "mfem_tangent_demag_coarse_right"
    )
    preconditioner_variant = (
        "graph_demag_coarse"
        if exchange_edge_count > 0
        else "demag_coarse"
    )
    periodic_mesh_certificate = {
        "schema_version": "periodic_mesh_certificate.v5",
        "artifact_role": "frequency_response_input_preflight_candidate",
        "magnetic_pair_count": 1,
        "airbox_pair_count": 1,
        "magnetic_pair_map_sha256": "sha256:"
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "airbox_pair_map_sha256": "sha256:"
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "pair_map_hash_canonicalization": "periodic_mesh_certificate_pair_map.v1",
        "tangent_frame_transfer_required": True,
        "tangent_frame_transfer_artifact_status": "pending_native_certificate_consumption",
    }
    input_preflight = {
        "schema_version": "frequency_response_input_preflight.v1",
        "status": "ok",
        "periodic_mesh_certificate": periodic_mesh_certificate,
    }
    coupled_block_norms = {
        "rhs_delta_m_l2_norm": 1.0,
        "rhs_delta_phi_l2_norm": 0.0,
        "residual_delta_m_l2_norm": 0.5,
        "residual_delta_phi_l2_norm": 0.0,
        "relative_residual_delta_m_l2_norm": 0.5,
        "relative_residual_delta_phi_l2_norm": 0.0,
        "response_delta_m_l2_norm": 1.0,
        "response_delta_phi_l2_norm": 0.0,
    }
    diagnostics.update(
        {
            "requested_execution_lane": "production_cpu",
            "resolved_execution_lane": "production_cpu",
            "validation_fallback_used": False,
            "periodic_airbox_coupled_block_solver": False,
            "mfem_coupled_block_assembly": False,
            "dynamic_demag_matrix_form": "magnetic_only",
            "demag_tangent_operator_source": "matrix_free_demag_tangent_provider",
            "demag_tangent_linearity_check": True,
            "demag_tangent_additivity_max_abs_error": 0.0,
            "demag_tangent_homogeneity_max_abs_error": 0.0,
            "demag_tangent_additivity_relative_error": 0.0,
            "demag_tangent_homogeneity_relative_error": 0.0,
            "krylov_preconditioner_kind": preconditioner_kind,
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": preconditioner_variant,
            "krylov_preconditioner_variant": preconditioner_variant,
            "krylov_preconditioner_applied": True,
            "krylov_preconditioner_setup_status": "ok",
            "graph_preconditioner_relaxation": graph_preconditioner_relaxation_for_variant(
                preconditioner_variant
            ),
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 0.25,
            "right_preconditioner_probe_relative_residual_l2_norm": 0.25,
            "right_preconditioner_auto_disabled": False,
            "right_preconditioner_probe_disable_relative_threshold": 0.0,
            "right_preconditioner_auto_disable_reason": "",
            "frequency_response_demag_solver_policy_effective": {
                "relative_tolerance": 1.0e-4,
                "max_iterations": 1000,
            },
            "demag_solver_relative_tolerance": 1.0e-4,
            "demag_solver_max_iterations": 1000,
            "gmres_relative_residual_history": [1.0, 0.5],
            "total_iteration_count": 4,
            "max_iterations_for_frequency": 8,
            "restart_iterations_for_frequency": 8,
            "progress_interval_iterations": 2,
            "last_tracked_relative_residual_l2_norm": 0.5,
            "last_recomputed_relative_residual_l2_norm": 0.5,
            "residual_consistency_status": "ok",
            "residual_consistency_relative_gap": 0.0,
            "residual_consistency_recomputed_to_tracked_ratio": 1.0,
            "residual_consistency_relative_gap_threshold": 0.1,
            "block_norms": {
                "rhs_real_l2_norm": 1.0,
                "rhs_imag_l2_norm": 0.0,
                "residual_real_l2_norm": 0.5,
                "residual_imag_l2_norm": 0.0,
                "response_real_l2_norm": 1.0,
                "response_imag_l2_norm": 0.0,
            },
            "coupled_residual_partition_status": "magnetic_only_demag_tangent_provider",
            "coupled_block_norms": coupled_block_norms,
            "requested_magnetostatic_bc": "periodic_airbox_k0",
            "resolved_magnetostatic_bc": "periodic_airbox_k0",
            "magnetic_periodic_constraint_set_count": 1,
            "magnetostatic_periodic_constraint_set_count": 1,
            "delta_m_tangent_dof_count": 2,
            "delta_phi_dof_count": 1,
            "magnetostatic_periodic_node_pair_count": 1,
            "exchange_edge_count": exchange_edge_count,
            "delta_phi_phase_validation_status": "ok",
            "delta_phi_phase_max_residual": 0.0,
            "delta_phi_seam_validation_status": "ok",
            "delta_phi_seam_max_after_offset": 0.0,
            "delta_phi_seam_best_constant_offset_real": 0.0,
            "delta_phi_seam_best_constant_offset_imag": 0.0,
            "h_demag_seam_validation_status": "ok",
            "h_demag_seam_validation_reason": "evaluated_tangent_periodic_pairs",
            "h_demag_seam_max_tangent_mismatch": 0.0,
            "delta_phi_flux_validation_status": "ok",
            "delta_phi_flux_validation_reason": "evaluated_periodic_airbox_normal_flux",
            "delta_phi_flux_max_residual": 0.0,
            "input_preflight": input_preflight,
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["physics"].update(
        {
            "spin_wave_bc": {"kind": "periodic"},
            "periodic_or_floquet": True,
            "requested_magnetostatic_bc": "periodic_airbox_k0",
            "resolved_magnetostatic_bc": "periodic_airbox_k0",
            "magnetic_periodic_constraint_set_count": 1,
            "magnetostatic_periodic_constraint_set_count": 1,
            "delta_m_tangent_dof_count": 2,
            "delta_phi_dof_count": 1,
            "magnetostatic_periodic_node_pair_count": 1,
            "delta_phi_phase_validation_status": "ok",
            "delta_phi_phase_max_residual": 0.0,
            "delta_phi_seam_validation_status": "ok",
            "delta_phi_seam_max_after_offset": 0.0,
            "delta_phi_seam_best_constant_offset_real": 0.0,
            "delta_phi_seam_best_constant_offset_imag": 0.0,
            "h_demag_seam_validation_status": "ok",
            "h_demag_seam_validation_reason": "evaluated_tangent_periodic_pairs",
            "h_demag_seam_max_tangent_mismatch": 0.0,
            "delta_phi_flux_validation_status": "ok",
            "delta_phi_flux_validation_reason": "evaluated_periodic_airbox_normal_flux",
            "delta_phi_flux_max_residual": 0.0,
        }
    )
    manifest["diagnostics"].update(
        {
            "requested_execution_lane": "production_cpu",
            "resolved_execution_lane": "production_cpu",
            "validation_fallback_used": False,
            "periodic_airbox_coupled_block_solver": False,
            "mfem_coupled_block_assembly": False,
            "dynamic_demag_matrix_form": "magnetic_only",
            "demag_tangent_operator_source": "matrix_free_demag_tangent_provider",
            "demag_tangent_linearity_check": True,
            "demag_tangent_additivity_max_abs_error": 0.0,
            "demag_tangent_homogeneity_max_abs_error": 0.0,
            "demag_tangent_additivity_relative_error": 0.0,
            "demag_tangent_homogeneity_relative_error": 0.0,
            "krylov_preconditioner_kind": preconditioner_kind,
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": preconditioner_variant,
            "krylov_preconditioner_variant": preconditioner_variant,
            "krylov_preconditioner_applied": True,
            "krylov_preconditioner_setup_status": "ok",
            "graph_preconditioner_relaxation": graph_preconditioner_relaxation_for_variant(
                preconditioner_variant
            ),
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 0.25,
            "right_preconditioner_probe_relative_residual_l2_norm": 0.25,
            "right_preconditioner_auto_disabled": False,
            "right_preconditioner_probe_disable_relative_threshold": 0.0,
            "right_preconditioner_auto_disable_reason": "",
            "frequency_response_demag_solver_policy_effective": {
                "relative_tolerance": 1.0e-4,
                "max_iterations": 1000,
            },
            "demag_solver_relative_tolerance": 1.0e-4,
            "demag_solver_max_iterations": 1000,
            "gmres_relative_residual_history": [1.0, 0.5],
            "total_iteration_count": 4,
            "max_iterations_for_frequency": 8,
            "restart_iterations_for_frequency": 8,
            "progress_interval_iterations": 2,
            "last_tracked_relative_residual_l2_norm": 0.5,
            "last_recomputed_relative_residual_l2_norm": 0.5,
            "residual_consistency_status": "ok",
            "residual_consistency_relative_gap": 0.0,
            "residual_consistency_recomputed_to_tracked_ratio": 1.0,
            "residual_consistency_relative_gap_threshold": 0.1,
            "block_norms": {
                "rhs_real_l2_norm": 1.0,
                "rhs_imag_l2_norm": 0.0,
                "residual_real_l2_norm": 0.5,
                "residual_imag_l2_norm": 0.0,
                "response_real_l2_norm": 1.0,
                "response_imag_l2_norm": 0.0,
            },
            "coupled_residual_partition_status": "magnetic_only_demag_tangent_provider",
            "coupled_block_norms": coupled_block_norms,
            "requested_magnetostatic_bc": "periodic_airbox_k0",
            "resolved_magnetostatic_bc": "periodic_airbox_k0",
            "magnetic_periodic_constraint_set_count": 1,
            "magnetostatic_periodic_constraint_set_count": 1,
            "delta_m_tangent_dof_count": 2,
            "delta_phi_dof_count": 1,
            "magnetostatic_periodic_node_pair_count": 1,
            "exchange_edge_count": exchange_edge_count,
            "delta_phi_phase_validation_status": "ok",
            "delta_phi_phase_max_residual": 0.0,
            "delta_phi_seam_validation_status": "ok",
            "delta_phi_seam_max_after_offset": 0.0,
            "delta_phi_seam_best_constant_offset_real": 0.0,
            "delta_phi_seam_best_constant_offset_imag": 0.0,
            "h_demag_seam_validation_status": "ok",
            "h_demag_seam_validation_reason": "evaluated_tangent_periodic_pairs",
            "h_demag_seam_max_tangent_mismatch": 0.0,
            "delta_phi_flux_validation_status": "ok",
            "delta_phi_flux_validation_reason": "evaluated_periodic_airbox_normal_flux",
            "delta_phi_flux_max_residual": 0.0,
            "input_preflight": input_preflight,
        }
    )
    manifest["resolved_execution"]["dynamic_demag_matrix_form"] = "magnetic_only"
    manifest["capabilities"]["dynamic_demag_matrix_form"] = "magnetic_only"
    manifest_path.write_text(json.dumps(manifest))

    for index in range(frequency_point_count):
        point_path = root / "response" / "frequency_points" / f"frequency_{index:04d}.json"
        point = json.loads(point_path.read_text())
        point.update(
            {
                "requested_magnetostatic_bc": "periodic_airbox_k0",
                "resolved_magnetostatic_bc": "periodic_airbox_k0",
                "delta_m_tangent_dof_count": 2,
                "delta_phi_dof_count": 1,
                "demag_contribution": {
                    "status": "solved",
                    "operator_source": "matrix_free_demag_tangent_provider",
                    "dynamic_demag_matrix_form": "magnetic_only",
                    "mfem_coupled_block_assembly": False,
                    "input_preflight": input_preflight,
                    "delta_phi_phase_validation_status": "ok",
                    "delta_phi_phase_max_residual": 0.0,
                    "delta_phi_seam_validation_status": "ok",
                    "delta_phi_seam_max_after_offset": 0.0,
                    "delta_phi_seam_best_constant_offset_real": 0.0,
                    "delta_phi_seam_best_constant_offset_imag": 0.0,
                    "h_demag_seam_validation_status": "ok",
                    "h_demag_seam_validation_reason": "evaluated_tangent_periodic_pairs",
                    "h_demag_seam_max_tangent_mismatch": 0.0,
                    "delta_phi_flux_validation_status": "ok",
                    "delta_phi_flux_validation_reason": "evaluated_periodic_airbox_normal_flux",
                    "delta_phi_flux_max_residual": 0.0,
                    "delta_phi_complex": None,
                    "h_demag_complex": [[0.0, 0.0], [0.0, 0.0]],
                },
            }
        )
        point_path.write_text(json.dumps(point))


def add_m5_equilibrium_provenance_fixture(root: Path) -> None:
    source_root = root / "m5_equilibrium_artifacts"
    (source_root / "diagnostics").mkdir(parents=True, exist_ok=True)
    (source_root / "reports").mkdir(parents=True, exist_ok=True)
    (source_root / "m_final.json").write_text(json.dumps({"m": [[1.0, 0.0, 0.0]]}))
    (source_root / "diagnostics" / "fem_static_pbc_demag_seams.v1.json").write_text(
        json.dumps({"schema_version": "fem_static_pbc_demag_seams.v1", "status": "ok"})
    )
    (source_root / "reports" / "z_padding_validation.v1.json").write_text(
        json.dumps({"schema_version": "fem_static_pbc_z_padding_validation.v1", "status": "ok"})
    )
    (source_root / "reports" / "supercell_validation.v1.json").write_text(
        json.dumps({"schema_version": "fem_static_pbc_supercell_validation.v1", "status": "ok"})
    )
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["equilibrium_provenance"] = {
        "schema_version": "fem_frequency_domain_equilibrium_provenance.v1",
        "acceptance_gate": "M5_static_pbc_demag_equilibrium",
        "accepted": True,
        "source_kind": "m5_static_pbc_demag_equilibrium",
        "source_artifact_root": str(source_root),
        "equilibrium_field_path": "m_final.json",
        "seam_diagnostics_path": "diagnostics/fem_static_pbc_demag_seams.v1.json",
        "z_padding_report_path": "reports/z_padding_validation.v1.json",
        "supercell_report_path": "reports/supercell_validation.v1.json",
        "magnetostatic_bc": "periodic_airbox_k0",
        "pbc_axes": ["x", "y"],
    }
    manifest_path.write_text(json.dumps(manifest))


def write_periodic_airbox_cpu_demag_solve_error_fixture(root: Path) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(
        root,
        frequency_point_count=0,
        exchange_edge_count=0,
    )
    (root / "mesh").mkdir(parents=True, exist_ok=True)
    (root / "mesh" / "periodic_pairs.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "periodic_pairs.v1",
                "pair_count": 1,
                "unpaired_source_count": 0,
                "unpaired_destination_count": 0,
                "max_translation_residual_m": 0.0,
                "residual_diagnostics": {
                    "max_translation_residual_m": 0.0,
                    "floquet_phase_loop_max_residual": 0.0,
                },
                "pairs": [
                    {
                        "pair_id": "x0",
                        "validation_status": "ok",
                        "node_a": 0,
                        "node_b": 1,
                        "translation_m": [2.0e-7, 0.0, 0.0],
                        "expected_translation_m": [2.0e-7, 0.0, 0.0],
                        "translation_residual_m": 0.0,
                        "phase_rad": 0.0,
                    }
                ],
            }
        )
    )
    progress_path = root / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress.update(
        {
            "status": "solve_error",
            "complete": False,
            "state": "solve_error",
            "total_frequency_points": 1,
            "completed_frequency_points": 0,
            "written_frequency_point_artifacts": 0,
            "partial_artifacts_available": True,
            "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
            "current_frequency_hz": 2.75e9,
            "native_frequency_index": 0,
            "native_iteration_count": 8,
            "native_max_iterations_for_frequency": 8,
            "native_current_frequency_solve_fraction": 1.0,
            "native_residual_l2_norm": 25.0,
            "native_relative_residual_l2_norm": 0.95,
            "native_converged": False,
            "demag_mode": "periodic_airbox_k0",
            "progress_json": json.dumps(
                {
                    "schema_version": "frequency_domain_sweep_progress.v1",
                    "status": "solve_error",
                    "complete": False,
                    "state": "solve_error",
                    "total_frequency_points": 1,
                    "completed_frequency_points": 0,
                    "written_frequency_point_artifacts": 0,
                    "partial_artifacts_available": True,
                    "latest_artifact_manifest_path": "frequency_domain/manifest.v1.json",
                    "current_frequency_hz": 2.75e9,
                    "native_frequency_index": 0,
                    "native_iteration_count": 8,
                    "native_max_iterations_for_frequency": 8,
                    "native_current_frequency_solve_fraction": 1.0,
                    "native_residual_l2_norm": 25.0,
                    "native_relative_residual_l2_norm": 0.95,
                    "native_converged": False,
                    "demag_mode": "periodic_airbox_k0",
                }
            ),
        }
    )
    progress_path.write_text(json.dumps(progress))

    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.update(
        {
            "status": "solve_error",
            "complete": False,
            "completed_frequency_point_count": 0,
            "written_frequency_point_artifacts": 0,
            "total_iteration_count": 8,
            "max_iterations_for_frequency": 8,
            "restart_iterations_for_frequency": 8,
            "progress_interval_iterations": 8,
            "solver_relative_tolerance": 1.0e-3,
            "rhs_l2_norm": 1.0,
            "initial_relative_residual_l2_norm": 1.0,
            "relative_residual_l2_norm": 0.95,
            "last_tracked_relative_residual_l2_norm": 0.5,
            "last_recomputed_relative_residual_l2_norm": 0.95,
            "residual_consistency_status": "degraded",
            "residual_consistency_relative_gap": (0.95 - 0.5) / 0.95,
            "residual_consistency_recomputed_to_tracked_ratio": 1.9,
            "residual_consistency_relative_gap_threshold": 0.1,
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.update({"status": "solve_error", "complete": False})
    manifest["requested_execution"]["frequency_count"] = 1
    manifest["artifacts"]["frequency_point_paths"] = []
    manifest["resources"]["response_field_resources"] = []
    manifest["diagnostics"].update(diagnostics)
    for section in (manifest, manifest["diagnostics"], manifest["physics"]):
        section["domain_mesh_mode"] = "generated_frozen_magnetic_submesh"
    manifest_path.write_text(json.dumps(manifest))


def convert_solve_error_fixture_to_stagnated_early_stop(root: Path) -> None:
    progress_path = root / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress.update(
        {
            "native_iteration_count": 256,
            "native_max_iterations_for_frequency": 8192,
            "native_current_frequency_solve_fraction": 256.0 / 8192.0,
            "native_residual_l2_norm": 0.95,
            "native_relative_residual_l2_norm": 0.95,
        }
    )
    progress_json = json.loads(progress["progress_json"])
    progress_json.update(
        {
            "native_iteration_count": 256,
            "native_max_iterations_for_frequency": 8192,
            "native_current_frequency_solve_fraction": 256.0 / 8192.0,
            "native_residual_l2_norm": 0.95,
            "native_relative_residual_l2_norm": 0.95,
        }
    )
    progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.update(
        {
            "total_iteration_count": 256,
            "max_iterations_for_frequency": 8192,
            "restart_iterations_for_frequency": 512,
            "progress_interval_iterations": 64,
            "gmres_relative_residual_history": [1.0, 0.96, 0.95],
            "initial_relative_residual_l2_norm": 1.0,
            "relative_residual_l2_norm": 0.95,
            "last_tracked_relative_residual_l2_norm": 0.95,
            "last_recomputed_relative_residual_l2_norm": 0.95,
            "residual_consistency_status": "ok",
            "residual_consistency_relative_gap": 0.0,
            "residual_consistency_recomputed_to_tracked_ratio": 1.0,
            "stop_reason": "stagnated",
            "stagnation_detected": True,
            "stagnation_iteration": 256,
            "stagnation_relative_residual_ratio": 0.95,
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].update(diagnostics)
    manifest_path.write_text(json.dumps(manifest))


def convert_periodic_airbox_fixture_to_schur_coupled_block(root: Path) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    for key in [
        "demag_tangent_operator_source",
        "demag_tangent_linearity_check",
        "demag_tangent_additivity_max_abs_error",
        "demag_tangent_homogeneity_max_abs_error",
        "demag_tangent_additivity_relative_error",
        "demag_tangent_homogeneity_relative_error",
        "block_norms",
    ]:
        diagnostics.pop(key, None)
    exchange_edge_count = diagnostics.get("exchange_edge_count", 0)
    preconditioner_variant = (
        "graph_demag_coarse"
        if isinstance(exchange_edge_count, int) and exchange_edge_count > 0
        else "demag_coarse"
    )
    preconditioner_kind = (
        "static_periodic_reduced_mfem_schur_residual_right"
        if preconditioner_variant == "graph_demag_coarse"
        else "mfem_tangent_demag_coarse_right"
    )
    diagnostics.update(
        {
            "periodic_airbox_coupled_block_solver": True,
            "dynamic_demag_operator_source": "matrix_free_mfem_demag_phi_consistency_schur_provider",
            "dynamic_demag_matrix_form": "schur_phi_consistency_provider",
            "coupled_residual_partition_status": "magnetic_schur_phi_consistency_provider",
            "krylov_preconditioner_kind": preconditioner_kind,
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": preconditioner_variant,
            "krylov_preconditioner_variant": preconditioner_variant,
            "graph_preconditioner_relaxation": graph_preconditioner_relaxation_for_variant(
                preconditioner_variant
            ),
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 0.25,
            "right_preconditioner_probe_relative_residual_l2_norm": 0.25,
            "right_preconditioner_auto_disabled": False,
            "right_preconditioner_probe_disable_relative_threshold": 0.0,
            "right_preconditioner_auto_disable_reason": "",
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"].update(
        {
            "solver_model": "periodic_airbox_mfem_phi_consistency_schur",
            "periodic_airbox_coupled_block_solver": True,
            "mfem_coupled_block_assembly": False,
            "dynamic_demag_operator_source": "matrix_free_mfem_demag_phi_consistency_schur_provider",
            "dynamic_demag_matrix_form": "schur_phi_consistency_provider",
        }
    )
    manifest["capabilities"].update(
        {
            "periodic_airbox_coupled_block_solver": True,
            "mfem_coupled_block_assembly": False,
            "dynamic_demag_operator_source": "matrix_free_mfem_demag_phi_consistency_schur_provider",
            "dynamic_demag_matrix_form": "schur_phi_consistency_provider",
        }
    )
    for key in [
        "demag_tangent_operator_source",
        "demag_tangent_linearity_check",
        "demag_tangent_additivity_max_abs_error",
        "demag_tangent_homogeneity_max_abs_error",
        "demag_tangent_additivity_relative_error",
        "demag_tangent_homogeneity_relative_error",
        "block_norms",
    ]:
        manifest["diagnostics"].pop(key, None)
    manifest["diagnostics"].update(
        {
            "periodic_airbox_coupled_block_solver": True,
            "dynamic_demag_operator_source": "matrix_free_mfem_demag_phi_consistency_schur_provider",
            "dynamic_demag_matrix_form": "schur_phi_consistency_provider",
            "coupled_residual_partition_status": "magnetic_schur_phi_consistency_provider",
            "krylov_preconditioner_kind": preconditioner_kind,
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": preconditioner_variant,
            "krylov_preconditioner_variant": preconditioner_variant,
            "graph_preconditioner_relaxation": graph_preconditioner_relaxation_for_variant(
                preconditioner_variant
            ),
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 0.25,
            "right_preconditioner_probe_relative_residual_l2_norm": 0.25,
            "right_preconditioner_auto_disabled": False,
            "right_preconditioner_probe_disable_relative_threshold": 0.0,
            "right_preconditioner_auto_disable_reason": "",
        }
    )
    manifest_path.write_text(json.dumps(manifest))
    for point_path in sorted((root / "response" / "frequency_points").glob("frequency_*.json")):
        point = json.loads(point_path.read_text())
        point["demag_contribution"].update(
            {
                "operator_source": "matrix_free_mfem_demag_phi_consistency_schur_provider",
                "dynamic_demag_matrix_form": "schur_phi_consistency_provider",
                "delta_phi_phase_validation_status": "ok",
                "delta_phi_phase_max_residual": 0.0,
                "delta_phi_seam_validation_status": "ok",
                "delta_phi_seam_max_after_offset": 0.0,
                "delta_phi_seam_best_constant_offset_real": 0.0,
                "delta_phi_seam_best_constant_offset_imag": 0.0,
                "h_demag_seam_validation_status": "ok",
                "h_demag_seam_validation_reason": "evaluated_tangent_periodic_pairs",
                "h_demag_seam_max_tangent_mismatch": 0.0,
                "delta_phi_flux_validation_status": "ok",
                "delta_phi_flux_validation_reason": "evaluated_periodic_airbox_normal_flux",
                "delta_phi_flux_max_residual": 0.0,
                "delta_phi_complex": [[0.0, 0.0]],
                "h_demag_complex": [[0.0, 0.0], [0.0, 0.0]],
            }
        )
        point_path.write_text(json.dumps(point))


def set_frequency_point_response(
    root: Path,
    *,
    index: int,
    frequency_hz: float,
    response_amplitude: float,
) -> None:
    angular_frequency_rad_per_s = frequency_hz * 6.283185307179586
    point_path = root / "response" / "frequency_points" / f"frequency_{index:04d}.json"
    point = json.loads(point_path.read_text())
    point["frequency_hz"] = frequency_hz
    point["angular_frequency_rad_per_s"] = angular_frequency_rad_per_s
    point["response_amplitude"] = response_amplitude
    point["component_response_amplitude"] = [response_amplitude, 0.0]
    point_path.write_text(json.dumps(point))

    sweep_path = root / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    sweep_point = sweep["points"][index]
    sweep_point["frequency_hz"] = frequency_hz
    sweep_point["angular_frequency_rad_per_s"] = angular_frequency_rad_per_s
    sweep_point["response_amplitude"] = response_amplitude
    sweep_point["component_response_amplitude"] = [response_amplitude, 0.0]
    sweep_path.write_text(json.dumps(sweep))


def set_frequency_point_payload_width(root: Path, *, index: int, width: int) -> None:
    point_path = root / "response" / "frequency_points" / f"frequency_{index:04d}.json"
    point = json.loads(point_path.read_text())
    response_amplitude = point["response_amplitude"]
    point["m_complex"] = [[1.0, 0.0]] + [
        [0.0, 0.0] for _ in range(width - 1)
    ]
    point["component_response_amplitude"] = [
        response_amplitude,
        *([0.0] * (width - 1)),
    ]
    point["component_response_phase"] = [0.0] * width
    point["delta_m_tangent_dof_count"] = width
    point["demag_contribution"]["h_demag_complex"] = [
        [0.0, 0.0] for _ in range(width)
    ]
    point_path.write_text(json.dumps(point))

    sweep_path = root / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    sweep_point = sweep["points"][index]
    sweep_point["m_complex"] = point["m_complex"]
    sweep_point["component_response_amplitude"] = point["component_response_amplitude"]
    sweep_point["component_response_phase"] = point["component_response_phase"]
    sweep_path.write_text(json.dumps(sweep))


def write_derived_peak_mode_fixture(
    root: Path,
    *,
    index: int = 1,
    omit_refinement_recommendation: bool = False,
    omit_provenance: bool = False,
) -> None:
    sweep = json.loads((root / "response" / "magnetic_response_sweep.v2.json").read_text())
    point = sweep["points"][index]
    response_amplitude_source = (
        "max_response_amplitude"
        if point.get("max_response_amplitude") is not None
        else "response_amplitude"
    )
    payload = {
        "schema_version": "frequency_response_derived_mode.v1",
        "source": "magnetic_response_sweep.v2",
        "selection": "max_response_amplitude",
        "mode_label": "driven_response_peak_0000",
        "frequency_index": point["frequency_index"],
        "frequency_hz": point["frequency_hz"],
        "response_amplitude": point["response_amplitude"],
        "frequency_point_artifact_path": point["frequency_point_artifact_path"],
        "field_payload_path": point["response_field_payload_path"],
        "interpretation": "driven_response_field_at_peak_frequency",
    }
    if not omit_provenance:
        payload["provenance"] = {
            "schema_version": "frequency_response_derived_mode_provenance.v1",
            "canonical_product": "frequency_response",
            "source_artifact_path": "response/magnetic_response_sweep.v2.json",
            "source_schema_version": sweep["schema_version"],
            "derivation_method": "select_max_response_amplitude",
            "selection_metric": response_amplitude_source,
            "selected_sweep_point_index": index,
            "selected_frequency_index": point["frequency_index"],
            "selected_frequency_hz": point["frequency_hz"],
            "selected_response_amplitude": point[response_amplitude_source],
            "selected_frequency_point_artifact_path": point[
                "frequency_point_artifact_path"
            ],
            "selected_field_payload_path": point["response_field_payload_path"],
            "not_an_eigenmode": True,
        }
    if not omit_refinement_recommendation:
        frequency_hz = [float(sweep_point["frequency_hz"]) for sweep_point in sweep["points"]]
        if len(frequency_hz) < 2:
            refinement_recommendation = {
                "schema_version": "frequency_response_peak_refinement.v1",
                "strategy": "local_peak_window",
                "peak_position": "single_point",
                "recommended_frequency_count": 0,
                "frequency_spacing_hz": None,
                "recommended_frequencies_hz": [],
            }
        else:
            peak_frequency = frequency_hz[index]
            if index == 0:
                spacing = abs(frequency_hz[1] - frequency_hz[0])
                start = max(0.0, peak_frequency - 2.0 * spacing)
                stop = peak_frequency
                peak_position = "lower_boundary"
            elif index == len(frequency_hz) - 1:
                spacing = abs(frequency_hz[-1] - frequency_hz[-2])
                start = peak_frequency
                stop = peak_frequency + 2.0 * spacing
                peak_position = "upper_boundary"
            else:
                left_spacing = abs(peak_frequency - frequency_hz[index - 1])
                right_spacing = abs(frequency_hz[index + 1] - peak_frequency)
                spacing = min(left_spacing, right_spacing)
                start = max(0.0, peak_frequency - 0.5 * spacing)
                stop = peak_frequency + 0.5 * spacing
                peak_position = "interior"
            frequency_count = 5
            step = (stop - start) / float(frequency_count - 1)
            refinement_recommendation = {
                "schema_version": "frequency_response_peak_refinement.v1",
                "strategy": "local_peak_window",
                "peak_position": peak_position,
                "recommended_frequency_count": frequency_count,
                "frequency_spacing_hz": spacing,
                "recommended_frequencies_hz": [
                    start + step * step_index for step_index in range(frequency_count)
                ],
            }
        payload["refinement_recommendation"] = {
            **refinement_recommendation,
        }
    output = root / "response" / "derived_modes" / "fmr_peak_mode.v1.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def set_exchange_edge_count(root: Path, *, count: int) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["exchange_edge_count"] = count
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["exchange_edge_count"] = count
    manifest_path.write_text(json.dumps(manifest))


def set_krylov_preconditioner_kind(root: Path, *, kind: str) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["krylov_preconditioner_kind"] = kind
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["krylov_preconditioner_kind"] = kind
    manifest_path.write_text(json.dumps(manifest))


def set_krylov_preconditioner_variant(root: Path, *, variant: str) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["krylov_preconditioner_requested_variant"] = variant
    diagnostics["krylov_preconditioner_initial_variant"] = variant
    diagnostics["krylov_preconditioner_variant"] = variant
    diagnostics["graph_preconditioner_relaxation"] = (
        graph_preconditioner_relaxation_for_variant(variant)
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["krylov_preconditioner_requested_variant"] = variant
    manifest["diagnostics"]["krylov_preconditioner_initial_variant"] = variant
    manifest["diagnostics"]["krylov_preconditioner_variant"] = variant
    manifest["diagnostics"]["graph_preconditioner_relaxation"] = (
        graph_preconditioner_relaxation_for_variant(variant)
    )
    manifest_path.write_text(json.dumps(manifest))


def set_krylov_preconditioner_disabled(root: Path) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.update(
        {
            "krylov_preconditioner_kind": "none",
            "krylov_preconditioner_requested_variant": "none",
            "krylov_preconditioner_initial_variant": "none",
            "krylov_preconditioner_variant": "none",
            "krylov_preconditioner_applied": False,
            "krylov_preconditioner_setup_status": "not_configured",
            "graph_preconditioner_relaxation": 0.0,
            "right_preconditioner_probe_available": False,
            "right_preconditioner_probe_residual_l2_norm": 0.0,
            "right_preconditioner_probe_relative_residual_l2_norm": 0.0,
            "right_preconditioner_auto_disabled": False,
            "right_preconditioner_probe_disable_relative_threshold": 0.0,
            "right_preconditioner_auto_disable_reason": "",
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].update(
        {
            "krylov_preconditioner_kind": "none",
            "krylov_preconditioner_requested_variant": "none",
            "krylov_preconditioner_initial_variant": "none",
            "krylov_preconditioner_variant": "none",
            "krylov_preconditioner_applied": False,
            "krylov_preconditioner_setup_status": "not_configured",
            "graph_preconditioner_relaxation": 0.0,
            "right_preconditioner_probe_available": False,
            "right_preconditioner_probe_residual_l2_norm": 0.0,
            "right_preconditioner_probe_relative_residual_l2_norm": 0.0,
            "right_preconditioner_auto_disabled": False,
            "right_preconditioner_probe_disable_relative_threshold": 0.0,
            "right_preconditioner_auto_disable_reason": "",
        }
    )
    manifest_path.write_text(json.dumps(manifest))


def set_krylov_preconditioner_auto_fallback(
    root: Path,
    *,
    reason: str = "probe_relative_residual_above_threshold",
) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    initial_variant = diagnostics["krylov_preconditioner_initial_variant"]
    diagnostics.update(
        {
            "krylov_preconditioner_kind": "none",
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": initial_variant,
            "krylov_preconditioner_variant": "none",
            "krylov_preconditioner_applied": False,
            "krylov_preconditioner_setup_status": "not_configured",
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 2.0,
            "right_preconditioner_probe_relative_residual_l2_norm": 2.0,
            "right_preconditioner_auto_disabled": True,
            "right_preconditioner_probe_disable_relative_threshold": 1.0,
            "right_preconditioner_auto_disable_reason": reason,
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    initial_variant = manifest["diagnostics"]["krylov_preconditioner_initial_variant"]
    manifest["diagnostics"].update(
        {
            "krylov_preconditioner_kind": "none",
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": initial_variant,
            "krylov_preconditioner_variant": "none",
            "krylov_preconditioner_applied": False,
            "krylov_preconditioner_setup_status": "not_configured",
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 2.0,
            "right_preconditioner_probe_relative_residual_l2_norm": 2.0,
            "right_preconditioner_auto_disabled": True,
            "right_preconditioner_probe_disable_relative_threshold": 1.0,
            "right_preconditioner_auto_disable_reason": reason,
        }
    )
    manifest_path.write_text(json.dumps(manifest))


def set_krylov_preconditioner_auto_block_jacobi_fallback(root: Path) -> None:
    diagnostics_path = root / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    initial_variant = diagnostics["krylov_preconditioner_initial_variant"]
    diagnostics.update(
        {
            "krylov_preconditioner_kind": "mfem_tangent_block_jacobi_right",
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": initial_variant,
            "krylov_preconditioner_variant": "block_jacobi",
            "krylov_preconditioner_applied": True,
            "krylov_preconditioner_setup_status": "ok",
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 2.0,
            "right_preconditioner_probe_relative_residual_l2_norm": 2.0,
            "right_preconditioner_auto_disabled": True,
            "right_preconditioner_probe_disable_relative_threshold": 1.0,
            "right_preconditioner_auto_disable_reason": "probe_relative_residual_above_threshold",
        }
    )
    diagnostics_path.write_text(json.dumps(diagnostics))
    (root / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    initial_variant = manifest["diagnostics"]["krylov_preconditioner_initial_variant"]
    manifest["diagnostics"].update(
        {
            "krylov_preconditioner_kind": "mfem_tangent_block_jacobi_right",
            "krylov_preconditioner_requested_variant": "auto",
            "krylov_preconditioner_initial_variant": initial_variant,
            "krylov_preconditioner_variant": "block_jacobi",
            "krylov_preconditioner_applied": True,
            "krylov_preconditioner_setup_status": "ok",
            "right_preconditioner_probe_available": True,
            "right_preconditioner_probe_residual_l2_norm": 2.0,
            "right_preconditioner_probe_relative_residual_l2_norm": 2.0,
            "right_preconditioner_auto_disabled": True,
            "right_preconditioner_probe_disable_relative_threshold": 1.0,
            "right_preconditioner_auto_disable_reason": "probe_relative_residual_above_threshold",
        }
    )
    manifest_path.write_text(json.dumps(manifest))


def set_manifest_domain_mesh_mode(root: Path, *, mode: str) -> None:
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["domain_mesh_mode"] = mode
    manifest_path.write_text(json.dumps(manifest))


def test_validator_accepts_tangent_field_payload_metadata(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_unavailable_bundle_with_explicit_flag(tmp_path: Path) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)

    result = run_validator(tmp_path, allow_unavailable=True)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_periodic_airbox_gpu_unavailable_boundary(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_gpu_unavailable_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_periodic_airbox_gpu_unsupported=True,
        allow_unavailable=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_floquet_airbox_gpu_unavailable_boundary(
    tmp_path: Path,
) -> None:
    write_floquet_airbox_gpu_unavailable_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_airbox_gpu_unsupported=True,
        allow_unavailable=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_periodic_airbox_cpu_demag_solved_boundary(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_periodic_airbox_manifest_certificate_hash_mismatch(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["input_preflight"]["periodic_mesh_certificate"][
        "magnetic_pair_map_sha256"
    ] = (
        "sha256:"
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    )
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "periodic_mesh_certificate.magnetic_pair_map_sha256" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_frequency_point_certificate_hash_mismatch(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["demag_contribution"]["input_preflight"]["periodic_mesh_certificate"][
        "airbox_pair_map_sha256"
    ] = (
        "sha256:"
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    )
    point_path.write_text(json.dumps(point))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "demag_contribution.input_preflight.periodic_mesh_certificate.airbox_pair_map_sha256" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_certificate_zero_magnetic_pairs(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    mutate_periodic_mesh_certificate_copies(tmp_path, "magnetic_pair_count", 0)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "periodic_mesh_certificate.magnetic_pair_count" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_certificate_unknown_transfer_status(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    mutate_periodic_mesh_certificate_copies(
        tmp_path,
        "tangent_frame_transfer_artifact_status",
        "unknown",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "periodic_mesh_certificate.tangent_frame_transfer_artifact_status" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_pending_periodic_certificate_when_accepted_required(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_accepted_periodic_mesh_certificate=True,
    )

    assert result.returncode != 0
    assert "tangent_frame_transfer_artifact_status" in (
        result.stderr + result.stdout
    )
    assert "accepted_native_certificate_consumed" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_consumed_periodic_certificate_when_accepted_required(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    mutate_periodic_mesh_certificate_copies(
        tmp_path,
        "tangent_frame_transfer_artifact_status",
        "accepted_native_certificate_consumed",
    )
    mutate_periodic_mesh_certificate_copies(
        tmp_path,
        "tangent_frame_transfer_block_count",
        1,
    )
    mutate_periodic_mesh_certificate_copies(
        tmp_path,
        "tangent_frame_transfer_blocks_row_major_2x2_sha256",
        "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_accepted_periodic_mesh_certificate=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_accepted_periodic_certificate_without_transfer_block_evidence(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    mutate_periodic_mesh_certificate_copies(
        tmp_path,
        "tangent_frame_transfer_artifact_status",
        "accepted_native_certificate_consumed",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_accepted_periodic_mesh_certificate=True,
    )

    assert result.returncode != 0
    assert "tangent_frame_transfer_block_count" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_cpu_demag_without_flux_validation(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["delta_phi_flux_validation_status"] = "not_evaluated"
    diagnostics["delta_phi_flux_validation_reason"] = (
        "normal_flux_diagnostic_payload_unavailable"
    )
    diagnostics.pop("delta_phi_flux_max_residual", None)
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "delta_phi_flux_validation_status" in (result.stderr + result.stdout)


def test_validator_rejects_device_periodic_airbox_flux_residual_above_strict_tolerance(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_periodic_airbox_flux_residual(tmp_path, 8.8e-3)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        env={
            "FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE": "device_hypre_poisson",
        },
    )

    assert result.returncode != 0
    assert "delta_phi_flux_max_residual exceeds tolerance" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_hybrid_periodic_airbox_flux_residual_below_compatibility_tolerance(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_periodic_airbox_flux_residual(tmp_path, 8.8e-3)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        env={
            "FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE": "hybrid_cpu_poisson",
        },
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_configured_periodic_airbox_flux_residual_tolerance(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_periodic_airbox_flux_residual(tmp_path, 1.5e-2)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        env={
            "FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE": "hybrid_cpu_poisson",
            "FULLMAG_FEM_FREQUENCY_RESPONSE_DELTA_PHI_FLUX_MAX_TOLERANCE_T": "2e-2",
        },
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_periodic_airbox_cpu_demag_without_dynamic_demag_matrix_form(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("dynamic_demag_matrix_form", None)
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "dynamic_demag_matrix_form" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_cpu_demag_without_preconditioner_variant(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("krylov_preconditioner_variant", None)
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].pop("krylov_preconditioner_variant", None)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_variant" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_cpu_demag_without_preconditioner_probe(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("right_preconditioner_probe_available", None)
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].pop("right_preconditioner_probe_available", None)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "right_preconditioner_probe_available" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_cpu_demag_preconditioner_probe_manifest_drift(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["right_preconditioner_probe_relative_residual_l2_norm"] = 0.5
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "manifest.diagnostics.right_preconditioner_probe_relative_residual_l2_norm" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_cpu_demag_without_demag_solver_policy(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("frequency_response_demag_solver_policy_effective", None)
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "diagnostics.frequency_response_demag_solver_policy_effective" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_cpu_demag_without_residual_consistency(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("residual_consistency_status", None)
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "manifest.diagnostics.residual_consistency_status" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_periodic_airbox_cpu_demag_without_preconditioner(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_krylov_preconditioner_disabled(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_periodic_airbox_cpu_demag_auto_preconditioner_fallback(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_krylov_preconditioner_auto_fallback(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_periodic_airbox_cpu_demag_auto_retry_without_preconditioner(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_krylov_preconditioner_auto_fallback(
        tmp_path,
        reason="solve_error_retry_without_right_preconditioner",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_periodic_airbox_cpu_demag_auto_unpreconditioned_pilot(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_krylov_preconditioner_auto_fallback(
        tmp_path,
        reason="pilot_selected_unpreconditioned_after_probe",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_periodic_airbox_cpu_demag_auto_block_jacobi_fallback(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, exchange_edge_count=4)
    set_krylov_preconditioner_auto_block_jacobi_fallback(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_periodic_airbox_cpu_demag_direct_block_jacobi_variant(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, exchange_edge_count=4)
    set_krylov_preconditioner_variant(tmp_path, variant="block_jacobi")
    set_krylov_preconditioner_kind(
        tmp_path,
        kind="mfem_tangent_block_jacobi_right",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "block_jacobi is only valid as an auto fallback" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_exchange_graph_with_demag_coarse_variant(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, exchange_edge_count=4)
    set_krylov_preconditioner_variant(tmp_path, variant="demag_coarse")

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_variant" in (result.stderr + result.stdout)
    assert "graph_demag_coarse" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_no_exchange_with_graph_variant(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, exchange_edge_count=0)
    set_krylov_preconditioner_variant(tmp_path, variant="graph_demag_coarse")

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_variant" in (result.stderr + result.stdout)
    assert "demag_coarse" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_schur_exchange_graph_with_demag_coarse_variant(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, exchange_edge_count=4)
    convert_periodic_airbox_fixture_to_schur_coupled_block(tmp_path)
    set_krylov_preconditioner_variant(tmp_path, variant="demag_coarse")

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_variant" in (result.stderr + result.stdout)
    assert "graph_demag_coarse" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_schur_no_exchange_with_graph_variant(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, exchange_edge_count=0)
    convert_periodic_airbox_fixture_to_schur_coupled_block(tmp_path)
    set_krylov_preconditioner_variant(tmp_path, variant="graph_demag_coarse")

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_variant" in (result.stderr + result.stdout)
    assert "demag_coarse" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_cpu_demag_with_iteration_limit_drift(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress["native_max_iterations_for_frequency"] = 4
    progress_json = json.loads(progress["progress_json"])
    progress_json["native_max_iterations_for_frequency"] = 4
    progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["max_iterations_for_frequency"] = 4
    diagnostics["restart_iterations_for_frequency"] = 8
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["max_iterations_for_frequency"] = 4
    manifest["diagnostics"]["restart_iterations_for_frequency"] = 8
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "restart_iterations_for_frequency must be <=" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_response_without_m5_equilibrium_provenance(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_m5_equilibrium_provenance=True,
    )

    assert result.returncode != 0
    assert "manifest.equilibrium_provenance" in (result.stderr + result.stdout)


def test_validator_accepts_periodic_airbox_response_with_m5_equilibrium_provenance(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    add_m5_equilibrium_provenance_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_m5_equilibrium_provenance=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_periodic_airbox_response_with_missing_m5_artifact_file(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    add_m5_equilibrium_provenance_fixture(tmp_path)
    (tmp_path / "m5_equilibrium_artifacts" / "reports" / "supercell_validation.v1.json").unlink()

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_m5_equilibrium_provenance=True,
    )

    assert result.returncode != 0
    assert "supercell_report_path" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_response_with_failed_m5_report(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    add_m5_equilibrium_provenance_fixture(tmp_path)
    (tmp_path / "m5_equilibrium_artifacts" / "reports" / "supercell_validation.v1.json").write_text(
        json.dumps({"schema_version": "fem_static_pbc_supercell_validation.v1", "status": "failed"})
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_m5_equilibrium_provenance=True,
    )

    assert result.returncode != 0
    assert "supercell_report_path.status" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_response_with_wrong_m5_report_schema(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    add_m5_equilibrium_provenance_fixture(tmp_path)
    (tmp_path / "m5_equilibrium_artifacts" / "reports" / "supercell_validation.v1.json").write_text(
        json.dumps({"schema_version": "fem_static_pbc_z_padding_validation.v1", "status": "ok"})
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_m5_equilibrium_provenance=True,
    )

    assert result.returncode != 0
    assert "supercell_report_path.schema_version" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_solved_boundary_without_progress_demag_mode(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress.pop("demag_mode", None)
    if isinstance(progress.get("progress_json"), str):
        progress_json = json.loads(progress["progress_json"])
        progress_json.pop("demag_mode", None)
        progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "progress.demag_mode" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_solved_boundary_without_native_progress_budget(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress.pop("native_max_iterations_for_frequency", None)
    if isinstance(progress.get("progress_json"), str):
        progress_json = json.loads(progress["progress_json"])
        progress_json.pop("native_max_iterations_for_frequency", None)
        progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "progress.native_max_iterations_for_frequency" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_solved_boundary_with_progress_json_drift(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress_json = json.loads(progress["progress_json"])
    progress_json["native_current_frequency_solve_fraction"] = 0.5
    progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "progress.progress_json.native_current_frequency_solve_fraction" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_frozen_magnetic_submesh_boundary(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_missing_frozen_magnetic_submesh_boundary(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
    )

    assert result.returncode != 0
    assert "generated_frozen_magnetic_submesh" in (result.stderr + result.stdout)


def test_validator_accepts_periodic_airbox_multifrequency_spectrum_boundary(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=3)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    set_frequency_point_response(tmp_path, index=0, frequency_hz=2.0e9, response_amplitude=0.5)
    set_frequency_point_response(tmp_path, index=1, frequency_hz=2.5e9, response_amplitude=2.0)
    set_frequency_point_response(tmp_path, index=2, frequency_hz=3.0e9, response_amplitude=0.8)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
        require_response_peak=True,
        require_field_payloads_for_frequency_points=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_periodic_airbox_derived_peak_mode(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=3)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    set_frequency_point_response(tmp_path, index=0, frequency_hz=2.0e9, response_amplitude=0.5)
    set_frequency_point_response(tmp_path, index=1, frequency_hz=2.5e9, response_amplitude=2.0)
    set_frequency_point_response(tmp_path, index=2, frequency_hz=3.0e9, response_amplitude=0.8)
    write_derived_peak_mode_fixture(tmp_path, index=1)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
        require_response_peak=True,
        require_field_payloads_for_frequency_points=True,
        require_derived_peak_mode=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_missing_periodic_airbox_derived_peak_mode(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=3)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
        require_response_peak=True,
        require_field_payloads_for_frequency_points=True,
        require_derived_peak_mode=True,
    )

    assert result.returncode != 0
    assert "response/derived_modes/fmr_peak_mode.v1.json" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_derived_peak_mode_without_refinement_recommendation(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=3)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    set_frequency_point_response(tmp_path, index=0, frequency_hz=2.0e9, response_amplitude=0.5)
    set_frequency_point_response(tmp_path, index=1, frequency_hz=2.5e9, response_amplitude=2.0)
    set_frequency_point_response(tmp_path, index=2, frequency_hz=3.0e9, response_amplitude=0.8)
    write_derived_peak_mode_fixture(
        tmp_path,
        index=1,
        omit_refinement_recommendation=True,
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
        require_response_peak=True,
        require_field_payloads_for_frequency_points=True,
        require_derived_peak_mode=True,
    )

    assert result.returncode != 0
    assert "derived_peak_mode.refinement_recommendation" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_derived_peak_mode_without_provenance(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=3)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    set_frequency_point_response(tmp_path, index=0, frequency_hz=2.0e9, response_amplitude=0.5)
    set_frequency_point_response(tmp_path, index=1, frequency_hz=2.5e9, response_amplitude=2.0)
    set_frequency_point_response(tmp_path, index=2, frequency_hz=3.0e9, response_amplitude=0.8)
    write_derived_peak_mode_fixture(
        tmp_path,
        index=1,
        omit_provenance=True,
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
        require_response_peak=True,
        require_field_payloads_for_frequency_points=True,
        require_derived_peak_mode=True,
    )

    assert result.returncode != 0
    assert "derived_peak_mode.provenance" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_spectrum_with_too_few_points(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=1)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
    )

    assert result.returncode != 0
    assert "requires at least 3 completed frequency points" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_spectrum_without_field_payloads(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=3)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    (tmp_path / "response" / "field_payloads.zarr" / "frequency_0001" / "vector_xyz_complex" / "0.0.0").unlink()

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
        require_field_payloads_for_frequency_points=True,
    )

    assert result.returncode != 0
    assert "field payload for every completed frequency point" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_spectrum_without_positive_peak(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=3)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    for index in range(3):
        set_frequency_point_response(
            tmp_path,
            index=index,
            frequency_hz=float(index + 1) * 1.0e9,
            response_amplitude=0.0,
        )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=3,
        require_response_peak=True,
    )

    assert result.returncode != 0
    assert "positive response peak" in (result.stderr + result.stdout)


def test_validator_accepts_periodic_airbox_refined_spectrum_with_interior_peak(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=5)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    for index, amplitude in enumerate([0.5, 1.0, 2.0, 1.2, 0.7]):
        set_frequency_point_response(
            tmp_path,
            index=index,
            frequency_hz=(2.0 + 0.1 * index) * 1.0e9,
            response_amplitude=amplitude,
        )
    write_derived_peak_mode_fixture(tmp_path, index=2)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=5,
        require_response_peak=True,
        require_interior_response_peak=True,
        require_field_payloads_for_frequency_points=True,
        require_derived_peak_mode=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_periodic_airbox_refined_spectrum_with_boundary_peak(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path, frequency_point_count=5)
    set_manifest_domain_mesh_mode(tmp_path, mode="generated_frozen_magnetic_submesh")
    for index, amplitude in enumerate([2.0, 1.0, 0.8, 0.7, 0.6]):
        set_frequency_point_response(
            tmp_path,
            index=index,
            frequency_hz=(2.0 + 0.1 * index) * 1.0e9,
            response_amplitude=amplitude,
        )
    write_derived_peak_mode_fixture(tmp_path, index=0)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        require_min_frequency_points=5,
        require_response_peak=True,
        require_interior_response_peak=True,
        require_field_payloads_for_frequency_points=True,
        require_derived_peak_mode=True,
    )

    assert result.returncode != 0
    assert "interior response peak" in (result.stderr + result.stdout)


def test_validator_accepts_periodic_airbox_airbox_reference_convergence(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_periodic_airbox_cpu_demag_solved_fixture(reference)
    write_periodic_airbox_cpu_demag_solved_fixture(candidate)
    set_frequency_point_response(reference, index=0, frequency_hz=2.0e9, response_amplitude=1.0)
    set_frequency_point_response(candidate, index=0, frequency_hz=2.0e9, response_amplitude=1.00000001)

    result = run_validator(
        candidate,
        require_periodic_airbox_cpu_demag_solved=True,
        airbox_reference=reference,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_periodic_airbox_airbox_reference_magnetic_mesh_drift(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_periodic_airbox_cpu_demag_solved_fixture(reference)
    write_periodic_airbox_cpu_demag_solved_fixture(candidate)
    set_frequency_point_response(
        reference, index=0, frequency_hz=2.0e9, response_amplitude=1.0e-8
    )
    set_frequency_point_response(
        candidate, index=0, frequency_hz=2.0e9, response_amplitude=1.00000001e-8
    )
    set_frequency_point_payload_width(candidate, index=0, width=3)

    result = run_validator(
        candidate,
        require_periodic_airbox_cpu_demag_solved=True,
        airbox_reference=reference,
    )

    assert result.returncode != 0
    assert "airbox z-padding magnetic mesh invariant mismatch" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_airbox_reference_exchange_graph_drift(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_periodic_airbox_cpu_demag_solved_fixture(reference)
    write_periodic_airbox_cpu_demag_solved_fixture(candidate)
    set_frequency_point_response(
        reference, index=0, frequency_hz=2.0e9, response_amplitude=1.0e-8
    )
    set_frequency_point_response(
        candidate, index=0, frequency_hz=2.0e9, response_amplitude=1.00000001e-8
    )
    set_exchange_edge_count(candidate, count=5)

    result = run_validator(
        candidate,
        require_periodic_airbox_cpu_demag_solved=True,
        airbox_reference=reference,
    )

    assert result.returncode != 0
    assert "airbox z-padding magnetic mesh invariant mismatch" in (
        result.stderr + result.stdout
    )
    assert "exchange_edge_count" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_airbox_reference_amplitude_drift(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_periodic_airbox_cpu_demag_solved_fixture(reference)
    write_periodic_airbox_cpu_demag_solved_fixture(candidate)
    set_frequency_point_response(reference, index=0, frequency_hz=2.0e9, response_amplitude=1.0)
    set_frequency_point_response(candidate, index=0, frequency_hz=2.0e9, response_amplitude=1.25)

    result = run_validator(
        candidate,
        require_periodic_airbox_cpu_demag_solved=True,
        airbox_reference=reference,
    )

    assert result.returncode != 0
    assert "airbox z-padding mismatch at frequency[0].response_amplitude" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_airbox_reference_small_amplitude_drift(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_periodic_airbox_cpu_demag_solved_fixture(reference)
    write_periodic_airbox_cpu_demag_solved_fixture(candidate)
    set_frequency_point_response(
        reference, index=0, frequency_hz=2.0e9, response_amplitude=1.0e-9
    )
    set_frequency_point_response(
        candidate, index=0, frequency_hz=2.0e9, response_amplitude=2.0e-9
    )

    result = run_validator(
        candidate,
        require_periodic_airbox_cpu_demag_solved=True,
        airbox_reference=reference,
    )

    assert result.returncode != 0
    assert "airbox z-padding mismatch at frequency[0].response_amplitude" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_periodic_airbox_cpu_demag_solved_with_unsupported_reason(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["demag_contribution"]["unsupported_reason"] = (
        "periodic_airbox_dynamic_demag_coupled_block_unimplemented"
    )
    point_path.write_text(json.dumps(point))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "unsupported_reason" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_cpu_demag_solved_without_demag_field(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["demag_contribution"]["h_demag_complex"] = None
    point_path.write_text(json.dumps(point))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "h_demag_complex" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_cpu_demag_solved_with_short_demag_field(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    point_path = tmp_path / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["demag_contribution"]["h_demag_complex"] = [[0.0, 0.0]]
    point_path.write_text(json.dumps(point))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "h_demag_complex length" in (result.stderr + result.stdout)


def test_validator_rejects_unavailable_bundle_without_explicit_flag(tmp_path: Path) -> None:
    write_unavailable_frequency_domain_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "--allow-unavailable" in (result.stderr + result.stdout)


def test_validator_accepts_bounded_periodic_airbox_solve_error_bundle(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_stagnated_periodic_airbox_solve_error_before_max_iterations(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    convert_solve_error_fixture_to_stagnated_early_stop(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_bounded_periodic_airbox_schur_solve_error_bundle(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    convert_periodic_airbox_fixture_to_schur_coupled_block(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_schur_bundle_with_provider_name_as_preconditioner_kind(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    convert_periodic_airbox_fixture_to_schur_coupled_block(tmp_path)
    set_krylov_preconditioner_kind(
        tmp_path,
        kind="mfem_phi_consistency_schur_right",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_kind" in (result.stderr + result.stdout)
    assert "mfem_tangent_demag_coarse_right" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_solve_error_bundle_without_demag_tangent_relative_linearity(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    del diagnostics["demag_tangent_additivity_relative_error"]
    diagnostics_path.write_text(json.dumps(diagnostics))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["diagnostics"]["demag_tangent_additivity_relative_error"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "demag_tangent_additivity_relative_error" in (result.stderr + result.stdout)


def test_validator_rejects_solve_error_bundle_without_krylov_preconditioner_kind(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    del diagnostics["krylov_preconditioner_kind"]
    diagnostics_path.write_text(json.dumps(diagnostics))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["diagnostics"]["krylov_preconditioner_kind"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_kind" in (result.stderr + result.stdout)


def test_validator_rejects_exchange_graph_bundle_with_demag_coarse_preconditioner_kind(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solved_fixture(tmp_path)
    set_krylov_preconditioner_kind(
        tmp_path,
        kind="mfem_tangent_demag_coarse_right",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_kind" in (result.stderr + result.stdout)
    assert "mfem_tangent_graph_demag_coarse_right" in (result.stderr + result.stdout)


def test_validator_rejects_no_exchange_bundle_with_graph_preconditioner_kind(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    set_krylov_preconditioner_kind(
        tmp_path,
        kind="mfem_tangent_graph_demag_coarse_right",
    )

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "krylov_preconditioner_kind" in (result.stderr + result.stdout)
    assert "mfem_tangent_demag_coarse_right" in (result.stderr + result.stdout)


def test_validator_rejects_solve_error_bundle_without_block_norms(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    del diagnostics["block_norms"]
    diagnostics_path.write_text(json.dumps(diagnostics))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["diagnostics"]["block_norms"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "block_norms" in (result.stderr + result.stdout)


def test_validator_rejects_solve_error_bundle_without_coupled_block_norms(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("coupled_block_norms", None)
    diagnostics_path.write_text(json.dumps(diagnostics))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].pop("coupled_block_norms", None)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "coupled_block_norms" in (result.stderr + result.stdout)


def test_validator_rejects_solve_error_bundle_with_empty_gmres_history(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["gmres_relative_residual_history"] = []
    diagnostics_path.write_text(json.dumps(diagnostics))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["gmres_relative_residual_history"] = []
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "gmres_relative_residual_history" in (result.stderr + result.stdout)


def test_validator_rejects_solve_error_bundle_without_explicit_flag(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
    )

    assert result.returncode != 0
    assert "--allow-solve-error" in (result.stderr + result.stdout)


def test_validator_rejects_solve_error_bundle_with_validation_fallback(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["validation_fallback_used"] = True
    diagnostics_path.write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "validation_fallback_used" in (result.stderr + result.stdout)


def test_validator_rejects_solve_error_bundle_without_native_progress_telemetry(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    del progress["native_iteration_count"]
    progress_path.write_text(json.dumps(progress))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "progress.native_iteration_count" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_solve_error_without_progress_demag_mode(
    tmp_path: Path,
) -> None:
    write_periodic_airbox_cpu_demag_solve_error_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    del progress["demag_mode"]
    progress["progress_json"] = json.dumps(
        {
            key: value
            for key, value in json.loads(progress["progress_json"]).items()
            if key != "demag_mode"
        }
    )
    progress_path.write_text(json.dumps(progress))

    result = run_validator(
        tmp_path,
        require_periodic_airbox_cpu_demag_solved=True,
        require_frozen_magnetic_submesh=True,
        allow_solve_error=True,
    )

    assert result.returncode != 0
    assert "progress.demag_mode" in (result.stderr + result.stdout)


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
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
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


def test_validator_rejects_susceptibility_provenance_kind_drift(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path)
    sweep_path = tmp_path / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    sweep["points"][0]["susceptibility_tensor_provenance"]["kind"] = "si_tensor"
    sweep_path.write_text(json.dumps(sweep))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "susceptibility_tensor_provenance.kind" in (
        result.stderr + result.stdout
    )


def set_ms_correct_si_observables(root: Path, *, include_ms_source: bool = True) -> None:
    sweep_path = root / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    point_paths = [
        root / point["frequency_point_artifact_path"]
        for point in sweep["points"]
    ]
    for point in sweep["points"]:
        point["susceptibility_tensor_provenance"] = {
            "kind": "drive_projected_si_susceptibility",
            "basis": "local_tangent_drive",
            "component_pair_count": 1,
            "full_tensor": False,
            "response_quantity": "delta_M_over_h_drive",
            "response_units": "dimensionless",
            "dimensionless_si_susceptibility": True,
            "requires_ms_for_chi_si": False,
            "ms_factor_applied": True,
            "normalization": "sum(Ms*response*conj(drive))/sum(abs(drive)^2)",
        }
        point["absorbed_power_density_provenance"] = {
            "kind": "drive_projected_absorption_proxy",
            "basis": "local_tangent_drive",
            "physical_power_density": False,
            "units": "drive_projected_proxy_not_W_per_m3",
            "requires_mu0_ms_factor": False,
            "mu0_ms_factor_applied": True,
            "normalization": "0.5*mu0*omega*imag(sum(Ms*response*conj(drive)))/tangent_dof_count",
            "volume_weighted": False,
            "spatial_reduction": "drive_projected_tangent_dof_average",
            "absolute_value_applied": False,
            "full_power_density": False,
        }
        if include_ms_source:
            point["susceptibility_tensor_provenance"]["ms_source"] = "uniform"
            point["absorbed_power_density_provenance"]["ms_source"] = "uniform"
    sweep_path.write_text(json.dumps(sweep))
    for point_path, point in zip(point_paths, sweep["points"]):
        point_artifact = json.loads(point_path.read_text())
        point_artifact["susceptibility_tensor_provenance"] = point[
            "susceptibility_tensor_provenance"
        ]
        point_artifact["absorbed_power_density_provenance"] = point[
            "absorbed_power_density_provenance"
        ]
        point_path.write_text(json.dumps(point_artifact))


def test_validator_accepts_ms_correct_si_response_observables(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    set_ms_correct_si_observables(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_si_observables_without_ms_source(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path)
    set_ms_correct_si_observables(tmp_path, include_ms_source=False)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "ms_source" in (result.stderr + result.stdout)


def test_validator_rejects_absorbed_power_proxy_without_normalization(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path)
    sweep_path = tmp_path / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    del sweep["points"][0]["absorbed_power_density_provenance"]["normalization"]
    sweep_path.write_text(json.dumps(sweep))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "absorbed_power_density_provenance.normalization" in (
        result.stderr + result.stdout
    )


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


def test_validator_rejects_missing_progress_json_checkpoint(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_progress_json=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "progress.progress_json" in (result.stderr + result.stdout)


def test_validator_rejects_completed_manifest_missing_progress_links(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path, omit_manifest_progress_links=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.artifacts.response_progress_v1_path" in (
        result.stderr + result.stdout
    ) or "manifest.resources.response_progress_resource_key" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_progress_json_without_status_and_complete(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress_json = json.loads(progress["progress_json"])
    progress_json.pop("status", None)
    progress_json.pop("complete", None)
    progress["progress_json"] = json.dumps(progress_json)
    progress_path.write_text(json.dumps(progress))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "progress.progress_json.status" in (result.stderr + result.stdout)


def test_validator_rejects_progress_range_not_mirrored_in_progress_json(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(tmp_path)
    progress_path = tmp_path / "response" / "progress.v1.json"
    progress = json.loads(progress_path.read_text())
    progress["frequency_min_hz"] = 2.0e9
    progress["frequency_max_hz"] = 5.0e9
    progress_path.write_text(json.dumps(progress))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "progress.progress_json.frequency_min_hz" in (
        result.stderr + result.stdout
    )


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


def test_validator_rejects_missing_diagnostics_matrix_form(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_diagnostics_matrix_form=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "diagnostics.matrix_form" in (result.stderr + result.stdout)


def test_validator_rejects_missing_diagnostics_phasor_convention(tmp_path: Path) -> None:
    write_frequency_domain_fixture(tmp_path, omit_diagnostics_phasor_convention=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "diagnostics.phasor_convention" in (result.stderr + result.stdout)


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


def test_validator_accepts_gpu_dynamic_demag_operator_source(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    mark_fixture_as_gpu_dynamic_demag(
        tmp_path,
        source="matrix_free_demag_tangent_provider",
    )

    result = run_validator(tmp_path, require_production_gpu=True)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_gpu_dynamic_demag_without_operator_source(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    mark_fixture_as_gpu_dynamic_demag(tmp_path, source=None)

    result = run_validator(tmp_path, require_production_gpu=True)

    assert result.returncode != 0
    assert "demag_tangent_operator_source" in (result.stderr + result.stdout)


def test_validator_rejects_gpu_dynamic_demag_with_none_operator_source(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    mark_fixture_as_gpu_dynamic_demag(tmp_path, source="none")

    result = run_validator(tmp_path, require_production_gpu=True)

    assert result.returncode != 0
    assert "demag_tangent_operator_source" in (result.stderr + result.stdout)


def test_validator_accepts_required_floquet_phase_projection(tmp_path: Path) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_floquet_projection_without_basis_transport_policy(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        omit_floquet_basis_transport_policy=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "basis_transport_policy" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_projection_with_full_vector_transport_policy(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        floquet_basis_transport_policy="full_vector",
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "basis_transport_policy=full_vector" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_identity_transport_with_frame_mismatch(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        floquet_tangent_frame_max_mismatch=1.0e-6,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "tangent_frame_identity" in (result.stderr + result.stdout)


def test_validator_rejects_missing_required_floquet_phase_projection(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "floquet_phase_projection" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_projection_without_k_metadata(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        omit_floquet_k_vector_metadata=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "floquet_k_vector_rad_per_m" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_projection_when_dynamic_demag_is_available(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["capabilities"]["dynamic_demag_k_available"] = True
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "dynamic_demag_k_available" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_projection_without_exchange_operator(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics["operator_terms_included"] = ["zeeman"]
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "operator_terms_included" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_projection_without_exchange_edge_count(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("exchange_edge_count")
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "exchange_edge_count" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_projection_without_real_imag_mixing(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    diagnostics_path = tmp_path / "response" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    diagnostics.pop("floquet_real_imag_mixing")
    diagnostics_path.write_text(json.dumps(diagnostics))
    (tmp_path / "response" / "diagnostics.v1.json").write_text(json.dumps(diagnostics))

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "floquet_real_imag_mixing" in (result.stderr + result.stdout)


def test_validator_rejects_floquet_projection_without_pair_artifact(
    tmp_path: Path,
) -> None:
    write_frequency_domain_fixture(
        tmp_path,
        include_floquet_phase_projection=True,
        omit_floquet_pair_artifact=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        tmp_path,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
    )

    assert result.returncode != 0
    assert "periodic_pairs.v1.json" in (result.stderr + result.stdout)


def test_validator_accepts_floquet_exchange_reciprocal_reference(tmp_path: Path) -> None:
    positive_k_root = tmp_path / "positive-k"
    negative_k_root = tmp_path / "negative-k"
    write_frequency_domain_fixture(
        positive_k_root,
        include_floquet_phase_projection=True,
        floquet_k_vector_rad_per_m=[1.0e6, 0.0, 0.0],
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    write_frequency_domain_fixture(
        negative_k_root,
        include_floquet_phase_projection=True,
        floquet_k_vector_rad_per_m=[-1.0e6, 0.0, 0.0],
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        positive_k_root,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
        floquet_reciprocal_reference=negative_k_root,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_floquet_reciprocal_reference_without_opposite_k(
    tmp_path: Path,
) -> None:
    target_root = tmp_path / "target"
    reference_root = tmp_path / "reference"
    for root in [target_root, reference_root]:
        write_frequency_domain_fixture(
            root,
            include_floquet_phase_projection=True,
            floquet_k_vector_rad_per_m=[1.0e6, 0.0, 0.0],
            execution_lane="production_gpu",
            manifest_engine="native_fem_mfem_frequency_domain_gpu",
            sweep_v1_lane_classification="fem_gpu_production",
        )

    result = run_validator(
        target_root,
        require_production_gpu=True,
        require_floquet_phase_projection=True,
        floquet_reciprocal_reference=reference_root,
    )

    assert result.returncode != 0
    assert "Floquet reciprocal" in (result.stderr + result.stdout)
    assert "opposite k-vector" in (result.stderr + result.stdout)


def test_validator_accepts_static_periodic_gpu_cpu_parity_reference(tmp_path: Path) -> None:
    cpu_root = tmp_path / "cpu"
    gpu_root = tmp_path / "gpu"
    write_frequency_domain_fixture(cpu_root, include_static_periodic_diagnostics=True)
    write_frequency_domain_fixture(
        gpu_root,
        include_static_periodic_diagnostics=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )

    result = run_validator(
        gpu_root,
        require_static_periodic=True,
        require_production_gpu=True,
        parity_reference=cpu_root,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_static_periodic_gpu_cpu_parity_mismatch(tmp_path: Path) -> None:
    cpu_root = tmp_path / "cpu"
    gpu_root = tmp_path / "gpu"
    write_frequency_domain_fixture(cpu_root, include_static_periodic_diagnostics=True)
    write_frequency_domain_fixture(
        gpu_root,
        include_static_periodic_diagnostics=True,
        execution_lane="production_gpu",
        manifest_engine="native_fem_mfem_frequency_domain_gpu",
        sweep_v1_lane_classification="fem_gpu_production",
    )
    point_path = gpu_root / "response" / "frequency_points" / "frequency_0000.json"
    point = json.loads(point_path.read_text())
    point["m_complex"] = [[1.5, 0.0], [0.0, 0.0]]
    point["response_amplitude"] = 1.5
    point["component_response_amplitude"] = [1.5, 0.0]
    point_path.write_text(json.dumps(point))
    sweep_path = gpu_root / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text())
    sweep["points"][0]["m_complex"] = point["m_complex"]
    sweep["points"][0]["response_amplitude"] = 1.5
    sweep["points"][0]["component_response_amplitude"] = [1.5, 0.0]
    sweep_path.write_text(json.dumps(sweep))

    result = run_validator(
        gpu_root,
        require_static_periodic=True,
        require_production_gpu=True,
        parity_reference=cpu_root,
    )

    assert result.returncode != 0
    assert "CPU/GPU parity" in (result.stderr + result.stdout)


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


def test_validator_rejects_cancel_requested_without_progress_json_checkpoint(
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
    cancel_requested_path = tmp_path / "response" / "cancel_requested.v1.json"
    cancel_requested = json.loads(cancel_requested_path.read_text())
    cancel_requested.pop("progress_json", None)
    cancel_requested_path.write_text(json.dumps(cancel_requested))

    result = run_validator(tmp_path, allow_interrupted=True)

    assert result.returncode != 0
    assert "cancel_requested.progress_json" in (result.stderr + result.stdout)


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
