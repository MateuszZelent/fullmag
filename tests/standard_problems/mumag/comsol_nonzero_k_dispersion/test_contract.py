"""Contract tests for the COMSOL-aligned public benchmark workflow."""

from __future__ import annotations

import csv
import json
import math
import os
from pathlib import Path
import sys

import pytest


REPO_ROOT = Path(__file__).resolve().parents[4]
PYTHON_PACKAGE = REPO_ROOT / "packages" / "fullmag-py" / "src"
if str(PYTHON_PACKAGE) not in sys.path:
    sys.path.insert(0, str(PYTHON_PACKAGE))

import fullmag as fm
from tests.standard_problems.mumag.comsol_nonzero_k_dispersion.materialize_real_asset import (
    _assess_benchmark_mesh,
)

from tests.standard_problems.mumag.comsol_nonzero_k_dispersion.config import (
    A_LAT_M,
    AEX_J_PER_M,
    AIRBOX_GROWTH_RATE,
    AIRBOX_HMAX_M,
    BIAS_FIELD_A_PER_M_VECTOR,
    BIAS_FIELD_T,
    COMSOL_A_FIELD_A_M,
    CONTROL_LABELS,
    C0_MODE_COUNT,
    FREQUENCY_WINDOW_HZ,
    GAMMA_M_PER_A_S,
    HOLE_RADIUS_M,
    INITIAL_SHIFT_HZ,
    INTERFACE_HMAX_M,
    INTERFACE_THICKNESS_M,
    INTERFACE_TRANSITION_DISTANCE_M,
    KPATH_SAMPLES_PER_SEGMENT,
    MODE_FIELD_SAMPLE_INDICES,
    MODE_COUNT,
    MS_A_PER_M,
    RELAX_ALPHA,
    RELAX_DT_S,
    RELAX_MAX_STEPS,
    RELAX_TORQUE_TOLERANCE_A_PER_M,
    TARGET_BANDS,
    THIN_FILM_LAYERS,
    THIN_FILM_ORDER,
    UNIVERSE_SIZE_M,
)


SCRIPT = Path(__file__).with_name("problem.py")
KPATH_CSV = REPO_ROOT / "docs" / "guides" / "comsol-dispersion-benchmark" / "kpath.csv"
PARAMETERS_JSON = REPO_ROOT / "docs" / "guides" / "comsol-dispersion-benchmark" / "parameters.json"


def _load_case(case: str):
    previous = os.environ.get("FULLMAG_COMSOL_DISPERSION_CASE")
    previous_all_fields = os.environ.get("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS")
    os.environ["FULLMAG_COMSOL_DISPERSION_CASE"] = case
    os.environ.pop("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS", None)
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(SCRIPT, lightweight_assets=True)
        stages = tuple(
            stage.problem.to_ir(
                requested_backend="fem",
                execution_mode="strict",
                execution_precision="double",
                include_geometry_assets=False,
            )
            for stage in loaded.stages
        )
        assert len(stages) == 2
        return stages
    finally:
        if previous is None:
            os.environ.pop("FULLMAG_COMSOL_DISPERSION_CASE", None)
        else:
            os.environ["FULLMAG_COMSOL_DISPERSION_CASE"] = previous
        if previous_all_fields is None:
            os.environ.pop("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS", None)
        else:
            os.environ["FULLMAG_COMSOL_DISPERSION_ALL_FIELDS"] = previous_all_fields
        fm.reset()


def _benchmark_metadata(eigen_ir: dict[str, object]) -> dict[str, object]:
    metadata = eigen_ir["problem_meta"]["runtime_metadata"]
    return metadata["comsol_nonzero_k_dispersion"]


def _mesh_metadata(eigen_ir: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    workflow = eigen_ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]
    per_geometry = workflow["per_geometry"]
    assert len(per_geometry) == 1
    return workflow, per_geometry[0]


def test_configuration_matches_the_published_comsol_parameter_sheet() -> None:
    parameters = json.loads(PARAMETERS_JSON.read_text(encoding="utf-8"))

    assert parameters["benchmark_id"] == "comsol-py-antidot-square-v1"
    assert parameters["status"] == "proposed_not_executed"
    assert parameters["time_convention"] == "exp(+i*omega*t)"
    assert parameters["full_field_bloch_convention"] == "exp(-i*k_dot_r)"
    assert parameters["potential_unknown"] == "periodic_envelope_psi"

    geometry = parameters["geometry"]
    assert geometry["period_x_m"] == A_LAT_M
    assert geometry["period_y_m"] == A_LAT_M
    assert geometry["film_thickness_m"] == pytest.approx(10.0e-9)
    assert geometry["hole_radius_m"] == HOLE_RADIUS_M
    assert geometry["air_padding_each_side_m"] == pytest.approx(2.0e-6)
    assert geometry["potential_top_bottom_bc"] == "dirichlet_zero"
    assert geometry["magnetic_volume_m3"] == pytest.approx(
        (A_LAT_M * A_LAT_M - math.pi * HOLE_RADIUS_M * HOLE_RADIUS_M) * 10.0e-9
    )

    material = parameters["material"]
    assert material["Ms_A_per_m"] == MS_A_PER_M
    assert material["Aex_J_per_m"] == AEX_J_PER_M
    assert material["mu0_H_per_m"] == pytest.approx(4.0e-7 * math.pi)
    assert material["gamma0_m_per_A_s"] == GAMMA_M_PER_A_S
    assert material["alpha_eigen"] == 0
    assert material["alpha_relax"] == RELAX_ALPHA
    assert parameters["bias_H_A_per_m"] == pytest.approx(list(BIAS_FIELD_A_PER_M_VECTOR))

    path = parameters["path"]
    assert path["file"] == "kpath.csv"
    assert path["samples"] == 61
    assert path["nodes"] == list(CONTROL_LABELS)
    assert path["intervals_per_segment"] == 20

    search = parameters["eigen_search"]
    assert search["initial_shift_hz"] == INITIAL_SHIFT_HZ
    assert search["initial_requested_modes"] == MODE_COUNT
    assert search["target_positive_physical_bands"] == TARGET_BANDS

    assert parameters["qualification"] == "NOT VERIFIED"
    assert parameters["controls_finite_dirichlet_box"]["Nz_uniform_gamma"] == pytest.approx(
        0.9975062344139651
    )


def _assert_common_pipeline(
    relax_ir: dict[str, object],
    eigen_ir: dict[str, object],
    *,
    case: str,
) -> None:
    assert relax_ir["study"]["kind"] == "relaxation"
    assert eigen_ir["study"]["kind"] == "eigenmodes"

    runtime = eigen_ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    assert runtime == {
        "backend": "fem",
        "device": "cpu",
        "gpu_count": 0,
        "device_index": None,
        "cpu_threads": None,
        "execution_mode": "strict",
        "execution_precision": "double",
    }

    relax = relax_ir["study"]
    assert relax["algorithm"] == "llg_overdamped"
    assert relax["stop"] == {
        "torque_tolerance_apm": RELAX_TORQUE_TOLERANCE_A_PER_M,
        "max_steps": RELAX_MAX_STEPS,
    }
    assert relax["dynamics"]["gyromagnetic_ratio"] == GAMMA_M_PER_A_S
    assert relax["dynamics"]["fixed_timestep"] == RELAX_DT_S

    eigen = eigen_ir["study"]
    assert eigen["operator"] == {"kind": "full_2x2", "include_demag": case != "c0"}
    expected_mode_count = C0_MODE_COUNT if case == "c0" else MODE_COUNT
    assert eigen["count"] == expected_mode_count
    assert eigen["target"] == {
        "kind": "frequency_window",
        "frequency_min_hz": FREQUENCY_WINDOW_HZ[0],
        "frequency_max_hz": FREQUENCY_WINDOW_HZ[1],
    }
    assert eigen["equilibrium"] == {"kind": "relaxed_initial_state"}
    assert eigen["normalization"] == "unit_l2"
    assert eigen["damping_policy"] == "ignore"
    assert eigen["dynamics"]["gyromagnetic_ratio"] == GAMMA_M_PER_A_S

    output_kinds = [output["kind"] for output in eigen["sampling"]["outputs"]]
    assert output_kinds == [
        "eigen_spectrum",
        "dispersion_curve",
        "eigen_diagnostics",
        "eigen_mode",
    ]
    mode_output = eigen["sampling"]["outputs"][-1]
    expected_mode_indices = (0,) if case == "c0" else tuple(range(TARGET_BANDS))
    assert mode_output["indices"] == list(expected_mode_indices)
    sample_selector = mode_output["sample_selector"]
    assert sample_selector["sample_indices"] == list(
        MODE_FIELD_SAMPLE_INDICES if case != "c0" else (0,)
    )
    assert sample_selector["sample_labels"] == []

    metadata = _benchmark_metadata(eigen_ir)
    assert metadata["benchmark_id"] == "comsol-py-antidot-square-v1"
    assert metadata["case_id"] == case
    assert metadata["execution_status"] == "authoring_contract_only"
    assert metadata["material"]["Ms_A_per_m"] == MS_A_PER_M
    assert metadata["material"]["Aex_J_per_m"] == AEX_J_PER_M
    assert metadata["material"]["comsol_A_field_A_m"] == COMSOL_A_FIELD_A_M
    assert metadata["material"]["bias_field_T"] == list(BIAS_FIELD_T)
    assert metadata["material"]["bias_field_A_per_m"] == list(BIAS_FIELD_A_PER_M_VECTOR)
    assert metadata["equilibrium"]["relax_alpha"] == RELAX_ALPHA
    assert metadata["equilibrium"]["reuse_for_all_k"] is True
    assert metadata["eigensolve"]["initial_shift_hz"] == 1.0e9
    assert "public DSL has no shift parameter" in metadata["eigensolve"]["initial_shift_status"]


def test_c0_is_the_gamma_exchange_only_control() -> None:
    relax_ir, eigen_ir = _load_case("c0")
    _assert_common_pipeline(relax_ir, eigen_ir, case="c0")

    assert [term["kind"] for term in eigen_ir["energy_terms"]] == ["exchange", "zeeman"]
    assert eigen_ir["pbc"] == {
        "axes": ["periodic", "periodic", "open"],
        "demag": "open",
    }
    eigen = eigen_ir["study"]
    assert eigen["k_sampling"] == {"kind": "single", "k_vector": [0.0, 0.0, 0.0]}
    assert eigen["spin_wave_bc"] == {
        "kind": "periodic",
        "pair_ids": ["x_faces", "y_faces"],
    }
    assert eigen["magnetostatic_bc"] == "open"
    assert eigen_ir["problem_meta"]["runtime_metadata"]["comsol_nonzero_k_dispersion"][
        "outputs"
    ]["potential"] == "not_applicable"


@pytest.mark.parametrize("case", ("c1", "a1"))
def test_demag_controls_use_the_finite_dirichlet_airbox_and_floquet_path(case: str) -> None:
    relax_ir, eigen_ir = _load_case(case)
    _assert_common_pipeline(relax_ir, eigen_ir, case=case)

    for ir in (relax_ir, eigen_ir):
        assert [term["kind"] for term in ir["energy_terms"]] == [
            "exchange",
            "demag",
            "zeeman",
        ]
        demag = next(term for term in ir["energy_terms"] if term["kind"] == "demag")
        assert demag["realization"] == "poisson_dirichlet"
        assert ir["pbc"]["demag"] == "periodic_airbox_k0"

    eigen = eigen_ir["study"]
    assert eigen["spin_wave_bc"] == {
        "kind": "floquet",
        "pair_ids": ["x_faces", "y_faces"],
        "phase_convention": "exp_minus_i_k_dot_delta_r",
    }
    assert eigen["magnetostatic_bc"] == "floquet_airbox"

    sampling = eigen["k_sampling"]
    assert sampling["kind"] == "path"
    assert sampling["closed"] is False
    assert sampling["samples_per_segment"] == list(KPATH_SAMPLES_PER_SEGMENT)
    assert [point["label"] for point in sampling["points"]] == list(CONTROL_LABELS)
    assert sampling["points"][0]["k_vector"] == [0.0, 0.0, 0.0]
    assert sampling["points"][1]["k_vector"] == pytest.approx(
        [math.pi / A_LAT_M, 0.0, 0.0]
    )
    assert sampling["points"][2]["k_vector"] == pytest.approx(
        [math.pi / A_LAT_M, math.pi / A_LAT_M, 0.0]
    )
    assert sampling["points"][3]["k_vector"] == [0.0, 0.0, 0.0]

    mesh_workflow, mesh = _mesh_metadata(eigen_ir)
    assert mesh_workflow["default_mesh"]["periodic_pair_ids"] == [
        "x_faces",
        "y_faces",
    ]
    assert mesh_workflow["mesh_options"]["periodic_pair_ids"] == [
        "x_faces",
        "y_faces",
    ]
    assert mesh["mesh_strategy"] == "thin_film_tetrahedral"
    assert mesh["through_thickness_elements"] == THIN_FILM_LAYERS
    assert mesh["order"] == THIN_FILM_ORDER
    assert mesh["hmax"] == INTERFACE_HMAX_M
    assert mesh["hmin"] == INTERFACE_HMAX_M
    assert mesh["interface_hmax"] == INTERFACE_HMAX_M
    assert mesh["interface_thickness"] == INTERFACE_THICKNESS_M
    assert mesh["transition_distance"] == INTERFACE_TRANSITION_DISTANCE_M
    assert mesh["edge_hmax"] == INTERFACE_HMAX_M
    assert mesh["edge_thickness"] == INTERFACE_THICKNESS_M

    universe = eigen_ir["problem_meta"]["runtime_metadata"]["study_universe"]
    assert universe["size"] == list(UNIVERSE_SIZE_M)
    assert universe["airbox_hmax"] == AIRBOX_HMAX_M
    assert universe["airbox_growth_rate"] == AIRBOX_GROWTH_RATE

    outputs = _benchmark_metadata(eigen_ir)["outputs"]
    assert outputs["potential"].startswith("potential_full.bin")
    assert outputs["potential_representation"] == "full_physical_phasor"
    assert outputs["potential_unknown"] == "full_physical_phi"
    assert _benchmark_metadata(eigen_ir)["comsol_reference"]["potential_unknown"] == "periodic_envelope_psi"
    assert outputs["full_nodal_potential_map"].endswith("runtime_not_verified")


def test_a1_preserves_the_through_hole_as_air_geometry() -> None:
    _, eigen_ir = _load_case("a1")
    entry = eigen_ir["geometry"]["entries"][0]
    assert entry["kind"] == "difference"
    assert entry["base"] == {
        "name": "full_film",
        "kind": "box",
        "size": [A_LAT_M, A_LAT_M, 10.0e-9],
    }
    assert entry["tool"] == {
        "name": "air_hole",
        "kind": "cylinder",
        "radius": HOLE_RADIUS_M,
        "height": 10.0e-9,
        "axis": [0.0, 0.0, 1.0],
    }
    geometry_metadata = _benchmark_metadata(eigen_ir)["geometry"]
    assert geometry_metadata["air_in_hole"] is True
    assert geometry_metadata["magnetic_volume_m3"] == pytest.approx(
        (A_LAT_M * A_LAT_M - math.pi * HOLE_RADIUS_M * HOLE_RADIUS_M) * 10.0e-9
    )


def test_c1_keeps_a_full_film_without_a_hole() -> None:
    _, eigen_ir = _load_case("c1")
    entry = eigen_ir["geometry"]["entries"][0]
    assert entry["kind"] == "box"
    assert entry["size"] == [A_LAT_M, A_LAT_M, 10.0e-9]
    assert _benchmark_metadata(eigen_ir)["geometry"]["air_in_hole"] is False


def test_supplied_kpath_csv_has_the_guide_61_samples_and_matches_controls() -> None:
    with KPATH_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    assert len(rows) == sum(KPATH_SAMPLES_PER_SEGMENT) + 1
    assert [row["label"] for row in rows if row["label"]] == list(CONTROL_LABELS)
    assert rows[0]["jpath"] == "0"
    assert rows[-1]["jpath"] == "60"
    assert float(rows[-1]["path_s_rad_per_m"]) == pytest.approx(53_630_341.22668976)

    # Independent cumulative-length check catches accidental non-Euclidean
    # path metadata or a changed endpoint without mirroring the implementation.
    previous = None
    path_s = 0.0
    for row in rows:
        point = tuple(float(row[key]) for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
        if previous is not None:
            path_s += math.dist(point, previous)
        assert float(row["path_s_rad_per_m"]) == pytest.approx(path_s, rel=1e-14, abs=1e-7)
        previous = point


def test_invalid_case_selector_fails_closed() -> None:
    previous = os.environ.get("FULLMAG_COMSOL_DISPERSION_CASE")
    os.environ["FULLMAG_COMSOL_DISPERSION_CASE"] = "unsupported"
    fm.reset()
    try:
        with pytest.raises(ValueError, match="must be one of c0, c1, a1"):
            fm.load_problem_from_script(SCRIPT, lightweight_assets=True)
    finally:
        if previous is None:
            os.environ.pop("FULLMAG_COMSOL_DISPERSION_CASE", None)
        else:
            os.environ["FULLMAG_COMSOL_DISPERSION_CASE"] = previous
        fm.reset()


def test_all_mode_fields_are_an_explicit_opt_in_without_changing_the_sweep() -> None:
    previous_case = os.environ.get("FULLMAG_COMSOL_DISPERSION_CASE")
    previous_all_fields = os.environ.get("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS")
    os.environ["FULLMAG_COMSOL_DISPERSION_CASE"] = "a1"
    os.environ["FULLMAG_COMSOL_DISPERSION_ALL_FIELDS"] = "1"
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(SCRIPT, lightweight_assets=True)
        eigen_ir = loaded.stages[-1].problem.to_ir(
            requested_backend="fem",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        eigen = eigen_ir["study"]
        assert eigen["k_sampling"]["samples_per_segment"] == [20, 20, 20]
        mode_output = eigen["sampling"]["outputs"][-1]
        assert mode_output["indices"] == list(range(MODE_COUNT))
        assert "sample_selector" not in mode_output
        metadata = _benchmark_metadata(eigen_ir)["outputs"]["mode_field_export"]
        assert metadata["policy"] == "all_61_samples_x_24_modes"
    finally:
        if previous_case is None:
            os.environ.pop("FULLMAG_COMSOL_DISPERSION_CASE", None)
        else:
            os.environ["FULLMAG_COMSOL_DISPERSION_CASE"] = previous_case
        if previous_all_fields is None:
            os.environ.pop("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS", None)
        else:
            os.environ["FULLMAG_COMSOL_DISPERSION_ALL_FIELDS"] = previous_all_fields
        fm.reset()


def _minimal_mesh_for_materialization_assessment() -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    benchmark = {
        "mesh": {
            "thin_film_layers": 3,
            "periodic_pair_ids": ["x_faces", "y_faces"],
        }
    }
    domain = {
        "region_markers": [{"geometry_name": "film", "marker": 1}],
        "build_report": {
            "build_mode": "single_geometry_geo_ring",
            "operation_statuses": [
                {
                    "kind": "thin_film",
                    "scope": "film",
                    "status": "applied",
                    "requested_method": "thin_film_tetrahedral",
                    "actual_method": "feature_aware_tetrahedral",
                    "details": {"through_thickness_elements": 3},
                }
            ],
        },
    }
    mesh = {
        "nodes": [[0.0, 0.0, value] for value in (-5.0e-9, -1.6666667e-9, 1.6666667e-9, 5.0e-9)],
        "cells": {
            "types": ["tet4"],
            "offsets": [0, 4],
            "nodes": [0, 1, 2, 3],
        },
        "element_markers": [1],
        "facets": {"types": ["tri3"]},
        "periodic_boundary_pairs": [
            {"pair_id": "x_faces"},
            {"pair_id": "y_faces"},
        ],
        "periodic_node_pairs": [{"pair_id": "x_faces"}],
    }
    return benchmark, domain, mesh


def test_materialization_assessment_accepts_only_proven_swept_layers() -> None:
    benchmark, domain, mesh = _minimal_mesh_for_materialization_assessment()

    assessment = _assess_benchmark_mesh(domain, mesh, benchmark)

    assert assessment["status"] == "accepted"
    assert assessment["accepted"] is True
    assert assessment["evidence"]["resolved_layer_planes"] == 4
    assert assessment["rejection_reasons"] == []


def test_materialization_assessment_rejects_a_reported_free_tetrahedral_fallback() -> None:
    benchmark, domain, mesh = _minimal_mesh_for_materialization_assessment()
    domain["build_report"]["build_mode"] = "conformal_occ"
    domain["build_report"]["operation_statuses"][0].update(
        {
            "status": "skipped",
            "actual_method": "free_tetrahedral",
            "reason": "Difference not yet supported for swept meshing",
        }
    )

    assessment = _assess_benchmark_mesh(domain, mesh, benchmark)

    assert assessment["status"] == "not_accepted"
    assert assessment["accepted"] is False
    assert any("thin_film operation was not applied" in reason for reason in assessment["rejection_reasons"])
    assert any("build mode" in reason for reason in assessment["rejection_reasons"])


def test_a1_exact_shared_geo_route_preserves_tet_layers_and_periodicity() -> None:
    pytest.importorskip("gmsh")
    from fullmag.meshing.gmsh_bridge import AirboxOptions, MeshOptions, generate_mesh

    geometry = fm.Box(size=(2.0e-6, 2.0e-6, 1.0e-7), name="film") - fm.Cylinder(
        radius=3.0e-7,
        height=1.0e-7,
        name="hole",
    )
    mesh = generate_mesh(
        geometry,
        hmax=5.0e-7,
        order=1,
        airbox=AirboxOptions(
            size=(2.0e-6, 2.0e-6, 4.0e-6),
            center=(0.0, 0.0, 0.0),
            grading_ratio=1.2,
            maximum_element_size=5.0e-7,
            minimum_element_size=2.0e-7,
        ),
        options=MeshOptions(
            mesh_strategy="thin_film_tetrahedral",
            through_thickness_elements=3,
            sweep_face_meshing="triangular",
            periodic_pair_ids=["x_faces", "y_faces"],
            compute_quality=False,
        ),
    )

    assert set(mesh.cell_types.tolist()) == {"tet4"}
    assert set(mesh.facet_types.tolist()) == {"tri3"}
    assert {str(pair["pair_id"]) for pair in mesh.periodic_boundary_pairs} == {
        "x_faces",
        "y_faces",
    }
    assert mesh.periodic_node_pairs
    magnetic_nodes = {
        int(node)
        for index, marker in enumerate(mesh.element_markers.tolist())
        if marker == 1
        for node in mesh.cell_nodes[mesh.cell_offsets[index] : mesh.cell_offsets[index + 1]]
    }
    planes = sorted({round(float(mesh.nodes[node, 2]), 15) for node in magnetic_nodes})
    assert len(planes) == THIN_FILM_LAYERS + 1
