#!/usr/bin/env python3
"""Unit tests for the FEM relaxation runtime log validator."""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
import os
import importlib.util
import subprocess
import sys
import tempfile
import struct
from types import SimpleNamespace
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "validate_fem_relaxation_runtime_log.py"
VERIFY_RUNTIME = REPO_ROOT / "scripts" / "verify_fem_relaxation_runtime.sh"
JUSTFILE = REPO_ROOT / "justfile"
FEM_RELAXATION_NOTE = (
    REPO_ROOT / "docs" / "physics" / "0510-fem-relaxation-algorithms-mfem-gpu.md"
)
BENCHMARK = REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
BENCHMARK_CASE = REPO_ROOT / "examples" / "bench_fem_gpu_long.py"
FULLMAG_PYTHON_SRC = REPO_ROOT / "packages" / "fullmag-py" / "src"
ZHANG_LI_VALIDATOR = REPO_ROOT / "scripts" / "validate_fem_zhang_li_skew_tetra_runtime.py"
RUNTIME_RESTORE_VERIFIER = REPO_ROOT / "scripts" / "verify_fem_gpu_runtime_restore.py"


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location("fem_gpu_benchmark", BENCHMARK)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_benchmark_case_module():
    sys.path.insert(0, str(FULLMAG_PYTHON_SRC))
    spec = importlib.util.spec_from_file_location("bench_fem_gpu_long", BENCHMARK_CASE)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_validator_module():
    spec = importlib.util.spec_from_file_location(
        "validate_fem_relaxation_runtime_log", VALIDATOR
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_performance_fixture(
    tmp_path: Path,
    benchmark,
    **overrides,
) -> Path:
    mesh = tmp_path / "mesh.json"
    mesh.write_text(
        json.dumps(
            {
                "mesh_name": "fixture",
                "nodes": [[0.0, 0.0, 0.0]],
                "elements": [[0, 0, 0, 0]],
            }
        ),
        encoding="utf-8",
    )
    payload = {
        "schema": "fullmag.fem_gpu.performance_fixture.v1",
        "solver_mesh_path": "mesh.json",
        "solver_mesh_sha256": benchmark.hashlib.sha256(mesh.read_bytes()).hexdigest(),
        "solver_mesh_signature": "fixture-mesh",
        "problem_ir_sha256": "a" * 64,
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "node_count": 1,
        "element_count": 1,
        "demag_policy": {
            "solver": "CG",
            "preconditioner": "AMG",
            "rtol": 1e-12,
            "amg_relax_type": 6,
            "amg_coarsening": 8,
            "amg_interpolation": 6,
            "amg_aggressive_coarsening": 1,
        },
        "stop_condition": {
            "kind": "torque_or_max_steps",
            "max_steps": 64,
            "benchmark_only_torque_target_apm": 1e-6,
        },
    }
    payload.update(overrides)
    manifest = tmp_path / "fixture.json"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    return manifest


def _typed_v2_test_mesh() -> dict[str, object]:
    """Return a small typed mesh with one exterior and one interface facet."""
    return {
        "mesh_name": "typed-v2-test",
        "nodes": [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        "cells": {
            "types": ["tet4", "tet4"],
            "offsets": [0, 4, 8],
            "nodes": [0, 1, 2, 3, 0, 2, 1, 4],
            "global_ordinals": [0, 1],
        },
        "element_markers": [1, 0],
        "facets": {
            "types": ["tri3", "tri3"],
            "roles": ["material_interface", "exterior"],
            "offsets": [0, 3, 6],
            "nodes": [0, 1, 2, 0, 1, 3],
            "global_ordinals": [0, 1],
        },
        "boundary_markers": [2, 3],
    }


def test_legacy_fixture_is_not_strict() -> None:
    benchmark = load_benchmark_module()
    mesh_path = (
        REPO_ROOT
        / "examples/assets/fem_performance/box500_airbox_exchange_demag_v1.mesh.json"
    )
    mesh = json.loads(mesh_path.read_text(encoding="utf-8"))
    owners: dict[tuple[int, ...], int] = {}
    for element in mesh["elements"]:
        for face in (
            (element[0], element[1], element[2]),
            (element[0], element[1], element[3]),
            (element[0], element[2], element[3]),
            (element[1], element[2], element[3]),
        ):
            key = tuple(sorted(face))
            owners[key] = owners.get(key, 0) + 1
    owner_counts = [owners[tuple(sorted(face))] for face in mesh["boundary_faces"]]
    assert owner_counts.count(2) == 64
    assert any(count != 1 for count in owner_counts)
    with pytest.raises(ValueError, match="typed performance fixture mesh"):
        benchmark.typed_mesh_topology_counts(mesh)


def test_typed_mesh_topology_counts_requires_exact_roles_and_owners() -> None:
    benchmark = load_benchmark_module()
    mesh = _typed_v2_test_mesh()
    assert benchmark.typed_mesh_topology_counts(mesh) == {
        "node_count": 5,
        "cell_count": 2,
        "facet_count": 2,
        "exterior_facet_count": 1,
        "interface_facet_count": 1,
    }

    invalid = json.loads(json.dumps(mesh))
    invalid["facets"]["roles"][0] = "exterior"
    with pytest.raises(ValueError, match="exterior facet 0 has 2 owners"):
        benchmark.typed_mesh_topology_counts(invalid)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("missing_cells_types", "missing cells.types"),
        ("missing_facets_types", "missing facets.types"),
        ("unknown_role", "unknown facet role"),
        ("one_owner_interface", "interface facet 0 has 1 owners"),
    ],
)
def test_typed_mesh_topology_counts_rejects_malformed_schema(
    mutation: str, message: str
) -> None:
    benchmark = load_benchmark_module()
    mesh = _typed_v2_test_mesh()
    if mutation == "missing_cells_types":
        del mesh["cells"]["types"]
    elif mutation == "missing_facets_types":
        del mesh["facets"]["types"]
    elif mutation == "unknown_role":
        mesh["facets"]["roles"][0] = "invented"
    elif mutation == "one_owner_interface":
        mesh["facets"]["nodes"][:3] = [0, 1, 3]
    else:  # pragma: no cover - parametrization protects this branch
        raise AssertionError(mutation)
    with pytest.raises(ValueError, match=message):
        benchmark.typed_mesh_topology_counts(mesh)


def test_typed_fixture_v2_manifest_preserves_topology_identity(tmp_path: Path) -> None:
    benchmark = load_benchmark_module()
    mesh_path = tmp_path / "typed.mesh.json"
    mesh_path.write_text(json.dumps(_typed_v2_test_mesh()), encoding="utf-8")
    counts = benchmark.typed_mesh_topology_counts(
        json.loads(mesh_path.read_text(encoding="utf-8"))
    )
    manifest = {
        "schema": "fullmag.fem_gpu.performance_fixture.v2",
        "solver_mesh_path": mesh_path.name,
        "solver_mesh_sha256": hashlib.sha256(mesh_path.read_bytes()).hexdigest(),
        "solver_mesh_signature": benchmark.solver_mesh_signature(
            _typed_v2_test_mesh()
        ),
        "problem_ir_sha256": "a" * 64,
        **counts,
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "demag_policy": {"solver": "CG", "preconditioner": "AMG", "rtol": 1e-12},
        "stop_condition": {"kind": "torque_or_max_steps", "max_steps": 1},
    }
    manifest_path = tmp_path / "typed.fixture.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    fixture = benchmark.load_fixture_manifest(manifest_path)
    assert fixture.node_count == counts["node_count"]
    assert fixture.element_count == counts["cell_count"]


def test_mesh_topology_stats_is_single_parser_and_legacy_requires_explicit_opt_in(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    typed_path = tmp_path / "typed.mesh.json"
    typed_path.write_text(json.dumps(_typed_v2_test_mesh()), encoding="utf-8")

    stats = benchmark.read_mesh_topology_stats(typed_path)
    assert stats == benchmark.MeshTopologyStats(
        node_count=5,
        cell_count=2,
        facet_count=2,
        exterior_facet_count=1,
        interface_facet_count=1,
        schema_kind="typed_v2",
    )

    legacy_path = tmp_path / "legacy.mesh.json"
    legacy_path.write_text(
        json.dumps({"nodes": [[0.0, 0.0, 0.0]], "elements": [[0, 0, 0, 0]]}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="legacy mesh requires explicit opt-in"):
        benchmark.read_mesh_topology_stats(legacy_path)
    legacy_stats = benchmark.read_mesh_topology_stats(
        legacy_path, allow_legacy=True
    )
    assert legacy_stats.schema_kind == "legacy_v1"


def test_mesh_topology_stats_rejects_conflicting_dual_schema(tmp_path: Path) -> None:
    benchmark = load_benchmark_module()
    mesh = _typed_v2_test_mesh()
    mesh["elements"] = [[0, 1, 2, 3]]
    mesh["boundary_faces"] = [[0, 1, 2]]
    path = tmp_path / "dual.mesh.json"
    path.write_text(json.dumps(mesh), encoding="utf-8")

    with pytest.raises(ValueError, match="conflicting dual-schema"):
        benchmark.read_mesh_topology_stats(path)


def test_solver_mesh_signature_v2_covers_roles_markers_and_owner_connectivity() -> None:
    benchmark = load_benchmark_module()
    mesh = _typed_v2_test_mesh()
    baseline = benchmark.solver_mesh_signature(mesh)
    assert baseline == benchmark.mesh_signature(mesh)

    for mutate in (
        lambda value: value["facets"]["roles"].__setitem__(0, "periodic_seam"),
        lambda value: value["element_markers"].__setitem__(0, 7),
        lambda value: value["boundary_markers"].__setitem__(0, 91),
        lambda value: value["facets"]["global_ordinals"].__setitem__(0, 9),
    ):
        changed = json.loads(json.dumps(mesh))
        mutate(changed)
        assert benchmark.solver_mesh_signature(changed) != baseline


def test_solver_mesh_signature_derives_current_ir_owners_and_rejects_partial_owner_arrays() -> None:
    benchmark = load_benchmark_module()
    mesh = _typed_v2_test_mesh()
    derived = benchmark.solver_mesh_signature(mesh)
    without_optional_owner_arrays = json.loads(json.dumps(mesh))
    assert benchmark.solver_mesh_signature(without_optional_owner_arrays) == derived

    partial = json.loads(json.dumps(mesh))
    partial["facets"]["owner_offsets"] = [0, 2, 3]
    with pytest.raises(ValueError, match="owner_offsets and owners"):
        benchmark.solver_mesh_signature(partial)


def test_execution_plan_mesh_stats_separates_input_and_solver_identity_and_fails_closed(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    input_path = tmp_path / "input.mesh.json"
    input_path.write_text(
        json.dumps(
            {
                "nodes": [[0.0, 0.0, 0.0]],
                "elements": [[0, 0, 0, 0]],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    solver_mesh = _typed_v2_test_mesh()
    solver_path = tmp_path / "solver.mesh.json"
    solver_path.write_text(json.dumps(solver_mesh), encoding="utf-8")
    metadata = {
        "execution_plan": {
            "backend_plan": {
                "kind": "fem",
                "mesh_name": "solver",
                "mesh": solver_mesh,
            }
        }
    }

    stats = benchmark.execution_plan_mesh_stats(
        metadata, input_mesh_path=input_path, solver_mesh_path=solver_path
    )
    assert stats["input_mesh_node_count"] == 1
    assert stats["input_mesh_cell_count"] == 1
    assert stats["solver_mesh_node_count"] == 5
    assert stats["solver_mesh_cell_count"] == 2
    assert stats["solver_mesh_facet_count"] == 2
    assert stats["solver_mesh_exterior_facet_count"] == 1
    assert stats["solver_mesh_interface_facet_count"] == 1
    assert stats["solver_mesh_signature"] == benchmark.solver_mesh_signature(solver_mesh)

    mismatched = json.loads(json.dumps(metadata))
    mismatched["execution_plan"]["backend_plan"]["mesh"]["boundary_markers"][0] = 99
    with pytest.raises(ValueError, match="solver mesh topology mismatch"):
        benchmark.execution_plan_mesh_stats(
            mismatched, input_mesh_path=input_path, solver_mesh_path=solver_path
        )


def test_typed_fixture_manifest_rejects_declared_solver_count_mismatch(tmp_path: Path) -> None:
    benchmark = load_benchmark_module()
    mesh_path = tmp_path / "typed.mesh.json"
    mesh_path.write_text(json.dumps(_typed_v2_test_mesh()), encoding="utf-8")
    counts = benchmark.typed_mesh_topology_counts(
        json.loads(mesh_path.read_text(encoding="utf-8"))
    )
    manifest = {
        "schema": "fullmag.fem_gpu.performance_fixture.v2",
        "solver_mesh_path": mesh_path.name,
        "solver_mesh_sha256": hashlib.sha256(mesh_path.read_bytes()).hexdigest(),
        "solver_mesh_signature": benchmark.solver_mesh_signature(
            _typed_v2_test_mesh()
        ),
        "problem_ir_sha256": "a" * 64,
        **counts,
        "cell_count": counts["cell_count"] + 1,
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "demag_policy": {"solver": "CG", "preconditioner": "AMG", "rtol": 1e-12},
        "stop_condition": {"kind": "torque_or_max_steps", "max_steps": 1},
    }
    manifest_path = tmp_path / "typed.fixture.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="cell_count differs"):
        benchmark.load_fixture_manifest(manifest_path)


def test_benchmark_summary_reports_distribution() -> None:
    benchmark = load_benchmark_module()
    summary = benchmark.summarize_distribution([10.0, 11.0, 12.0, 20.0, 30.0])
    assert summary == {
        "count": 5,
        "p50": 12.0,
        "p95": 30.0,
        "stddev": pytest.approx(7.5789181286),
    }


def task11_expected_qualification_identity() -> dict[str, object]:
    return {
        "schema": "fullmag.fem_gpu.relaxation_preconditioner_qualification_identity.v1",
        "fixture_suite_sha256": "f" * 64,
        "environment_sha256": "e" * 64,
        "runtime_identity": {
            "runtime_manifest_sha256": "runtime-identity",
            "runtime_source_inputs_sha256": "source-identity",
            "libfullmag_fem_sha256": "library-identity",
        },
        "gpu_identity": {
            "device_uuid": "GPU-task11-test",
            "device_name": "NVIDIA GeForce RTX 4080 SUPER",
            "compute_capability": "8.9",
        },
        "workload": {
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 64,
            "relaxation_algorithm": "nonlinear_cg",
            "precision": "double",
            "torque_tolerance_apm": 8000.0,
            "demag_solver": "CG",
            "demag_preconditioner": "AMG",
            "demag_relative_tolerance": 1e-12,
            "demag_amg_relax_type": 6,
        },
        "fixtures": [
            {
                "resolution": mesh_size,
                "solver_mesh_sha256": f"mesh-sha256-{mesh_size}",
                "solver_mesh_signature": f"solver-mesh-{mesh_size}",
                "executed_problem_ir_sha256": f"problem-ir-{mesh_size}",
                "node_count": 2,
                "element_count": 1,
            }
            for mesh_size in ("coarse", "medium", "fine")
        ],
    }


def task11_test_final_magnetization_sha256(
    values: list[list[float]],
    *,
    step: int = 16,
) -> str:
    digest = hashlib.sha256()
    digest.update(b"fullmag.task11.final_magnetization.v1\0")
    for text in ("m", "1"):
        encoded = text.encode("utf-8")
        digest.update(struct.pack(">I", len(encoded)))
        digest.update(encoded)
    digest.update(struct.pack(">Q", step))
    digest.update(struct.pack(">Q", len(values)))
    for vector in values:
        digest.update(struct.pack(">ddd", *vector))
    return digest.hexdigest()


def task11_preconditioner_qualification_rows(
    *,
    candidate_p95_regression: bool = False,
) -> list[dict[str, object]]:
    strategies = (
        "none",
        "diagonal_mass",
        "lumped_exchange_mass_cg4",
        "lumped_exchange_mass_cg8",
        "stagnation_triggered_cg8",
    )
    mesh_times = {
        "coarse": 100.0,
        "medium": 200.0,
        "fine": 400.0,
    }
    candidate_factors = {
        "coarse": 0.88,
        "medium": 0.89,
        "fine": 0.98,
    }
    rows: list[dict[str, object]] = []
    for strategy in strategies:
        for mesh_size, baseline_ms in mesh_times.items():
            for repeat_index in range(5):
                factor = 1.0
                if strategy == "lumped_exchange_mass_cg8":
                    factor = candidate_factors[mesh_size]
                    if candidate_p95_regression and repeat_index == 4:
                        factor = 1.10
                row = {
                    "backend": "fem_gpu",
                    "status": "ok",
                    "scenario": "box500_airbox_exchange_demag",
                    "reported_scenario": "box500_airbox_exchange_demag",
                    "integrator": "heun",
                    "reported_integrator": "heun",
                    "timestep_policy": "fixed",
                    "reported_timestep_policy": "fixed",
                    "dt_s": 1e-13,
                    "steps": 64,
                    "requested_relax_torque_tolerance_apm": 8000.0,
                    "reported_relaxation_algorithm": "nonlinear_cg",
                    "reported_precision": "double",
                    "requested_fem_execution": "gpu",
                    "requested_demag_solver": "CG",
                    "requested_demag_preconditioner": "AMG",
                    "requested_demag_relative_tolerance": "1e-12",
                    "requested_demag_amg_relax_type": "6",
                    "requested_demag_max_iterations": "500",
                    "demag_linear_solver": "CG",
                    "demag_preconditioner": "AMG",
                    "demag_relative_tolerance": 1e-12,
                    "demag_amg_relax_type": 6,
                    "demag_actual_iterations": 9,
                    "demag_final_residual_norm": 1e-13,
                    "execution_engine": "fem_native_gpu",
                    "fem_assembly_mode": "legacy_sparse",
                    "fem_execution_mode": "all_in_gpu_legacy_sparse",
                    "fem_data_residency": "device_source_of_truth",
                    "uses_cuda_kernels": True,
                    "uses_gpu_poisson": True,
                    "hypre_execution_policy": "device",
                    "demag_residency": "device",
                    "fem_demag_operator_mode": "device_hypre_poisson",
                    "mfem_device": "ceed-cuda:/gpu/cuda/shared",
                    "fem_gpu_qualification_status": "production_executable",
                    "fem_gpu_state_allocated": True,
                    "step_profiler_enabled": True,
                    "phase2_compute_assertion_enabled": True,
                    "phase2_compute_hot_loop_sync_clean": True,
                    "runtime_manifest_sha256": "runtime-identity",
                    "runtime_source_inputs_sha256": "source-identity",
                    "libfullmag_fem_sha256": "library-identity",
                    "device_uuid": "GPU-task11-test",
                    "device_name": "NVIDIA GeForce RTX 4080 SUPER",
                    "compute_capability": "8.9",
                    "solver_mesh_sha256": f"mesh-sha256-{mesh_size}",
                    "solver_mesh_signature": f"solver-mesh-{mesh_size}",
                    "executed_problem_ir_sha256": f"problem-ir-{mesh_size}",
                    "node_count": 2,
                    "element_count": 1,
                    "mesh_size": mesh_size,
                    "repeat_index": repeat_index,
                    "requested_relaxation_preconditioner_strategy": strategy,
                    "relaxation_preconditioner_strategy": strategy,
                    "relaxation_preconditioner_iterations": (
                        4
                        if strategy == "lumped_exchange_mass_cg4"
                        else 8
                        if strategy
                        in {
                            "lumped_exchange_mass_cg8",
                            "stagnation_triggered_cg8",
                        }
                        else 0
                    ),
                    "relaxation_preconditioner_lambda_m_per_a": (
                        1e-3 if "exchange_mass" in strategy or "triggered" in strategy else 0.0
                    ),
                    "relaxation_preconditioner_wall_time_ms": 1.0,
                    "accepted_steps": 16,
                    "cumulative_armijo_trials": 16,
                    "cumulative_demag_solves": 32,
                    "cumulative_preconditioner_wall_time_ms": (
                        0.0 if strategy == "none" else 16.0
                    ),
                    "cumulative_hypre_wall_time_ms": 32.0,
                    "relaxation_preconditioner_apply_count": (
                        0
                        if strategy == "none"
                        else 1
                        if strategy == "stagnation_triggered_cg8"
                        else 16
                    ),
                    "relaxation_preconditioner_cache_hits": 4,
                    "relaxation_preconditioner_cache_misses": 1,
                    "wall_time_ms": baseline_ms * factor,
                    "executed_steps": 16,
                    "rhs_evals": 2,
                    "total_rhs_evals": 32,
                    "demag_solves": 32,
                    "converged": True,
                    "stop_reason": "torque",
                    "energy_monotonicity_satisfied": True,
                    "norm_defect": 1e-12,
                    "final_e_total_j": 1e-20,
                    "final_torque_apm": 1e-7,
                    "hot_loop_compute_host_sync_count": 0,
                    "hot_loop_exchange_host_sync_count": 0,
                    "hot_loop_compute_h2d_bytes": 0,
                    "hot_loop_compute_d2h_bytes": 0,
                    "hot_loop_exchange_h2d_bytes": 0,
                    "hot_loop_exchange_d2h_bytes": 0,
                    "hot_loop_control_scalar_host_sync_count": 51,
                }
                rows.append(row)
    return rows


def task11_preconditioner_cpu_gpu_parity_rows() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for mesh_size in ("coarse", "medium", "fine"):
        for backend in ("fem_cpu", "fem_gpu"):
            final_values = [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0 if backend == "fem_cpu" else 1e-12],
            ]
            rows.append(
                {
                    "backend": backend,
                    "status": "ok",
                    "scenario": "box500_airbox_exchange_demag",
                    "reported_scenario": "box500_airbox_exchange_demag",
                    "integrator": "heun",
                    "reported_integrator": "heun",
                    "timestep_policy": "fixed",
                    "reported_timestep_policy": "fixed",
                    "dt_s": 1e-13,
                    "steps": 64,
                    "reported_relaxation_algorithm": "nonlinear_cg",
                    "reported_precision": "double",
                    "requested_relaxation_preconditioner_strategy": "none",
                    "relaxation_preconditioner_strategy": "none",
                    "requested_fem_execution": "cpu" if backend == "fem_cpu" else "gpu",
                    "requested_relax_torque_tolerance_apm": 8000.0,
                    "requested_demag_solver": "CG",
                    "requested_demag_preconditioner": "AMG",
                    "requested_demag_relative_tolerance": "1e-12",
                    "requested_demag_amg_relax_type": "6",
                    "requested_demag_max_iterations": "500",
                    "demag_linear_solver": "CG",
                    "demag_preconditioner": "AMG",
                    "demag_relative_tolerance": 1e-12,
                    "demag_amg_relax_type": 6,
                    "demag_actual_iterations": 9,
                    "demag_final_residual_norm": 1e-13,
                    "execution_engine": (
                        "fem_cpu_native" if backend == "fem_cpu" else "fem_native_gpu"
                    ),
                    "fem_assembly_mode": "legacy_sparse",
                    "fem_execution_mode": "all_in_gpu_legacy_sparse",
                    "fem_data_residency": "device_source_of_truth",
                    "uses_cuda_kernels": True,
                    "uses_gpu_poisson": True,
                    "hypre_execution_policy": "device",
                    "demag_residency": "device",
                    "fem_demag_operator_mode": "device_hypre_poisson",
                    "fem_gpu_qualification_status": "production_executable",
                    "fem_gpu_state_allocated": True,
                    "phase2_compute_assertion_enabled": True,
                    "phase2_compute_hot_loop_sync_clean": True,
                    "hot_loop_compute_host_sync_count": 0,
                    "hot_loop_exchange_host_sync_count": 0,
                    "hot_loop_compute_h2d_bytes": 0,
                    "hot_loop_compute_d2h_bytes": 0,
                    "hot_loop_exchange_h2d_bytes": 0,
                    "hot_loop_exchange_d2h_bytes": 0,
                    "hot_loop_control_scalar_host_sync_count": 51,
                    "total_rhs_evals": 32,
                    "runtime_manifest_sha256": "runtime-identity",
                    "runtime_source_inputs_sha256": "source-identity",
                    "libfullmag_fem_sha256": "library-identity",
                    "device_uuid": (
                        "GPU-task11-test" if backend == "fem_gpu" else None
                    ),
                    "device_name": (
                        "NVIDIA GeForce RTX 4080 SUPER"
                        if backend == "fem_gpu"
                        else None
                    ),
                    "compute_capability": "8.9" if backend == "fem_gpu" else None,
                    "solver_mesh_sha256": f"mesh-sha256-{mesh_size}",
                    "solver_mesh_signature": f"solver-mesh-{mesh_size}",
                    "executed_problem_ir_sha256": f"problem-ir-{mesh_size}",
                    "node_count": 2,
                    "element_count": 1,
                    "mesh_size": mesh_size,
                    "executed_steps": 16,
                    "converged": True,
                    "stop_reason": "torque",
                    "final_torque_apm": 1e-7,
                    "final_e_total_j": 1e-20,
                    "norm_defect": 1e-12,
                    "final_magnetization_observable": "m",
                    "final_magnetization_unit": "1",
                    "final_magnetization_step": 16,
                    "final_magnetization_node_count": 2,
                    "final_magnetization_sha256": task11_test_final_magnetization_sha256(
                        final_values
                    ),
                    "final_magnetization_values_json": json.dumps(final_values),
                }
            )
    return rows


def test_task11_preconditioner_qualification_promotes_only_complete_physical_matrix() -> None:
    benchmark = load_benchmark_module()

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(),
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
        qualification_identity=task11_expected_qualification_identity(),
    )

    assert summary["status"] == "pass"
    assert summary["row_count"] == 75
    assert summary["promoted_strategy"] == "lumped_exchange_mass_cg8"
    candidate = next(
        item
        for item in summary["strategies"]
        if item["strategy"] == "lumped_exchange_mass_cg8"
    )
    assert candidate["qualifies"] is True
    assert candidate["p50_improved_size_count"] == 2


def test_task11_preconditioner_qualification_requires_immutable_identity() -> None:
    benchmark = load_benchmark_module()

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(),
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    assert summary["status"] == "invalid"
    assert summary["promoted_strategy"] is None
    assert any(
        "immutable Task 11 qualification identity is missing" in failure
        for failure in summary["matrix_failures"]
    )


@pytest.mark.parametrize("tamper", ["fixture_suite", "environment"])
def test_task11_identity_loader_rejects_modified_source_artifact(
    tamper: str,
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    fixture_suite = (
        REPO_ROOT
        / "examples/assets/fem_performance/amg_qualification_suite_v1.json"
    )
    environment = (
        REPO_ROOT
        / "benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json"
    )
    tampered_path = tmp_path / f"{tamper}.json"
    source = fixture_suite if tamper == "fixture_suite" else environment
    tampered_path.write_bytes(source.read_bytes() + b"\n")

    with pytest.raises(ValueError, match="SHA-256 differs"):
        benchmark.load_task11_qualification_identity(
            fixture_suite_path=(
                tampered_path if tamper == "fixture_suite" else fixture_suite
            ),
            environment_path=(
                tampered_path if tamper == "environment" else environment
            ),
        )


@pytest.mark.parametrize(
    ("collection", "field", "value", "failure_fragment"),
    [
        ("matrix", "reported_scenario", "invented", "reported_scenario"),
        ("matrix", "device_uuid", "GPU-invented", "device_uuid"),
        ("matrix", "solver_mesh_sha256", "invented", "solver_mesh_sha256"),
        (
            "matrix",
            "executed_problem_ir_sha256",
            "invented",
            "executed_problem_ir_sha256",
        ),
        ("parity", "node_count", 3, "node_count"),
    ],
)
def test_task11_preconditioner_qualification_rejects_unpinned_identity(
    collection: str,
    field: str,
    value: object,
    failure_fragment: str,
) -> None:
    benchmark = load_benchmark_module()
    matrix_rows = task11_preconditioner_qualification_rows()
    parity_rows = task11_preconditioner_cpu_gpu_parity_rows()
    (matrix_rows if collection == "matrix" else parity_rows)[0][field] = value

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        matrix_rows,
        cpu_gpu_parity_rows=parity_rows,
        qualification_identity=task11_expected_qualification_identity(),
    )

    assert summary["status"] == "invalid"
    assert any(
        failure_fragment in failure for failure in summary["matrix_failures"]
    )


@pytest.mark.parametrize(
    ("field", "value", "failure_fragment"),
    [
        ("final_magnetization_step", 15, "magnetization step"),
        ("final_magnetization_node_count", 1, "magnetization node count"),
        ("final_magnetization_sha256", "invalid", "magnetization SHA-256"),
        ("final_torque_apm", 8000.1, "final_torque_apm"),
    ],
)
def test_task11_preconditioner_qualification_rejects_incomplete_final_state(
    field: str,
    value: object,
    failure_fragment: str,
) -> None:
    benchmark = load_benchmark_module()
    parity_rows = task11_preconditioner_cpu_gpu_parity_rows()
    parity_rows[0][field] = value

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(),
        cpu_gpu_parity_rows=parity_rows,
        qualification_identity=task11_expected_qualification_identity(),
    )

    assert summary["status"] == "invalid"
    assert any(
        failure_fragment in failure for failure in summary["matrix_failures"]
    )


def test_task11_preconditioner_qualification_rejects_p95_regression() -> None:
    benchmark = load_benchmark_module()

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(candidate_p95_regression=True),
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    candidate = next(
        item
        for item in summary["strategies"]
        if item["strategy"] == "lumped_exchange_mass_cg8"
    )
    assert candidate["qualifies"] is False
    assert any("p95 regression" in failure for failure in candidate["failures"])


def test_task11_preconditioner_qualification_rejects_invalid_none_timing_reference() -> None:
    benchmark = load_benchmark_module()
    rows = task11_preconditioner_qualification_rows()
    for row in rows:
        if row["requested_relaxation_preconditioner_strategy"] == "none":
            row["converged"] = False
            row["stop_reason"] = "max_steps"

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        rows,
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    assert summary["status"] == "invalid"
    assert summary["promoted_strategy"] is None
    assert summary["baseline_eligible"] is False
    candidate = next(
        item
        for item in summary["strategies"]
        if item["strategy"] == "lumped_exchange_mass_cg8"
    )
    assert candidate["qualifies"] is False
    assert any(
        "none baseline failed physical row gates" in failure
        for failure in summary["matrix_failures"]
    )


def test_task11_preconditioner_qualification_rejects_incomplete_none_baseline() -> None:
    benchmark = load_benchmark_module()
    rows = task11_preconditioner_qualification_rows()
    rows.pop(0)

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        rows,
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
        qualification_identity=task11_expected_qualification_identity(),
    )

    assert summary["status"] == "invalid"
    assert summary["baseline_eligible"] is False
    assert summary["promoted_strategy"] is None


@pytest.mark.parametrize(
    ("field", "tampered_value", "failure_fragment"),
    [
        ("execution_engine", "fem_cpu_native", "execution_engine must be fem_native_gpu"),
        ("scenario", "exchange_only_box500_airbox1um", "scenario must be box500_airbox_exchange_demag"),
        (
            "hot_loop_control_scalar_host_sync_count",
            999,
            "control-readback budget exceeded",
        ),
        (
            "demag_final_residual_norm",
            1e-3,
            "demag_final_residual_norm exceeds",
        ),
    ],
)
def test_task11_preconditioner_qualification_rejects_wrong_workload_or_host_identity(
    field: str,
    tampered_value: object,
    failure_fragment: str,
) -> None:
    benchmark = load_benchmark_module()
    rows = task11_preconditioner_qualification_rows()
    rows[0][field] = tampered_value

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        rows,
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    assert summary["status"] == "invalid"
    assert summary["promoted_strategy"] is None
    assert summary["baseline_eligible"] is False
    assert any(
        failure_fragment in failure for failure in summary["matrix_failures"]
    )


@pytest.mark.parametrize(
    ("field", "tampered_value", "failure_fragment"),
    [
        ("runtime_manifest_sha256", "other-runtime", "runtime identity"),
        ("solver_mesh_signature", "other-mesh", "solver mesh identity"),
    ],
)
def test_task11_preconditioner_qualification_rejects_mixed_runtime_or_mesh_identity(
    field: str,
    tampered_value: object,
    failure_fragment: str,
) -> None:
    benchmark = load_benchmark_module()
    rows = task11_preconditioner_qualification_rows()
    rows[0][field] = tampered_value

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        rows,
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    assert summary["status"] == "invalid"
    assert any(
        failure_fragment in failure for failure in summary["matrix_failures"]
    )


@pytest.mark.parametrize(
    "missing_field",
    [
        "accepted_steps",
        "cumulative_armijo_trials",
        "cumulative_demag_solves",
        "cumulative_preconditioner_wall_time_ms",
        "cumulative_hypre_wall_time_ms",
    ],
)
def test_task11_preconditioner_qualification_rejects_missing_cumulative_telemetry(
    missing_field: str,
) -> None:
    benchmark = load_benchmark_module()
    rows = task11_preconditioner_qualification_rows()
    rows[0].pop(missing_field)

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        rows,
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    assert summary["status"] == "invalid"
    assert any(
        missing_field in failure for failure in summary["matrix_failures"]
    )


def test_task11_stagnation_triggered_strategy_requires_a_real_apply() -> None:
    benchmark = load_benchmark_module()
    rows = task11_preconditioner_qualification_rows()
    for row in rows:
        if (
            row["requested_relaxation_preconditioner_strategy"]
            == "stagnation_triggered_cg8"
        ):
            row["relaxation_preconditioner_apply_count"] = 0
            row["relaxation_preconditioner_iterations"] = 0

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        rows,
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    candidate = next(
        item
        for item in summary["strategies"]
        if item["strategy"] == "stagnation_triggered_cg8"
    )
    assert candidate["qualifies"] is False
    assert any(
        "stagnation-triggered strategy never applied CG8" in failure
        for failure in candidate["failures"]
    )


def test_task11_candidate_requires_positive_cumulative_preconditioner_time() -> None:
    benchmark = load_benchmark_module()
    rows = task11_preconditioner_qualification_rows()
    for row in rows:
        if row["requested_relaxation_preconditioner_strategy"] == "diagonal_mass":
            row["cumulative_preconditioner_wall_time_ms"] = 0.0

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        rows,
        cpu_gpu_parity_rows=task11_preconditioner_cpu_gpu_parity_rows(),
    )

    assert summary["status"] == "invalid"
    assert any(
        "cumulative_preconditioner_wall_time_ms must be positive for diagonal_mass"
        in failure
        for failure in summary["matrix_failures"]
    )


def test_task11_preconditioner_qualification_requires_separate_cpu_gpu_parity() -> None:
    benchmark = load_benchmark_module()

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows()
    )

    assert summary["status"] == "invalid"
    assert summary["promoted_strategy"] is None
    assert any(
        "CPU/GPU parity evidence is missing" in failure
        for failure in summary["matrix_failures"]
    )


def test_task11_preconditioner_qualification_rejects_magnetization_parity_failure() -> None:
    benchmark = load_benchmark_module()
    parity_rows = task11_preconditioner_cpu_gpu_parity_rows()
    gpu_row = next(
        row
        for row in parity_rows
        if row["backend"] == "fem_gpu" and row["mesh_size"] == "fine"
    )
    gpu_row["final_magnetization_values_json"] = json.dumps(
        [[1.0, 0.0, 0.0], [0.0, 1.0, 1e-3]]
    )

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(),
        cpu_gpu_parity_rows=parity_rows,
        qualification_identity=task11_expected_qualification_identity(),
    )

    assert summary["status"] == "invalid"
    assert any(
        "magnetization max-component difference" in failure
        for failure in summary["matrix_failures"]
    )


def test_task11_preconditioner_qualification_rejects_values_with_stale_content_hash(
) -> None:
    benchmark = load_benchmark_module()
    parity_rows = task11_preconditioner_cpu_gpu_parity_rows()
    fabricated_values = json.dumps(
        [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0]],
        separators=(",", ":"),
    )
    for row in parity_rows:
        row["final_magnetization_values_json"] = fabricated_values

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(),
        cpu_gpu_parity_rows=parity_rows,
        qualification_identity=task11_expected_qualification_identity(),
    )

    assert summary["status"] == "invalid"
    assert summary["promoted_strategy"] is None
    assert any(
        "final magnetization content SHA-256 mismatch" in failure
        for failure in summary["matrix_failures"]
    )


def test_task11_preconditioner_qualification_rejects_parity_runtime_drift() -> None:
    benchmark = load_benchmark_module()
    parity_rows = task11_preconditioner_cpu_gpu_parity_rows()
    parity_rows[0]["runtime_manifest_sha256"] = "other-runtime"

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(),
        cpu_gpu_parity_rows=parity_rows,
    )

    assert summary["status"] == "invalid"
    assert any(
        "parity runtime identity" in failure
        for failure in summary["matrix_failures"]
    )


def test_task11_preconditioner_qualification_rejects_wrong_parity_demag_policy() -> None:
    benchmark = load_benchmark_module()
    parity_rows = task11_preconditioner_cpu_gpu_parity_rows()
    parity_rows[0]["demag_preconditioner"] = "JACOBI"

    summary = benchmark.relaxation_preconditioner_qualification_summary(
        task11_preconditioner_qualification_rows(),
        cpu_gpu_parity_rows=parity_rows,
    )

    assert summary["status"] == "invalid"
    assert any(
        "demag_preconditioner must be 'AMG'" in failure
        for failure in summary["matrix_failures"]
    )


def test_task11_final_magnetization_evidence_is_captured_before_tempdir_cleanup(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    artifact = tmp_path / "m_final.json"
    artifact.write_text(
        json.dumps(
            {
                "observable": "m",
                "unit": "1",
                "step": 16,
                "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 1e-12]],
            }
        ),
        encoding="utf-8",
    )

    evidence = benchmark.load_final_magnetization_evidence(tmp_path)

    assert evidence["final_magnetization_node_count"] == 2
    assert evidence["final_magnetization_step"] == 16
    assert json.loads(evidence["final_magnetization_values_json"])[1][2] == 1e-12
    assert evidence["final_magnetization_sha256"] == (
        task11_test_final_magnetization_sha256(
            [[1.0, 0.0, 0.0], [0.0, 1.0, 1e-12]]
        )
    )
    assert evidence["final_magnetization_artifact_sha256"] == (
        benchmark.hashlib.sha256(artifact.read_bytes()).hexdigest()
    )


def test_task11_cumulative_runtime_payload_is_materialized_in_csv_units() -> None:
    benchmark = load_benchmark_module()

    evidence = benchmark.task11_cumulative_relaxation_evidence(
        {
            "accepted_steps": 12,
            "cumulative_armijo_trials": 17,
            "cumulative_demag_solves": 29,
            "cumulative_preconditioner_wall_time_ns": 2_500_000,
            "cumulative_hypre_wall_time_ns": 7_500_000,
            "relaxation_preconditioner_apply_count": 9,
        }
    )

    assert evidence == {
        "accepted_steps": 12,
        "cumulative_armijo_trials": 17,
        "cumulative_demag_solves": 29,
        "cumulative_preconditioner_wall_time_ms": 2.5,
        "cumulative_hypre_wall_time_ms": 7.5,
        "relaxation_preconditioner_apply_count": 9,
    }


def test_task11_qualification_writer_loads_separate_cpu_gpu_parity_csv(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    matrix_path = tmp_path / "matrix.csv"
    parity_path = tmp_path / "parity.csv"
    output_path = tmp_path / "qualification.json"
    benchmark.write_csv(task11_preconditioner_qualification_rows(), str(matrix_path))
    benchmark.write_csv(task11_preconditioner_cpu_gpu_parity_rows(), str(parity_path))

    summary = benchmark.write_relaxation_preconditioner_qualification(
        matrix_path,
        output_path,
        cpu_gpu_parity_input_path=parity_path,
        qualification_identity=task11_expected_qualification_identity(),
    )

    assert summary["status"] == "pass"
    assert summary["cpu_gpu_parity"]["status"] == "pass"
    assert json.loads(output_path.read_text(encoding="utf-8"))["status"] == "pass"


def test_benchmark_csv_uses_repository_line_endings(tmp_path) -> None:
    benchmark = load_benchmark_module()
    output = tmp_path / "benchmark.csv"

    benchmark.write_csv([{"backend": "fem_gpu", "status": "ok"}], str(output))

    assert output.read_bytes() == b"backend,status\nfem_gpu,ok\n"


def test_fixture_identity_rejects_mesh_hash_drift(tmp_path) -> None:
    benchmark = load_benchmark_module()
    mesh = tmp_path / "mesh.json"
    mesh.write_text('{"nodes":[],"elements":[]}', encoding="utf-8")
    manifest = tmp_path / "fixture.json"
    manifest.write_text(
        json.dumps(
            {
                "schema": "fullmag.fem_gpu.performance_fixture.v1",
                "solver_mesh_path": "mesh.json",
                "solver_mesh_sha256": "0" * 64,
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="solver mesh sha256 mismatch"):
        benchmark.load_fixture_manifest(manifest)


def test_fixture_identity_rejects_row_drift(tmp_path) -> None:
    benchmark = load_benchmark_module()
    manifest = write_performance_fixture(tmp_path, benchmark)
    fixture = benchmark.load_fixture_manifest(manifest)

    assert benchmark.verify_fixture_row(
        {
            "solver_mesh_signature": "different-mesh",
            "executed_problem_ir_sha256": "different-ir",
            "reported_scenario": "box500_airbox_exchange_demag",
            "reported_relaxation_algorithm": "nonlinear_cg",
            "steps": 64,
            "executed_steps": 64,
            "requested_relax_torque_tolerance_apm": 1e-6,
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "AMG",
            "requested_demag_relative_tolerance": 1e-12,
            "requested_demag_amg_relax_type": 6,
            "requested_demag_amg_coarsening": 8,
            "requested_demag_amg_interpolation": 6,
            "requested_demag_amg_aggressive_coarsening": 1,
            "demag_linear_solver": "CG",
            "demag_preconditioner": "AMG",
            "demag_relative_tolerance": 1e-12,
            "demag_amg_relax_type": 6,
            "demag_amg_coarsening": 8,
            "demag_amg_interpolation": 6,
            "demag_amg_aggressive_coarsening": 1,
            "node_count": 1,
            "element_count": 1,
        },
        fixture,
    ) == [
        "solver_mesh_signature differs from fixture",
        "executed_problem_ir_sha256 differs from fixture",
    ]


def test_fixture_manifest_sha_must_match_environment_pin(tmp_path) -> None:
    benchmark = load_benchmark_module()
    manifest = write_performance_fixture(tmp_path, benchmark)

    with pytest.raises(ValueError, match="fixture manifest sha256 mismatch"):
        benchmark.load_fixture_manifest(
            manifest,
            expected_manifest_sha256="0" * 64,
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("reported_scenario", "other", "scenario differs from fixture"),
        (
            "reported_relaxation_algorithm",
            "projected_gradient_bb",
            "relaxation_algorithm differs from fixture",
        ),
        ("steps", 63, "steps differs from fixture stop condition"),
        ("executed_steps", 65, "executed_steps violates fixture stop condition"),
        ("requested_relax_torque_tolerance_apm", 2e-6, "torque target differs from fixture"),
        ("requested_demag_solver", "GMRES", "demag solver differs from fixture"),
        (
            "requested_demag_preconditioner",
            "JACOBI",
            "demag preconditioner differs from fixture",
        ),
        ("requested_demag_relative_tolerance", 1e-8, "demag rtol differs from fixture"),
        ("requested_demag_amg_relax_type", 18, "demag AMG relax type differs from fixture"),
        ("node_count", 2, "node_count differs from fixture"),
        ("element_count", 2, "element_count differs from fixture"),
    ],
)
def test_fixture_identity_rejects_full_contract_tamper(
    tmp_path,
    field,
    value,
    message,
) -> None:
    benchmark = load_benchmark_module()
    fixture = benchmark.load_fixture_manifest(
        write_performance_fixture(tmp_path, benchmark)
    )
    row = {
        "solver_mesh_signature": benchmark.solver_mesh_signature(
            _typed_v2_test_mesh()
        ),
        "executed_problem_ir_sha256": "a" * 64,
        "reported_scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "steps": 64,
        "executed_steps": 64,
        "requested_relax_torque_tolerance_apm": 1e-6,
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": 1e-12,
        "requested_demag_amg_relax_type": 6,
        "requested_demag_amg_coarsening": 8,
        "requested_demag_amg_interpolation": 6,
        "requested_demag_amg_aggressive_coarsening": 1,
        "demag_linear_solver": "CG",
        "demag_preconditioner": "AMG",
        "demag_relative_tolerance": 1e-12,
        "demag_amg_relax_type": 6,
        "demag_amg_coarsening": 8,
        "demag_amg_interpolation": 6,
        "demag_amg_aggressive_coarsening": 1,
        "node_count": 1,
        "element_count": 1,
    }
    row[field] = value

    assert message in benchmark.verify_fixture_row(row, fixture)


def test_fixture_identity_rejects_resolved_demag_policy_tamper(tmp_path) -> None:
    benchmark = load_benchmark_module()
    fixture = benchmark.load_fixture_manifest(
        write_performance_fixture(tmp_path, benchmark)
    )
    row = {
        "solver_mesh_signature": "fixture-mesh",
        "executed_problem_ir_sha256": "a" * 64,
        "reported_scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "steps": 64,
        "executed_steps": 64,
        "requested_relax_torque_tolerance_apm": 1e-6,
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": 1e-12,
        "requested_demag_amg_relax_type": 6,
        "requested_demag_amg_coarsening": 8,
        "requested_demag_amg_interpolation": 6,
        "requested_demag_amg_aggressive_coarsening": 1,
        "demag_linear_solver": "CG",
        "demag_preconditioner": "JACOBI",
        "demag_relative_tolerance": 1e-12,
        "demag_amg_relax_type": 6,
        "demag_amg_coarsening": 8,
        "demag_amg_interpolation": 6,
        "demag_amg_aggressive_coarsening": 1,
        "node_count": 1,
        "element_count": 1,
    }

    assert "resolved demag preconditioner differs from fixture" in (
        benchmark.verify_fixture_row(row, fixture)
    )


def test_fixture_identity_requires_hash_observed_from_executed_ir(tmp_path) -> None:
    benchmark = load_benchmark_module()
    fixture = benchmark.load_fixture_manifest(
        write_performance_fixture(tmp_path, benchmark)
    )

    failures = benchmark.verify_fixture_row(
        {
            "solver_mesh_signature": "fixture-mesh",
            "problem_ir_sha256": fixture.problem_ir_sha256,
        },
        fixture,
    )

    assert "executed_problem_ir_sha256 differs from fixture" in failures


def test_fixture_execution_command_consumes_exact_canonical_ir() -> None:
    benchmark = load_benchmark_module()

    command = benchmark.problem_ir_execution_command(
        binary=Path("/runtime/fullmag"),
        problem_ir_path=Path("/tmp/canonical.problem-ir.json"),
        run_dir=Path("/tmp/run"),
        until_seconds=1e-12,
    )

    assert command == [
        "/runtime/fullmag",
        "run-json",
        "/tmp/canonical.problem-ir.json",
        "--until",
        "1e-12",
        "--output-dir",
        "/tmp/run",
    ]


def test_fixture_stop_identity_is_extracted_from_exact_problem_ir() -> None:
    benchmark = load_benchmark_module()

    stop = benchmark.problem_ir_stop_condition(
        {
            "study": {
                "stop": {
                    "max_steps": 64,
                    "torque_tolerance_apm": 1.0e-6,
                }
            }
        }
    )

    assert stop == {
        "kind": "torque_or_max_steps",
        "benchmark_only_torque_target_apm": 1.0e-6,
        "max_steps": 64,
    }


def test_run_json_artifacts_supply_authoritative_benchmark_payload(tmp_path) -> None:
    benchmark = load_benchmark_module()
    (tmp_path / "metadata.json").write_text(
        json.dumps(
            {
                "status": "completed",
                "scalar_rows": 2,
                "execution_provenance": {"precision": "double"},
                "requested_execution": {"precision": "single"},
                "fem_gpu_relaxation_qualification": {
                    "executed_steps": 2,
                },
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "scalars.csv").write_text(
        "step,time,solver_dt,E_ex,E_demag,E_ext,E_ani,E_dmi,E_total,"
        "max_dm_dt,max_h_eff,max_h_demag,max_torque_Apm,max_torque_T\n"
        "2,2e-12,1e-12,1,2,3,4,5,15,6,7,8,9,10\n",
        encoding="utf-8",
    )
    (tmp_path / "solver_steps.csv").write_text(
        "step,rejected_attempts,rhs_evals,demag_solves\n"
        "1,1,2,3\n"
        "2,0,3,4\n",
        encoding="utf-8",
    )

    payload = benchmark.load_authoritative_benchmark_payload(tmp_path)

    assert payload == {
        "status": "completed",
        "executed_steps": 2,
        "artifact_dir": str(tmp_path),
        "precision": "double",
        "final_time_s": "2e-12",
        "final_solver_dt_s": "1e-12",
        "final_e_ex_j": "1",
        "final_e_demag_j": "2",
        "final_e_ext_j": "3",
        "final_e_ani_j": "4",
        "final_e_dmi_j": "5",
        "final_e_total_j": "15",
        "max_dm_dt": "6",
        "max_h_eff": "7",
        "max_h_demag": "8",
        "max_torque_Apm": "9",
            "max_torque_T": "10",
            "accepted_steps": 2,
            "rhs_evals": 3,
            "total_rhs_evals": 5,
            "demag_solves": 7,
            "cumulative_demag_solves": 7,
            "rejected_attempts": 1,
        }


def test_native_direct_minimizer_accepted_armijo_proof_is_plumbed_to_solver_steps() -> None:
    header = (REPO_ROOT / "native" / "include" / "fullmag_fem.h").read_text(
        encoding="utf-8"
    )
    sys_bindings = (
        REPO_ROOT / "crates" / "fullmag-fem-sys" / "src" / "lib.rs"
    ).read_text(encoding="utf-8")
    runner_types = (
        REPO_ROOT / "crates" / "fullmag-runner" / "src" / "types.rs"
    ).read_text(encoding="utf-8")
    native_fem = (
        REPO_ROOT / "crates" / "fullmag-runner" / "src" / "native_fem.rs"
    ).read_text(encoding="utf-8")
    artifacts = (
        REPO_ROOT / "crates" / "fullmag-runner" / "src" / "artifacts.rs"
    ).read_text(encoding="utf-8")
    cpu_pgbb = (
        REPO_ROOT
        / "backends"
        / "fem"
        / "cpu"
        / "mfem"
        / "relaxation"
        / "projected_gradient_bb.cpp"
    ).read_text(encoding="utf-8")
    gpu_pgbb = (
        REPO_ROOT
        / "backends"
        / "fem"
        / "gpu"
        / "cuda"
        / "relaxation"
        / "pgbb.cpp"
    ).read_text(encoding="utf-8")
    cpu_ncg = (
        REPO_ROOT
        / "backends"
        / "fem"
        / "cpu"
        / "mfem"
        / "relaxation"
        / "nonlinear_cg.cpp"
    ).read_text(encoding="utf-8")
    gpu_ncg = (
        REPO_ROOT
        / "backends"
        / "fem"
        / "gpu"
        / "cuda"
        / "relaxation"
        / "nonlinear_cg.cpp"
    ).read_text(encoding="utf-8")

    fields = [
        "accepted_energy_proof_available",
        "accepted_energy_delta_j",
        "accepted_energy_roundoff_bound_j",
        "accepted_energy_delta_upper_j",
        "armijo_increment_rhs_j",
    ]
    step_stats = header.split("} fullmag_fem_step_stats;", 1)[0].rsplit(
        "typedef struct {", 1
    )[1]
    assert all(field not in step_stats for field in fields)
    assert "FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION" in header
    assert "fullmag_fem_accepted_energy_proof_v1" in header
    assert "fullmag_fem_backend_take_accepted_energy_proof_v1" in header
    assert "fullmag_fem_backend_accepted_energy_proof_v1" not in header
    assert "abi_version" in header
    assert "struct_size" in header
    for field in fields:
        assert field in header
        assert field in sys_bindings
        assert field in runner_types
        assert field in native_fem
        assert field in artifacts
    for source in (cpu_pgbb, gpu_pgbb, cpu_ncg, gpu_ncg):
        assert "accepted_energy_proof.available = true" in source
        assert "accepted_energy_proof.delta_j" in source
        assert "accepted_energy_proof.roundoff_bound_j" in source
        assert "accepted_energy_proof.delta_upper_j" in source
        assert "accepted_energy_proof.armijo_rhs_j" in source
    assert native_fem.count("self.take_accepted_energy_proof()?") == 1

    assert "accepted_energy_delta_upper_j <= armijo_increment_rhs_j" in cpu_pgbb
    assert "accepted_energy_delta_upper_j <= armijo_increment_rhs_j" in gpu_pgbb
    assert "accepted_energy_delta_upper_j <= armijo_increment_rhs_j" in cpu_ncg
    assert "accepted_energy_delta_upper_j <= armijo_increment_rhs_j" in gpu_ncg
    assert "accepted_energy_proof.available = true" in cpu_pgbb
    assert "accepted_energy_proof.available = true" in gpu_pgbb
    assert "accepted_energy_proof.available = true" in cpu_ncg
    assert "accepted_energy_proof.available = true" in gpu_ncg


def test_authoritative_payload_uses_requested_precision_only_as_fallback(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    (tmp_path / "metadata.json").write_text(
        json.dumps(
            {
                "status": "completed",
                "scalar_rows": 1,
                "requested_execution": {"precision": "double"},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "scalars.csv").write_text(
        "step,E_total\n1,1e-20\n",
        encoding="utf-8",
    )

    payload = benchmark.load_authoritative_benchmark_payload(tmp_path)

    assert payload is not None
    assert payload["precision"] == "double"


def test_authoritative_payload_proves_zero_demag_solves_only_for_explicit_no_demag(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    (tmp_path / "metadata.json").write_text(
        json.dumps(
            {
                "status": "completed",
                "scalar_rows": 1,
                "execution_provenance": {
                    "precision": "double",
                    "fem_demag_operator_mode": "none",
                },
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "scalars.csv").write_text(
        "step,E_total\n1,1e-20\n",
        encoding="utf-8",
    )

    payload = benchmark.load_authoritative_benchmark_payload(tmp_path)

    assert payload is not None
    assert payload["demag_solves"] == 0


def test_authoritative_payload_does_not_fabricate_zero_for_cpu_demag_runtime(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    (tmp_path / "metadata.json").write_text(
        json.dumps(
            {
                "status": "completed",
                "scalar_rows": 1,
                "execution_provenance": {"fem_demag_operator_mode": "none"},
                "demag_runtime": {"model": "airbox"},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "scalars.csv").write_text(
        "step,E_total\n1,1e-20\n",
        encoding="utf-8",
    )

    payload = benchmark.load_authoritative_benchmark_payload(tmp_path)

    assert payload is not None
    assert "demag_solves" not in payload


def test_authoritative_payload_reads_latest_accepted_pgbb_proof(tmp_path: Path) -> None:
    benchmark = load_benchmark_module()
    (tmp_path / "metadata.json").write_text(
        json.dumps({"status": "completed", "scalar_rows": 2}),
        encoding="utf-8",
    )
    (tmp_path / "scalars.csv").write_text(
        "step,E_total\n1,2e-20\n2,1e-20\n",
        encoding="utf-8",
    )
    (tmp_path / "solver_steps.csv").write_text(
        "step,accepted_energy_proof_available,accepted_energy_delta_j,"
        "accepted_energy_roundoff_bound_j,accepted_energy_delta_upper_j,"
        "armijo_increment_rhs_j\n"
        "1,true,-2e-20,1e-21,-1.9e-20,-1e-20\n"
        "2,true,-3e-20,2e-21,-2.8e-20,-2e-20\n",
        encoding="utf-8",
    )

    payload = benchmark.load_authoritative_benchmark_payload(tmp_path)

    assert payload is not None
    assert payload["accepted_energy_proof_available"] is True
    assert payload["accepted_energy_delta_j"] == -3e-20
    assert payload["accepted_energy_roundoff_bound_j"] == 2e-21
    assert payload["accepted_energy_delta_upper_j"] == -2.8e-20
    assert payload["armijo_increment_rhs_j"] == -2e-20
    assert payload["accepted_energy_proof_count"] == 2
    assert payload["accepted_energy_proof_invalid_count"] == 0
    assert payload["accepted_energy_proof_invalid_details"] == []


def test_authoritative_payload_rejects_invalid_middle_pgbb_proof(tmp_path: Path) -> None:
    benchmark = load_benchmark_module()
    (tmp_path / "metadata.json").write_text(
        json.dumps({"status": "completed", "scalar_rows": 3}),
        encoding="utf-8",
    )
    (tmp_path / "scalars.csv").write_text(
        "step,E_total\n1,3e-20\n2,2e-20\n3,1e-20\n",
        encoding="utf-8",
    )
    (tmp_path / "solver_steps.csv").write_text(
        "step,accepted_energy_proof_available,accepted_energy_delta_j,"
        "accepted_energy_roundoff_bound_j,accepted_energy_delta_upper_j,"
        "armijo_increment_rhs_j\n"
        "1,true,-2e-20,1e-21,-1.9e-20,-1e-20\n"
        "2,true,-3e-20,2e-21,-1e-20,-2e-20\n"
        "3,true,-4e-20,1e-21,-3.9e-20,-3e-20\n",
        encoding="utf-8",
    )

    payload = benchmark.load_authoritative_benchmark_payload(tmp_path)

    assert payload is not None
    assert payload["accepted_energy_proof_count"] == 3
    assert payload["accepted_energy_proof_invalid_count"] == 1
    assert payload["accepted_energy_proof_invalid_details"] == [
        "step=2: upper exceeds Armijo RHS"
    ]


def test_run_json_summary_publishes_cumulative_rhs_telemetry() -> None:
    source = (REPO_ROOT / "crates" / "fullmag-cli" / "src" / "main.rs").read_text(
        encoding="utf-8"
    )
    function_start = source.index("fn run_json_summary(")
    function_end = source.index("fn is_script_mode(", function_start)
    function_source = source[function_start:function_end]

    assert '"rhs_evals"' in function_source
    assert '"total_rhs_evals"' in function_source
    assert ".steps" in function_source
    assert ".sum::<u64>()" in function_source


def test_benchmark_parses_run_json_cumulative_rhs_telemetry() -> None:
    benchmark = load_benchmark_module()
    output = json.dumps(
        {
            "status": "completed",
            "total_steps": 64,
            "rhs_evals": 1,
            "total_rhs_evals": 64,
            "output_dir": "/tmp/run",
        }
    )

    payload = benchmark.parse_benchmark_result(output)

    assert payload is not None
    assert payload["executed_steps"] == 64
    assert payload["rhs_evals"] == 1
    assert payload["total_rhs_evals"] == 64


def test_weak_workspace_payload_is_enriched_without_overriding_stronger_fields() -> None:
    benchmark = load_benchmark_module()
    output = (
        json.dumps(
            {
                "workspace_dir": "/tmp/workspace",
                "backend_create_wall_time_ns": 10,
                "precision": "double",
                "demag_solves": 0,
                "rhs_evals": 4,
            }
        )
        + "\nfullmag workspace summary\n"
        + "- status: completed\n"
        + "- total_steps: 64\n"
        + "- artifact_dir: /tmp/artifacts\n"
    )
    weak_payload = benchmark.parse_benchmark_result(output)
    script_summary = benchmark.parse_script_run_summary(output)

    assert weak_payload == {
        "status": "completed",
        "executed_steps": 64,
        "artifact_dir": "/tmp/artifacts",
    }

    payload = benchmark.merge_missing_payload_fields(
        weak_payload,
        script_summary,
        {"executed_steps": 63, "demag_solves": 127},
    )

    assert payload == {
        "status": "completed",
        "executed_steps": 64,
        "artifact_dir": "/tmp/artifacts",
        "workspace_dir": "/tmp/workspace",
        "backend_create_wall_time_ns": 10,
        "precision": "double",
        "demag_solves": 0,
        "rhs_evals": 4,
    }


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        (["3", "2", "2"], (True, 3, 0.0)),
        (["3"], (True, 1, 0.0)),
        (["2", "3"], (False, 2, 1.0)),
        (["2", "nan"], (False, 2, None)),
        ([], (False, 0, None)),
    ],
)
def test_energy_monotonicity_evidence_uses_complete_scalar_trajectory(
    tmp_path: Path,
    values: list[str],
    expected: tuple[bool, int, float | None],
) -> None:
    benchmark = load_benchmark_module()
    if values:
        (tmp_path / "scalars.csv").write_text(
            "step,E_total\n"
            + "".join(f"{index},{value}\n" for index, value in enumerate(values)),
            encoding="utf-8",
        )

    evidence = benchmark.load_energy_monotonicity_evidence(tmp_path)

    assert evidence == {
        "energy_monotonicity_satisfied": expected[0],
        "energy_trajectory_record_count": expected[1],
        "energy_trajectory_max_increase_j": expected[2],
    }


def test_fixture_generation_uses_runtime_realized_mesh_signature() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.fixture_solver_mesh_signature(
        {
            "status": "ok",
            "solver_mesh_signature": "runtime-realized-signature",
        }
    ) == "runtime-realized-signature"
    with pytest.raises(ValueError, match="did not report solver_mesh_signature"):
        benchmark.fixture_solver_mesh_signature({"status": "ok"})


def test_fem_gpu_performance_regression_recipe_is_fail_closed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(justfile, "verify-fem-gpu-performance-regression")

    for required in [
            "--fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json",
            "--require-fixture-identity",
            "--gpu-warmup",
            'FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}"',
            '--repeat "$FULLMAG_BENCH_REPEAT"',
            "--require-stable-solver-mesh",
        "--accepted-baseline benchmarks/fem-gpu/accepted/rtx4080-sm89/benchmark.csv",
        "--require-accepted-baseline",
        "--max-performance-regression-percent 5",
        "benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "--fixture-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "FULLMAG_BENCH_DOMAIN_HMAX=50e-9",
        "FULLMAG_BENCH_AIRBOX_HMAX=100e-9",
    ]:
        assert required in recipe


def test_task11_preconditioner_qualification_recipe_is_literal_and_fail_closed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(
        justfile,
        "verify-fem-gpu-relaxation-preconditioner-qualification",
    )

    for required in [
        "--meshes coarse,medium,fine",
        "--backends cpu,gpu",
        "--backends gpu",
        "--scenarios box500_airbox_exchange_demag",
        "--relax-algorithms nonlinear_cg",
        "--relaxation-preconditioner-strategies none,diagonal_mass,lumped_exchange_mass_cg4,lumped_exchange_mass_cg8,stagnation_triggered_cg8",
        "--demag-rtols 1e-12",
        "--demag-amg-relax-types 6",
        "--steps 64",
        "--dt 1e-13",
        "--relax-torque-tolerance-apm 8000",
        "--repeat 5",
        "--capture-final-magnetization",
        "--task11-relaxation-preconditioner-cpu-gpu-parity-sweep",
        "--task11-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json",
        "--task11-qualification-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "--require-gpu-strict-residency",
        "--require-gpu-control-readback-budget",
        "--require-demag-converged",
        "--relaxation-preconditioner-cpu-gpu-parity-input",
        "--relaxation-preconditioner-qualification-input",
        "--relaxation-preconditioner-qualification-output",
    ]:
        assert required in recipe


def test_authoritative_demag_benchmark_preserves_pre_task0_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(
        justfile, "verify-fem-gpu-demag-performance-benchmark"
    )

    assert "box500_airbox_exchange_demag,box500_airbox_exchange_demag_anis_uniaxial,box500_airbox_exchange_demag_anis_cubic" in recipe
    assert 'FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-OMIT,AMG,JACOBI}"' in recipe
    assert 'FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP="${FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP:-2}"' in recipe
    assert "--require-best-demag-policy" in recipe
    assert '--min-gpu-demag-total-speedup "$FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP"' in recipe
    assert "--fixture-manifest" not in recipe
    assert "FULLMAG_BENCH_REPEAT" not in recipe


def test_pre_remediation_capture_has_narrow_task0_contract() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(
        justfile, "capture-fem-gpu-pre-remediation-performance-baseline"
    )

    for required in (
        "box500_airbox_exchange_demag",
        "--relax-algorithms nonlinear_cg",
        "--demag-preconditioners AMG",
        "--demag-amg-relax-types 6",
        "--steps 64",
        "--repeat 5",
        "--fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json",
        "--fixture-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "--require-fixture-identity",
    ):
        assert required in recipe
    assert "--min-gpu-demag-total-speedup" not in recipe
    assert "--require-best-demag-policy" not in recipe


def test_benchmark_performance_summary_groups_repeat_distributions() -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
    }

    summary = benchmark.performance_distribution_summary(
        [
            {**base, "wall_time_ms": 10.0},
            {**base, "wall_time_ms": 12.0},
            {**base, "wall_time_ms": 20.0},
        ]
    )

    assert len(summary) == 1
    assert summary[0]["metrics"]["wall_time_ms"] == {
        "count": 3,
        "p50": 12.0,
        "p95": 20.0,
        "stddev": pytest.approx(4.3204937989),
    }


def test_performance_regression_compares_p95_distributions() -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
    }
    baseline = [
        {**base, "wall_time_ms": value} for value in [10.0, 20.0, 30.0, 40.0, 50.0]
    ]
    within_limit = [
        {**base, "wall_time_ms": value} for value in [10.0, 20.0, 30.0, 40.0, 52.0]
    ]
    regressed = [
        {**base, "wall_time_ms": value} for value in [10.0, 20.0, 30.0, 40.0, 53.0]
    ]

    assert benchmark.performance_regression_failures(
        within_limit,
        baseline,
        max_regression_percent=5.0,
    ) == []
    failures = benchmark.performance_regression_failures(
        regressed,
        baseline,
        max_regression_percent=5.0,
    )
    assert len(failures) == 1
    assert "p95" in failures[0]


def test_performance_regression_gates_only_objective_metrics() -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
    }
    baseline = [
        {**base, "wall_time_ms": 100.0, "demag_assemble_wall_time_ms": 10.0}
        for _ in range(5)
    ]
    current = [
        {**base, "wall_time_ms": 104.0, "demag_assemble_wall_time_ms": 100.0}
        for _ in range(5)
    ]

    assert benchmark.performance_regression_failures(
        current,
        baseline,
        max_regression_percent=5.0,
    ) == []


@pytest.mark.parametrize(
    ("side", "values", "reason"),
    [
        ("current", [None] * 5, "current wall_time_ms contains missing"),
        ("accepted", [None] * 5, "accepted wall_time_ms contains missing"),
        ("current", [10.0, 11.0, float("nan"), 13.0, 14.0], "current wall_time_ms contains non-finite"),
        ("accepted", [10.0, 11.0, float("inf"), 13.0, 14.0], "accepted wall_time_ms contains non-finite"),
        ("current", [10.0, 11.0, 0.0, 13.0, 14.0], "current wall_time_ms contains non-positive"),
        ("accepted", [10.0, 11.0, -1.0, 13.0, 14.0], "accepted wall_time_ms contains non-positive"),
        ("current", [10.0, 11.0, 12.0, 13.0], "current wall_time_ms requires at least 5 samples"),
        ("accepted", [10.0, 11.0, 12.0, 13.0], "accepted wall_time_ms requires at least 5 samples"),
    ],
)
def test_required_accepted_baseline_rejects_invalid_objective_samples(
    side,
    values,
    reason,
) -> None:
    benchmark = load_benchmark_module()
    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "demag_solver_apply_wall_time_ms": 1.0,
    }
    valid = [{**base, "wall_time_ms": value} for value in [10, 11, 12, 13, 14]]
    invalid = [{**base, "wall_time_ms": value} for value in values]
    current = invalid if side == "current" else valid
    accepted = invalid if side == "accepted" else valid

    failures = benchmark.performance_regression_failures(
        current,
        accepted,
        max_regression_percent=5.0,
        require_complete_objectives=True,
        required_sample_count=5,
    )

    assert any(reason in failure for failure in failures)


def test_gpu_environment_identity_rejects_different_device() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.gpu_environment_identity_failures(
        {
            "gpu": {
                "uuid": "GPU-expected",
                "name": "NVIDIA GeForce RTX 4080 SUPER",
                "compute_capability": "8.9",
            }
        },
        {
            "uuid": "GPU-other",
            "name": "NVIDIA GeForce RTX 4090",
            "compute_capability": "8.9",
        },
    ) == [
        "GPU uuid differs from accepted baseline",
        "GPU name differs from accepted baseline",
    ]


def test_fixture_generation_recipe_uses_managed_runtime() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(justfile, "generate-fem-gpu-performance-fixtures")

    assert "just ensure-managed-fem-runtime" in recipe
    assert "docker compose --profile fem-gpu run --rm" in recipe
    assert "PYTHONPATH=/workspace/packages/fullmag-py/src" in recipe
    assert "FULLMAG_GMSH_THREADS=1" in recipe
    assert "--steps 1" in recipe
    assert "--reuse-generated-domain-mesh" in recipe
    assert "--write-fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json" in recipe
    assert "--write-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json" in recipe


def test_typed_fixture_v2_recipes_are_managed_and_strict() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    generation = just_recipe_source(justfile, "generate-fem-performance-fixture-v2")
    verification = just_recipe_source(justfile, "verify-fem-performance-fixture-v2")
    assert "just ensure-managed-fem-runtime" in generation
    assert "FULLMAG_GMSH_THREADS=1" in generation
    assert "--demag-rtols 1e-12" in generation
    assert "--demag-amg-relax-types 6" in generation
    assert "box500_airbox_exchange_demag_v2.fixture.json" in generation
    assert "amg_qualification_suite_v2.json" in generation
    assert 'runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"' in generation
    assert '"$runtime_root:/workspace/.fullmag/runtime:ro"' in generation
    assert "FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime" in generation
    assert "--target fem_mixed_p1_contract" in verification
    assert "FULLMAG_MIXED_P1_ROLLBACK_DEVICE=cpu" in verification
    assert "--list-amg-qualification-fixture-suite" in verification
    assert "while IFS=$'\\''\\t'\\'' read -r" in verification
    assert 'runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"' in verification
    assert '"$runtime_root:/workspace/.fullmag/runtime:ro"' in verification
    assert "FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime" in verification


def test_equilibrium_parity_recipe_mounts_managed_runtime() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(justfile, "verify-fem-relaxation-equilibrium-parity")

    assert "just ensure-managed-fem-runtime" in recipe
    assert 'runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"' in recipe
    assert '"$runtime_root:/workspace/.fullmag/runtime:ro"' in recipe
    assert "FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime" in recipe
    assert "--require-equilibrium-parity" in recipe


def test_runtime_restore_manifest_rejects_library_hash_drift(tmp_path) -> None:
    benchmark = load_benchmark_module()
    bundle = tmp_path / "bundle"
    (bundle / "lib").mkdir(parents=True)
    (bundle / "manifest.json").write_text("manifest", encoding="utf-8")
    (bundle / "snapshot.json").write_text("snapshot", encoding="utf-8")
    (bundle / "lib" / "libfullmag_fem.so").write_text("library", encoding="utf-8")
    restore_manifest = bundle / "restore-manifest-v2.json"
    restore_manifest.write_text(
        json.dumps(
            {
                "schema": "fullmag.fem_gpu.runtime_restore_manifest.v2",
                "bundle_root": str(bundle),
                "manifest_sha256": benchmark.hashlib.sha256(b"manifest").hexdigest(),
                "immutable_snapshot_json_sha256": benchmark.hashlib.sha256(
                    b"snapshot"
                ).hexdigest(),
                "libraries": {
                    "libfullmag_fem": {
                        "path": "lib/libfullmag_fem.so",
                        "sha256": "0" * 64,
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="libfullmag_fem sha256 mismatch"):
        benchmark.validate_runtime_restore_manifest(restore_manifest)


def test_runtime_restore_recipe_proves_controlled_export_invariance() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = just_recipe_source(
        justfile, "verify-fem-gpu-pre-remediation-runtime-restore"
    )

    for required in (
        "scripts/verify_fem_gpu_runtime_restore.py capture",
        "benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json",
        "just rebuild-fem-runtime",
        "scripts/verify_fem_gpu_runtime_restore.py compare",
    ):
        assert required in recipe


def test_runtime_restore_verifier_fails_clearly_for_missing_external_bundle(
    tmp_path,
) -> None:
    environment = tmp_path / "environment.json"
    environment.write_text(
        json.dumps(
            {
                "runtime_bundle": {
                    "root": "missing/bundle",
                    "restore_manifest_path": "missing/bundle/restore-manifest-v2.json",
                    "restore_manifest_sha256": "0" * 64,
                }
            }
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(RUNTIME_RESTORE_VERIFIER),
            "capture",
            "--environment",
            str(environment),
            "--state",
            str(tmp_path / "state.json"),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode != 0
    assert "external immutable FEM GPU runtime bundle is missing" in completed.stderr


def test_resolves_container_workspace_artifact_path_on_host(monkeypatch) -> None:
    validator = load_validator_module()
    with tempfile.TemporaryDirectory() as directory:
        repo_root = Path(directory)
        artifact_dir = repo_root / "examples" / "case.zarr" / "artifacts"
        artifact_dir.mkdir(parents=True)
        monkeypatch.chdir(repo_root)

        resolved = validator.resolve_artifact_dir(
            {"artifact_dir": "/workspace/examples/case.zarr/artifacts"},
            repo_root / "runtime.log",
        )

        assert resolved == artifact_dir


def just_recipe_source(justfile: str, recipe_name: str) -> str:
    marker = f"{recipe_name}:"
    start = justfile.index(marker)
    following = justfile[start + len(marker) :].splitlines()
    recipe_lines = [marker]
    for line in following:
        if line and not line.startswith((" ", "\t", "#")) and ":" in line:
            break
        recipe_lines.append(line)
    return "\n".join(recipe_lines)


def expected_cpu_line_search(algorithm: str) -> str:
    if algorithm == "projected_gradient_bb":
        return "native_armijo_backtracking_bb1_bb2"
    if algorithm == "nonlinear_cg":
        return "native_armijo_backtracking_pr_plus_restart"
    return "native_armijo_backtracking"


def expected_realization(engine: str, algorithm: str) -> str:
    return {
        ("cpu", "projected_gradient_bb"): "native_mfem_pgbb",
        ("gpu", "projected_gradient_bb"): "native_cuda_pgbb",
        ("cpu", "nonlinear_cg"): "native_mfem_nonlinear_cg",
        ("gpu", "nonlinear_cg"): "native_cuda_nonlinear_cg",
        ("cpu", "tangent_plane_implicit"): "native_mfem_tpi",
    }[(engine, algorithm)]


def write_artifacts(
    artifact_dir: Path,
    algorithm: str = "nonlinear_cg",
    energies: list[float] | None = None,
    steps: list[int] | None = None,
    torques: list[float] | None = None,
    gpu_status: str = "production_executable",
    engine: str = "gpu",
    include_cpu_qualification: bool = True,
    include_cpu_algorithm_policy: bool = True,
    include_cpu_algorithm_update_policy: bool = True,
    include_gpu_qualification: bool = True,
    include_gpu_gradient_policy: bool = True,
    include_gpu_norm_defect: bool = True,
    cpu_norm_defect: float = 0.0,
    gpu_norm_defect: float = 0.0,
    cpu_line_search: str | None = None,
    gpu_provenance_exchange_operator_mode: str = "legacy_sparse_gpu",
) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    energies = energies or [4.0e-17, 3.0e-17, 2.0e-17, 1.0e-17]
    steps = steps or list(range(1, len(energies) + 1))
    torques = torques or [1.0 for _ in energies]
    assert len(steps) == len(energies)
    assert len(torques) == len(energies)
    execution_engine = "fem_native_gpu" if engine == "gpu" else "fem_cpu_native"
    fem_execution_mode = "all_in_gpu_legacy_sparse" if engine == "gpu" else "cpu_native"
    uses_cuda_kernels = "true" if engine == "gpu" else "false"
    uses_gpu_poisson = "true" if engine == "gpu" else "false"
    energy_minimizer_realization = (
        "native_llg_time_integrator"
        if algorithm == "llg_overdamped"
        else expected_realization(engine, algorithm)
    )
    llg_provenance_policy = (
        """
    "requested_integrator": "heun",
    "resolved_integrator": "heun",
    "llg_mode": "pure_damping","""
        if algorithm == "llg_overdamped"
        else ""
    )
    qualification_key = (
        f'"fem_gpu_qualification_status": "{gpu_status}",'
        if engine == "gpu"
        else '"fem_gpu_qualification_status": null,'
    )
    gpu_provenance_policy = ""
    if engine == "gpu":
        gpu_provenance_policy = f"""
    "fem_data_residency": "device_source_of_truth",
    "fem_exchange_operator_mode": "{gpu_provenance_exchange_operator_mode}",
    "fem_demag_operator_mode": "device_hypre_poisson","""
    cpu_qualification = ""
    if engine == "cpu" and include_cpu_qualification:
        line_search = cpu_line_search or expected_cpu_line_search(algorithm)
        if algorithm == "llg_overdamped":
            cpu_algorithm_policy = (
                """"algorithm_policy": {
      "realization": "native_llg_time_integrator",
      "time_integrator": "heun",
      "precession_policy": "disabled_pure_damping",
      "rhs_policy": "llg_overdamped_rhs"
    }"""
                if include_cpu_algorithm_policy
                else '"algorithm_policy": null'
            )
        else:
            update_policy = ""
            preconditioner = "exchange_plus_mass_tangent_gradient"
            linear_solver_policy = (
                "serial MFEM CG production default; HyprePCG/BoomerAMG explicit opt-in"
            )
            tangent_operator_policy = ""
            if algorithm == "tangent_plane_implicit":
                preconditioner = "native_tangent_plane_linear_solve_preconditioner"
                linear_solver_policy = (
                    "MFEM/Hypre Krylov solver with non-SPD fallback for indefinite terms"
                )
                tangent_operator_policy = (
                    '"tangent_operator": '
                    '"mass_exchange_local_anisotropy_zeeman_dmi_demag_linear_response",'
                )
            elif include_cpu_algorithm_update_policy:
                update_policy = (
                    '"direction_update": "polak_ribiere_plus_projected_restart",'
                    if algorithm == "nonlinear_cg"
                    else '"step_update": "alternating_bb1_bb2",'
                )
            derivative_contract = (
                '"metric": "mu0_ms_fem_lumped_volume",\n'
                '      "gradient_metric": "mu0_ms_fem_lumped_volume",\n'
                '      "gradient_units": "A/m",\n'
                '      "search_direction_units": "A/m",\n'
                '      "line_search_step_units": "m/A",\n'
                '      "armijo_slope_units": "J A/m",\n'
                '      "armijo_decrement_units": "J",'
                '\n      "armijo_derivative_units": "J",'
            )
            cpu_algorithm_policy = f""""algorithm_policy": {{
    "realization": "{expected_realization("cpu", algorithm)}",
      {derivative_contract}
      "preconditioner": "{preconditioner}",
      "linear_solver_policy": "{linear_solver_policy}",
      "line_search": "{line_search}",
      {tangent_operator_policy}
      {update_policy}
      "gpu_status": "unsupported"
    }}"""
        cpu_qualification = f""",
  "fem_cpu_relaxation_qualification": {{
    "schema_version": "fem_cpu_relaxation_qualification.v1",
    "benchmark_gate_version": "fem_cpu_no_pbc_adaptive.v1",
    "relaxation_algorithm": "{algorithm}",
    "executed_steps": {len(energies)},
    "stop_reason": "max_steps",
    "stop_metric_name": "steps",
    "stop_metric_value": {float(len(energies)):.1f},
    "stop_threshold": {float(len(energies)):.1f},
    "assembly_mode": "legacy_sparse",
    "physics_terms": ["exchange", "demag"],
    "norm_defect": {cpu_norm_defect:.15e},
    {cpu_algorithm_policy}
  }}"""
    gpu_qualification = ""
    if engine == "gpu" and include_gpu_qualification:
        if algorithm == "llg_overdamped":
            algorithm_policy = """"realization": "native_llg_time_integrator",
      "time_integrator": "heun",
      "precession_policy": "disabled_pure_damping",
      "rhs_policy": "llg_overdamped_rhs"
"""
        elif algorithm in {"projected_gradient_bb", "nonlinear_cg"}:
            line_search = expected_cpu_line_search(algorithm)
            direction_policy = (
                '"direction_update": "polak_ribiere_plus_projected_restart"'
                if algorithm == "nonlinear_cg"
                else '"step_update": "alternating_bb1_bb2"'
            )
            gradient_policy = (
                '"gradient_policy": "device_tangent_gradient",'
                if include_gpu_gradient_policy
                else ""
            )
            algorithm_policy = f""""realization": "{expected_realization("gpu", algorithm)}",
      "metric": "mu0_ms_fem_lumped_volume",
      "gradient_metric": "mu0_ms_fem_lumped_volume",
      "gradient_units": "A/m",
      "search_direction_units": "A/m",
      "line_search_step_units": "m/A",
      "armijo_slope_units": "J A/m",
      "armijo_decrement_units": "J",
      "armijo_derivative_units": "J",
      {gradient_policy}
      "line_search": "{line_search}",
      {direction_policy}
"""
        else:
            algorithm_policy = ""
        gpu_norm_defect_field = (
            f'"norm_defect": {gpu_norm_defect:.15e},'
            if include_gpu_norm_defect
            else ""
        )
        gpu_qualification = f""",
  "fem_gpu_relaxation_qualification": {{
    "schema_version": "fem_gpu_relaxation_qualification.v1",
    "relaxation_algorithm": "{algorithm}",
    "algorithm_policy": {{
      {algorithm_policy}
    }},
    "device_policy": {{
      "execution_mode": "all_in_gpu_legacy_sparse",
      "qualification_status": "{gpu_status}",
      "data_residency": "device_source_of_truth",
      "exchange_operator_mode": "legacy_sparse_gpu",
      "demag_operator_mode": "device_hypre_poisson",
      "uses_cuda_kernels": true,
      "uses_gpu_poisson": true,
      "hot_loop_exchange_host_sync_count": 0,
      "hot_loop_compute_host_sync_count": 3
    }},
    {gpu_norm_defect_field}
    "executed_steps": {len(energies)}
  }}"""
    (artifact_dir / "metadata.json").write_text(
        f"""{{
  "status": "completed",
  "problem_name": "fem_relax_gpu_smoke_{algorithm}",
  "scalar_rows": {len(energies)},
  "execution_provenance": {{
    "execution_engine": "{execution_engine}",
    "requested_energy_minimizer": "{algorithm}",
    "resolved_energy_minimizer": "{algorithm}",
    "energy_minimizer_realization": "{energy_minimizer_realization}",
{llg_provenance_policy}
    {qualification_key}
    "fem_execution_mode": "{fem_execution_mode}",
{gpu_provenance_policy}
    "uses_cuda_kernels": {uses_cuda_kernels},
    "uses_gpu_poisson": {uses_gpu_poisson},
    "hot_loop_exchange_host_sync_count": 0,
    "hot_loop_compute_host_sync_count": 3
  }}{cpu_qualification}{gpu_qualification}
}}
""",
        encoding="utf-8",
    )
    rows = [
        "step,time,solver_dt,mx,my,mz,E_ex,E_demag,E_ext,E_ani,E_dmi,E_total,"
        "max_dm_dt,max_h_eff,max_h_demag,max_torque_Apm,max_torque_T"
    ]
    for index, energy, torque in zip(steps, energies, torques):
        rows.append(
            f"{index},0.0,1.0e-6,0.0,0.0,1.0,0.0,0.0,0.0,0.0,0.0,{energy:.15e},"
            f"0.0,1.0,0.0,{torque:.15e},{torque:.15e}"
        )
    (artifact_dir / "scalars.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")


def run_validator(
    log_text: str,
    algorithm: str = "nonlinear_cg",
    energies: list[float] | None = None,
    steps: list[int] | None = None,
    torques: list[float] | None = None,
    gpu_status: str = "production_executable",
    engine: str = "gpu",
    include_cpu_qualification: bool = True,
    include_cpu_algorithm_policy: bool = True,
    include_cpu_algorithm_update_policy: bool = True,
    include_gpu_qualification: bool = True,
    include_gpu_gradient_policy: bool = True,
    include_gpu_norm_defect: bool = True,
    cpu_norm_defect: float = 0.0,
    gpu_norm_defect: float = 0.0,
    cpu_line_search: str | None = None,
    gpu_provenance_exchange_operator_mode: str = "legacy_sparse_gpu",
    validator_extra_args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        artifact_dir = Path(tmp) / "artifacts"
        write_artifacts(
            artifact_dir,
            algorithm=algorithm,
            energies=energies,
            steps=steps,
            torques=torques,
            gpu_status=gpu_status,
            engine=engine,
            include_cpu_qualification=include_cpu_qualification,
            include_cpu_algorithm_policy=include_cpu_algorithm_policy,
            include_cpu_algorithm_update_policy=include_cpu_algorithm_update_policy,
            include_gpu_qualification=include_gpu_qualification,
            include_gpu_gradient_policy=include_gpu_gradient_policy,
            include_gpu_norm_defect=include_gpu_norm_defect,
            cpu_norm_defect=cpu_norm_defect,
            gpu_norm_defect=gpu_norm_defect,
            cpu_line_search=cpu_line_search,
            gpu_provenance_exchange_operator_mode=gpu_provenance_exchange_operator_mode,
        )
        log_text = log_text.replace("__ARTIFACT_DIR__", str(artifact_dir))
        log_path = Path(tmp) / "runtime.log"
        log_path.write_text(log_text, encoding="utf-8")
        command = [
                "python3",
                str(VALIDATOR),
                "--engine",
                engine,
                "--algorithm",
                algorithm,
                "--min-steps",
                "4",
                str(log_path),
            ]
        if validator_extra_args:
            command[2:2] = validator_extra_args
        return subprocess.run(
            command,
            cwd=REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )


def valid_log() -> str:
    return """
[fullmag-runner] live FEM engine: resolved_engine_id=fem_native_gpu fallback=None
info: native FEM backend active: engine=fem_native_gpu device='NVIDIA GeForce RTX 4080 SUPER'
{
  "problem_name": "fem_relax_gpu_smoke_nonlinear_cg",
  "status": "completed",
  "backend": "fem",
  "mode": "strict",
  "precision": "double",
  "total_steps": 4,
  "final_time": 0.0,
  "final_e_total": 1.0e-17,
  "artifact_dir": "__ARTIFACT_DIR__"
}
"""


def valid_log_with_final_energy(final_energy: float) -> str:
    return valid_log().replace('"final_e_total": 1.0e-17', f'"final_e_total": {final_energy:.15e}')


def valid_gpu_log(algorithm: str = "nonlinear_cg") -> str:
    return valid_log().replace(
        "fem_relax_gpu_smoke_nonlinear_cg",
        f"fem_relax_gpu_smoke_{algorithm}",
    )


def valid_cpu_log(algorithm: str = "nonlinear_cg") -> str:
    mode = "extended" if algorithm == "tangent_plane_implicit" else "strict"
    return f"""
[fullmag-runner] live FEM engine: resolved_engine_id=fem_cpu_native fallback=None
info: native FEM backend active: engine=fem_cpu_native
{{
  "problem_name": "fem_relax_gpu_smoke_{algorithm}",
  "status": "completed",
  "backend": "fem",
  "mode": "{mode}",
  "precision": "double",
  "total_steps": 4,
  "final_time": 0.0,
  "final_e_total": 1.0e-17,
  "artifact_dir": "__ARTIFACT_DIR__"
}}
"""


def test_accepts_completed_native_gpu_log() -> None:
    result = run_validator(valid_log())
    assert result.returncode == 0, result.stderr
    assert "validated gpu nonlinear_cg" in result.stdout


def test_accepts_completed_native_cpu_log() -> None:
    result = run_validator(valid_cpu_log(), engine="cpu")
    assert result.returncode == 0, result.stderr
    assert "validated cpu nonlinear_cg" in result.stdout


def test_accepts_completed_native_cpu_tpi_log() -> None:
    result = run_validator(
        valid_cpu_log("tangent_plane_implicit"),
        algorithm="tangent_plane_implicit",
        engine="cpu",
    )
    assert result.returncode == 0, result.stderr
    assert "validated cpu tangent_plane_implicit" in result.stdout


def test_rejects_native_cpu_tpi_in_strict_mode() -> None:
    log_text = valid_cpu_log("tangent_plane_implicit").replace(
        '"mode": "extended"',
        '"mode": "strict"',
    )
    result = run_validator(
        log_text,
        algorithm="tangent_plane_implicit",
        engine="cpu",
    )
    assert result.returncode != 0
    assert "mode" in result.stderr


def test_rejects_production_relaxation_algorithms_in_extended_mode() -> None:
    for algorithm in ("llg_overdamped", "projected_gradient_bb", "nonlinear_cg"):
        log_text = valid_cpu_log(algorithm).replace(
            '"mode": "strict"',
            '"mode": "extended"',
        )
        result = run_validator(log_text, algorithm=algorithm, engine="cpu")
        assert result.returncode != 0, algorithm
        assert "mode" in result.stderr, (algorithm, result.stderr)


def test_rejects_failed_status() -> None:
    log_text = valid_log().replace('"status": "completed"', '"status": "failed"')
    result = run_validator(log_text)
    assert result.returncode != 0
    assert "status" in result.stderr


def test_rejects_cpu_fallback() -> None:
    log_text = valid_log().replace(
        "resolved_engine_id=fem_native_gpu fallback=None",
        "resolved_engine_id=fem_cpu_native fallback=Some(fem_gpu_relaxation_algorithm_cpu_only)",
    )
    result = run_validator(log_text)
    assert result.returncode != 0
    assert "fem_native_gpu" in result.stderr or "fallback" in result.stderr


def test_rejects_direct_minimizer_without_production_gpu_status() -> None:
    result = run_validator(valid_log(), gpu_status="source_visible")
    assert result.returncode != 0
    assert "production_executable" in result.stderr


def test_rejects_direct_minimizer_energy_increase() -> None:
    result = run_validator(valid_log(), energies=[4.0e-17, 3.0e-17, 3.5e-17, 1.0e-17])
    assert result.returncode != 0
    assert "E_total" in result.stderr


def test_rejects_llg_overdamped_energy_increase() -> None:
    result = run_validator(
        valid_gpu_log("llg_overdamped"),
        algorithm="llg_overdamped",
        energies=[4.0e-17, 3.0e-17, 3.5e-17, 1.0e-17],
    )
    assert result.returncode != 0
    assert "E_total" in result.stderr


def test_rejects_relaxation_without_meaningful_energy_decrease() -> None:
    final_energy = 3.99997e-17
    result = run_validator(
        valid_log_with_final_energy(final_energy),
        energies=[4.0e-17, 3.99999e-17, 3.99998e-17, final_energy],
    )
    assert result.returncode != 0
    assert "relative decrease" in result.stderr
    assert "E_total" in result.stderr


def test_stricter_convergence_threshold_rejects_weak_energy_decrease() -> None:
    final_energy = 3.4e-17
    result = run_validator(
        valid_log_with_final_energy(final_energy),
        energies=[4.0e-17, 3.8e-17, 3.6e-17, final_energy],
        validator_extra_args=["--min-relative-energy-decrease", "0.20"],
    )
    assert result.returncode != 0
    assert "relative decrease" in result.stderr
    assert "2.000000e-01" in result.stderr


def test_rejects_relaxation_with_large_final_torque_growth() -> None:
    result = run_validator(
        valid_log(),
        energies=[4.0e-17, 3.0e-17, 2.0e-17, 1.0e-17],
        torques=[1.0, 1.2, 1.6, 2.0],
    )
    assert result.returncode != 0
    assert "max_torque_T" in result.stderr
    assert "growth" in result.stderr


def test_rejects_scalars_with_noncontiguous_step_sequence() -> None:
    result = run_validator(valid_log(), steps=[1, 2, 2, 4])
    assert result.returncode != 0
    assert "step" in result.stderr


def test_accepts_runtime_with_more_scalar_rows_than_minimum() -> None:
    final_energy = 5.0e-18
    result = run_validator(
        valid_log_with_final_energy(final_energy),
        energies=[4.0e-17, 3.0e-17, 2.0e-17, 1.0e-17, final_energy],
    )
    assert result.returncode == 0, result.stderr


def test_rejects_summary_final_energy_that_disagrees_with_scalars() -> None:
    result = run_validator(valid_log_with_final_energy(9.0e-17))
    assert result.returncode != 0
    assert "final_e_total" in result.stderr
    assert "scalars.csv" in result.stderr


def test_rejects_native_cpu_log_without_relaxation_qualification() -> None:
    result = run_validator(valid_cpu_log(), engine="cpu", include_cpu_qualification=False)
    assert result.returncode != 0
    assert "fem_cpu_relaxation_qualification" in result.stderr


def test_rejects_cpu_llg_without_algorithm_policy() -> None:
    result = run_validator(
        valid_cpu_log("llg_overdamped"),
        algorithm="llg_overdamped",
        engine="cpu",
        include_cpu_algorithm_policy=False,
    )
    assert result.returncode != 0
    assert "algorithm_policy" in result.stderr
    assert "llg_overdamped" in result.stderr


def test_rejects_gpu_direct_minimizer_without_relaxation_qualification() -> None:
    result = run_validator(valid_log(), include_gpu_qualification=False)
    assert result.returncode != 0
    assert "fem_gpu_relaxation_qualification" in result.stderr


def test_rejects_gpu_llg_without_relaxation_qualification() -> None:
    result = run_validator(
        valid_gpu_log("llg_overdamped"),
        algorithm="llg_overdamped",
        include_gpu_qualification=False,
    )
    assert result.returncode != 0
    assert "fem_gpu_relaxation_qualification" in result.stderr


def test_rejects_gpu_direct_minimizer_without_gradient_policy() -> None:
    result = run_validator(valid_log(), include_gpu_gradient_policy=False)
    assert result.returncode != 0
    assert "gradient_policy" in result.stderr
    assert "device_tangent_gradient" in result.stderr


def test_rejects_gpu_qualification_that_disagrees_with_provenance() -> None:
    result = run_validator(
        valid_log(),
        gpu_provenance_exchange_operator_mode="legacy_sparse_cpu_shadow",
    )
    assert result.returncode != 0
    assert "fem_exchange_operator_mode" in result.stderr
    assert "legacy_sparse_gpu" in result.stderr


def test_rejects_cpu_projected_gradient_bb_with_nonlinear_cg_line_search() -> None:
    result = run_validator(
        valid_cpu_log("projected_gradient_bb"),
        algorithm="projected_gradient_bb",
        engine="cpu",
        cpu_line_search="native_armijo_backtracking_pr_plus_restart",
    )
    assert result.returncode != 0
    assert "line_search" in result.stderr
    assert "native_armijo_backtracking_bb1_bb2" in result.stderr


def test_rejects_cpu_projected_gradient_bb_without_step_update_policy() -> None:
    result = run_validator(
        valid_cpu_log("projected_gradient_bb"),
        algorithm="projected_gradient_bb",
        engine="cpu",
        include_cpu_algorithm_update_policy=False,
    )
    assert result.returncode != 0
    assert "step_update" in result.stderr
    assert "alternating_bb1_bb2" in result.stderr


def test_rejects_cpu_nonlinear_cg_without_direction_update_policy() -> None:
    result = run_validator(
        valid_cpu_log("nonlinear_cg"),
        algorithm="nonlinear_cg",
        engine="cpu",
        include_cpu_algorithm_update_policy=False,
    )
    assert result.returncode != 0
    assert "direction_update" in result.stderr
    assert "polak_ribiere_plus_projected_restart" in result.stderr


def test_rejects_cpu_relaxation_with_large_magnetization_norm_defect() -> None:
    result = run_validator(
        valid_cpu_log("nonlinear_cg"),
        algorithm="nonlinear_cg",
        engine="cpu",
        cpu_norm_defect=1.0e-2,
    )
    assert result.returncode != 0
    assert "norm_defect" in result.stderr


def test_rejects_gpu_relaxation_without_magnetization_norm_defect() -> None:
    result = run_validator(
        valid_gpu_log("nonlinear_cg"),
        algorithm="nonlinear_cg",
        engine="gpu",
        include_gpu_norm_defect=False,
    )
    assert result.returncode != 0
    assert "norm_defect" in result.stderr


def test_zhang_li_gate_preserves_each_run_in_a_distinct_explicit_bundle() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    validator = ZHANG_LI_VALIDATOR.read_text(encoding="utf-8")
    zhang_li_recipe = just_recipe_source(
        justfile,
        "verify-fem-zhang-li-skew-tetra-runtime",
    )

    assert 'fem-managed-headless fem_execution script output_dir="":' in justfile
    assert '--output-dir "$output_dir"' in justfile
    assert '--workspace-root "$output_dir/workspace-history"' in justfile
    assert zhang_li_recipe.count("mktemp -d") == 10
    assert zhang_li_recipe.count("just fem-managed-headless") == 10
    assert "zip(dt_runs, (32, 64, 128), strict=True)" in validator


def test_runtime_gate_and_physics_note_promote_cpu_tpi_without_gpu_claim() -> None:
    verify_source = VERIFY_RUNTIME.read_text(encoding="utf-8")
    justfile = JUSTFILE.read_text(encoding="utf-8")
    physics_note = FEM_RELAXATION_NOTE.read_text(encoding="utf-8")
    normalized_physics_note = " ".join(physics_note.split())

    assert (
        'algorithms="${FULLMAG_FEM_RELAXATION_ALGORITHMS:-llg_overdamped '
        'projected_gradient_bb nonlinear_cg tangent_plane_implicit}"'
    ) in verify_source
    assert (
        'min_relative_energy_decrease="${FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE:-1e-3}"'
        in verify_source
    )
    assert (
        'max_torque_growth="${FULLMAG_FEM_RELAXATION_MAX_FINAL_TORQUE_GROWTH_FACTOR:-2.0}"'
        in verify_source
    )
    assert "--min-relative-energy-decrease" in verify_source
    assert "--max-final-torque-growth-factor" in verify_source
    assert "FULLMAG_FEM_RELAXATION_KEEP_LOGS" in verify_source
    assert "preserving runtime logs" in verify_source
    assert "just verify-fem-relaxation-source-contract" in verify_source
    assert 'just fem-managed-container-headless "$engine" "$script"' in verify_source
    assert 'just fem-managed-headless "$engine" "$script"' not in verify_source
    assert "just fem-gpu-headless" not in verify_source
    assert (
        "supported: llg_overdamped projected_gradient_bb nonlinear_cg tangent_plane_implicit"
        in verify_source
    )
    assert "skip unsupported FEM gpu smoke: tangent_plane_implicit" in verify_source

    assert "verify-fem-relaxation-source-contract:" in justfile
    assert "cmake --build native/build --target fem_relaxation_source_contract" in justfile
    assert "native/build/backends/fem/fem_relaxation_source_contract" in justfile
    assert "verify-fem-relaxation-convergence:" in justfile
    assert "verify-fem-relaxation-cpu-gpu-consistency-smoke:" in justfile
    assert "verify-fem-relaxation-consistency-semantics:" in justfile
    assert "verify-fem-relaxation-production-benchmark:" in justfile
    assert "verify-fem-gpu-demag-performance-benchmark:" in justfile
    assert "bench-fem-gpu-demag-amg-profile-sweep:" in justfile
    consistency_recipe = just_recipe_source(
        justfile,
        "verify-fem-relaxation-cpu-gpu-consistency-smoke",
    )
    semantics_recipe = just_recipe_source(
        justfile,
        "verify-fem-relaxation-consistency-semantics",
    )
    production_recipe = just_recipe_source(
        justfile,
        "verify-fem-relaxation-production-benchmark",
    )
    demag_performance_recipe = just_recipe_source(
        justfile,
        "verify-fem-gpu-demag-performance-benchmark",
    )
    amg_profile_sweep_recipe = just_recipe_source(
        justfile,
        "bench-fem-gpu-demag-amg-profile-sweep",
    )
    for recipe in [consistency_recipe, production_recipe, demag_performance_recipe]:
        assert "docker compose --profile fem-gpu run --rm" in recipe
        assert "cd /workspace" in recipe
        assert "python3 scripts/analysis/fem_gpu_benchmark.py" in recipe
        assert "PYTHONPATH=/workspace/packages/fullmag-py/src" in recipe
        assert ".fullmag/reports/" in recipe
    assert "python3 scripts/verify_fem_relaxation_consistency_semantics.py" in semantics_recipe
    for env_name in [
        "FULLMAG_BENCH_INTEGRATORS",
        "FULLMAG_BENCH_RELAX_ALGORITHMS",
        "FULLMAG_BENCH_STEPS",
        "FULLMAG_BENCH_CASE_TIMEOUT_S",
        "FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL",
        "FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J",
        "FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL",
        "FULLMAG_BENCH_OUTPUT",
        "FULLMAG_BENCH_SUMMARY",
    ]:
        assert f"-e {env_name}=" in production_recipe
    assert "fem-managed-container-headless fem_execution script:" in justfile
    assert "docker compose --profile fem-gpu run --rm" in justfile
    assert ".fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu" in justfile
    assert "--box500-airbox-exchange-only-preset" in justfile
    assert "--box500-airbox-interaction-consistency-preset" in justfile
    assert "--require-cpu-gpu-consistency" in justfile
    assert "--require-gpu-phase-timings" in demag_performance_recipe
    assert "--require-min-solver-nodes" in demag_performance_recipe
    assert "--demag-convergence-max-iterations" in production_recipe
    assert "--demag-convergence-max-iterations" in demag_performance_recipe
    assert "--require-demag-setup-reused" in production_recipe
    assert "--require-demag-setup-reused" in demag_performance_recipe
    assert "--max-demag-solver-apply-ms" in production_recipe
    assert "--max-demag-solver-apply-ms" in demag_performance_recipe
    assert "FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS" in production_recipe
    assert "FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS" in demag_performance_recipe
    assert "FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS" in production_recipe
    assert "FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS" in demag_performance_recipe
    assert "FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC" in production_recipe
    assert "FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC" in demag_performance_recipe
    assert "--best-demag-policy-metric" in production_recipe
    assert "--best-demag-policy-metric" in demag_performance_recipe
    for env_name, cli_flag in [
        ("FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES", "--demag-amg-relax-types"),
        ("FULLMAG_BENCH_DEMAG_AMG_COARSENINGS", "--demag-amg-coarsenings"),
        ("FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS", "--demag-amg-interpolations"),
        (
            "FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS",
            "--demag-amg-aggressive-coarsenings",
        ),
        (
            "FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS",
            "--demag-amg-strength-thresholds",
        ),
        ("FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS", "--demag-amg-max-levels"),
    ]:
        assert env_name in production_recipe
        assert env_name in demag_performance_recipe
        assert cli_flag in production_recipe
        assert cli_flag in demag_performance_recipe
        if env_name == "FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES":
            assert env_name in amg_profile_sweep_recipe
            assert cli_flag in amg_profile_sweep_recipe
    assert "docker compose --profile fem-gpu run --rm" in amg_profile_sweep_recipe
    assert "python3 scripts/analysis/fem_gpu_benchmark.py" in amg_profile_sweep_recipe
    assert "FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES:-18,6" in amg_profile_sweep_recipe
    assert "--emit-best-demag-policy" in amg_profile_sweep_recipe
    assert "--best-demag-policy-metric" in amg_profile_sweep_recipe
    assert "--human-report-output" in amg_profile_sweep_recipe
    assert "--require-best-demag-policy" in amg_profile_sweep_recipe
    assert "--require-demag-converged" in amg_profile_sweep_recipe
    assert "--require-cpu-gpu-consistency" in amg_profile_sweep_recipe
    assert "--max-demag-solver-apply-ms" not in amg_profile_sweep_recipe
    assert "amg_qualification_suite_v1.json" in amg_profile_sweep_recipe
    assert "for profiler in off on" in amg_profile_sweep_recipe
    assert "--backends fem_cpu,fem_gpu" in amg_profile_sweep_recipe
    assert "--demag-rtols 1e-12" in amg_profile_sweep_recipe
    assert "--relax-torque-tolerance-t 1e-4" in amg_profile_sweep_recipe
    assert "--repeat 1" in amg_profile_sweep_recipe
    assert 'FULLMAG_BENCH_REPEAT:-5' in amg_profile_sweep_recipe
    assert "--amg-relax-qualification-output" in amg_profile_sweep_recipe
    assert "FULLMAG_BENCH_DEMAG_RTOLS" in demag_performance_recipe
    assert "--demag-rtols" in demag_performance_recipe
    assert "FULLMAG_BENCH_MESHES" in demag_performance_recipe
    assert '--meshes "$FULLMAG_BENCH_MESHES"' in demag_performance_recipe
    assert "--reuse-generated-domain-mesh" in production_recipe
    assert "--reuse-generated-domain-mesh" in demag_performance_recipe
    assert "FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" in production_recipe
    assert "FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" in demag_performance_recipe
    assert "--generated-domain-mesh-cache-dir" in production_recipe
    assert "--generated-domain-mesh-cache-dir" in demag_performance_recipe
    assert (
        'FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg'
        in demag_performance_recipe
    )
    assert "FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP" in demag_performance_recipe
    assert "--gpu-pgbb-control-readback-per-step" in demag_performance_recipe
    assert "--max-performance-regression-percent" in demag_performance_recipe
    assert "--relax-algorithms" in justfile
    assert (
        'FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg'
        in justfile
    )
    assert ".fullmag/reports/fullmag_relaxation_production_benchmark.csv" in justfile
    assert ".fullmag/reports/fullmag_relaxation_production_benchmark_summary.json" in justfile
    assert 'FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-16}"' in justfile
    assert '-e FULLMAG_RELAX_DEVICE="${FULLMAG_RELAX_DEVICE:-gpu}"' in justfile
    assert '-e FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-4}"' in justfile
    assert '-e FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-}"' not in justfile
    assert (
        'FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE="${FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE:-1e-2}"'
        in justfile
    )
    assert "`just verify-fem-relaxation-convergence`" in physics_note
    assert "`just verify-fem-relaxation-cpu-gpu-consistency-smoke`" in physics_note
    assert "`just verify-fem-relaxation-production-benchmark`" in physics_note
    assert "FULLMAG_FEM_RELAXATION_KEEP_LOGS=1" in physics_note

    assert "Current production-executable subset" in physics_note
    assert 'algorithm = "llg_overdamped"' in normalized_physics_note
    assert 'algorithm = "projected_gradient_bb"' in normalized_physics_note
    assert 'algorithm = "nonlinear_cg"' in normalized_physics_note
    assert (
        '`algorithm = "tangent_plane_implicit"` remains under development'
    ) in physics_note
    assert "four algorithms are public-executable" not in normalized_physics_note
    assert "- [x] FEM backend (`tangent_plane_implicit` native CPU/MFEM" in physics_note
    assert "- [ ] FEM backend (`tangent_plane_implicit` full GPU/libCEED" in physics_note
    assert (
        "- [x] Broader interaction-matrix CPU/GPU benchmark gate is wired for current LLG/PG-BB/NCG production lanes"
        in physics_note
    )
    assert (
        "- [x] Broader interaction-matrix CPU/GPU benchmark pass for current LLG/PG-BB/NCG production lanes"
        in physics_note
    )


def test_cpu_gpu_consistency_smoke_covers_active_relaxation_algorithms() -> None:
    benchmark_source = (
        REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
    ).read_text(encoding="utf-8")
    benchmark_case = (REPO_ROOT / "examples" / "bench_fem_gpu_long.py").read_text(
        encoding="utf-8"
    )
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "--relax-algorithms" in benchmark_source
    assert "resolve_relaxation_algorithms(" in benchmark_source
    assert "FULLMAG_BENCH_RELAX_ALGORITHM" in benchmark_source
    assert "reported_relaxation_algorithm" in benchmark_source
    assert "relaxation_algorithm" in benchmark_source
    assert "row.get(\"reported_relaxation_algorithm\")" in benchmark_source

    assert "SUPPORTED_RELAXATION_ALGORITHMS" in benchmark_case
    assert "def env_relaxation_algorithm()" in benchmark_case
    assert "FULLMAG_BENCH_RELAX_ALGORITHM" in benchmark_case
    assert 'algorithm="llg_overdamped"' not in benchmark_case

    assert "--relax-algorithms" in justfile
    assert (
        'FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg'
        in justfile
    )


def test_cpu_gpu_consistency_coverage_is_per_relaxation_algorithm() -> None:
    benchmark = load_benchmark_module()
    algorithms = [
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
        "tangent_plane_implicit",
    ]
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=[benchmark.BOX500_AIRBOX_SCENARIO],
        relaxation_algorithms=algorithms,
        steps=16,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    assert [manifest["relaxation_algorithm"] for manifest in manifests] == algorithms
    by_manifest_algorithm = {
        manifest["relaxation_algorithm"]: manifest for manifest in manifests
    }
    assert by_manifest_algorithm["tangent_plane_implicit"]["required_backends"] == [
        "fem_cpu"
    ]
    assert by_manifest_algorithm["nonlinear_cg"]["required_backends"] == [
        "fem_cpu",
        "fem_gpu",
    ]

    rows: list[dict[str, object]] = []
    for algorithm in algorithms:
        for backend in (
            ["fem_cpu"]
            if algorithm == "tangent_plane_implicit"
            else ["fem_cpu", "fem_gpu"]
        ):
            rows.append(
                {
                    "backend": backend,
                    "status": "ok",
                    "scenario": benchmark.BOX500_AIRBOX_SCENARIO,
                    "integrator": "heun",
                    "relaxation_algorithm": algorithm,
                    "reported_relaxation_algorithm": algorithm,
                    "timestep_policy": "fixed",
                    "dt_s": 1.0e-13,
                    "steps": 16,
                    "reported_precision": "double",
                    "solver_mesh_signature": "mesh-a",
                    "execution_engine": (
                        "fem_cpu_native" if backend == "fem_cpu" else "fem_native_gpu"
                    ),
                    "fem_execution_mode": (
                        "cpu_native" if backend == "fem_cpu" else "all_in_gpu_legacy_sparse"
                    ),
                    "mfem_device": "cpu" if backend == "fem_cpu" else "cuda",
                    "uses_cuda_kernels": backend == "fem_gpu",
                    "executed_steps": 0,
                    "final_e_total_j": -1.0,
                    "final_e_ex_j": -1.0,
                    "final_torque_apm": 0.0,
                    "final_torque_t": 0.0,
                }
            )

    coverage = benchmark.cpu_gpu_required_case_coverage(
        rows,
        case_manifests=manifests,
    )
    assert [(case["case_id"], case["relaxation_algorithm"]) for case in coverage] == [
        (benchmark.BOX500_AIRBOX_SCENARIO, algorithm) for algorithm in algorithms
    ]
    by_algorithm = {case["relaxation_algorithm"]: case for case in coverage}
    assert all(
        by_algorithm[algorithm]["status"] == "pass"
        and by_algorithm[algorithm]["pair_count"] == 1
        for algorithm in ["llg_overdamped", "projected_gradient_bb", "nonlinear_cg"]
    )
    assert by_algorithm["tangent_plane_implicit"]["status"] == "pass"
    assert by_algorithm["tangent_plane_implicit"]["required_backends"] == ["fem_cpu"]
    assert by_algorithm["tangent_plane_implicit"]["pair_count"] == 0
    assert by_algorithm["tangent_plane_implicit"]["gpu_ok_count"] == 0

    rows = [
        row
        for row in rows
        if not (
            row["backend"] == "fem_gpu"
            and row["relaxation_algorithm"] == "nonlinear_cg"
        )
    ]
    coverage = benchmark.cpu_gpu_required_case_coverage(
        rows,
        case_manifests=manifests,
    )
    by_algorithm = {case["relaxation_algorithm"]: case for case in coverage}
    assert by_algorithm["llg_overdamped"]["status"] == "pass"
    assert by_algorithm["projected_gradient_bb"]["status"] == "pass"
    assert by_algorithm["nonlinear_cg"]["status"] == "fail"
    assert by_algorithm["tangent_plane_implicit"]["status"] == "pass"
    assert "nonlinear_cg has no completed fem_gpu row" in " ".join(
        by_algorithm["nonlinear_cg"]["failures"]
    )


def test_demag_apply_budget_gate_flags_slow_single_solve_rows() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "demag_solver_apply_wall_time_ms": 20_370.0,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_only",
            "status": "ok",
            "demag_solver_apply_wall_time_ms": 99_000.0,
        },
    ]

    failures = benchmark.demag_solver_apply_budget_failures(
        rows,
        max_apply_ms=5_000.0,
    )

    assert len(failures) == 1
    assert "demag_solver_apply_wall_time_ms=20370" in failures[0]
    assert "exceeds 5000" in failures[0]


def test_demag_setup_reuse_gate_flags_multi_step_rebuilds() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "steps": 2,
            "executed_steps": 2,
            "demag_solver_setup_reused": False,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "steps": 1,
            "executed_steps": 1,
            "demag_solver_setup_reused": False,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_only",
            "status": "ok",
            "steps": 2,
            "executed_steps": 2,
            "demag_solver_setup_reused": False,
        },
    ]

    failures = benchmark.demag_setup_reuse_failures(rows)

    assert len(failures) == 1
    assert "demag_solver_setup_reused is not true" in failures[0]


def test_demag_setup_reuse_gate_requires_telemetry_for_multi_step_demag() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "steps": 2,
            "executed_steps": 2,
        }
    ]

    failures = benchmark.demag_setup_reuse_failures(rows)

    assert len(failures) == 1
    assert "missing demag_solver_setup_reused" in failures[0]


def test_gpu_ncg_endpoint_reuse_gate_requires_one_steady_demag_solve() -> None:
    benchmark = load_benchmark_module()
    good = {
        "backend": "fem_gpu",
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "status": "ok",
        "executed_steps": 32,
        "rhs_evals": 1,
        "demag_solves": 1,
    }

    assert benchmark.gpu_ncg_accepted_endpoint_reuse_failures([good]) == []
    failures = benchmark.gpu_ncg_accepted_endpoint_reuse_failures(
        [{**good, "demag_solves": 2}]
    )
    assert len(failures) == 1
    assert "steady accepted step requires demag_solves=1" in failures[0]
    assert benchmark.gpu_ncg_accepted_endpoint_reuse_failures(
        [{**good, "rhs_evals": 2, "demag_solves": 2}]
    ) == []


def test_gpu_demag_single_setup_gate_requires_zero_step_setup_and_derived_reuse() -> None:
    benchmark = load_benchmark_module()
    good = {
        "backend": "fem_gpu",
        "scenario": "box500_airbox_exchange_demag",
        "status": "ok",
        "executed_steps": 32,
        "demag_solver_setup_wall_time_ms": 0.0,
        "demag_solver_setup_reused": True,
    }

    assert benchmark.gpu_demag_single_setup_failures([good]) == []
    assert benchmark.gpu_demag_single_setup_failures(
        [{**good, "demag_solver_setup_wall_time_ms": 0.25}]
    )
    assert benchmark.gpu_demag_single_setup_failures(
        [{**good, "demag_solver_setup_reused": False}]
    )


def test_startup_timing_fields_keep_backend_create_and_first_solver_apply_separate() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.startup_timing_fields(
        {
            "backend_create_wall_time_ns": 12_500_000,
            "first_accepted_step_demag_solver_apply_wall_time_ns": 3_250_000,
        }
    ) == {
        "backend_create_wall_time_ms": 12.5,
        "first_accepted_step_demag_solver_apply_wall_time_ms": 3.25,
    }

    base = {
        "status": "ok",
        "solver_mesh_signature": "mesh",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
    }
    summary = benchmark.performance_distribution_summary(
        [
            {
                **base,
                "backend_create_wall_time_ms": create_ms,
                "first_accepted_step_demag_solver_apply_wall_time_ms": apply_ms,
            }
            for create_ms, apply_ms in [(10, 2), (12, 3), (20, 5)]
        ]
    )
    assert summary[0]["metrics"]["backend_create_wall_time_ms"]["p50"] == 12.0
    assert (
        summary[0]["metrics"]["first_accepted_step_demag_solver_apply_wall_time_ms"]["p95"]
        == 5.0
    )


def test_benchmark_harness_can_pin_one_runner_to_a_selected_runtime_root(
    monkeypatch, tmp_path
) -> None:
    runtime_root = tmp_path / "baseline-runtime"
    runner = tmp_path / "instrumented-runner"
    monkeypatch.setenv("FULLMAG_FEM_RUNTIME_ROOT", str(runtime_root))
    monkeypatch.setenv("FULLMAG_BENCH_GPU_BIN", str(runner))

    benchmark = load_benchmark_module()

    assert benchmark.MANAGED_FEM_RUNTIME_ROOT == runtime_root
    assert benchmark.FULLMAG_GPU == runner

    runtime_root.mkdir()
    manifest = runtime_root / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema": 3,
                "source_provenance": {
                    "git_commit": "a" * 40,
                    "git_tree": "b" * 40,
                    "dirty": False,
                    "dirty_patch_sha256": None,
                    "source_inputs_sha256": "c" * 64,
                    "source_input_manifest": (
                        "scripts/managed_fem_runtime_source_inputs.v1.txt"
                    ),
                },
            }
        ),
        encoding="utf-8",
    )
    assert benchmark.runtime_bundle_identity(runtime_root) == {
        "runtime_bundle_root": str(runtime_root.resolve()),
        "runtime_manifest_sha256": benchmark.hashlib.sha256(
            manifest.read_bytes()
        ).hexdigest(),
        "runtime_git_commit": "a" * 40,
        "runtime_git_tree": "b" * 40,
        "runtime_source_inputs_sha256": "c" * 64,
        "runtime_dirty": "false",
        "runtime_dirty_patch_sha256": "",
    }


def test_task8_identity_keeps_input_mesh_signature_separate_from_runtime_telemetry() -> None:
    benchmark = load_benchmark_module()
    mesh = {"nodes": [[0.0, 0.0, 0.0]], "elements": [[0]], "element_markers": [1]}
    mesh_path = Path("/tmp/task8-input-mesh.json")
    problem_ir = {
        "magnets": [
            {
                "name": "magnet",
                "region": "magnet",
                "initial_magnetization": {"kind": "uniform", "value": [1, 0, 0]},
            }
        ]
    }
    expected = benchmark.mesh_signature(mesh)
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(Path, "read_text", lambda *_args, **_kwargs: json.dumps(mesh))
        identity = benchmark.task8_qualification_row_identity(
            case_manifest={"case_id": "case"},
            solver_mesh_path=mesh_path,
            problem_ir=problem_ir,
        )
    assert identity["qualification_input_mesh_signature"] == expected
    assert identity["solver_mesh_signature"] == expected


def task8_expected_qualification_identity() -> tuple[
    dict[str, object], list[dict[str, object]]
]:
    runtime_identity = {
        "runtime_git_commit": "a" * 40,
        "runtime_git_tree": "b" * 40,
        "runtime_source_inputs_sha256": "c" * 64,
        "runtime_dirty": "false",
        "runtime_dirty_patch_sha256": "",
        "runtime_manifest_sha256": "b" * 64,
        "libfullmag_fem_sha256": "c" * 64,
        "device_name": "NVIDIA GeForce RTX 4080",
        "compute_capability": "8.9",
        "precision": "double",
        "omp_thread_count": {
            "fem_cpu": 8,
            "fem_gpu": 1,
        },
    }
    case_identities = [
        {
            "case_id": "box500_airbox_exchange_demag",
            "relaxation_algorithm": "projected_gradient_bb",
            "required_backends": ["fem_cpu", "fem_gpu"],
            "fixture_sha256": "d" * 64,
            "solver_mesh_signature": "e" * 64,
            "magnetic_node_indices_sha256": "f" * 64,
            "initial_m_sha256": "1" * 64,
            "demag_enabled": True,
            "resolved_demag_policy": {
            "linear_solver": "CG",
            "preconditioner": "AMG",
            "relative_tolerance": 1e-12,
            "absolute_tolerance": 0.0,
            "max_iterations": 500,
            "print_level": 0,
            "amg_relax_type": 18,
            "amg_coarsening": 8,
            "amg_interpolation": 6,
            "amg_aggressive_coarsening": 1,
            "amg_strength_threshold": 0.25,
            "amg_max_levels": 25,
            "policy_source": "problem_ir",
            },
        },
    ]
    return runtime_identity, case_identities


def task8_qualification_row(
    backend: str,
    repeat_index: int,
    runtime_identity: dict[str, object],
    case_identity: dict[str, object],
) -> dict[str, object]:
    demag_policy = case_identity["resolved_demag_policy"]
    assert isinstance(demag_policy, dict)
    omp_thread_count = runtime_identity["omp_thread_count"]
    assert isinstance(omp_thread_count, dict)
    row = {
        "backend": backend,
        "status": "ok",
        "scenario": case_identity["case_id"],
        "reported_relaxation_algorithm": case_identity["relaxation_algorithm"],
        "repeat_index": repeat_index,
        "runtime_git_commit": runtime_identity["runtime_git_commit"],
        "runtime_git_tree": runtime_identity["runtime_git_tree"],
        "runtime_source_inputs_sha256": runtime_identity[
            "runtime_source_inputs_sha256"
        ],
        "runtime_dirty": runtime_identity["runtime_dirty"],
        "runtime_dirty_patch_sha256": runtime_identity[
            "runtime_dirty_patch_sha256"
        ],
        "runtime_manifest_sha256": runtime_identity["runtime_manifest_sha256"],
        "libfullmag_fem_sha256": runtime_identity["libfullmag_fem_sha256"],
        "fixture_sha256": case_identity["fixture_sha256"],
        "solver_mesh_signature": case_identity["solver_mesh_signature"],
        "qualification_input_mesh_signature": case_identity[
            "solver_mesh_signature"
        ],
        "magnetic_node_indices_sha256": case_identity[
            "magnetic_node_indices_sha256"
        ],
        "initial_m_sha256": case_identity["initial_m_sha256"],
        "reported_precision": runtime_identity["precision"],
        "effective_fem_omp_threads": omp_thread_count[backend],
        "demag_linear_solver": demag_policy["linear_solver"],
        "demag_preconditioner": demag_policy["preconditioner"],
        "demag_relative_tolerance": demag_policy["relative_tolerance"],
        "demag_absolute_tolerance": demag_policy["absolute_tolerance"],
        "demag_max_iterations": demag_policy["max_iterations"],
        "demag_print_level": demag_policy["print_level"],
        "demag_amg_relax_type": demag_policy["amg_relax_type"],
        "demag_amg_coarsening": demag_policy["amg_coarsening"],
        "demag_amg_interpolation": demag_policy["amg_interpolation"],
        "demag_amg_aggressive_coarsening": demag_policy[
            "amg_aggressive_coarsening"
        ],
        "demag_amg_strength_threshold": demag_policy["amg_strength_threshold"],
        "demag_amg_max_levels": demag_policy["amg_max_levels"],
        "demag_policy_source": demag_policy["policy_source"],
        "demag_model": "airbox",
        "demag_solves": 1,
        "energy_monotonicity_satisfied": True,
        "energy_trajectory_record_count": 1,
        "energy_trajectory_max_increase_j": 0.0,
        "accepted_energy_proof_available": True,
        "accepted_energy_delta_j": -2e-20,
        "accepted_energy_roundoff_bound_j": 1e-21,
        "accepted_energy_delta_upper_j": -1.9e-20,
        "armijo_increment_rhs_j": -1e-20,
        "accepted_energy_proof_count": 1,
        "accepted_energy_proof_invalid_count": 0,
        "accepted_energy_proof_invalid_details": [],
        "executed_steps": 1,
    }
    if backend == "fem_gpu":
        row.update(
            {
                "device_name": runtime_identity["device_name"],
                "compute_capability": runtime_identity["compute_capability"],
            }
        )
    return row


def task8_complete_qualification_rows(
    runtime_identity: dict[str, object],
    case_identity: dict[str, object],
    *,
    repeat_count: int = 1,
) -> list[dict[str, object]]:
    return [
        task8_qualification_row(backend, repeat_index, runtime_identity, case_identity)
        for repeat_index in range(repeat_count)
        for backend in ("fem_cpu", "fem_gpu")
    ]


def test_task8_qualification_accepts_exact_identity_complete_pairs_and_monotonicity() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(
        runtime_identity,
        case_identities[0],
        repeat_count=2,
    )

    assert benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=2,
    ) == []


@pytest.mark.parametrize(
    ("backend", "row_field", "tampered_value", "failure_label"),
    [
        (
            "fem_gpu",
            "runtime_source_inputs_sha256",
            "2" * 64,
            "runtime_source_inputs_sha256",
        ),
        ("fem_gpu", "runtime_manifest_sha256", "3" * 64, "runtime_manifest_sha256"),
        ("fem_gpu", "libfullmag_fem_sha256", "4" * 64, "libfullmag_fem_sha256"),
        ("fem_gpu", "fixture_sha256", "5" * 64, "fixture_sha256"),
        (
            "fem_gpu",
            "solver_mesh_signature",
            "9" * 64,
            "solver_mesh_signature",
        ),
        (
            "fem_gpu",
            "qualification_input_mesh_signature",
            "6" * 64,
            "qualification_input_mesh_signature",
        ),
        (
            "fem_gpu",
            "magnetic_node_indices_sha256",
            "7" * 64,
            "magnetic_node_indices_sha256",
        ),
        ("fem_gpu", "initial_m_sha256", "8" * 64, "initial_m_sha256"),
        ("fem_gpu", "device_name", "unexpected GPU", "device_name"),
        ("fem_gpu", "compute_capability", "9.0", "compute_capability"),
        ("fem_gpu", "reported_precision", "single", "precision"),
        ("fem_cpu", "effective_fem_omp_threads", 4, "OpenMP thread count"),
        ("fem_gpu", "effective_fem_omp_threads", 2, "OpenMP thread count"),
        ("fem_gpu", "demag_linear_solver", "GMRES", "resolved demag policy"),
        (
            "fem_gpu",
            "demag_preconditioner",
            "JACOBI",
            "resolved demag policy",
        ),
        (
            "fem_gpu",
            "demag_relative_tolerance",
            1e-8,
            "resolved demag policy",
        ),
        (
            "fem_gpu",
            "demag_absolute_tolerance",
            1e-30,
            "resolved demag policy",
        ),
        ("fem_gpu", "demag_max_iterations", 100, "resolved demag policy"),
        ("fem_gpu", "demag_print_level", 1, "resolved demag policy"),
        ("fem_gpu", "demag_amg_relax_type", 6, "resolved demag policy"),
        ("fem_gpu", "demag_amg_coarsening", 10, "resolved demag policy"),
        ("fem_gpu", "demag_amg_interpolation", 0, "resolved demag policy"),
        (
            "fem_gpu",
            "demag_amg_aggressive_coarsening",
            0,
            "resolved demag policy",
        ),
        (
            "fem_gpu",
            "demag_amg_strength_threshold",
            0.5,
            "resolved demag policy",
        ),
        ("fem_gpu", "demag_amg_max_levels", 10, "resolved demag policy"),
        ("fem_gpu", "demag_policy_source", "environment", "resolved demag policy"),
    ],
)
def test_task8_qualification_rejects_identity_drift(
    backend: str,
    row_field: str,
    tampered_value: object,
    failure_label: str,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(runtime_identity, case_identities[0])
    row = next(row for row in rows if row["backend"] == backend)
    row[row_field] = tampered_value

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any(failure_label in failure for failure in failures)


def test_task8_qualification_rejects_incomplete_pair_for_each_repeat() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(
        runtime_identity,
        case_identities[0],
        repeat_count=2,
    )
    rows = [
        row
        for row in rows
        if not (row["backend"] == "fem_gpu" and row["repeat_index"] == 1)
    ]

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=2,
    )

    assert any(
        "repeat_index=1" in failure and "fem_gpu" in failure
        for failure in failures
    )


@pytest.mark.parametrize("evidence", [None, False])
def test_task8_qualification_keeps_recomputed_energy_monotonicity_as_diagnostic(
    evidence: bool | None,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(runtime_identity, case_identities[0])
    gpu_row = next(row for row in rows if row["backend"] == "fem_gpu")
    if evidence is None:
        gpu_row.pop("energy_monotonicity_satisfied")
    else:
        gpu_row["energy_monotonicity_satisfied"] = evidence

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert not any("energy_monotonicity_satisfied" in failure for failure in failures)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("accepted_energy_proof_count", 0),
        ("accepted_energy_proof_invalid_count", 1),
        ("accepted_energy_proof_invalid_details", ["step=1: invalid"]),
    ],
)
def test_task8_pgbb_qualification_requires_native_accepted_armijo_proof(
    field: str,
    value: object,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(runtime_identity, case_identities[0])
    rows[0][field] = value

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any("accepted Armijo proof" in failure for failure in failures)


def test_task8_qualification_rejects_old_98f832_native_library_identity() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    runtime_identity.update(
        {
            "runtime_source_inputs_sha256": "3bf69a81294a5d4ae8bcd0d19359ae610032e992098e2c04d65071cba9f3ca56",
            "runtime_manifest_sha256": "7aec841222232a1bfcd87e9a0ba6fc2e9501ccb99b6ccacd21d521bc8f439b69",
            "libfullmag_fem_sha256": "c34db964a116df422463a7dc2e96983e0589dd0cc9a50a4d82a9defe412be855",
        }
    )
    rows = task8_complete_qualification_rows(runtime_identity, case_identities[0])
    for row in rows:
        row.update(
            {
                "runtime_source_inputs_sha256": "2587f0134abd89ec0a30cc7c576ff6d9166356d7ada9d00362519b149f4e3c8c",
                "runtime_manifest_sha256": "98f832772d0d9a5c7c46b4823c5f5c5bf2e4ed823e0f143e53ffa9aa9843fff8",
                "libfullmag_fem_sha256": "63547f779f2c88611382532c6bdfe827f2969f5634733794494247d00817c03e",
            }
        )

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any("libfullmag_fem_sha256" in failure for failure in failures)


@pytest.mark.parametrize(
    "field",
    [
        "fixture_sha256",
        "solver_mesh_signature",
        "magnetic_node_indices_sha256",
        "initial_m_sha256",
    ],
)
def test_task8_qualification_rejects_missing_expected_case_identity_before_rows(
    field: str,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    case_identities[0].pop(field)

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert failures[0] == f"Task 8 expected case identity is missing {field}"


@pytest.mark.parametrize(
    "field",
    [
        "runtime_source_inputs_sha256",
        "runtime_manifest_sha256",
        "libfullmag_fem_sha256",
    ],
)
@pytest.mark.parametrize("invalid_sha256", ["a", "g" * 64, "A" * 64])
def test_task8_qualification_rejects_invalid_runtime_sha256_before_rows(
    field: str,
    invalid_sha256: str,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    runtime_identity[field] = invalid_sha256

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert failures[0] == f"Task 8 expected runtime identity has invalid {field}"


@pytest.mark.parametrize(
    "field",
    [
        "fixture_sha256",
        "solver_mesh_signature",
        "magnetic_node_indices_sha256",
        "initial_m_sha256",
    ],
)
@pytest.mark.parametrize("invalid_identity", ["a", "g" * 64, "A" * 64])
def test_task8_qualification_rejects_invalid_case_hash_identity_before_rows(
    field: str,
    invalid_identity: str,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    case_identities[0][field] = invalid_identity

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert failures[0] == f"Task 8 expected case identity has invalid {field}"


@pytest.mark.parametrize("backend", ["fem_cpu", "fem_gpu"])
def test_task8_qualification_rejects_missing_backend_omp_identity_before_rows(
    backend: str,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    omp_threads = runtime_identity["omp_thread_count"]
    assert isinstance(omp_threads, dict)
    omp_threads.pop(backend)

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert failures[0] == (
        f"Task 8 expected runtime identity has invalid OpenMP thread count for {backend}"
    )


@pytest.mark.parametrize("backend", ["fem_cpu", "fem_gpu"])
@pytest.mark.parametrize("invalid_omp_threads", [True, 1.5, 0, -1])
def test_task8_qualification_rejects_invalid_omp_identity_before_rows(
    backend: str,
    invalid_omp_threads: object,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    omp_threads = runtime_identity["omp_thread_count"]
    assert isinstance(omp_threads, dict)
    omp_threads[backend] = invalid_omp_threads

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert failures[0] == (
        f"Task 8 expected runtime identity has invalid OpenMP thread count for {backend}"
    )


@pytest.mark.parametrize("invalid_repeat_count", [True, 1.5, 0, -1])
def test_task8_qualification_rejects_invalid_repeat_count_before_rows(
    invalid_repeat_count: object,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=invalid_repeat_count,
    )

    assert failures == ["Task 8 expected_repeat_count must be a positive integer"]


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("linear_solver", None),
        ("preconditioner", 1),
        ("relative_tolerance", None),
        ("absolute_tolerance", float("nan")),
        ("amg_strength_threshold", float("inf")),
        ("max_iterations", True),
        ("print_level", 1.5),
        ("amg_relax_type", "18"),
        ("policy_source", []),
    ],
)
def test_task8_qualification_rejects_invalid_demag_policy_before_rows(
    field: str,
    invalid_value: object,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    demag_policy = case_identities[0]["resolved_demag_policy"]
    assert isinstance(demag_policy, dict)
    demag_policy[field] = invalid_value

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert failures[0] == (
        "Task 8 expected case identity has invalid resolved demag policy "
        f"{field}: case_id=box500_airbox_exchange_demag "
        "relaxation_algorithm=projected_gradient_bb"
    )


def test_task8_qualification_rejects_extra_failed_duplicate_row() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(runtime_identity, case_identities[0])
    rows.append({**rows[0], "status": "failed"})

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any(
        "repeat_index=0 has 2 total fem_cpu rows; expected exactly one" in failure
        for failure in failures
    )


def test_task8_qualification_rejects_empty_expected_case_matrix_before_rows() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, _ = task8_expected_qualification_identity()

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=[],
        expected_repeat_count=1,
    )

    assert failures == ["Task 8 expected_case_identities must not be empty"]


@pytest.mark.parametrize(
    "required_backends",
    [
        ["fem_cpu"],
        ["fem_gpu"],
        ["fem_cpu", "fem_cpu"],
        ["fem_cpu", "fem_gpu", "fem_gpu"],
        ["fem_cpu", "fem_gpu", "unexpected"],
    ],
)
def test_task8_qualification_requires_exact_cpu_gpu_backend_set_before_rows(
    required_backends: list[str],
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    case_identities[0]["required_backends"] = required_backends

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert failures[0] == (
        "Task 8 expected case identity required_backends must be exactly "
        "['fem_cpu', 'fem_gpu']: case_id=box500_airbox_exchange_demag "
        "relaxation_algorithm=projected_gradient_bb"
    )


def test_task8_mixed_demag_case_matrix_accepts_case_scoped_policy_and_empty_nondemag() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    demag_rows = task8_complete_qualification_rows(
        runtime_identity,
        case_identities[0],
    )
    nondemag_case = {
        **case_identities[0],
        "case_id": "box500_airbox_exchange_only",
        "fixture_sha256": "2" * 64,
        "solver_mesh_signature": "3" * 64,
        "magnetic_node_indices_sha256": "4" * 64,
        "initial_m_sha256": "5" * 64,
        "demag_enabled": False,
    }
    nondemag_case.pop("resolved_demag_policy")
    case_identities.append(nondemag_case)
    policy_row_fields = {
        "demag_linear_solver",
        "demag_preconditioner",
        "demag_relative_tolerance",
        "demag_absolute_tolerance",
        "demag_max_iterations",
        "demag_print_level",
        "demag_amg_relax_type",
        "demag_amg_coarsening",
        "demag_amg_interpolation",
        "demag_amg_aggressive_coarsening",
        "demag_amg_strength_threshold",
        "demag_amg_max_levels",
        "demag_policy_source",
    }
    nondemag_rows = []
    for row in demag_rows:
        nondemag_row = {
            key: value for key, value in row.items() if key not in policy_row_fields
        }
        nondemag_row.update(
            {
                "scenario": nondemag_case["case_id"],
                "fixture_sha256": nondemag_case["fixture_sha256"],
                "solver_mesh_signature": nondemag_case["solver_mesh_signature"],
                "qualification_input_mesh_signature": nondemag_case[
                    "solver_mesh_signature"
                ],
                "magnetic_node_indices_sha256": nondemag_case[
                    "magnetic_node_indices_sha256"
                ],
                "initial_m_sha256": nondemag_case["initial_m_sha256"],
                "demag_model": None,
                "demag_solves": 0,
            }
        )
        nondemag_rows.append(nondemag_row)

    assert benchmark.task8_qualification_failures(
        [*demag_rows, *nondemag_rows],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    ) == []


@pytest.mark.parametrize(
    "mutation",
    [
        "missing_demag_enabled",
        "demag_without_policy",
        "nondemag_with_policy",
    ],
)
def test_task8_mixed_demag_case_matrix_rejects_fail_open_case_schema(
    mutation: str,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    case = case_identities[0]
    if mutation == "missing_demag_enabled":
        case.pop("demag_enabled")
    elif mutation == "demag_without_policy":
        case.pop("resolved_demag_policy")
    else:
        case["demag_enabled"] = False

    failures = benchmark.task8_qualification_failures(
        [],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any("demag" in failure.lower() for failure in failures)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("demag_model", "airbox"),
        ("demag_linear_solver", "CG"),
        ("demag_preconditioner", "AMG"),
        ("demag_policy_source", "problem_ir"),
        ("demag_policy_source", ["problem_ir"]),
        ("demag_solves", 1),
    ],
)
def test_task8_mixed_demag_case_matrix_rejects_nondemag_runtime_contamination(
    field: str,
    value: object,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    row = task8_complete_qualification_rows(runtime_identity, case_identities[0])[0]
    case = case_identities[0]
    case["demag_enabled"] = False
    case.pop("resolved_demag_policy")
    policy_fields = [key for key in row if key.startswith("demag_")]
    for policy_field in policy_fields:
        row.pop(policy_field)
    row["demag_model"] = None
    row["demag_solves"] = 0
    row[field] = value

    failures = benchmark.task8_qualification_failures(
        [row],
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any(field in failure for failure in failures)


def task8_two_policy_matrix():
    runtime_identity, case_identities = task8_expected_qualification_identity()
    amg_case = case_identities[0]
    jacobi_case = json.loads(json.dumps(amg_case))
    jacobi_policy = jacobi_case["resolved_demag_policy"]
    jacobi_policy["preconditioner"] = "JACOBI"
    for field in (
        "absolute_tolerance",
        "amg_relax_type",
        "amg_coarsening",
        "amg_interpolation",
        "amg_aggressive_coarsening",
        "amg_strength_threshold",
        "amg_max_levels",
    ):
        jacobi_policy.pop(field)
    case_identities.append(jacobi_case)
    amg_rows = task8_complete_qualification_rows(runtime_identity, amg_case)
    jacobi_rows = []
    for amg_row in amg_rows:
        jacobi_row = dict(amg_row)
        jacobi_row["demag_preconditioner"] = "JACOBI"
        for row_field in (
            "demag_absolute_tolerance",
            "demag_amg_relax_type",
            "demag_amg_coarsening",
            "demag_amg_interpolation",
            "demag_amg_aggressive_coarsening",
            "demag_amg_strength_threshold",
            "demag_amg_max_levels",
        ):
            jacobi_row[row_field] = ""
        jacobi_rows.append(jacobi_row)
    rows = [*amg_rows, *jacobi_rows]
    return runtime_identity, case_identities, rows


def test_task8_policy_variant_cardinality_accepts_two_exact_policies_with_shared_fixture() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities, rows = task8_two_policy_matrix()

    assert case_identities[0]["fixture_sha256"] == case_identities[1][
        "fixture_sha256"
    ]
    assert benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    ) == []


def test_task8_policy_variant_cardinality_rejects_missing_backend_in_one_policy() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities, rows = task8_two_policy_matrix()
    rows = [
        row
        for row in rows
        if not (
            row["backend"] == "fem_gpu"
            and row["demag_preconditioner"] == "JACOBI"
        )
    ]

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any(
        "preconditioner=JACOBI" in failure and "missing a total fem_gpu row" in failure
        for failure in failures
    )


def test_task8_policy_variant_cardinality_rejects_duplicate_backend_in_one_policy() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities, rows = task8_two_policy_matrix()
    duplicate = next(
        row
        for row in rows
        if row["backend"] == "fem_cpu" and row["demag_preconditioner"] == "AMG"
    )
    rows.append(dict(duplicate))

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert any(
        "preconditioner=AMG" in failure and "has 2 total fem_cpu rows" in failure
        for failure in failures
    )


def test_task8_identity_capture_cli_and_recipes_keep_candidate_separate_from_qualification_input(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    output = tmp_path / "expected-identity.json"

    args = benchmark.parse_args(
        ["--write-task8-qualification-identity", str(output)]
    )
    assert args.write_task8_qualification_identity == output

    capture = just_recipe_source(
        JUSTFILE.read_text(encoding="utf-8"),
        "capture-fem-task8-qualification-identity",
    )
    production = just_recipe_source(
        JUSTFILE.read_text(encoding="utf-8"),
        "verify-fem-relaxation-production-benchmark",
    )
    assert "candidate-identity.json" in capture
    assert "expected-identity.json" not in capture
    assert "FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY" in production
    assert "--task8-qualification-identity" in production
    assert "candidate-identity.json" not in production
    for recipe in (capture, production):
        assert 'FULLMAG_BENCH_THREAD_COUNTS="${FULLMAG_BENCH_THREAD_COUNTS:-1}"' in recipe
        assert recipe.count('--thread-counts "$FULLMAG_BENCH_THREAD_COUNTS"') == 1
        assert recipe.count(
        '--cpu-gpu-energy-rtol "$FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL"'
        ) == 1
        assert recipe.count(
        '--cpu-gpu-energy-atol "$FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J"'
        ) == 1
        assert recipe.count(
        '--cpu-gpu-torque-rtol "$FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL"'
        ) == 1


def test_task8_identity_capture_standalone_managed_recipe_is_forwarded_before_run() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    capture = just_recipe_source(
        justfile,
        "capture-fem-task8-qualification-identity",
    )
    production = just_recipe_source(
        justfile,
        "verify-fem-relaxation-production-benchmark",
    )

    assert "just ensure-managed-fem-runtime" in capture
    assert "docker compose --profile fem-gpu run --rm" in capture
    assert "--write-task8-qualification-identity" in capture
    assert "--task8-qualification-identity" not in capture
    assert "just capture-fem-task8-qualification-identity" not in production
    assert "--write-task8-qualification-identity" not in production
    shared_env = (
        "FULLMAG_BENCH_DOMAIN_HMAX",
        "FULLMAG_BENCH_AIRBOX_HMAX",
        "FULLMAG_BENCH_INTEGRATORS",
        "FULLMAG_BENCH_RELAX_ALGORITHMS",
        "FULLMAG_BENCH_DEMAG_SOLVERS",
        "FULLMAG_BENCH_DEMAG_PRECONDITIONERS",
        "FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES",
        "FULLMAG_BENCH_DEMAG_AMG_COARSENINGS",
        "FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS",
        "FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS",
        "FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS",
        "FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS",
        "FULLMAG_BENCH_STEPS",
        "FULLMAG_BENCH_REPEAT",
        "FULLMAG_BENCH_THREAD_COUNTS",
        "FULLMAG_BENCH_CASE_TIMEOUT_S",
        "FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL",
        "FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J",
        "FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL",
        "FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR",
    )
    for variable in shared_env:
        assert variable in capture
        assert variable in production
    assert "FULLMAG_BENCH_TASK8_QUALIFICATION_CANDIDATE" in capture
    assert "FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY" in production
    assert "sha256sum" not in capture
    assert "jq " not in capture


def test_task8_identity_capture_entrypoints_cannot_execute_or_read_results() -> None:
    tree = ast.parse(BENCHMARK.read_text(encoding="utf-8"))
    capture_functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name
        in {
            "build_task8_qualification_case_identities",
            "write_task8_qualification_identity",
        }
    }
    assert set(capture_functions) == {
        "build_task8_qualification_case_identities",
        "write_task8_qualification_identity",
    }
    forbidden = {
        "run_backend",
        "write_csv",
        "load_csv",
        "cpu_gpu_consistency_summary",
        "write_cpu_gpu_consistency_summary",
    }
    for function in capture_functions.values():
        called = {
            node.func.id
            for node in ast.walk(function)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        assert called.isdisjoint(forbidden)
        assert not any(
            isinstance(node, ast.Name) and node.id == "results"
            for node in ast.walk(function)
        )


def test_task8_identity_capture_jacobi_policy_uses_real_applicable_shape() -> None:
    benchmark = load_benchmark_module()
    problem_ir = {
        "backend_policy": {
            "discretization_hints": {
                "fem": {
                    "demag_solver_policy": {
                        "solver": "CG",
                        "preconditioner": "JACOBI",
                        "rtol": 1e-12,
                        "max_iterations": 500,
                        "print_level": 1,
                    }
                }
            }
        }
    }

    policy = benchmark.task8_expected_resolved_demag_policy(
        problem_ir=problem_ir,
        demag_amg_profile=(18, 8, 6, 1, None, None),
    )

    assert policy == {
        "linear_solver": "CG",
        "preconditioner": "JACOBI",
        "relative_tolerance": 1e-12,
        "max_iterations": 500,
        "print_level": 1,
        "policy_source": "explicit",
    }


def test_task8_identity_capture_uses_materialized_policy_when_requested_print_level_diverges(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    benchmark = load_benchmark_module()
    monkeypatch.syspath_prepend(str(REPO_ROOT / "packages" / "fullmag-py" / "src"))
    args = benchmark.parse_args(["--demag-print-level", "0"])
    domain_mesh_path = (
        REPO_ROOT
        / "examples/assets/fem_performance/box500_airbox_exchange_demag_amg_coarse_v1.mesh.json"
    )
    problem_ir = benchmark.canonical_problem_ir(
        mesh_path=tmp_path / "input.mesh.json",
        domain_mesh_path=domain_mesh_path,
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
        relaxation_algorithm="projected_gradient_bb",
        steps=2,
        dt=1e-13,
        timestep_policy="fixed",
        extra_env=benchmark.demag_policy_env(
            "CG",
            "AMG",
            1e-8,
            (18, 8, 6, 1, None, None),
            args,
        ),
    )

    policy = benchmark.task8_expected_resolved_demag_policy(
        problem_ir=problem_ir,
        demag_amg_profile=(18, 8, 6, 1, None, None),
    )

    assert args.demag_print_level == 0
    assert policy["print_level"] == 1


def test_task8_identity_capture_schema_cardinality_includes_default_policy_variants() -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    jacobi_case = json.loads(json.dumps(case_identities[0]))
    jacobi_case["resolved_demag_policy"] = {
        "linear_solver": "CG",
        "preconditioner": "JACOBI",
        "relative_tolerance": 1e-12,
        "max_iterations": 500,
        "print_level": 0,
        "policy_source": "explicit",
    }
    case_identities[0]["resolved_demag_policy"]["policy_source"] = "explicit"

    payload = benchmark.task8_qualification_identity_payload(
        runtime_identity=runtime_identity,
        case_identities=[*case_identities, jacobi_case],
        expected_repeat_count=5,
    )

    assert payload["schema"] == "fullmag.fem.task8_qualification_identity.v1"
    assert payload["expected_repeat_count"] == 5
    policies = [
        case["resolved_demag_policy"]["preconditioner"]
        for case in payload["case_identities"]
    ]
    assert policies == ["AMG", "JACOBI"]


def test_task8_identity_capture_manifest_expected_device_rejects_observed_drift(
    tmp_path: Path,
    monkeypatch,
) -> None:
    benchmark = load_benchmark_module()
    runtime_root = tmp_path / "runtime"
    library = runtime_root / "lib" / "libfullmag_fem.so"
    library.parent.mkdir(parents=True)
    library.write_bytes(b"native")
    (runtime_root / "manifest.json").write_text(
        json.dumps(
            {
                "schema": 3,
                "source_provenance": {
                    "git_commit": "a" * 40,
                    "git_tree": "b" * 40,
                    "dirty": False,
                    "dirty_patch_sha256": None,
                    "source_inputs_sha256": "c" * 64,
                    "source_input_manifest": (
                        "scripts/managed_fem_runtime_source_inputs.v1.txt"
                    ),
                },
                "native_libraries": {
                    "fullmag_fem": {"path": "lib/libfullmag_fem.so"}
                },
                "runtime_diagnostics": {
                    "device_name": "NVIDIA GeForce RTX 4080 SUPER",
                    "compute_capability": "8.9",
                },
            }
        ),
        encoding="utf-8",
    )
    _, cases = task8_expected_qualification_identity()
    monkeypatch.setattr(benchmark, "MANAGED_FEM_RUNTIME_ROOT", runtime_root)
    monkeypatch.setattr(
        benchmark,
        "build_task8_qualification_case_identities",
        lambda args: (cases, 1),
    )
    output = tmp_path / "identity.json"

    payload = benchmark.write_task8_qualification_identity(
        SimpleNamespace(repeat=1), output
    )
    rows = task8_complete_qualification_rows(
        payload["runtime_identity"], payload["case_identities"][0]
    )
    gpu_row = next(row for row in rows if row["backend"] == "fem_gpu")
    benchmark.attach_observed_gpu_identity(
        gpu_row,
        {
            "device_uuid": "GPU-test-4090",
            "device_name": "NVIDIA GeForce RTX 4090",
            "compute_capability": "8.9",
            "gpu_index": 0,
        },
    )

    assert payload["runtime_identity"]["device_name"] == (
        "NVIDIA GeForce RTX 4080 SUPER"
    )
    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=payload["runtime_identity"],
        expected_case_identities=payload["case_identities"],
        expected_repeat_count=1,
    )
    assert any("device_name differs" in failure for failure in failures)


def test_task8_qualification_integration_cli_delegates_actual_rows_to_single_owner(
    tmp_path: Path,
    monkeypatch,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(runtime_identity, case_identities[0])
    identity_artifact = tmp_path / "task8-qualification-identity.json"
    identity_artifact.write_text(
        json.dumps(
            {
                "schema": "fullmag.fem.task8_qualification_identity.v1",
                "runtime_identity": runtime_identity,
                "case_identities": case_identities,
                "expected_repeat_count": 1,
            }
        ),
        encoding="utf-8",
    )
    owner_calls: list[dict[str, object]] = []

    def qualification_owner(
        actual_rows,
        *,
        expected_runtime_identity,
        expected_case_identities,
        expected_repeat_count,
    ):
        owner_calls.append(
            {
                "rows": actual_rows,
                "runtime_identity": expected_runtime_identity,
                "case_identities": expected_case_identities,
                "repeat_count": expected_repeat_count,
            }
        )
        return ["Task 8 integration sentinel mismatch"]

    monkeypatch.setattr(
        benchmark,
        "task8_qualification_failures",
        qualification_owner,
    )

    args = benchmark.parse_args(
        ["--task8-qualification-identity", str(identity_artifact)]
    )
    gate = benchmark.task8_qualification_gate(
        rows,
        args.task8_qualification_identity,
    )

    assert owner_calls == [
        {
            "rows": rows,
            "runtime_identity": runtime_identity,
            "case_identities": case_identities,
            "repeat_count": 1,
        }
    ]
    assert gate == {
        "schema": "fullmag.fem.task8_qualification_gate.v1",
        "status": "fail",
        "identity_artifact": str(identity_artifact),
        "identity_artifact_sha256": benchmark.hashlib.sha256(
            identity_artifact.read_bytes()
        ).hexdigest(),
        "failure_count": 1,
        "failures": ["Task 8 integration sentinel mismatch"],
    }


def test_task8_qualification_integration_failure_marks_machine_summary_failed() -> None:
    benchmark = load_benchmark_module()
    summary = {
        "status": "pass",
        "failure_count": 0,
        "failures": [],
    }
    gate = {
        "schema": "fullmag.fem.task8_qualification_gate.v1",
        "status": "fail",
        "identity_artifact": "/workspace/expected-task8-identity.json",
        "identity_artifact_sha256": "a" * 64,
        "failure_count": 1,
        "failures": ["Task 8 integration sentinel mismatch"],
    }

    benchmark.attach_task8_qualification_summary(summary, gate)

    assert summary["status"] == "fail"
    assert summary["failure_count"] == 1
    assert summary["failures"] == ["Task 8 integration sentinel mismatch"]
    assert summary["task8_qualification"] == gate


def test_task8_qualification_integration_production_recipe_only_forwards_artifact() -> None:
    recipe = just_recipe_source(
        JUSTFILE.read_text(encoding="utf-8"),
        "verify-fem-relaxation-production-benchmark",
    )

    assert '-e FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY="${FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY:-}"' in recipe
    assert (
        'if [ -n "$FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY" ]; then '
        'identity_args+=(--task8-qualification-identity '
        '"$FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY"); fi;'
        in recipe
    )
    assert (
        '"${identity_args[@]}"'
        in recipe
    )
    assert "sha256sum" not in recipe
    assert "jq " not in recipe


def test_task8_qualification_row_identity_integration_is_computed_from_runtime_and_case_inputs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    benchmark = load_benchmark_module()
    runtime_root = tmp_path / "runtime"
    runtime_library = runtime_root / "lib" / "libfullmag_fem.so.0.1.0"
    runtime_library.parent.mkdir(parents=True)
    runtime_library.write_bytes(b"actual-native-library")
    runtime_manifest = {
        "schema": 3,
        "source_provenance": {
            "git_commit": "a" * 40,
            "git_tree": "b" * 40,
            "dirty": False,
            "dirty_patch_sha256": None,
            "source_inputs_sha256": "c" * 64,
            "source_input_manifest": "scripts/managed_fem_runtime_source_inputs.v1.txt",
        },
        "native_libraries": {
            "fullmag_fem": {
                "path": "lib/libfullmag_fem.so.0.1.0",
                "sha256": "0" * 64,
            }
        },
        "runtime_diagnostics": {
            "device_name": "NVIDIA GeForce RTX 4080 SUPER",
            "compute_capability": "8.9",
        },
    }
    runtime_manifest_path = runtime_root / "manifest.json"
    runtime_manifest_path.write_text(
        json.dumps(runtime_manifest),
        encoding="utf-8",
    )
    monkeypatch.setattr(benchmark, "MANAGED_FEM_RUNTIME_ROOT", runtime_root)

    solver_mesh = tmp_path / "shared-domain.mesh.json"
    solver_mesh.write_text(
        json.dumps(
            {
                "mesh_name": "shared-domain",
                "nodes": [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 1.0],
                ],
                "elements": [[0, 1, 2, 3], [1, 2, 3, 4]],
                "element_markers": [1, 0],
            }
        ),
        encoding="utf-8",
    )
    input_mesh = tmp_path / "input.mesh.json"
    input_mesh.write_text(
        json.dumps({"mesh_name": "input", "nodes": [], "elements": []}),
        encoding="utf-8",
    )
    case_manifest = {
        "case_id": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "projected_gradient_bb",
        "required_backends": ["fem_cpu", "fem_gpu"],
        "relaxation": {"max_steps": 2, "dt_s": 1e-13},
    }
    problem_ir = {
        "ir_version": "1",
        "study": {
            "stop": {
                "max_steps": 2,
                "torque_tolerance_apm": 1e-4,
            }
        },
        "magnets": [
            {
                "name": "body",
                "region": "body",
                "initial_magnetization": {
                    "kind": "preset_texture",
                    "preset_kind": "helical",
                    "preset_params": {
                        "wavevector": [1.0, 0.0, 0.0],
                        "e1": [1.0, 0.0, 0.0],
                        "e2": [0.0, 1.0, 0.0],
                        "phase_rad": 0.0,
                    },
                },
            }
        ],
    }
    common = {
        "binary": tmp_path / "missing-binary",
        "mesh_path": input_mesh,
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "steps": 2,
        "dt": 1e-13,
        "extra_env": {
            "FULLMAG_BENCH_DOMAIN_MESH": str(solver_mesh),
            "FULLMAG_FEM_STEP_PROFILE": "1",
        },
        "problem_ir": problem_ir,
        "qualification_case_manifest": case_manifest,
    }

    cpu_row = benchmark.run_backend(backend_label="fem_cpu", **common)
    gpu_row = benchmark.run_backend(
        backend_label="fem_gpu",
        observed_gpu_identity={
            "device_uuid": "GPU-test-4090",
            "device_name": "NVIDIA GeForce RTX 4090",
            "compute_capability": "8.9",
            "gpu_index": 0,
        },
        **common,
    )
    assert cpu_row["step_profiler_enabled"] is True
    assert gpu_row["step_profiler_enabled"] is True

    canonical = lambda value: json.dumps(
        value, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    expected_fixture_sha256 = benchmark.hashlib.sha256(
        canonical(case_manifest)
    ).hexdigest()
    magnetic_node_indices = [0, 1, 2, 3]
    expected_indices_sha256 = benchmark.hashlib.sha256(
        canonical(magnetic_node_indices)
    ).hexdigest()
    expected_initial_m_sha256 = benchmark.hashlib.sha256(
        canonical(
            {
                "magnetic_node_indices": magnetic_node_indices,
                "magnets": [
                    {
                        "name": "body",
                        "region": "body",
                        "initial_magnetization": problem_ir["magnets"][0][
                            "initial_magnetization"
                        ],
                    }
                ],
            }
        )
    ).hexdigest()
    expected_shared = {
        "runtime_git_commit": "a" * 40,
        "runtime_git_tree": "b" * 40,
        "runtime_source_inputs_sha256": "c" * 64,
        "runtime_dirty": "false",
        "runtime_dirty_patch_sha256": "",
        "runtime_manifest_sha256": benchmark.hashlib.sha256(
            runtime_manifest_path.read_bytes()
        ).hexdigest(),
        "libfullmag_fem_sha256": benchmark.hashlib.sha256(
            runtime_library.read_bytes()
        ).hexdigest(),
        "fixture_sha256": expected_fixture_sha256,
        "magnetic_node_indices_sha256": expected_indices_sha256,
        "initial_m_sha256": expected_initial_m_sha256,
    }
    for field, expected in expected_shared.items():
        assert cpu_row[field] == expected
        assert gpu_row[field] == expected
    assert "device_name" not in cpu_row
    assert "device_uuid" not in cpu_row
    assert "compute_capability" not in cpu_row
    assert gpu_row["device_name"] == "NVIDIA GeForce RTX 4090"
    assert gpu_row["device_uuid"] == "GPU-test-4090"
    assert gpu_row["compute_capability"] == "8.9"
    assert gpu_row["observed_gpu_index"] == 0
    assert cpu_row["solver_mesh_signature"] == gpu_row["solver_mesh_signature"]


def test_task8_current_device_identity_rejects_unavailable_nvidia_smi(
    monkeypatch,
) -> None:
    benchmark = load_benchmark_module()

    def unavailable(*args, **kwargs):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(benchmark.subprocess, "run", unavailable)

    with pytest.raises(ValueError, match="nvidia-smi.*unavailable"):
        benchmark.observe_current_gpu_identity(gpu_index=0)


def test_task8_current_device_identity_selects_configured_multi_gpu_index(
    monkeypatch,
) -> None:
    benchmark = load_benchmark_module()
    calls = []

    def completed(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=(
                "GPU-test-3090, NVIDIA GeForce RTX 3090, 8.6\n"
                "GPU-test-4080, NVIDIA GeForce RTX 4080 SUPER, 8.9\n"
            ),
            stderr="",
        )

    monkeypatch.setattr(benchmark.subprocess, "run", completed)

    assert benchmark.observe_current_gpu_identity(gpu_index=1) == {
        "device_uuid": "GPU-test-4080",
        "device_name": "NVIDIA GeForce RTX 4080 SUPER",
        "compute_capability": "8.9",
        "gpu_index": 1,
    }
    assert len(calls) == 1
    assert calls[0][0] == [
        "nvidia-smi",
        "--query-gpu=uuid,name,compute_cap",
        "--format=csv,noheader",
    ]


@pytest.mark.parametrize(
    "stdout",
    [
        "",
        "NVIDIA GeForce RTX 4080 SUPER\n",
        "NVIDIA GeForce RTX 4080 SUPER, unknown\n",
        "GPU-test, NVIDIA GeForce RTX 4080 SUPER, unknown\n",
        "GPU-test, NVIDIA GeForce RTX 4080 SUPER, 8.9, extra\n",
    ],
)
def test_task8_current_device_identity_rejects_missing_or_malformed_observation(
    stdout: str,
    monkeypatch,
) -> None:
    benchmark = load_benchmark_module()
    monkeypatch.setattr(
        benchmark.subprocess,
        "run",
        lambda command, **kwargs: subprocess.CompletedProcess(
            command,
            0,
            stdout=stdout,
            stderr="",
        ),
    )

    with pytest.raises(ValueError, match="GPU identity"):
        benchmark.observe_current_gpu_identity(gpu_index=0)


def test_task8_current_device_identity_mismatch_is_authored_on_gpu_row_and_rejected(
    tmp_path: Path,
    monkeypatch,
) -> None:
    benchmark = load_benchmark_module()
    runtime_identity, case_identities = task8_expected_qualification_identity()
    rows = task8_complete_qualification_rows(runtime_identity, case_identities[0])
    observed = {
        "device_uuid": "GPU-test-4090",
        "device_name": "NVIDIA GeForce RTX 4090",
        "compute_capability": "8.9",
        "gpu_index": 0,
    }
    gpu_row = next(row for row in rows if row["backend"] == "fem_gpu")
    benchmark.attach_observed_gpu_identity(gpu_row, observed)

    failures = benchmark.task8_qualification_failures(
        rows,
        expected_runtime_identity=runtime_identity,
        expected_case_identities=case_identities,
        expected_repeat_count=1,
    )

    assert gpu_row["device_name"] == "NVIDIA GeForce RTX 4090"
    assert any("device_name differs" in failure for failure in failures)


def test_task8_current_device_identity_is_wired_only_to_qualified_gpu_branch() -> None:
    tree = ast.parse(BENCHMARK.read_text(encoding="utf-8"))
    main = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "main"
    )
    qualified_calls = []
    for node in ast.walk(main):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        if node.func.id != "run_backend":
            continue
        keywords = {keyword.arg: keyword.value for keyword in node.keywords}
        if "qualification_case_manifest" not in keywords:
            continue
        backend = keywords.get("backend_label")
        assert isinstance(backend, ast.Constant)
        qualified_calls.append((backend.value, keywords))

    assert [backend for backend, _ in qualified_calls] == ["fem_cpu", "fem_gpu"]
    cpu_keywords = qualified_calls[0][1]
    gpu_keywords = qualified_calls[1][1]
    assert "observed_gpu_identity" not in cpu_keywords
    assert ast.unparse(gpu_keywords["observed_gpu_identity"]) == "observed_gpu_identity"
    gpu_extra_env = gpu_keywords["extra_env"]
    assert isinstance(gpu_extra_env, ast.Dict)
    gpu_index_value = next(
        value
        for key, value in zip(gpu_extra_env.keys, gpu_extra_env.values, strict=True)
        if isinstance(key, ast.Constant) and key.value == "FULLMAG_FEM_GPU_INDEX"
    )
    gpu_index_source = ast.unparse(gpu_index_value)
    assert "observed_gpu_identity" in gpu_index_source
    assert "gpu_index" in gpu_index_source


def test_gpu_zero_global_sync_gate_uses_strict_compute_sync_audit() -> None:
    benchmark = load_benchmark_module()
    good = {
        "backend": "fem_gpu",
        "scenario": "box500_airbox_exchange_demag",
        "status": "ok",
        "hot_loop_compute_host_sync_count": 0,
    }

    assert benchmark.gpu_zero_global_sync_failures([good]) == []
    failures = benchmark.gpu_zero_global_sync_failures(
        [{**good, "hot_loop_compute_host_sync_count": 1}]
    )
    assert len(failures) == 1
    assert "requires hot_loop_compute_host_sync_count=0" in failures[0]


def test_demag_policy_selection_key_separates_relaxation_algorithms() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 4,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
    }

    pgbb_key = benchmark.demag_policy_selection_case_key(
        {**base_row, "relaxation_algorithm": "projected_gradient_bb"}
    )
    ncg_key = benchmark.demag_policy_selection_case_key(
        {**base_row, "relaxation_algorithm": "nonlinear_cg"}
    )

    assert pgbb_key != ncg_key


def test_benchmark_shared_domain_reuse_classifies_demag_scenarios() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.benchmark_scenario_requires_shared_domain(
        "box500_airbox_exchange_demag"
    )
    assert benchmark.benchmark_scenario_requires_shared_domain("exchange_demag")
    assert not benchmark.benchmark_scenario_requires_shared_domain("exchange_only")


def test_demag_rtol_sweep_parser_preserves_unique_positive_tolerances() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.resolve_demag_rtols("1e-8,1e-6,1e-6", 1e-8) == [
        1e-8,
        1e-6,
    ]
    assert benchmark.resolve_demag_rtols(None, 1e-7) == [1e-7]


def test_demag_amg_profile_sweep_parser_and_policy_identity() -> None:
    benchmark = load_benchmark_module()

    profiles = [
        (relax_type, 8, 6, 1, None, None)
        for relax_type in benchmark.resolve_nonnegative_ints("18,18,6", 18)
    ]

    assert profiles == [(18, 8, 6, 1, None, None), (6, 8, 6, 1, None, None)]
    assert benchmark.demag_amg_profiles_for_preconditioner("AMG", profiles) == profiles
    assert benchmark.demag_amg_profiles_for_preconditioner("OMIT", profiles) == profiles
    assert benchmark.demag_amg_profiles_for_preconditioner("JACOBI", profiles) == [
        (
            benchmark.DEFAULT_DEMAG_AMG_RELAX_TYPE,
            benchmark.DEFAULT_DEMAG_AMG_COARSENING,
            benchmark.DEFAULT_DEMAG_AMG_INTERPOLATION,
            benchmark.DEFAULT_DEMAG_AMG_AGGRESSIVE_COARSENING,
            benchmark.DEFAULT_DEMAG_AMG_STRENGTH_THRESHOLD,
            benchmark.DEFAULT_DEMAG_AMG_MAX_LEVELS,
        )
    ]

    first = {
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_amg_relax_type": "18",
        "requested_demag_amg_coarsening": "8",
        "requested_demag_amg_interpolation": "6",
        "requested_demag_amg_aggressive_coarsening": "1",
        "requested_demag_amg_strength_threshold": "",
        "requested_demag_amg_max_levels": "",
        "demag_linear_solver": "CG",
        "demag_preconditioner": "AMG",
        "demag_amg_relax_type": 18,
        "demag_amg_coarsening": 8,
        "demag_amg_interpolation": 6,
        "demag_amg_aggressive_coarsening": 1,
        "demag_amg_strength_threshold": None,
        "demag_amg_max_levels": None,
    }
    requested_only_drift = {**first, "requested_demag_amg_relax_type": "6"}
    effective_relax_change = {**first, "demag_amg_relax_type": 6}
    effective_strength_change = {**first, "demag_amg_strength_threshold": 0.25}

    assert benchmark.demag_policy_identity(first) == benchmark.demag_policy_identity(
        requested_only_drift
    )
    assert benchmark.demag_policy_identity(first) != benchmark.demag_policy_identity(
        effective_relax_change
    )
    assert benchmark.demag_policy_identity(first) != benchmark.demag_policy_identity(
        effective_strength_change
    )


def test_optional_demag_amg_profile_parser_preserves_defaults_and_overrides() -> None:
    benchmark = load_benchmark_module()

    assert benchmark.resolve_optional_nonnegative_floats(None) == [None]
    assert benchmark.resolve_optional_nonnegative_floats("default,0.25") == [
        None,
        0.25,
    ]
    assert benchmark.resolve_optional_nonnegative_ints(None) == [None]
    assert benchmark.resolve_optional_nonnegative_ints("none,25") == [None, 25]


def amg_relax_qualification_rows(
    algorithm: str = "nonlinear_cg",
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for relax_type, timing_ms in [(18, 100.0), (6, 94.0)]:
        for repeat_index in range(5):
            rows.append(
                {
                    "backend": "fem_gpu",
                    "solver_mesh_signature": "mesh-fine",
                    "scenario": "box500_airbox_exchange_demag",
                    "relaxation_algorithm": algorithm,
                    "step_profiler_enabled": True,
                    "repeat_index": repeat_index,
                    "status": "ok",
                    "executed_problem_ir_sha256": "b" * 64,
                    "qualification_fixture_problem_ir_sha256": "a" * 64,
                    "demag_linear_solver": "CG",
                    "demag_preconditioner": "AMG",
                    "demag_amg_relax_type": relax_type,
                    "demag_amg_coarsening": 8,
                    "demag_amg_interpolation": 6,
                    "demag_amg_aggressive_coarsening": 1,
                    "demag_amg_strength_threshold": None,
                    "demag_amg_max_levels": None,
                    "demag_solver_apply_wall_time_ms": timing_ms,
                    "wall_time_ms": timing_ms,
                    "demag_final_residual_norm": 1.0e-13,
                    "demag_relative_tolerance": 1.0e-12,
                    "energy_monotonicity_satisfied": True,
                    "executed_steps": 3,
                    "steps": 3,
                    "stop_reason": "max_steps",
                    "requested_relax_torque_tolerance_apm": 100.0,
                    "norm_defect": 2.0e-16,
                    "final_e_total_j": -1.0e-17,
                    "final_e_ex_j": 1.0e-20,
                    "final_e_demag_j": 2.0e-18,
                    "final_e_ext_j": -1.201e-17,
                    "final_torque_apm": 64.0,
                    "final_torque_t": 8.042477193189871e-5,
                }
            )
    return rows


def amg_relax_qualification_summary(benchmark, rows):
    return benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={
            "mesh-fine": "a" * 64
        },
    )


@pytest.mark.parametrize(
    ("field", "value", "failure_fragment"),
    [
        ("demag_linear_solver", "GMRES", "demag_linear_solver"),
        ("demag_preconditioner", "JACOBI", "demag_preconditioner"),
        ("demag_amg_coarsening", 10, "demag_amg_coarsening"),
        ("demag_amg_interpolation", 8, "demag_amg_interpolation"),
        ("demag_amg_aggressive_coarsening", 0, "demag_amg_aggressive_coarsening"),
        ("demag_amg_strength_threshold", 0.25, "demag_amg_strength_threshold"),
        ("demag_amg_max_levels", 25, "demag_amg_max_levels"),
        ("demag_relative_tolerance", 1.0e-8, "demag_relative_tolerance"),
        (
            "qualification_fixture_problem_ir_sha256",
            "c" * 64,
            "qualification_fixture_problem_ir_sha256",
        ),
        ("executed_problem_ir_sha256", "drifted-ir", "executed_problem_ir_sha256"),
    ],
)
def test_amg_relax_qualification_rejects_exact_matrix_identity_drift(
    field: str,
    value: object,
    failure_fragment: str,
) -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    rows[0][field] = value

    summary = amg_relax_qualification_summary(benchmark, rows)

    assert summary["promotion_eligible"] is False
    assert summary["exact_matrix_identity_gate_passed"] is False
    assert any(failure_fragment in failure for failure in summary["failures"])


def test_amg_relax_qualification_rejects_problem_ir_pair_drift() -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    candidate = next(
        row
        for row in rows
        if row["demag_amg_relax_type"] == 6 and row["repeat_index"] == 0
    )
    candidate["executed_problem_ir_sha256"] = "c" * 64

    summary = amg_relax_qualification_summary(benchmark, rows)

    assert summary["promotion_eligible"] is False
    assert summary["physics_equivalence_gate_passed"] is False
    assert any(
        "executed_problem_ir_sha256 mismatch" in failure
        for failure in summary["failures"]
    )


def test_amg_relax_qualification_rejects_problem_ir_drift_across_matrix_cases() -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    cpu_profiler_off_rows = []
    for row in rows:
        cpu_profiler_off_rows.append(
            {
                **row,
                "backend": "fem_cpu",
                "step_profiler_enabled": False,
                "executed_problem_ir_sha256": "c" * 64,
            }
        )
    rows.extend(cpu_profiler_off_rows)

    summary = amg_relax_qualification_summary(benchmark, rows)

    assert summary["promotion_eligible"] is False
    assert summary["exact_matrix_identity_gate_passed"] is False
    assert any(
        "executed_problem_ir_sha256 differs across matrix cases" in failure
        for failure in summary["failures"]
    )


def test_amg_relax_qualification_normalizes_empty_optional_csv_fields() -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    for row in rows:
        row["demag_amg_strength_threshold"] = ""
        row["demag_amg_max_levels"] = ""

    summary = amg_relax_qualification_summary(benchmark, rows)

    assert summary["exact_matrix_identity_gate_passed"] is True
    assert summary["promotion_eligible"] is True


def test_amg_relax_qualification_summary_enforces_p50_p95_and_geomean_gates() -> None:
    benchmark = load_benchmark_module()

    rows = amg_relax_qualification_rows()

    summary = benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )
    assert summary["promotion_eligible"] is True
    assert summary["geometric_mean_end_to_end_improvement_percent"] == pytest.approx(6.0)

    regressed = [dict(row) for row in rows]
    for row in regressed:
        if row["demag_amg_relax_type"] == 6:
            row["wall_time_ms"] = 106.0
    summary = benchmark.amg_relax_policy_qualification_summary(
        regressed,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )
    assert summary["promotion_eligible"] is False
    assert summary["p50_end_to_end_no_regression"] is False
    assert summary["p95_end_to_end_no_regression"] is False


def test_amg_relax_qualification_uses_native_armijo_proof_for_pgbb() -> None:
    benchmark = load_benchmark_module()

    rows = amg_relax_qualification_rows("projected_gradient_bb")
    for row in rows:
        repeat_index = int(row["repeat_index"])
        row.update(
            {
                "energy_monotonicity_satisfied": False,
                "accepted_energy_proof_available": True,
                "accepted_energy_proof_count": 3,
                "accepted_energy_proof_invalid_count": 0,
                "accepted_energy_proof_invalid_details": (
                    "[]" if repeat_index % 2 else []
                ),
            }
        )

    summary = benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )

    assert summary["trajectory_gate_passed"] is True
    assert summary["promotion_eligible"] is True


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("accepted_energy_proof_available", False),
        ("accepted_energy_proof_count", 2),
        ("accepted_energy_proof_invalid_count", 1),
        ("accepted_energy_proof_invalid_details", ["step=2: invalid"]),
    ],
)
def test_amg_relax_qualification_fails_closed_on_invalid_pgbb_proof(
    field: str,
    value: object,
) -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows("projected_gradient_bb")
    for row in rows:
        row.update(
            {
                "energy_monotonicity_satisfied": False,
                "accepted_energy_proof_available": True,
                "accepted_energy_proof_count": 3,
                "accepted_energy_proof_invalid_count": 0,
                "accepted_energy_proof_invalid_details": [],
            }
        )
    rows[0][field] = value

    summary = benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )

    assert summary["trajectory_gate_passed"] is False
    assert summary["promotion_eligible"] is False
    assert any("accepted Armijo proof" in failure for failure in summary["failures"])


def test_amg_relax_qualification_accepts_paired_physics_with_canonical_tolerances() -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    candidate = next(
        row
        for row in rows
        if row["demag_amg_relax_type"] == 6 and row["repeat_index"] == 0
    )
    candidate["norm_defect"] = 9.0e-10
    candidate["final_e_total_j"] = -1.0000005e-17
    candidate["final_torque_apm"] = 64.000032

    summary = benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )

    assert summary["physics_equivalence_gate_passed"] is True
    assert summary["promotion_eligible"] is True


@pytest.mark.parametrize(
    ("field", "value", "failure_fragment"),
    [
        ("stop_reason", "torque", "stop_reason mismatch"),
        ("executed_steps", 2, "executed_steps mismatch"),
        ("steps", 4, "configured steps mismatch"),
        (
            "requested_relax_torque_tolerance_apm",
            101.0,
            "requested torque target mismatch",
        ),
        ("norm_defect", 1.1e-9, "norm_defect exceeds"),
        ("final_e_total_j", -1.01e-17, "final_e_total_j mismatch"),
        ("final_e_demag_j", None, "missing numeric final_e_demag_j"),
        ("final_torque_apm", 65.0, "final_torque_apm mismatch"),
        ("final_torque_t", 9.0e-5, "final_torque_t mismatch"),
    ],
)
def test_amg_relax_qualification_fails_closed_on_paired_physics_drift(
    field: str,
    value: object,
    failure_fragment: str,
) -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    candidate = next(
        row
        for row in rows
        if row["demag_amg_relax_type"] == 6 and row["repeat_index"] == 0
    )
    candidate[field] = value

    summary = benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )

    assert summary["physics_equivalence_gate_passed"] is False
    assert summary["promotion_eligible"] is False
    assert any(failure_fragment in failure for failure in summary["failures"])


def test_amg_relax_qualification_fails_closed_on_duplicate_repeat_pairing() -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    candidate_rows = [row for row in rows if row["demag_amg_relax_type"] == 6]
    candidate_rows[-1]["repeat_index"] = 3

    summary = benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )

    assert summary["physics_equivalence_gate_passed"] is False
    assert summary["promotion_eligible"] is False
    assert any("repeat_index=3 has 2 rows" in failure for failure in summary["failures"])


def test_amg_relax_qualification_fails_closed_on_unknown_completion_semantics() -> None:
    benchmark = load_benchmark_module()
    rows = amg_relax_qualification_rows()
    for row in rows:
        if row["repeat_index"] == 0:
            row["stop_reason"] = "unknown"

    summary = benchmark.amg_relax_policy_qualification_summary(
        rows,
        cpu_gpu_parity_gate_passed=True,
        pcg_symmetry_contract_passed=True,
        expected_problem_ir_by_solver_mesh_signature={"mesh-fine": "a" * 64},
    )

    assert summary["physics_equivalence_gate_passed"] is False
    assert summary["promotion_eligible"] is False
    assert any(
        "unsupported qualification stop_reason" in failure
        for failure in summary["failures"]
    )


def test_demag_amg_qualification_suite_rejects_malformed_runtime_signature(
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    source_path = (
        REPO_ROOT / "examples/assets/fem_performance/amg_qualification_suite_v1.json"
    )
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    for fixture in payload["fixtures"]:
        fixture["solver_mesh_path"] = str(
            source_path.parent / fixture["solver_mesh_path"]
        )
    payload["fixtures"][0]["solver_mesh_signature"] = "not-a-runtime-signature"
    corrupted_path = tmp_path / "corrupted-suite.json"
    corrupted_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="64 lowercase hexadecimal characters"):
        benchmark.load_amg_qualification_fixture_suite(corrupted_path)


def test_canonical_problem_ir_inlines_explicit_shared_domain_mesh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.syspath_prepend(str(FULLMAG_PYTHON_SRC))
    benchmark = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples/assets/box_40x20x10_coarse.mesh.json"
    domain_mesh_path = (
        REPO_ROOT
        / "examples/assets/fem_performance/box500_airbox_exchange_demag_amg_coarse_v1.mesh.json"
    )

    problem_ir = benchmark.canonical_problem_ir(
        mesh_path=mesh_path,
        domain_mesh_path=domain_mesh_path,
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
        relaxation_algorithm="projected_gradient_bb",
        steps=64,
        dt=1.0e-13,
        timestep_policy="fixed",
        extra_env={},
    )

    domain_asset = problem_ir["geometry_assets"]["fem_domain_mesh_asset"]
    expected_mesh = json.loads(domain_mesh_path.read_text(encoding="utf-8"))
    assert domain_asset["mesh"] == expected_mesh


def test_single_backend_case_label_preserves_explicit_zero_amg_values() -> None:
    benchmark = load_benchmark_module()

    label = benchmark.single_backend_case_label(
        {
            "scenario": "box500_airbox_exchange_demag",
            "relaxation_algorithm": "nonlinear_cg",
            "backend": "fem_gpu",
            "demag_linear_solver": "CG",
            "demag_preconditioner": "AMG",
            "demag_amg_relax_type": 0,
            "demag_amg_coarsening": 0,
            "demag_amg_interpolation": 0,
            "demag_amg_aggressive_coarsening": 0,
            "demag_amg_strength_threshold": 0.0,
            "demag_amg_max_levels": 0,
        }
    )

    assert "amg=0/0/0/0/0.0/0" in label


def test_demag_amg_qualification_suite_and_recipe_cover_the_exact_matrix() -> None:
    benchmark = load_benchmark_module()
    fixtures = benchmark.load_amg_qualification_fixture_suite(
        REPO_ROOT / "examples/assets/fem_performance/amg_qualification_suite_v1.json"
    )
    assert [fixture["resolution"] for fixture in fixtures] == [
        "coarse",
        "medium",
        "fine",
    ]
    assert all(
        len(str(fixture["solver_mesh_signature"])) == 64
        and set(str(fixture["solver_mesh_signature"])) <= set("0123456789abcdef")
        for fixture in fixtures
    )
    recipe = just_recipe_source(
        JUSTFILE.read_text(encoding="utf-8"),
        "bench-fem-gpu-demag-amg-profile-sweep",
    )
    for required in (
        "for profiler in off on",
        "--backends fem_cpu,fem_gpu",
        "--relax-algorithms \"$FULLMAG_BENCH_RELAX_ALGORITHMS\"",
        "--demag-rtols 1e-12",
        "--steps 64",
        "--relax-torque-tolerance-t 1e-4",
        "--repeat 1",
        'FULLMAG_BENCH_REPEAT:-5',
        "--require-demag-converged",
        "--require-cpu-gpu-consistency",
        "--require-stable-solver-mesh",
        "--expected-solver-mesh-signature",
        "--qualification-fixture-problem-ir-sha256",
        "--amg-relax-qualification-output",
        "--amg-relax-qualification-fixture-suite",
        "--amg-relax-pcg-symmetry-passed",
    ):
        assert required in recipe
    assert 'problem_ir_sha256' in recipe


def test_demag_convergence_gate_uses_row_requested_rtol_by_default() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-6,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        },
        {
            "backend": "fem_gpu",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-8,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        },
    ]

    failures = benchmark.demag_convergence_failures(
        rows,
        max_residual=None,
        max_iterations=100,
    )

    assert len(failures) == 1
    assert "exceeds 1e-08" in failures[0]


def test_demag_rtol_sweep_does_not_install_global_default_residual_gate() -> None:
    benchmark = load_benchmark_module()
    args = benchmark.parse_args(["--demag-rtols", "1e-8,1e-6"])

    assert args.demag_convergence_residual is None
    assert benchmark.resolve_demag_rtols(args.demag_rtols, args.demag_rtol) == [
        1e-8,
        1e-6,
    ]


def test_task8_capture_interaction_preset_preserves_explicit_thread_count() -> None:
    benchmark = load_benchmark_module()
    args = benchmark.parse_args(
        [
            "--box500-airbox-interaction-consistency-preset",
            "--thread-counts",
            "1",
        ]
    )

    benchmark.apply_box500_airbox_interaction_consistency_preset(args)

    assert args.thread_counts == "1"


def test_gpu_host_thread_contract_requires_effective_request_and_device_hypre() -> None:
    benchmark = load_benchmark_module()
    row = {
        "backend": "fem_gpu",
        "requested_fem_omp_threads": 4,
        "effective_fem_omp_threads": 1,
        "fem_cpu_thread_cap_reason": "gpu-bypass",
        "fem_demag_operator_mode": "device_hypre_poisson",
        "hypre_execution_policy": "device",
    }

    failures = benchmark.gpu_host_thread_contract_failures(row, expected_threads=4)

    assert failures == [
        "effective_fem_omp_threads must equal requested value 4, got 1",
        "fem_cpu_thread_cap_reason must not resolve to gpu-bypass",
    ]


def _gpu_host_thread_qualification_rows() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    candidate_wall_ms = {1: 100.0, 2: 98.0, 4: 90.0, 8: 97.0}
    for threads in (1, 2, 4, 8):
        for profiler_enabled in (False, True):
            for ui_surface in ("headless", "interactive"):
                for repeat_index in range(5):
                    rows.append(
                        {
                            "backend": "fem_gpu",
                            "status": "ok",
                            "runtime_manifest_sha256": "1" * 64,
                            "runtime_source_inputs_sha256": "2" * 64,
                            "libfullmag_fem_sha256": "3" * 64,
                            "device_uuid": "GPU-task12",
                            "device_name": "NVIDIA Task 12",
                            "compute_capability": "8.9",
                            "solver_mesh_signature": "4" * 64,
                            "scenario": "box500_airbox_exchange_demag",
                            "reported_scenario": "box500_airbox_exchange_demag",
                            "integrator": "heun",
                            "reported_integrator": "heun",
                            "timestep_policy": "fixed",
                            "reported_timestep_policy": "fixed",
                            "dt_s": 1e-13,
                            "executed_problem_ir_sha256": "5" * 64,
                            "steps": 32,
                            "executed_steps": 32,
                            "relaxation_algorithm": "projected_gradient_bb",
                            "reported_relaxation_algorithm": "projected_gradient_bb",
                            "reported_precision": "double",
                            "requested_fem_execution": "gpu",
                            "requested_relaxation_preconditioner_strategy": "none",
                            "requested_demag_solver": "CG",
                            "requested_demag_preconditioner": "AMG",
                            "demag_linear_solver": "CG",
                            "demag_preconditioner": "AMG",
                            "requested_demag_relative_tolerance": 1e-12,
                            "demag_relative_tolerance": 1e-12,
                            "requested_demag_amg_relax_type": 6,
                            "demag_amg_relax_type": 6,
                            "requested_cpu_thread_spec": str(threads),
                            "requested_fem_omp_threads": threads,
                            "effective_fem_omp_threads": threads,
                            "execution_engine": "fem_native_gpu",
                            "fem_assembly_mode": "legacy_sparse",
                            "fem_execution_mode": "all_in_gpu_legacy_sparse",
                            "fem_data_residency": "device_source_of_truth",
                            "fem_demag_operator_mode": "device_hypre_poisson",
                            "hypre_execution_policy": "device",
                            "demag_residency": "device",
                            "fem_gpu_qualification_status": "production_executable",
                            "mfem_device": "ceed-cuda:/gpu/cuda/shared",
                            "step_profiler_enabled": profiler_enabled,
                            "ui_surface": ui_surface,
                            "repeat_index": repeat_index,
                            "wall_time_ms": candidate_wall_ms[threads] + repeat_index,
                            "backend_create_wall_time_ms": 10.0 + repeat_index,
                            "cumulative_step_interval_wall_time_ms": (
                                candidate_wall_ms[threads] - 15.0 + repeat_index
                            ),
                            "cumulative_native_solver_wall_time_ms": (
                                candidate_wall_ms[threads] - 20.0 + repeat_index
                            ),
                            "cumulative_publisher_replace_wall_time_ms": 1.0,
                            "cumulative_publish_lag_wall_time_ms": 2.0,
                            "cumulative_artifact_enqueue_block_wall_time_ms": 0.5,
                            "artifact_queue_depth_max": 1,
                            "host_cpu_time_ms": candidate_wall_ms[threads] * 1.5,
                            "host_cpu_average_core_count": 1.5,
                            "host_cpu_capacity": 16,
                            "host_cpu_oversubscribed": False,
                        }
                    )
    return rows


def test_gpu_host_thread_qualification_promotes_only_strict_winner() -> None:
    benchmark = load_benchmark_module()

    summary = benchmark.gpu_host_thread_policy_qualification_summary(
        _gpu_host_thread_qualification_rows()
    )

    assert summary["status"] == "pass"
    assert summary["resolved_default_threads"] == 4
    assert summary["decision"] == "promote-qualified-default"
    assert summary["expected_measured_row_count"] == 80
    assert summary["observed_measured_row_count"] == 80


def test_gpu_host_thread_qualification_retains_deliberate_default_one() -> None:
    benchmark = load_benchmark_module()
    rows = _gpu_host_thread_qualification_rows()
    for row in rows:
        if row["requested_cpu_thread_spec"] != "1":
            row["wall_time_ms"] = 99.0 + int(row["repeat_index"])

    summary = benchmark.gpu_host_thread_policy_qualification_summary(rows)

    assert summary["status"] == "pass"
    assert summary["resolved_default_threads"] == 1
    assert summary["decision"] == "retain-deliberate-default-one"


@pytest.mark.parametrize(
    "field,replacement",
    [
        ("runtime_manifest_sha256", "9" * 64),
        ("device_uuid", "GPU-mixed"),
        ("solver_mesh_signature", "8" * 64),
        ("reported_scenario", "box500_airbox_exchange_only"),
        ("executed_steps", 31),
        ("reported_relaxation_algorithm", "nonlinear_cg"),
        ("reported_precision", "single"),
        ("demag_relative_tolerance", 1e-10),
        ("hypre_execution_policy", "host"),
    ],
)
def test_gpu_host_thread_qualification_rejects_mixed_identity_or_workload(
    field: str,
    replacement: object,
) -> None:
    benchmark = load_benchmark_module()
    rows = _gpu_host_thread_qualification_rows()
    rows[-1][field] = replacement

    summary = benchmark.gpu_host_thread_policy_qualification_summary(rows)

    assert summary["status"] == "invalid"
    assert summary["resolved_default_threads"] == 1
    assert not any(candidate["qualifies"] for candidate in summary["candidates"])
    assert any(field in failure for failure in summary["failures"])


@pytest.mark.parametrize(
    "field,replacement",
    [
        ("integrator", "rk45"),
        ("reported_integrator", "rk45"),
        ("timestep_policy", "adaptive"),
        ("reported_timestep_policy", "adaptive"),
        ("dt_s", 9e-9),
        ("executed_problem_ir_sha256", "6" * 64),
    ],
)
def test_gpu_host_thread_qualification_rejects_task12_workload_mutation(
    field: str,
    replacement: object,
) -> None:
    benchmark = load_benchmark_module()
    rows = _gpu_host_thread_qualification_rows()
    rows[-1][field] = replacement

    summary = benchmark.gpu_host_thread_policy_qualification_summary(rows)

    assert summary["status"] == "invalid"
    assert summary["resolved_default_threads"] == 1
    assert summary["decision"] == (
        "qualification-invalid-retain-deliberate-default-one"
    )
    assert not any(candidate["qualifies"] for candidate in summary["candidates"])
    assert any(field in failure for failure in summary["failures"])


@pytest.mark.parametrize(
    "field",
    [
        "integrator",
        "reported_integrator",
        "timestep_policy",
        "reported_timestep_policy",
        "dt_s",
        "executed_problem_ir_sha256",
    ],
)
def test_gpu_host_thread_qualification_rejects_missing_task12_workload_identity(
    field: str,
) -> None:
    benchmark = load_benchmark_module()
    rows = _gpu_host_thread_qualification_rows()
    rows[-1].pop(field)

    summary = benchmark.gpu_host_thread_policy_qualification_summary(rows)

    assert summary["status"] == "invalid"
    assert summary["resolved_default_threads"] == 1
    assert summary["decision"] == (
        "qualification-invalid-retain-deliberate-default-one"
    )
    assert not any(candidate["qualifies"] for candidate in summary["candidates"])
    assert any(field in failure for failure in summary["failures"])


def test_gpu_host_thread_qualification_rejects_raw_cpu_use_increase() -> None:
    benchmark = load_benchmark_module()
    rows = _gpu_host_thread_qualification_rows()
    for row in rows:
        if row["requested_cpu_thread_spec"] == "4":
            row["host_cpu_time_ms"] = 250.0
            row["host_cpu_average_core_count"] = 2.5
            row["host_cpu_oversubscribed"] = False

    summary = benchmark.gpu_host_thread_policy_qualification_summary(rows)

    candidate = next(
        item for item in summary["candidates"] if item["threads"] == 4
    )
    assert candidate["qualifies"] is False
    assert any("host_cpu_time_ms p50" in failure for failure in candidate["failures"])
    assert any(
        "host_cpu_average_core_count p95" in failure
        for failure in candidate["failures"]
    )


@pytest.mark.parametrize(
    "field",
    [
        "cumulative_step_interval_wall_time_ms",
        "cumulative_native_solver_wall_time_ms",
        "cumulative_publisher_replace_wall_time_ms",
        "cumulative_publish_lag_wall_time_ms",
        "cumulative_artifact_enqueue_block_wall_time_ms",
        "artifact_queue_depth_max",
    ],
)
def test_gpu_host_thread_qualification_requires_exact_cumulative_telemetry(
    field: str,
) -> None:
    benchmark = load_benchmark_module()
    rows = _gpu_host_thread_qualification_rows()
    rows[0].pop(field)

    summary = benchmark.gpu_host_thread_policy_qualification_summary(rows)

    assert summary["status"] == "invalid"
    assert summary["resolved_default_threads"] == 1
    assert any(field in failure for failure in summary["failures"])


def test_gpu_host_thread_rows_do_not_fabricate_callback_gap_or_use_writer_proxy() -> None:
    benchmark = load_benchmark_module()
    source = inspect.getsource(benchmark.run_backend)

    assert "callback_gap_estimate_ms" not in source
    assert "artifact_writer_job_wall_time_ms" not in (
        benchmark.GPU_HOST_THREAD_QUALIFICATION_METRICS
    )


def test_gpu_host_thread_rows_convert_only_exact_cumulative_runtime_signals() -> None:
    benchmark = load_benchmark_module()

    evidence = benchmark.task12_exact_runtime_evidence(
        {
            "cumulative_step_interval_wall_time_ns": 11_000_000,
            "cumulative_native_solver_wall_time_ns": 7_000_000,
            "cumulative_publisher_replace_wall_time_ns": 300_000,
            "cumulative_publish_lag_wall_time_ns": 400_000,
            "cumulative_artifact_enqueue_block_wall_time_ns": 500_000,
            "artifact_queue_depth_max": 3,
        }
    )

    assert evidence == {
        "cumulative_step_interval_wall_time_ms": 11.0,
        "cumulative_native_solver_wall_time_ms": 7.0,
        "cumulative_publisher_replace_wall_time_ms": 0.3,
        "cumulative_publish_lag_wall_time_ms": 0.4,
        "cumulative_artifact_enqueue_block_wall_time_ms": 0.5,
        "artifact_queue_depth_max": 3,
    }


def test_gpu_host_thread_qualification_recipe_is_exact_managed_matrix() -> None:
    recipe = just_recipe_source(
        JUSTFILE.read_text(encoding="utf-8"),
        "verify-fem-gpu-host-thread-policy-qualification",
    )

    assert "just ensure-managed-fem-runtime" in recipe
    assert 'FULLMAG_BENCH_THREAD_COUNTS="1,2,4,8"' in recipe
    assert 'FULLMAG_BENCH_REPEAT="5"' in recipe
    assert recipe.count("--gpu-warmup") == 4
    assert recipe.count("--repeat \"$FULLMAG_BENCH_REPEAT\"") == 4
    assert recipe.count("--ui-surface headless") == 2
    assert recipe.count("--ui-surface interactive") == 2
    assert recipe.count("FULLMAG_FEM_STEP_PROFILE=0") == 2
    assert recipe.count("FULLMAG_FEM_STEP_PROFILE=1") == 2
    assert recipe.count("--gpu-host-thread-qualification-run") == 4
    assert "--gpu-host-thread-qualification-inputs" in recipe
    assert "--gpu-host-thread-qualification-output" in recipe


def test_best_demag_policy_uses_row_requested_rtol_by_default() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-6,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "status": "ok",
        "demag_actual_iterations": 10,
        "demag_final_residual_norm": 8e-7,
    }
    rows = [
        {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "AMG",
                "demag_linear_solver": "CG",
                "demag_preconditioner": "AMG",
                "demag_wall_time_ms": 20.0,
        },
        {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "JACOBI",
                "demag_linear_solver": "CG",
                "demag_preconditioner": "JACOBI",
                "demag_wall_time_ms": 10.0,
        },
    ]

    summaries = benchmark.best_demag_policy_rows(
        rows,
        max_residual=None,
        max_iterations=100,
    )

    assert len(summaries) == 1
    assert summaries[0]["demag_preconditioner"] == "JACOBI"
    assert summaries[0]["converged_policy_count"] == 2


def test_best_demag_policy_can_select_by_solver_apply_time() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "status": "ok",
        "demag_actual_iterations": 20,
        "demag_final_residual_norm": 8e-9,
    }
    rows = [
        {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "AMG",
                "demag_linear_solver": "CG",
                "demag_preconditioner": "AMG",
                "demag_wall_time_ms": 100.0,
            "demag_solver_apply_wall_time_ms": 20.0,
        },
        {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "JACOBI",
                "demag_linear_solver": "CG",
                "demag_preconditioner": "JACOBI",
                "demag_wall_time_ms": 50.0,
            "demag_solver_apply_wall_time_ms": 30.0,
        },
    ]

    summaries = benchmark.best_demag_policy_rows(
        rows,
        max_residual=None,
        max_iterations=100,
        selection_metric="demag_solver_apply_wall_time_ms",
    )

    assert len(summaries) == 1
    assert summaries[0]["selection_timing_field"] == "demag_solver_apply_wall_time_ms"
    assert summaries[0]["demag_preconditioner"] == "AMG"


def test_best_demag_policy_rejects_unstable_solver_mesh() -> None:
    benchmark = load_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "status": "ok",
        "demag_actual_iterations": 20,
        "demag_final_residual_norm": 8e-9,
    }
    rows = [
        {
            **base_row,
            "solver_mesh_signature": "mesh-a",
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "AMG",
            "demag_solver_apply_wall_time_ms": 20.0,
        },
        {
            **base_row,
            "solver_mesh_signature": "mesh-b",
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "JACOBI",
            "demag_solver_apply_wall_time_ms": 10.0,
        },
    ]

    summaries = benchmark.best_demag_policy_rows(
        rows,
        max_residual=None,
        max_iterations=100,
        selection_metric="demag_solver_apply_wall_time_ms",
    )
    failures = benchmark.best_demag_policy_failures(
        rows,
        max_residual=None,
        max_iterations=100,
        selection_metric="demag_solver_apply_wall_time_ms",
    )

    assert summaries == []
    assert len(failures) == 1
    assert "cannot select a best demag policy" in failures[0]
    assert "2 solver_mesh_signature values" in failures[0]


def test_benchmark_report_renders_best_demag_policy_table() -> None:
    benchmark = load_benchmark_module()

    report = benchmark.render_cpu_gpu_benchmark_report(
        {
            "status": "pass",
            "row_count": 2,
            "ok_count": 2,
            "failed_count": 0,
            "failure_count": 0,
            "case_coverage": [],
            "pairs": [],
            "completed_pair_case_count": 0,
            "required_case_count": 0,
            "best_demag_policy": [
                {
                    "case_key": ["fem_gpu", "mesh.json"],
                    "demag_solver": "CG",
                    "demag_preconditioner": "JACOBI",
                    "solver_mesh_signature": "mesh-a",
                    "average_demag_solver_apply_wall_time_ms": 3.5,
                    "average_demag_wall_time_ms": 5.0,
                    "max_demag_final_residual_norm": 8e-9,
                    "max_demag_actual_iterations": 70,
                }
            ],
        },
        {
            "status": "pass",
            "gate_failure_count": 0,
            "group_failure_count": 0,
            "solver_mesh_groups": [],
            "failures": [],
        },
    )

    assert "## Best Demag Policy" in report
    assert "CG/JACOBI" in report
    assert "mesh-a" in report


def test_generated_domain_mesh_env_reuses_persistent_cache(
    monkeypatch,
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()
    calls: list[Path] = []

    def fake_export_generated_domain_mesh(**kwargs):
        output_path = kwargs["output_path"]
        calls.append(output_path)
        output_path.write_text('{"mesh": true}\n', encoding="utf-8")
        return output_path

    monkeypatch.setattr(
        benchmark,
        "export_generated_domain_mesh",
        fake_export_generated_domain_mesh,
    )
    thread_spec = benchmark.ThreadCountSpec(label="auto", env_value="auto")
    common = {
        "cache_dir": tmp_path,
        "mesh_path": Path("mesh.json"),
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "steps": 2,
        "dt": 1e-13,
        "timestep_policy": "fixed",
        "thread_spec": thread_spec,
        "extra_env": {
            "FULLMAG_BENCH_DOMAIN_HMAX": "50e-9",
            "FULLMAG_BENCH_AIRBOX_HMAX": "100e-9",
        },
        "timeout_s": 10.0,
    }

    first = benchmark.generated_domain_mesh_env(cache={}, **common)
    second = benchmark.generated_domain_mesh_env(cache={}, **common)

    assert first == second
    assert Path(first["FULLMAG_BENCH_DOMAIN_MESH"]).is_file()
    assert len(calls) == 1


def test_generated_domain_mesh_env_preserves_explicit_domain_mesh(monkeypatch) -> None:
    benchmark = load_benchmark_module()

    def unexpected_export(**_kwargs):
        raise AssertionError("explicit domain mesh must not be regenerated")

    monkeypatch.setattr(
        benchmark,
        "export_generated_domain_mesh",
        unexpected_export,
    )

    result = benchmark.generated_domain_mesh_env(
        cache={},
        cache_dir=None,
        mesh_path=Path("input.mesh.json"),
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
        steps=64,
        dt=1e-13,
        timestep_policy="fixed",
        thread_spec=benchmark.ThreadCountSpec(label="auto", env_value="auto"),
        extra_env={"FULLMAG_BENCH_DOMAIN_MESH": "qualified-domain.mesh.json"},
        timeout_s=10.0,
    )

    assert result == {"FULLMAG_BENCH_DOMAIN_MESH": "qualified-domain.mesh.json"}


def test_generated_domain_mesh_env_materializes_box500_airbox_alias(
    monkeypatch,
    tmp_path: Path,
) -> None:
    benchmark = load_benchmark_module()

    def fake_export_generated_domain_mesh(**kwargs):
        output_path = kwargs["output_path"]
        output_path.write_text('{"mesh": true}\n', encoding="utf-8")
        return output_path

    monkeypatch.setattr(
        benchmark,
        "export_generated_domain_mesh",
        fake_export_generated_domain_mesh,
    )
    result = benchmark.generated_domain_mesh_env(
        cache={},
        cache_dir=tmp_path,
        mesh_path=Path("mesh.json"),
        scenario="box500_airbox_exchange_zeeman",
        integrator="heun",
        steps=2,
        dt=1e-13,
        timestep_policy="fixed",
        thread_spec=benchmark.ThreadCountSpec(label="auto", env_value="auto"),
        extra_env={},
        timeout_s=10.0,
    )

    assert Path(result["FULLMAG_BENCH_DOMAIN_MESH"]).is_file()


def test_benchmark_mesh_env_forwards_requested_generated_mesh_sizes(monkeypatch) -> None:
    benchmark = load_benchmark_module()
    monkeypatch.setenv("FULLMAG_BENCH_DOMAIN_HMAX", "20e-9")
    monkeypatch.setenv("FULLMAG_BENCH_AIRBOX_HMAX", "100e-9")
    monkeypatch.setenv("FULLMAG_BENCH_DOMAIN_MESH", "/workspace/exact.mesh.json")

    env = benchmark.benchmark_mesh_env(
        SimpleNamespace(
            gmsh_threads=None,
            require_stable_solver_mesh=True,
            require_cpu_gpu_consistency=True,
        )
    )

    assert env["FULLMAG_BENCH_DOMAIN_HMAX"] == "20e-9"
    assert env["FULLMAG_BENCH_AIRBOX_HMAX"] == "100e-9"
    assert env["FULLMAG_BENCH_DOMAIN_MESH"] == "/workspace/exact.mesh.json"
    assert env["FULLMAG_GMSH_THREADS"] == "1"


def test_benchmark_backend_runs_use_isolated_output_directory() -> None:
    source = BENCHMARK.read_text(encoding="utf-8")

    assert 'TemporaryDirectory(prefix=f"fullmag_{backend_label.lower()}_bench_")' in source
    assert '"--output-dir",' in source
    assert "str(run_dir)" in source


def test_box500_relaxation_uses_mesh_independent_nonuniform_initial_state() -> None:
    benchmark = load_benchmark_case_module()

    initial = benchmark.scenario_initial_magnetization(
        benchmark.BOX500_AIRBOX_SCENARIO
    ).to_ir()

    assert initial["kind"] == "preset_texture"
    assert initial["preset_kind"] == "helical"
    assert initial["preset_params"]["wavevector"][0] > 0.0


def test_box500_exchange_calibration_omits_airbox_but_demag_keeps_it() -> None:
    benchmark = load_benchmark_case_module()

    assert not benchmark.scenario_requires_shared_domain(
        benchmark.BOX500_EXCHANGE_SCENARIO
    )
    assert benchmark.scenario_requires_shared_domain("box500_airbox_exchange_demag")


def test_adaptive_benchmark_declares_executable_timestep_bounds() -> None:
    source = BENCHMARK_CASE.read_text(encoding="utf-8")

    assert "dt_min=dt * 1e-3" in source
    assert "dt_max=dt" in source


def test_performance_regression_case_key_normalizes_csv_values() -> None:
    benchmark = load_benchmark_module()
    baseline_row = {
        "solver_mesh_signature": "mesh-a",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "projected_gradient_bb",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": "1e-08",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "requested_demag_amg_relax_type": "18",
        "requested_demag_amg_coarsening": "8",
        "requested_demag_amg_interpolation": "6",
        "requested_demag_amg_aggressive_coarsening": "1",
        "requested_demag_amg_strength_threshold": "",
        "requested_demag_amg_max_levels": "",
        "status": "ok",
        "wall_time_ms": "10.0",
    }
    current_row = {
        **baseline_row,
        "requested_demag_relative_tolerance": 1e-8,
        "requested_demag_absolute_tolerance": None,
        "requested_demag_max_iterations": 500,
        "requested_demag_print_level": 0,
        "requested_demag_amg_relax_type": 18,
        "requested_demag_amg_coarsening": 8,
        "requested_demag_amg_interpolation": 6,
        "requested_demag_amg_aggressive_coarsening": 1,
        "requested_demag_amg_strength_threshold": None,
        "requested_demag_amg_max_levels": None,
        "wall_time_ms": 9.0,
    }

    assert benchmark.performance_regression_case_key(current_row) == (
        benchmark.performance_regression_case_key(baseline_row)
    )
    assert benchmark.comparable_baseline_case_count(
        [current_row],
        [baseline_row],
    ) == 1


def test_performance_regression_case_key_treats_legacy_blank_preconditioner_as_none() -> None:
    benchmark = load_benchmark_module()
    legacy_row = {
        "solver_mesh_signature": "mesh-a",
        "backend": "fem_gpu",
        "mesh_path": "mesh.json",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "relaxation_algorithm": "nonlinear_cg",
        "requested_relaxation_preconditioner_strategy": "",
        "timestep_policy": "fixed",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": "1e-08",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "requested_demag_amg_relax_type": "18",
        "requested_demag_amg_coarsening": "8",
        "requested_demag_amg_interpolation": "6",
        "requested_demag_amg_aggressive_coarsening": "1",
        "requested_demag_amg_strength_threshold": "",
        "requested_demag_amg_max_levels": "",
    }
    current_row = {
        **legacy_row,
        "requested_relaxation_preconditioner_strategy": "none",
    }

    assert benchmark.performance_regression_case_key(current_row) == (
        benchmark.performance_regression_case_key(legacy_row)
    )


def test_pass_fail_summary_uses_row_requested_rtol_by_default() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-6,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        }
    ]

    summary = benchmark.benchmark_pass_fail_summary(
        rows,
        gate_failures=[],
        max_residual=None,
        max_iterations=100,
    )

    assert summary["status"] == "pass"
    assert summary["solver_mesh_groups"][0]["status"] == "pass"
    assert summary["failures"] == []


def test_pass_fail_summary_includes_gate_and_group_failure_reasons() -> None:
    benchmark = load_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "status": "ok",
            "requested_demag_relative_tolerance": 1e-8,
            "demag_final_residual_norm": 8e-7,
            "demag_actual_iterations": 12,
        }
    ]

    summary = benchmark.benchmark_pass_fail_summary(
        rows,
        gate_failures=["case=mesh-a demag_solver_setup_reused is not true"],
        max_residual=None,
        max_iterations=100,
    )

    assert summary["status"] == "fail"
    assert summary["gate_failure_count"] == 1
    assert summary["group_failure_count"] == 1
    assert "demag_solver_setup_reused is not true" in summary["failures"][0]
    assert "solver_mesh_signature=mesh-a failed 1 benchmark checks" in summary["failures"][1]


def test_stt_oersted_consistency_cases_exclude_all_relaxation_algorithms() -> None:
    benchmark = load_benchmark_module()
    algorithms = [
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
        "tangent_plane_implicit",
    ]
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_stt_oersted"],
        relaxation_algorithms=algorithms,
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )

    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_stt_oersted", algorithms
    ) == []
    assert manifests == []


def test_direct_minimizer_consistency_is_coverage_only_not_a_pass() -> None:
    benchmark = load_benchmark_module()
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_demag"],
        relaxation_algorithms=["nonlinear_cg"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    base_row = {
        "scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "relaxation_algorithm": "nonlinear_cg",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1.0e-13,
        "steps": 32,
        "status": "ok",
        "solver_mesh_signature": "mesh-a",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "uses_cuda_kernels": False,
        "executed_steps": 32,
        "final_e_total_j": -1.0e-17,
        "final_e_ex_j": 1.0e-22,
        "final_e_demag_j": 2.0e-19,
        "final_e_ext_j": -1.02e-17,
        "final_torque_apm": 2.0e4,
        "final_torque_t": 2.5e-2,
    }
    gpu_row = {
        **base_row,
        "backend": "fem_gpu",
        "execution_engine": "fem_native_gpu",
        "fem_execution_mode": "all_in_gpu_legacy_sparse",
        "mfem_device": "cuda",
        "uses_cuda_kernels": True,
        "executed_steps": 24,
        "final_e_total_j": -9.5e-18,
        "final_e_ex_j": 1.4e-22,
        "final_e_demag_j": 2.4e-19,
        "final_e_ext_j": -9.74e-18,
        "final_torque_apm": 1.0e3,
        "final_torque_t": 1.25e-3,
    }
    cpu_row = {**base_row, "backend": "fem_cpu"}

    failures = benchmark.cpu_gpu_consistency_failures(
        [cpu_row, gpu_row],
        case_manifests=manifests,
        require_gpu_strict_residency=False,
    )

    assert failures == []
    summary = benchmark.cpu_gpu_consistency_summary(
        [cpu_row, gpu_row],
        case_manifests=manifests,
        require_gpu_strict_residency=False,
    )
    assert summary["status"] == "coverage_only"
    assert summary["consistency_status"] == "coverage_only"
    assert summary["consistency_scope"] == "direct_minimizer_coverage"
    assert summary["consistency_failure_count"] == 0
    assert summary["equilibrium_parity_status"] == "not_requested"
    report = benchmark.render_cpu_gpu_benchmark_report(
        summary,
        {"status": "pass", "gate_failure_count": 0, "group_failure_count": 0, "failures": []},
    )
    assert "- status: coverage_only" in report
    assert "CPU/GPU consistency: pass" not in report
    assert "execution coverage: coverage_only" in report
    assert "equilibrium parity: not_requested" in report
    assert "| box500_airbox_exchange_demag:nonlinear_cg | coverage_only |" in report


def test_direct_minimizer_equilibrium_parity_gate_fails_closed() -> None:
    benchmark = load_benchmark_module()
    common = {
        "scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "relaxation_algorithm": "nonlinear_cg",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1.0e-13,
        "steps": 32,
        "status": "ok",
        "solver_mesh_signature": "mesh-a",
        "executed_steps": 32,
        "final_e_total_j": -1.0e-17,
        "final_e_ex_j": 1.0e-22,
        "final_e_demag_j": 2.0e-19,
        "final_e_ext_j": -1.02e-17,
        "final_torque_apm": 2.0e4,
        "final_torque_t": 2.5e-2,
    }
    cpu = {
        **common,
        "backend": "fem_cpu",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "uses_cuda_kernels": False,
    }
    gpu = {
        **common,
        "backend": "fem_gpu",
        "execution_engine": "fem_native_gpu",
        "fem_execution_mode": "all_in_gpu_legacy_sparse",
        "mfem_device": "cuda",
        "uses_cuda_kernels": True,
    }
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_demag"],
        relaxation_algorithms=["nonlinear_cg"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    summary = benchmark.cpu_gpu_consistency_summary(
        [cpu, gpu],
        case_manifests=manifests,
        require_equilibrium_parity=True,
    )
    assert summary["status"] == "failed"
    assert summary["equilibrium_parity_status"] == "not_requested"
    assert any(
        failure == "direct minimizer equilibrium parity was not checked"
        for failure in summary["failures"]
    )

    args = benchmark.parse_args(
        ["--require-equilibrium-parity", "--capture-final-magnetization"]
    )
    assert args.require_equilibrium_parity is True


def test_llg_consistency_still_rejects_numeric_mismatch() -> None:
    benchmark = load_benchmark_module()
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_demag"],
        relaxation_algorithms=["llg_overdamped"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    cpu_row = {
        "backend": "fem_cpu",
        "scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "llg_overdamped",
        "relaxation_algorithm": "llg_overdamped",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1.0e-13,
        "steps": 32,
        "status": "ok",
        "solver_mesh_signature": "mesh-a",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "uses_cuda_kernels": False,
        "executed_steps": 32,
        "final_e_total_j": -1.0e-17,
        "final_e_ex_j": 1.0e-22,
        "final_e_demag_j": 2.0e-19,
        "final_e_ext_j": -1.02e-17,
        "final_torque_apm": 2.0e4,
        "final_torque_t": 2.5e-2,
    }
    gpu_row = {
        **cpu_row,
        "backend": "fem_gpu",
        "execution_engine": "fem_native_gpu",
        "fem_execution_mode": "all_in_gpu_legacy_sparse",
        "mfem_device": "cuda",
        "uses_cuda_kernels": True,
        "final_torque_apm": 1.0e3,
        "final_torque_t": 1.25e-3,
    }

    failures = benchmark.cpu_gpu_consistency_failures(
        [cpu_row, gpu_row],
        case_manifests=manifests,
        require_gpu_strict_residency=False,
    )

    assert any("final_torque_apm mismatch" in failure for failure in failures)


def test_stt_oersted_has_no_relaxation_consistency_manifest() -> None:
    benchmark = load_benchmark_module()
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_stt_oersted"],
        relaxation_algorithms=["llg_overdamped"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    assert manifests == []


def test_cpu_gpu_consistency_preflight_reports_unavailable_native_fem_gpu() -> None:
    benchmark = load_benchmark_module()
    with tempfile.TemporaryDirectory() as temp_dir:
        fake_runtime = Path(temp_dir) / "fullmag-fem-gpu"
        fake_runtime.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2 $3" = "runtime fem-availability --json" ]; then
  cat <<'JSON'
{
  "native_fem_cpu_available": true,
  "native_fem_gpu_available": false,
  "visible_cuda_device_count": 0,
  "reason_gpu": "cudaGetDeviceCount failed for fullmag_fem: CUDA driver version is insufficient for CUDA runtime version"
}
JSON
  exit 0
fi
exit 64
""",
            encoding="utf-8",
        )
        fake_runtime.chmod(0o755)

        failure = benchmark.runtime_gpu_availability_failure(fake_runtime)

    assert failure is not None
    assert "native FEM GPU backend is unavailable" in failure
    assert "cudaGetDeviceCount failed" in failure


def test_runtime_gate_can_preserve_logs_for_audit() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        fake_bin = temp_path / "bin"
        fake_bin.mkdir()
        audit_tmp = temp_path / "tmp"
        audit_tmp.mkdir()
        fake_just = fake_bin / "just"
        fake_python = fake_bin / "python3"
        fake_just.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "ensure-managed-fem-runtime" ]; then
  echo "[fake-just] managed runtime fresh"
  exit 0
fi
if [ "${1:-}" = "verify-fem-relaxation-source-contract" ]; then
  echo "[fake-just] source contract passed"
  exit 0
fi
echo "[fake-just] runtime smoke $*"
""",
            encoding="utf-8",
        )
        fake_python.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
exit 0
""",
            encoding="utf-8",
        )
        fake_just.chmod(0o755)
        fake_python.chmod(0o755)
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{fake_bin}:{env['PATH']}",
                "TMPDIR": str(audit_tmp),
                "FULLMAG_FEM_RELAXATION_KEEP_LOGS": "1",
                "FULLMAG_FEM_RELAXATION_ALGORITHMS": "llg_overdamped",
                "FULLMAG_FEM_RELAXATION_ENGINES": "gpu",
            }
        )
        result = subprocess.run(
            ["bash", str(VERIFY_RUNTIME)],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        marker = "[verify_fem_relaxation_runtime] preserving runtime logs: "
        assert marker in result.stdout
        log_dir_text = result.stdout.split(marker, 1)[1].splitlines()[0]
        preserved_log_dir = Path(log_dir_text)
        assert preserved_log_dir.exists()
        assert (preserved_log_dir / "gpu_llg_overdamped.log").exists()


def test_gpu_ncg_control_readback_budget_matches_cumulative_armijo_sync_structure() -> None:
    benchmark = load_benchmark_module()
    row = {
        "backend": "fem_gpu",
        "status": "ok",
        "scenario": "box500_airbox_exchange_demag_anis_uniaxial",
        "relaxation_algorithm": "nonlinear_cg",
        "executed_steps": 64,
        "total_rhs_evals": 128,
        "rejected_attempts": 0,
        "hot_loop_control_scalar_host_sync_count": 195,
    }
    common = {
        "base": 3,
        "per_step": 3,
        "llg_per_step": 0,
        "pgbb_per_step": 4,
        "per_rejected_attempt": 2,
    }

    assert benchmark.DEFAULT_GPU_NCG_CONTROL_READBACK_PER_STEP == 3
    assert benchmark.gpu_control_readback_budget_failures(
        [row], ncg_per_step=3, **common
    ) == []
    assert benchmark.gpu_control_readback_budget_failures(
        [{**row, "hot_loop_control_scalar_host_sync_count": 196}],
        ncg_per_step=3,
        **common,
    )
    extra_trial_row = {
        **row,
        "total_rhs_evals": 129,
        "rejected_attempts": 1,
        "hot_loop_control_scalar_host_sync_count": 196,
    }
    assert benchmark.gpu_control_readback_budget_failures(
        [extra_trial_row], ncg_per_step=3, **common
    ) == []
    assert benchmark.gpu_control_readback_budget_failures(
        [{**extra_trial_row, "hot_loop_control_scalar_host_sync_count": 197}],
        ncg_per_step=3,
        **common,
    )

    # One step exhausts 31 normal trials at the 30-backtrack boundary, then
    # accepts its first forced-restart recovery trial. That recovery trial is
    # an additional logical RHS record even though it is not another backtrack.
    forced_recovery_row = {
        **row,
        "total_rhs_evals": 159,
        "rejected_attempts": 30,
        "hot_loop_control_scalar_host_sync_count": 226,
    }
    assert benchmark.gpu_control_readback_budget_failures(
        [forced_recovery_row], ncg_per_step=3, **common
    ) == []
    assert benchmark.gpu_control_readback_budget_failures(
        [{**forced_recovery_row, "hot_loop_control_scalar_host_sync_count": 227}],
        ncg_per_step=3,
        **common,
    )


def test_fem_gpu_performance_regression_recipe_enforces_ncg_control_budget() -> None:
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe_start = justfile.index("verify-fem-gpu-performance-regression:")
    recipe_end = justfile.index(
        "\ncapture-fem-gpu-pre-remediation-performance-baseline:", recipe_start
    )
    recipe = justfile[recipe_start:recipe_end]

    assert (
        'FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP:-3}"'
        in recipe
    )
    assert 'FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}"' in recipe
    assert '--repeat "$FULLMAG_BENCH_REPEAT"' in recipe
    assert "--require-gpu-control-readback-budget" in recipe
    assert (
        '--gpu-ncg-control-readback-per-step "$FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP"'
        in recipe
    )


def test_gpu_pgbb_control_readback_budget_matches_cumulative_armijo_sync_structure() -> None:
    benchmark = load_benchmark_module()
    row = {
        "backend": "fem_gpu",
        "status": "ok",
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "projected_gradient_bb",
        "executed_steps": 64,
        "total_rhs_evals": 128,
        "rejected_attempts": 0,
        "hot_loop_control_scalar_host_sync_count": 259,
    }
    common = {
        "base": 3,
        "per_step": 4,
        "llg_per_step": 0,
        "ncg_per_step": 3,
        "per_rejected_attempt": 2,
    }

    assert benchmark.DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP == 4
    assert benchmark.expected_control_sync_budget(
        "projected_gradient_bb", 64, 128, 3
    ) == 259
    assert benchmark.gpu_control_readback_budget_failures(
        [row], pgbb_per_step=4, **common
    ) == []
    assert benchmark.gpu_control_readback_budget_failures(
        [{**row, "hot_loop_control_scalar_host_sync_count": 260}],
        pgbb_per_step=4,
        **common,
    )

    extra_trial_row = {
        **row,
        "total_rhs_evals": 129,
        "rejected_attempts": 1,
        "hot_loop_control_scalar_host_sync_count": 260,
    }
    assert benchmark.expected_control_sync_budget(
        "projected_gradient_bb", 64, 129, 3
    ) == 260
    assert benchmark.gpu_control_readback_budget_failures(
        [extra_trial_row], pgbb_per_step=4, **common
    ) == []
    assert benchmark.gpu_control_readback_budget_failures(
        [{**extra_trial_row, "hot_loop_control_scalar_host_sync_count": 261}],
        pgbb_per_step=4,
        **common,
    )

    source = (REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py").read_text(
        encoding="utf-8"
    )
    helper_start = source.index("def expected_control_sync_budget(")
    helper_end = source.index("\ndef ", helper_start + 1)
    helper_source = source[helper_start:helper_end]
    assert "total_rhs_evals - 2 * executed_steps" in helper_source
    assert source.count("total_rhs_evals - 2 * executed_steps") == 1
    assert "additional_attempt_budget *= 3" not in source


def test_fem_relaxation_production_recipe_enforces_pgbb_control_budget_and_repeat() -> None:
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe_start = justfile.index("verify-fem-relaxation-production-benchmark:")
    recipe_end = justfile.index("\nverify-fem-", recipe_start + 1)
    recipe = justfile[recipe_start:recipe_end]

    assert (
        'FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP:-4}"'
        in recipe
    )
    assert 'FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}"' in recipe
    assert '--repeat "$FULLMAG_BENCH_REPEAT"' in recipe
    assert "--require-gpu-control-readback-budget" in recipe
    assert (
        '--gpu-pgbb-control-readback-per-step "$FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP"'
        in recipe
    )


def test_direct_minimizer_control_readback_budgets_are_immutable() -> None:
    benchmark = load_benchmark_module()

    with pytest.raises(
        benchmark.argparse.ArgumentTypeError,
        match="PG-BB control-readback budget must be 4",
    ):
        benchmark.canonical_pgbb_control_readback_per_step_arg("5")
    with pytest.raises(
        benchmark.argparse.ArgumentTypeError,
        match="NCG control-readback budget must be 3",
    ):
        benchmark.canonical_ncg_control_readback_per_step_arg("2")
    with pytest.raises(SystemExit):
        benchmark.parse_args(["--gpu-pgbb-control-readback-per-step", "5"])
    with pytest.raises(SystemExit):
        benchmark.parse_args(["--gpu-ncg-control-readback-per-step", "2"])

    row = {
        "backend": "fem_gpu",
        "status": "ok",
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "projected_gradient_bb",
        "executed_steps": 2,
        "total_rhs_evals": 3,
        "rejected_attempts": 0,
        "hot_loop_control_scalar_host_sync_count": 12,
    }
    with pytest.raises(ValueError, match="PG-BB control-readback budget must be 4"):
        benchmark.gpu_control_readback_budget_failures(
            [row],
            base=3,
            per_step=4,
            llg_per_step=0,
            pgbb_per_step=5,
            ncg_per_step=3,
            per_rejected_attempt=2,
        )
    failures = benchmark.gpu_control_readback_budget_failures(
        [row],
        base=3,
        per_step=4,
        llg_per_step=0,
        pgbb_per_step=4,
        ncg_per_step=3,
        per_rejected_attempt=2,
    )
    assert len(failures) == 1
    assert "additional_attempt_budget=0" in failures[0]


def test_direct_minimizer_benchmark_uses_qualified_demag_tolerance() -> None:
    benchmark = load_benchmark_module()
    for algorithm in (
        "projected_gradient_bb",
        "nonlinear_cg",
        "tangent_plane_implicit",
    ):
        assert benchmark.qualified_demag_rtol_for_relaxation_algorithm(
            algorithm, 1.0e-8
        ) == 1.0e-12
        assert benchmark.qualified_demag_rtol_for_relaxation_algorithm(
            algorithm, 1.0e-13
        ) == 1.0e-13
    assert benchmark.qualified_demag_rtol_for_relaxation_algorithm(
        "llg_overdamped", 1.0e-8
    ) == 1.0e-8


def test_fem_pgbb_demag_is_included_in_current_production_manifest() -> None:
    benchmark = load_benchmark_module()
    algorithms = ["llg_overdamped", "projected_gradient_bb", "nonlinear_cg"]
    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_exchange_demag", algorithms
    ) == algorithms
    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_exchange_zeeman", algorithms
    ) == algorithms


def main() -> int:
    failures = 0
    for test in [
        test_accepts_completed_native_gpu_log,
        test_accepts_completed_native_cpu_log,
        test_accepts_completed_native_cpu_tpi_log,
        test_rejects_failed_status,
        test_rejects_cpu_fallback,
        test_rejects_direct_minimizer_without_production_gpu_status,
        test_rejects_direct_minimizer_energy_increase,
        test_rejects_llg_overdamped_energy_increase,
        test_rejects_relaxation_without_meaningful_energy_decrease,
        test_stricter_convergence_threshold_rejects_weak_energy_decrease,
        test_rejects_relaxation_with_large_final_torque_growth,
        test_rejects_scalars_with_noncontiguous_step_sequence,
        test_accepts_runtime_with_more_scalar_rows_than_minimum,
        test_rejects_summary_final_energy_that_disagrees_with_scalars,
        test_rejects_native_cpu_log_without_relaxation_qualification,
        test_rejects_cpu_llg_without_algorithm_policy,
        test_rejects_gpu_direct_minimizer_without_relaxation_qualification,
        test_rejects_gpu_llg_without_relaxation_qualification,
        test_rejects_gpu_direct_minimizer_without_gradient_policy,
        test_rejects_gpu_qualification_that_disagrees_with_provenance,
        test_rejects_cpu_projected_gradient_bb_with_nonlinear_cg_line_search,
        test_rejects_cpu_projected_gradient_bb_without_step_update_policy,
        test_rejects_cpu_nonlinear_cg_without_direction_update_policy,
        test_rejects_cpu_relaxation_with_large_magnetization_norm_defect,
        test_rejects_gpu_relaxation_without_magnetization_norm_defect,
        test_runtime_gate_and_physics_note_promote_cpu_tpi_without_gpu_claim,
        test_cpu_gpu_consistency_smoke_covers_active_relaxation_algorithms,
        test_cpu_gpu_consistency_coverage_is_per_relaxation_algorithm,
        test_stt_oersted_consistency_cases_exclude_all_relaxation_algorithms,
        test_direct_minimizer_consistency_is_coverage_only_not_a_pass,
        test_direct_minimizer_equilibrium_parity_gate_fails_closed,
        test_llg_consistency_still_rejects_numeric_mismatch,
        test_stt_oersted_has_no_relaxation_consistency_manifest,
        test_run_json_summary_publishes_cumulative_rhs_telemetry,
        test_benchmark_parses_run_json_cumulative_rhs_telemetry,
        test_gpu_ncg_control_readback_budget_matches_cumulative_armijo_sync_structure,
        test_fem_gpu_performance_regression_recipe_enforces_ncg_control_budget,
        test_gpu_pgbb_control_readback_budget_matches_cumulative_armijo_sync_structure,
        test_fem_relaxation_production_recipe_enforces_pgbb_control_budget_and_repeat,
        test_direct_minimizer_control_readback_budgets_are_immutable,
        test_direct_minimizer_benchmark_uses_qualified_demag_tolerance,
        test_fem_pgbb_demag_is_included_in_current_production_manifest,
        test_cpu_gpu_consistency_preflight_reports_unavailable_native_fem_gpu,
        test_runtime_gate_can_preserve_logs_for_audit,
    ]:
        try:
            test()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
        else:
            print(f"ok {test.__name__}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
