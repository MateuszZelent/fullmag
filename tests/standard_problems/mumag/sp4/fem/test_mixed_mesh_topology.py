from __future__ import annotations

import contextlib
import copy
import csv
import gc
import io
import json
import os
from pathlib import Path

import pytest

from fullmag.meshing._gmsh_types import MeshData, MixedLayerTopologyCertificate
from fullmag.meshing.asset_pipeline import (
    realize_fem_domain_mesh_asset_from_components_with_report,
)
from fullmag.runtime import helper as runtime_helper
from fullmag.runtime.loader import load_problem_from_script
from tests.standard_problems.mumag.sp4.fem.collect_results import (
    CollectionError,
    FIELDNAMES,
    collect_attempt,
)


SCENARIO = Path(__file__).with_name("scenarios") / "mesh_single_prism_layer.py"
REPO_ROOT = Path(__file__).parents[5]
CERTIFICATE_FIXTURE = (
    REPO_ROOT
    / "crates/fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
)


def _canonical_certificate() -> dict[str, object]:
    certificate = json.loads(CERTIFICATE_FIXTURE.read_text(encoding="utf-8"))["certificate"]
    magnetic_volume_m3 = 500e-9 * 125e-9 * 3e-9
    shared_domain_volume_m3 = 700e-9 * 250e-9 * 250e-9
    certificate.update(
        {
            "magnetic_plane_coordinates_m": [-1.5e-9, 1.5e-9],
            "magnetic_bounds_min_m": [-250e-9, -62.5e-9, -1.5e-9],
            "magnetic_bounds_max_m": [250e-9, 62.5e-9, 1.5e-9],
            "airbox_bounds_min_m": [-350e-9, -125e-9, -125e-9],
            "airbox_bounds_max_m": [350e-9, 125e-9, 125e-9],
            "magnetic_volume_m3": magnetic_volume_m3,
            "expected_magnetic_volume_m3": magnetic_volume_m3,
            "air_volume_m3": shared_domain_volume_m3 - magnetic_volume_m3,
            "shared_domain_volume_m3": shared_domain_volume_m3,
            "expected_shared_domain_volume_m3": shared_domain_volume_m3,
            "cell_family_counts_by_marker": {
                "0": {"pyramid5": 852, "tet4": 377160},
                "1": {"prism6": 64922},
            },
            "cell_family_counts_by_part": {
                "far_air": {"tet4": 7737},
                "magnetic": {"prism6": 64922},
                "transition_air": {"pyramid5": 852, "tet4": 369423},
            },
        }
    )
    for name in (
        "plane_tolerance_m",
        "transition_shell_thickness_m",
        "magnetic_bounds_relative_error",
        "airbox_bounds_relative_error",
        "magnetic_volume_m3",
        "expected_magnetic_volume_m3",
        "magnetic_relative_volume_error",
        "air_volume_m3",
        "shared_domain_volume_m3",
        "expected_shared_domain_volume_m3",
        "shared_domain_relative_volume_error",
    ):
        certificate[name] = float(certificate[name])
    for name in (
        "magnetic_plane_coordinates_m",
        "magnetic_bounds_min_m",
        "magnetic_bounds_max_m",
        "airbox_bounds_min_m",
        "airbox_bounds_max_m",
    ):
        certificate[name] = [float(value) for value in certificate[name]]
    for name in (
        "jacobian_minima_m3_by_family",
        "scaled_jacobian_minima_by_family",
        "scaled_jacobian_p05_by_family",
    ):
        certificate[name] = {
            key: float(value) for key, value in certificate[name].items()
        }
    return certificate


def _topology_metadata() -> dict[str, object]:
    certificate = _canonical_certificate()
    fingerprint = certificate["topology_fingerprint"]
    return {
        "requested_execution": {
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
        },
        "execution_provenance": {
            "execution_engine": "fem_cpu_native",
            "precision": "double",
            "lossy_fallback_used": False,
        },
        "mesh": {
            "topology_fingerprint": fingerprint,
            "node_count": 12,
            "element_count": 442934,
            "mesh_build_report": {
                "build_mode": "single_geometry_geo_mixed",
                "fallbacks_triggered": [],
                "degraded": False,
                "orphan_entities": [],
                "mixed_layer_topology_certificate": certificate,
                "mixed_topology_provenance": {
                    "requested_topology": "mixed_p1",
                    "resolved_topology": "mixed_p1",
                    "accepted_certificate_fingerprint": fingerprint,
                    "requested_device": "cpu",
                    "precision": "double",
                    "capability_status": "implemented",
                },
            },
        },
        "problem_meta": {
            "runtime_metadata": {
                "domain_frame": {
                    "declared_universe": {
                        "size": [700e-9, 250e-9, 250e-9],
                        "center": [0.0, 0.0, 0.0],
                    },
                    "object_bounds_min": [-250e-9, -62.5e-9, -1.5e-9],
                    "object_bounds_max": [250e-9, 62.5e-9, 1.5e-9],
                },
                "mesh_workflow": {
                    "per_geometry": [
                        {
                            "maximum_element_size": 3e-9,
                            "through_thickness_elements": 1,
                        }
                    ]
                },
            }
        },
    }


def _write_topology_artifacts(root: Path, metadata: dict[str, object]) -> Path:
    artifacts = root / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    return artifacts


def _export_run_config(*, lightweight_assets: bool) -> dict[str, object]:
    stdout = io.StringIO()
    arguments = [
        "export-run-config",
        "--script",
        str(SCENARIO),
        "--backend",
        "fem",
        "--mode",
        "strict",
        "--precision",
        "double",
    ]
    if lightweight_assets:
        arguments.append("--skip-geometry-assets")
    with contextlib.redirect_stdout(stdout):
        exit_code = runtime_helper.main(arguments)
    assert exit_code == 0
    return json.loads(stdout.getvalue())


def _export_real_topology_evidence(output_path: Path) -> dict[str, object]:
    loaded = load_problem_from_script(SCENARIO, lightweight_assets=True)
    problem = loaded.problem
    mesh, _markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
        [magnet.geometry for magnet in problem.magnets],
        problem.discretization.fem,
        study_universe=problem.runtime_metadata["study_universe"],
        mesh_workflow=problem.runtime_metadata["mesh_workflow"],
    )
    mesh.save(output_path)
    node_count = mesh.n_nodes
    element_count = mesh.n_elements
    del mesh
    gc.collect()

    persisted_mesh = MeshData.load(output_path)
    persisted_certificate = persisted_mesh.mixed_layer_topology_certificate
    assert persisted_certificate is not None
    certificate = persisted_certificate.to_dict()
    report_payload = report.to_dict()
    assert report_payload["mixed_layer_topology_certificate"] == certificate
    return {
        "node_count": node_count,
        "element_count": element_count,
        "mesh_certificate": certificate,
        "build_report": report_payload,
    }


def test_topology_smoke_authors_one_exact_prism_layer_without_a_solver_stage() -> None:
    payload = _export_run_config(lightweight_assets=True)

    assert payload["stages"] == []
    assert payload["ir"]["geometry"]["entries"] == [
        {"name": "film_geom", "kind": "box", "size": [500e-9, 125e-9, 3e-9]}
    ]
    runtime = payload["ir"]["problem_meta"]["runtime_metadata"]
    assert runtime["domain_frame"]["declared_universe"]["size"] == pytest.approx(
        [700e-9, 250e-9, 250e-9]
    )
    [mesh] = runtime["mesh_workflow"]["per_geometry"]
    assert runtime["mesh_workflow"]["build_requested"] is True
    assert runtime["mesh_workflow"]["build_target"] == "domain"
    assert mesh["hmin"] == pytest.approx(1e-9)
    assert mesh["hmax"] == pytest.approx(3e-9)
    assert mesh["order"] == 1
    assert mesh["topology"] == "prismatic"
    assert mesh["element_family"] == "prism"
    assert mesh["through_thickness_elements"] == 1
    assert mesh["exact_layer_count"] is True
    assert mesh["transition_policy"] == "pyramid_to_tetrahedra"
    assert mesh["interface_hmax"] == pytest.approx(2e-9)
    assert mesh["interface_thickness"] == pytest.approx(2e-9)
    assert mesh["transition_distance"] == pytest.approx(3e-9)
    assert mesh["edge_hmax"] == pytest.approx(1.5e-9)
    assert mesh["edge_thickness"] == pytest.approx(12e-9)
    assert mesh["edge_transition_distance"] == pytest.approx(24e-9)
    assert mesh["corner_hmax"] == pytest.approx(1e-9)
    assert mesh["corner_extent"] == pytest.approx(6e-9)
    assert mesh["corner_transition_distance"] == pytest.approx(12e-9)
    universe = runtime["study_universe"]
    assert universe["airbox_hmin"] == pytest.approx(15e-9)
    assert universe["airbox_hmax"] == pytest.approx(100e-9)
    assert universe["airbox_growth_rate"] == pytest.approx(2.5)
    assert universe["airbox_grading"] == "geometric"


@pytest.mark.skipif(
    os.environ.get("FULLMAG_RUN_SP4_MIXED_TOPOLOGY") != "1",
    reason="set FULLMAG_RUN_SP4_MIXED_TOPOLOGY=1 for the opt-in real-Gmsh topology smoke",
)
def test_topology_smoke_materializes_an_accepted_mixed_layer_certificate(
    tmp_path: Path,
) -> None:
    evidence_root = Path(
        os.environ.get("FULLMAG_SP4_TOPOLOGY_EVIDENCE_DIR", str(tmp_path))
    )
    evidence_root.mkdir(parents=True, exist_ok=True)
    mesh_path = evidence_root / "fem-domain-mesh-csr.npz"
    real_evidence = _export_real_topology_evidence(mesh_path)
    assert mesh_path.is_file()
    report = real_evidence["build_report"]
    assert isinstance(report, dict)
    certificate = report["mixed_layer_topology_certificate"]
    assert real_evidence["mesh_certificate"] == certificate
    evidence_path = evidence_root / "mixed-topology-evidence.json"
    evidence_path.write_text(
        json.dumps(
            {
                "node_count": real_evidence["node_count"],
                "element_count": real_evidence["element_count"],
                "build_report": report,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    del real_evidence
    gc.collect()
    persisted_evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    report = persisted_evidence["build_report"]
    certificate = report["mixed_layer_topology_certificate"]
    assert certificate["schema_version"] == "mixed_layer_topology_certificate.v1"
    assert certificate["certificate_status"] == "accepted"
    assert certificate["realized_layer_count"] == 1
    assert len(certificate["magnetic_plane_coordinates_m"]) == 2
    assert set(certificate["cell_family_counts_by_marker"]["1"]) == {"prism6"}
    assert certificate["cell_family_counts_by_marker"]["1"]["prism6"] > 0

    persisted_certificate = MixedLayerTopologyCertificate.from_dict(certificate)
    assert persisted_certificate.topology_fingerprint == certificate["topology_fingerprint"]

    metadata = _topology_metadata()
    metadata_mesh = metadata["mesh"]
    assert isinstance(metadata_mesh, dict)
    fixture_report = metadata_mesh["mesh_build_report"]
    assert isinstance(fixture_report, dict)
    provenance = fixture_report["mixed_topology_provenance"]
    assert isinstance(provenance, dict)
    runtime_report = dict(report)
    runtime_report["mixed_topology_provenance"] = dict(provenance)
    metadata_mesh.update(
        {
            "topology_fingerprint": certificate["topology_fingerprint"],
            "node_count": persisted_evidence["node_count"],
            "element_count": persisted_evidence["element_count"],
            "mesh_build_report": runtime_report,
        }
    )
    runtime_provenance = runtime_report["mixed_topology_provenance"]
    assert isinstance(runtime_provenance, dict)
    runtime_provenance["accepted_certificate_fingerprint"] = certificate[
        "topology_fingerprint"
    ]
    collected = collect_attempt(
        _write_topology_artifacts(evidence_root, metadata),
        evidence_root / "sp4-topology-results.csv",
        scenario="mesh_single_prism_layer",
        attempt_id="real-gmsh-topology",
    )
    assert collected["mesh_certificate_status"] == "accepted"


def test_topology_collector_records_the_accepted_two_plane_prism_certificate(
    tmp_path: Path,
) -> None:
    metadata = _topology_metadata()
    artifacts = _write_topology_artifacts(tmp_path, metadata)
    fingerprint = metadata["mesh"]["topology_fingerprint"]

    row = collect_attempt(
        artifacts,
        tmp_path / "results.csv",
        scenario="mesh_single_prism_layer",
        attempt_id="topology-001",
    )

    assert row["phase"] == "topology"
    assert row["mesh_topology_fingerprint"] == fingerprint
    assert row["mesh_certificate_status"] == "accepted"
    assert row["mesh_node_plane_count"] == "2"
    assert row["mesh_magnetic_prism6_count"] == "64922"
    assert row["mesh_magnetic_tet4_count"] == "0"
    assert row["mesh_magnetic_pyramid5_count"] == "0"


def test_topology_collector_migrates_a_legacy_ledger_header(tmp_path: Path) -> None:
    new_fields = {
        "mesh_certificate_status",
        "mesh_node_plane_count",
        "mesh_magnetic_prism6_count",
        "mesh_magnetic_tet4_count",
        "mesh_magnetic_pyramid5_count",
    }
    legacy_fields = [field for field in FIELDNAMES if field not in new_fields]
    ledger = tmp_path / "results.csv"
    with ledger.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=legacy_fields, lineterminator="\n")
        writer.writeheader()
        writer.writerow({"attempt_id": "legacy-topology", "phase": "topology"})

    collect_attempt(
        _write_topology_artifacts(tmp_path / "new", _topology_metadata()),
        ledger,
        scenario="mesh_single_prism_layer",
        attempt_id="topology-002",
    )

    with ledger.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        assert tuple(reader.fieldnames or ()) == FIELDNAMES
        rows = list(reader)
    assert rows[0]["attempt_id"] == "legacy-topology"
    assert rows[0]["mesh_certificate_status"] == ""
    assert rows[1]["mesh_certificate_status"] == "accepted"


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda metadata: metadata["mesh"].pop("mesh_build_report"), "certificate metadata missing"),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"].update(
                {"fallbacks_triggered": ["fallback"]}
            ),
            "fallbacks must be empty",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"].update({"degraded": True}),
            "degraded=false",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"].pop(
                "orphan_entities"
            ),
            "must prove no orphan entities",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"topology_fingerprint": "sha256:" + "b" * 64}),
            "fingerprint differs",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update(
                {
                    "requested_layer_count": 2,
                    "realized_layer_count": 2,
                    "magnetic_plane_coordinates_m": [-1.0, 0.0, 1.0],
                }
            ),
            "exactly one layer",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"magnetic_plane_coordinates_m": [-1.0, 0.0, 1.0]}),
            "invalid magnetic planes",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"certificate_status": "rejected"}),
            "must be accepted",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["cell_family_counts_by_marker"].update(
                {"1": {"prism6": 2, "tet4": 1}}
            ),
            "prism6-only",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["cell_family_counts_by_marker"].update(
                {"1": {"prism6": 2, "pyramid5": 1}}
            ),
            "prism6-only",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"nonconforming_face_count": 1}),
            "nonconforming_face_count must be zero",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"gmsh_version": "0.0.0"}),
            "unqualified Gmsh version",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"strategy": "unqualified"}),
            "unqualified strategy",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["deterministic_inputs"].update({"random_factor": 1}),
            "deterministic_inputs are stale",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"].pop(
                "mixed_topology_provenance"
            ),
            "provenance missing",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"magnetic_bounds_max_m": [249e-9, 62.5e-9, 1.5e-9]}),
            "magnetic bounds differ from runtime metadata",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"expected_magnetic_volume_m3": 1.0e-22}),
            "magnetic volume differs from runtime metadata",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"airbox_bounds_min_m": [-349e-9, -125e-9, -125e-9]}),
            "airbox bounds differ from runtime metadata",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ].update({"expected_shared_domain_volume_m3": 4.0e-20}),
            "shared-domain volume differs from runtime metadata",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["cell_family_counts_by_marker"].update({"2": {"tet4": 1}}),
            "exactly markers 0 and 1",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["cell_family_counts_by_part"]["transition_air"].update(
                {"tet4": 369422}
            ),
            "marker and mesh-part counts differ",
        ),
        (
            lambda metadata: (
                metadata["mesh"]["mesh_build_report"][
                    "mixed_layer_topology_certificate"
                ]["cell_family_counts_by_part"]["far_air"].update(
                    {"pyramid5": 1}
                ),
                metadata["mesh"]["mesh_build_report"][
                    "mixed_layer_topology_certificate"
                ]["cell_family_counts_by_marker"]["0"].update(
                    {"pyramid5": 853}
                ),
            ),
            "far_air must contain tet4 only",
        ),
        (
            lambda metadata: (
                metadata["mesh"]["mesh_build_report"][
                    "mixed_layer_topology_certificate"
                ]["cell_family_counts_by_part"]["transition_air"].update(
                    {"prism6": 1}
                ),
                metadata["mesh"]["mesh_build_report"][
                    "mixed_layer_topology_certificate"
                ]["cell_family_counts_by_marker"]["0"].update(
                    {"prism6": 1}
                ),
            ),
            "transition_air must contain pyramid5 and tet4 only",
        ),
        (
            lambda metadata: (
                metadata["mesh"]["mesh_build_report"][
                    "mixed_layer_topology_certificate"
                ]["cell_family_counts_by_part"]["transition_air"].pop(
                    "pyramid5"
                ),
                metadata["mesh"]["mesh_build_report"][
                    "mixed_layer_topology_certificate"
                ]["cell_family_counts_by_marker"]["0"].pop("pyramid5"),
            ),
            "transition_air must contain pyramid5 and tet4 only",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["scaled_jacobian_p05_by_family"].pop("tet4"),
            "p05 must cover prism6, pyramid5, and tet4",
        ),
        (
            lambda metadata: metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["scaled_jacobian_p05_by_family"].update({"hex8": 0.5}),
            "p05 must cover prism6, pyramid5, and tet4",
        ),
        (
            lambda metadata: metadata["mesh"].update(
                {"element_count": metadata["mesh"]["element_count"] + 1}
            ),
            "mesh element_count differs from certificate",
        ),
    ],
)
def test_topology_collector_rejects_noncanonical_certificate_or_build_report(
    tmp_path: Path,
    mutate,
    match: str,
) -> None:
    metadata = copy.deepcopy(_topology_metadata())
    mutate(metadata)

    with pytest.raises(CollectionError, match=match):
        collect_attempt(
            _write_topology_artifacts(tmp_path, metadata),
            tmp_path / "results.csv",
            scenario="mesh_single_prism_layer",
            attempt_id="topology-invalid",
        )
