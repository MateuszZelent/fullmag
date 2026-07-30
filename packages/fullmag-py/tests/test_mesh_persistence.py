from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile
from unittest.mock import patch

import numpy as np

import fullmag as fm

from fullmag.meshing.gmsh_bridge import MeshData
from fullmag.meshing.persistence import (
    MeshArtifactCorruptionError,
    MeshConfigurationMismatch,
    export_gmsh_mesh,
    import_gmsh_mesh,
    load_mesh_artifact,
    mesh_authoring_fingerprint,
    save_mesh_artifact,
)
from fullmag.model.problem import BackendTarget, build_geometry_assets_for_request


def _tetra_mesh() -> MeshData:
    return MeshData(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0e-9, 0.0, 0.0],
                [0.0, 1.0e-9, 0.0],
                [0.0, 0.0, 1.0e-9],
            ],
            dtype=np.float64,
        ),
        cell_types=np.asarray(["tet4"]),
        cell_offsets=np.asarray([0, 4]),
        cell_nodes=np.asarray([0, 1, 2, 3]),
        element_markers=np.asarray([1]),
        facet_types=np.asarray(["tri3", "tri3", "tri3", "tri3"]),
        facet_roles=np.asarray(
            ["exterior", "exterior", "exterior", "material_interface"]
        ),
        facet_offsets=np.asarray([0, 3, 6, 9, 12]),
        facet_nodes=np.asarray([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
        boundary_markers=np.asarray([10, 10, 10, 20]),
        cell_global_ordinals=np.asarray([41]),
        facet_global_ordinals=np.asarray([51, 52, 53, 54]),
        cell_mesh_parts=np.asarray(["magnetic"]),
    )


class MeshPersistenceTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def test_native_artifact_round_trips_complete_semantics(self) -> None:
        mesh = _tetra_mesh()
        authoring = {
            "geometry": [{"kind": "box", "size": [1e-9, 1e-9, 1e-9]}],
            "mesh_workflow": {"mesh_options": {"maximum_element_size": 1e-9}},
        }
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            save_mesh_artifact(
                path,
                mesh=mesh,
                mesh_name="study_domain",
                authoring_document=authoring,
                region_markers=[{"geometry_name": "film", "marker": 1}],
                object_region_markers=[],
                boundary_map={"outer": 10, "film_air": 20},
                build_report={"build_mode": "test"},
            )

            artifact = load_mesh_artifact(path, expected_authoring_document=authoring)

        np.testing.assert_array_equal(artifact.mesh.cell_nodes, mesh.cell_nodes)
        np.testing.assert_array_equal(artifact.mesh.facet_roles, mesh.facet_roles)
        np.testing.assert_array_equal(artifact.mesh.cell_global_ordinals, mesh.cell_global_ordinals)
        self.assertEqual(artifact.region_markers, [{"geometry_name": "film", "marker": 1}])
        self.assertEqual(artifact.boundary_map, {"film_air": 20, "outer": 10})
        self.assertEqual(artifact.build_report, {"build_mode": "test"})
        self.assertEqual(artifact.authoring_fingerprint, mesh_authoring_fingerprint(authoring))
        self.assertEqual(artifact.topology_fingerprint, mesh.topology_fingerprint_v3())

    def test_native_load_reports_authoring_mismatch(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            save_mesh_artifact(
                path,
                mesh=_tetra_mesh(),
                mesh_name="study_domain",
                authoring_document={"mesh": {"hmax": 1e-9}},
                region_markers=[{"geometry_name": "film", "marker": 1}],
            )
            with self.assertRaisesRegex(MeshConfigurationMismatch, "mesh.hmax"):
                load_mesh_artifact(
                    path,
                    expected_authoring_document={"mesh": {"hmax": 2e-9}},
                )

    def test_native_load_rejects_corrupt_topology_member(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            save_mesh_artifact(
                path,
                mesh=_tetra_mesh(),
                mesh_name="study_domain",
                authoring_document={"mesh": {"hmax": 1e-9}},
                region_markers=[{"geometry_name": "film", "marker": 1}],
            )
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr("topology.npz", b"corrupt")
            with self.assertRaisesRegex(MeshArtifactCorruptionError, "topology.npz"):
                load_mesh_artifact(path)

    def test_gmsh_export_and_import_preserve_semantic_groups(self) -> None:
        with TemporaryDirectory() as tmp:
            native = Path(tmp) / "film.fullmag-mesh"
            msh = Path(tmp) / "film.msh"
            save_mesh_artifact(
                native,
                mesh=_tetra_mesh(),
                mesh_name="study_domain",
                authoring_document={"mesh": {"hmax": 1e-9}},
                region_markers=[{"geometry_name": "film", "marker": 1}],
                boundary_map={"outer": 10, "film_air": 20},
            )
            artifact = load_mesh_artifact(native)

            export_gmsh_mesh(artifact, msh)
            imported = import_gmsh_mesh(msh, coordinate_unit="m")

            self.assertTrue(msh.exists())
            self.assertTrue(Path(f"{msh}.fullmag.json").exists())
            self.assertEqual(imported.region_markers, artifact.region_markers)
            self.assertEqual(imported.boundary_map, artifact.boundary_map)
            self.assertEqual(imported.mesh.n_elements, 1)
            self.assertEqual(imported.mesh.n_boundary_faces, 4)

    def test_gmsh_import_requires_explicit_coordinate_unit_without_sidecar(self) -> None:
        with TemporaryDirectory() as tmp:
            native = Path(tmp) / "film.fullmag-mesh"
            msh = Path(tmp) / "film.msh"
            save_mesh_artifact(
                native,
                mesh=_tetra_mesh(),
                mesh_name="study_domain",
                authoring_document={},
                region_markers=[{"geometry_name": "film", "marker": 1}],
                boundary_map={"outer": 10, "film_air": 20},
            )
            export_gmsh_mesh(load_mesh_artifact(native), msh)
            Path(f"{msh}.fullmag.json").unlink()

            with self.assertRaisesRegex(ValueError, "coordinate_unit"):
                import_gmsh_mesh(msh)

    def test_study_mesh_save_and_load_bind_native_artifact(self) -> None:
        mesh = _tetra_mesh()
        assets = {
            "fdm_grid_assets": [],
            "fem_mesh_assets": [],
            "fem_domain_mesh_asset": {
                "mesh_source": None,
                "mesh": mesh.to_ir("study_domain"),
                "region_markers": [{"geometry_name": "film", "marker": 1}],
                "object_region_markers": [],
                "build_report": {"build_mode": "test"},
            },
        }
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            study = fm.study("mesh-persistence")
            with patch("fullmag.world._build_explicit_mesh_assets", return_value=assets):
                saved = study.mesh.save(path)
            fm.reset()
            study = fm.study("mesh-persistence")
            loaded = study.mesh.load(path)

        self.assertEqual(saved, path)
        self.assertEqual(loaded.action, "loaded")
        self.assertEqual(loaded.topology_fingerprint, mesh.topology_fingerprint_v3())

    def test_study_mesh_save_or_load_skips_builder_for_matching_artifact(self) -> None:
        mesh = _tetra_mesh()
        assets = {
            "fem_domain_mesh_asset": {
                "mesh_source": None,
                "mesh": mesh.to_ir("study_domain"),
                "region_markers": [{"geometry_name": "film", "marker": 1}],
                "object_region_markers": [],
            }
        }
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            study = fm.study("mesh-persistence")
            with patch("fullmag.world._build_explicit_mesh_assets", return_value=assets):
                first = study.mesh.save_or_load(path)
            with patch("fullmag.world._build_explicit_mesh_assets") as builder:
                second = study.mesh.save_or_load(path)

        self.assertEqual(first.action, "saved")
        self.assertEqual(second.action, "loaded")
        builder.assert_not_called()

    def test_problem_materialization_inlines_native_shared_domain_artifact(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            save_mesh_artifact(
                path,
                mesh=_tetra_mesh(),
                mesh_name="study_domain",
                authoring_document={},
                region_markers=[{"geometry_name": "film", "marker": 1}],
                boundary_map={"outer": 10, "film_air": 20},
            )

            assets = build_geometry_assets_for_request(
                requested_backend=BackendTarget.FEM,
                geometries=[],
                discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, hmax=1e-9)),
                mesh_workflow={
                    "domain_mesh_source": str(path),
                    "domain_region_markers": [
                        {"geometry_name": "film", "marker": 1}
                    ],
                },
            )

        domain = assets["fem_domain_mesh_asset"]
        self.assertIsNotNone(domain["mesh"])
        self.assertEqual(domain["mesh"]["mesh_name"], "study_domain")


if __name__ == "__main__":
    unittest.main()
