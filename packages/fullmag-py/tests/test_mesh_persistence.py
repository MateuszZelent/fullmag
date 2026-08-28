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
    MeshArtifactVersionError,
    MeshConfigurationMismatch,
    MeshSemanticMappingError,
    export_comsol_mesh,
    export_gmsh_mesh,
    import_comsol_mesh,
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


def _mixed_linear_mesh() -> MeshData:
    cells = [
        (
            "tet4",
            [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)],
            [(0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)],
        ),
        (
            "prism6",
            [(3, 0, 0), (4, 0, 0), (3, 1, 0), (3, 0, 1), (4, 0, 1), (3, 1, 1)],
            [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)],
        ),
        (
            "pyramid5",
            [(6, 0, 0), (7, 0, 0), (7, 1, 0), (6, 1, 0), (6.5, 0.5, 1)],
            [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)],
        ),
        (
            "hex8",
            [
                (9, 0, 0), (10, 0, 0), (10, 1, 0), (9, 1, 0),
                (9, 0, 1), (10, 0, 1), (10, 1, 1), (9, 1, 1),
            ],
            [
                (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
            ],
        ),
    ]
    nodes: list[tuple[float, float, float]] = []
    cell_types: list[str] = []
    cell_offsets = [0]
    cell_nodes: list[int] = []
    facet_types: list[str] = []
    facet_offsets = [0]
    facet_nodes: list[int] = []
    for kind, points, faces in cells:
        base = len(nodes)
        nodes.extend(points)
        cell_types.append(kind)
        cell_nodes.extend(range(base, base + len(points)))
        cell_offsets.append(len(cell_nodes))
        for face in faces:
            facet_types.append("tri3" if len(face) == 3 else "quad4")
            facet_nodes.extend(base + node for node in face)
            facet_offsets.append(len(facet_nodes))
    return MeshData(
        nodes=np.asarray(nodes, dtype=np.float64) * 1e-9,
        cell_types=np.asarray(cell_types),
        cell_offsets=np.asarray(cell_offsets),
        cell_nodes=np.asarray(cell_nodes),
        element_markers=np.ones(len(cell_types), dtype=np.int32),
        facet_types=np.asarray(facet_types),
        facet_roles=np.asarray(["exterior"] * len(facet_types)),
        facet_offsets=np.asarray(facet_offsets),
        facet_nodes=np.asarray(facet_nodes),
        boundary_markers=np.full(len(facet_types), 10, dtype=np.int32),
        cell_global_ordinals=np.arange(len(cell_types)),
        facet_global_ordinals=np.arange(len(facet_types)),
        cell_mesh_parts=np.asarray(["magnetic"] * len(cell_types)),
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
                boundary_map={"outer": 10, "film_air": 20},
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
                boundary_map={"outer": 10, "film_air": 20},
            )
            with zipfile.ZipFile(path, "r") as archive:
                members = {name: archive.read(name) for name in archive.namelist()}
            members["topology.npz"] = b"corrupt"
            with zipfile.ZipFile(path, "w") as archive:
                for name, payload in members.items():
                    archive.writestr(name, payload)
            with self.assertRaisesRegex(MeshArtifactCorruptionError, "topology.npz"):
                load_mesh_artifact(path)

    def test_native_load_rejects_unsupported_schema(self) -> None:
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
            with zipfile.ZipFile(path, "r") as archive:
                members = {name: archive.read(name) for name in archive.namelist()}
            manifest = __import__("json").loads(members["manifest.json"])
            manifest["schema"] = "fullmag.mesh-artifact.v3"
            members["manifest.json"] = __import__("json").dumps(manifest).encode()
            with zipfile.ZipFile(path, "w") as archive:
                for name, payload in members.items():
                    archive.writestr(name, payload)

            with self.assertRaisesRegex(MeshArtifactVersionError, "v3"):
                load_mesh_artifact(path)

    def test_native_save_rejects_incomplete_semantic_maps(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            with self.assertRaisesRegex(MeshSemanticMappingError, "boundary markers"):
                save_mesh_artifact(
                    path,
                    mesh=_tetra_mesh(),
                    mesh_name="study_domain",
                    authoring_document={},
                    region_markers=[{"geometry_name": "film", "marker": 1}],
                    boundary_map={"outer": 10},
                )

    def test_native_load_rejects_incomplete_semantic_maps(self) -> None:
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
            with zipfile.ZipFile(path, "r") as archive:
                members = {name: archive.read(name) for name in archive.namelist()}
            manifest = __import__("json").loads(members["manifest.json"])
            manifest["boundary_map"] = {"outer": 10}
            members["manifest.json"] = __import__("json").dumps(manifest).encode()
            with zipfile.ZipFile(path, "w") as archive:
                for name, payload in members.items():
                    archive.writestr(name, payload)

            with self.assertRaisesRegex(MeshSemanticMappingError, "boundary markers"):
                load_mesh_artifact(path)

    def test_native_save_preserves_existing_artifact_when_replace_fails(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "film.fullmag-mesh"
            arguments = {
                "mesh": _tetra_mesh(),
                "mesh_name": "study_domain",
                "authoring_document": {},
                "region_markers": [{"geometry_name": "film", "marker": 1}],
                "boundary_map": {"outer": 10, "film_air": 20},
            }
            save_mesh_artifact(path, **arguments)
            original = path.read_bytes()

            with patch("fullmag.meshing.persistence.os.replace", side_effect=OSError("stop")):
                with self.assertRaisesRegex(OSError, "stop"):
                    save_mesh_artifact(path, **arguments)

            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(tmp).glob(".*.tmp")), [])

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

    def test_comsol_mphtxt_export_and_import_preserve_semantic_groups(self) -> None:
        with TemporaryDirectory() as tmp:
            native = Path(tmp) / "film.fullmag-mesh"
            mphtxt = Path(tmp) / "film.mphtxt"
            save_mesh_artifact(
                native,
                mesh=_tetra_mesh(),
                mesh_name="study_domain",
                authoring_document={},
                region_markers=[{"geometry_name": "film", "marker": 1}],
                boundary_map={"outer": 10, "film_air": 20},
            )

            export_comsol_mesh(load_mesh_artifact(native), mphtxt)
            exported_text = mphtxt.read_text(encoding="utf-8")
            sidecar = __import__("json").loads(
                Path(f"{mphtxt}.fullmag.json").read_text(encoding="utf-8")
            )
            imported = import_comsol_mesh(mphtxt)

        self.assertIn("4 Mesh # class", exported_text)
        self.assertEqual(imported.region_markers, [{"geometry_name": "film", "marker": 1}])
        self.assertEqual(imported.boundary_map, {"film_air": 20, "outer": 10})
        self.assertEqual(imported.mesh.cell_types.tolist(), ["tet4"])
        self.assertEqual(imported.mesh.facet_types.tolist(), ["tri3"] * 4)
        np.testing.assert_allclose(imported.mesh.nodes, _tetra_mesh().nodes)
        self.assertEqual(sidecar["cell_global_ordinals"], [41])
        self.assertEqual(sidecar["facet_global_ordinals"], [51, 52, 53, 54])
        self.assertEqual(sidecar["cell_mesh_parts"], ["magnetic"])

    def test_interchange_round_trips_all_supported_linear_element_families(self) -> None:
        mesh = _mixed_linear_mesh()
        with TemporaryDirectory() as tmp:
            native = Path(tmp) / "mixed.fullmag-mesh"
            save_mesh_artifact(
                native,
                mesh=mesh,
                mesh_name="study_domain",
                authoring_document={},
                region_markers=[{"geometry_name": "mixed", "marker": 1}],
                boundary_map={"outer": 10},
            )
            artifact = load_mesh_artifact(native)
            msh = export_gmsh_mesh(artifact, Path(tmp) / "mixed.msh")
            mphtxt = export_comsol_mesh(artifact, Path(tmp) / "mixed.mphtxt")
            gmsh_imported = import_gmsh_mesh(msh)
            comsol_imported = import_comsol_mesh(mphtxt)

        expected = {"tet4", "prism6", "pyramid5", "hex8"}
        self.assertEqual(set(gmsh_imported.mesh.cell_types.tolist()), expected)
        self.assertEqual(set(comsol_imported.mesh.cell_types.tolist()), expected)
        self.assertEqual(set(gmsh_imported.mesh.facet_types.tolist()), {"tri3", "quad4"})
        self.assertEqual(set(comsol_imported.mesh.facet_types.tolist()), {"tri3", "quad4"})

    def test_study_mesh_auto_dispatches_comsol_mphtxt(self) -> None:
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
            path = Path(tmp) / "film.mphtxt"
            study = fm.study("comsol-interchange")
            with patch("fullmag.world._build_explicit_mesh_assets", return_value=assets):
                study.mesh.export(path)
            fm.reset()
            study = fm.study("comsol-interchange")
            imported = study.mesh.import_(path)

        self.assertEqual(imported.action, "imported")
        self.assertEqual(imported.path, path)

    def test_comsol_import_without_sidecar_requires_explicit_entity_maps(self) -> None:
        with TemporaryDirectory() as tmp:
            native = Path(tmp) / "film.fullmag-mesh"
            mphtxt = Path(tmp) / "film.mphtxt"
            save_mesh_artifact(
                native,
                mesh=_tetra_mesh(),
                mesh_name="study_domain",
                authoring_document={},
                region_markers=[{"geometry_name": "film", "marker": 1}],
                boundary_map={"outer": 10, "film_air": 20},
            )
            export_comsol_mesh(load_mesh_artifact(native), mphtxt)
            Path(f"{mphtxt}.fullmag.json").unlink()

            with self.assertRaisesRegex(MeshSemanticMappingError, "entity_map"):
                import_comsol_mesh(
                    mphtxt,
                    region_map={"film": 1},
                    boundary_map={"outer": 10, "film_air": 20},
                    coordinate_unit="m",
                )
            with self.assertRaisesRegex(MeshSemanticMappingError, "boundary markers"):
                import_comsol_mesh(
                    mphtxt,
                    region_map={"film": 1},
                    boundary_map={"outer": 10, "film_air": 20},
                    region_entity_map={1: 1},
                    boundary_entity_map={0: 10},
                    coordinate_unit="m",
                )
            imported = import_comsol_mesh(
                mphtxt,
                region_map={"film": 1},
                boundary_map={"outer": 10, "film_air": 20},
                region_entity_map={1: 1},
                boundary_entity_map={0: 10, 1: 20},
                coordinate_unit="m",
            )

        self.assertEqual(imported.mesh.element_markers.tolist(), [1])
        self.assertEqual(imported.mesh.boundary_markers.tolist(), [10, 10, 10, 20])

    def test_comsol_import_accepts_complete_fixture_created_by_comsol(self) -> None:
        fixture = (
            Path(__file__).parent
            / "fixtures"
            / "comsol"
            / "testmesh-created-by-comsol-v4.mphtxt"
        )
        imported = import_comsol_mesh(
            fixture,
            region_map={"cube": 1},
            boundary_map={f"face_{entity}": 10 + entity for entity in range(6)},
            region_entity_map={1: 1},
            boundary_entity_map={entity: 10 + entity for entity in range(6)},
            coordinate_unit="m",
        )

        self.assertEqual(imported.mesh.n_nodes, 29)
        self.assertEqual(imported.mesh.n_elements, 58)
        self.assertEqual(imported.mesh.n_boundary_faces, 48)
        self.assertEqual(set(imported.mesh.cell_types.tolist()), {"tet4"})
        self.assertEqual(set(imported.mesh.facet_types.tolist()), {"tri3"})
        self.assertEqual(
            imported.provenance,
            {
                "origin": "comsol_import",
                "source": str(fixture),
                "source_sha256": (
                    "1bb2bfacbf92f60767b059f5bfe4b3de769ae040b393ccaae425394a36730f8d"
                ),
                "comsol_mesh_serialization_version": 4,
            },
        )

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

    def test_gmsh_import_rejects_unsupported_sidecar_schema(self) -> None:
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
            sidecar = Path(f"{msh}.fullmag.json")
            payload = __import__("json").loads(sidecar.read_text(encoding="utf-8"))
            payload["schema"] = "fullmag.mesh-interchange.v2"
            sidecar.write_text(__import__("json").dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(MeshArtifactVersionError, "interchange.v2"):
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

    def test_study_mesh_save_or_load_materializes_real_shared_domain(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "domain.fullmag-mesh"
            study = fm.study("real-mesh-persistence")
            study.engine("fem")
            study.universe(
                mode="auto",
                size=(24e-9, 20e-9, 12e-9),
                center=(0.0, 0.0, 0.0),
                padding=(0.0, 0.0, 0.0),
            )
            study.universe.mesh(maximum_element_size=8e-9)
            body = study.geometry(fm.Box(16e-9, 12e-9, 4e-9), name="body")
            body.mesh(maximum_element_size=4e-9, order=1)

            first = study.mesh.save_or_load(path)
            fm.reset()
            study = fm.study("real-mesh-persistence")
            study.engine("fem")
            study.universe(
                mode="auto",
                size=(24e-9, 20e-9, 12e-9),
                center=(0.0, 0.0, 0.0),
                padding=(0.0, 0.0, 0.0),
            )
            study.universe.mesh(maximum_element_size=8e-9)
            body = study.geometry(fm.Box(16e-9, 12e-9, 4e-9), name="body")
            body.mesh(maximum_element_size=4e-9, order=1)
            second = study.mesh.save_or_load(path)

        self.assertEqual(first.action, "saved")
        self.assertEqual(second.action, "loaded")
        self.assertEqual(first.topology_fingerprint, second.topology_fingerprint)

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
                implicit_cache_exists = (
                    Path(tmp) / ".fullmag" / "local" / "cache" / "imported_meshes"
                ).exists()
                rebound = study.mesh.save(Path(tmp) / "rebound.fullmag-mesh")
                rebound_exists = rebound.exists()

        self.assertEqual(exported, msh)
        self.assertEqual(imported.action, "imported")
        self.assertEqual(imported.path, msh)
        self.assertTrue(imported.topology_fingerprint.startswith("sha256:"))
        self.assertFalse(implicit_cache_exists)
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
