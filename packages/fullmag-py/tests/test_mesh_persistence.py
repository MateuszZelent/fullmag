from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile
from unittest.mock import patch

import numpy as np

import fullmag as fm

from fullmag.meshing.gmsh_bridge import MeshData, MeshQualityReport
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


def _shared_domain_mesh() -> MeshData:
    base = _tetra_mesh()
    return MeshData(
        nodes=np.vstack((base.nodes, base.nodes + np.asarray([3.0e-9, 0.0, 0.0]))),
        cell_types=np.asarray(["tet4", "tet4"]),
        cell_offsets=np.asarray([0, 4, 8]),
        cell_nodes=np.asarray([0, 1, 2, 3, 4, 5, 6, 7]),
        element_markers=np.asarray([1, 0]),
        facet_types=np.asarray(["tri3"] * 8),
        facet_roles=np.asarray(["exterior"] * 8),
        facet_offsets=np.arange(0, 25, 3),
        facet_nodes=np.asarray(
            [
                0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3,
                4, 6, 5, 4, 5, 7, 5, 6, 7, 6, 4, 7,
            ]
        ),
        boundary_markers=np.asarray([10] * 8),
        cell_global_ordinals=np.asarray([1, 2]),
        facet_global_ordinals=np.arange(1, 9),
        cell_mesh_parts=np.asarray(["magnetic", "far_air"]),
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

    def test_meshdata_npz_round_trips_quality_reports(self) -> None:
        quality = MeshQualityReport(
            n_elements=1,
            sicn_min=0.5,
            sicn_max=0.5,
            sicn_mean=0.5,
            sicn_p5=0.5,
            sicn_histogram=[0, 1],
            gamma_min=0.4,
            gamma_mean=0.4,
            gamma_histogram=[0, 1],
            volume_min=1e-27,
            volume_max=1e-27,
            volume_mean=1e-27,
            volume_std=0.0,
            avg_quality=0.5,
            quality_source="test",
        )
        mesh = replace(_tetra_mesh(), quality=quality, per_domain_quality={1: quality})
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mesh.npz"
            mesh.save(path)
            loaded = MeshData.load(path)

        self.assertEqual(loaded.quality, quality)
        self.assertEqual(loaded.per_domain_quality, {1: quality})

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
            with zipfile.ZipFile(path, "r") as archive:
                members = {name: archive.read(name) for name in archive.namelist()}
            members["topology.npz"] = b"corrupt"
            with zipfile.ZipFile(path, "w") as archive:
                for name, payload in members.items():
                    archive.writestr(name, payload)
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

    def test_gmsh_import_without_sidecar_uses_explicit_semantic_maps(self) -> None:
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

            imported = import_gmsh_mesh(
                msh,
                coordinate_unit="m",
                region_map={"film": 1},
                boundary_map={"outer": 10, "film_air": 20},
            )

        self.assertEqual(imported.region_markers, [{"geometry_name": "film", "marker": 1}])
        self.assertEqual(imported.boundary_map, {"film_air": 20, "outer": 10})

    def test_gmsh_round_trip_preserves_fullmag_air_marker_zero(self) -> None:
        with TemporaryDirectory() as tmp:
            native = Path(tmp) / "shared.fullmag-mesh"
            msh = Path(tmp) / "shared.msh"
            save_mesh_artifact(
                native,
                mesh=_shared_domain_mesh(),
                mesh_name="study_domain",
                authoring_document={},
                region_markers=[{"geometry_name": "film", "marker": 1}],
                boundary_map={"outer": 10},
            )

            export_gmsh_mesh(load_mesh_artifact(native), msh)
            imported = import_gmsh_mesh(msh, coordinate_unit="m")

        self.assertEqual(sorted(imported.mesh.element_markers.tolist()), [0, 1])
        self.assertEqual(
            imported.mesh.cell_mesh_parts.tolist(),
            [
                "far_air" if marker == 0 else "magnetic"
                for marker in imported.mesh.element_markers.tolist()
            ],
        )

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

    def test_study_mesh_save_or_load_rebuilds_after_mesh_setting_changes(self) -> None:
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
                study.mesh.save_or_load(path)
            study.objects.mesh.defaults(maximum_element_size=2e-9)
            with patch(
                "fullmag.world._build_explicit_mesh_assets", return_value=assets
            ) as builder:
                result = study.mesh.save_or_load(path)

        self.assertEqual(result.action, "saved")
        self.assertTrue(result.mismatch_reasons)
        builder.assert_called_once()

    def test_study_mesh_export_and_import_bind_interchange_mesh(self) -> None:
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
            msh = Path(tmp) / "film.msh"
            study = fm.study("mesh-interchange")
            with patch("fullmag.world._build_explicit_mesh_assets", return_value=assets):
                exported = study.mesh.export(msh)
            fm.reset()
            study = fm.study("mesh-interchange")
            with patch("fullmag.world.Path.cwd", return_value=Path(tmp)):
                imported = study.mesh.import_(msh)
                rebound = study.mesh.save(Path(tmp) / "rebound.fullmag-mesh")
                rebound_exists = rebound.exists()

        self.assertEqual(exported, msh)
        self.assertEqual(imported.action, "imported")
        self.assertEqual(imported.path, msh)
        self.assertTrue(imported.topology_fingerprint.startswith("sha256:"))
        self.assertTrue(rebound_exists)

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
