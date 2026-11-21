from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from fullmag.runtime import helper as runtime_helper
from fullmag.meshing.gmsh_bridge import MeshData


FIXTURE = Path("examples/fem_reciprocal_m2_public.py")
MESH_GENERATOR = Path("examples/generate_fem_reciprocal_m2_public_mesh.py")
MESH_ASSET = Path("examples/fem_reciprocal_m2_public_mesh.npz")
MESH_MARKERS = {
    "left": 101,
    "right": 102,
    "back": 103,
    "front": 104,
    "bottom": 105,
    "top": 106,
}


class PublicFemReciprocalM2FixtureTests(unittest.TestCase):
    def export_run_config(self) -> dict[str, object]:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "export-run-config",
                    "--script",
                    str(FIXTURE),
                    "--backend",
                    "fem",
                    "--mode",
                    "strict",
                    "--precision",
                    "double",
                    "--skip-geometry-assets",
                ]
            )
        self.assertEqual(exit_code, 0)
        return json.loads(stdout.getvalue())

    def render_canonical_script(self, output_path: Path) -> str:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "rewrite-script",
                    "--script",
                    str(FIXTURE),
                    "--output",
                    str(output_path),
                ]
            )
        self.assertEqual(exit_code, 0)
        return output_path.read_text(encoding="utf-8")

    def test_public_fixture_preserves_fem_m2_graph_without_demag(self) -> None:
        config = self.export_run_config()
        self.assertEqual(len(config["stages"]), 1)
        stage_ir = config["stages"][0]["ir"]

        self.assertEqual(
            stage_ir["energy_terms"],
            [
                {"kind": "exchange"},
                {
                    "id": "oersted:m2_charge",
                    "kind": "oersted_field",
                    "model": "from_current_solution",
                    "source": "m2_charge",
                },
            ],
        )
        runtime_metadata = stage_ir["problem_meta"]["runtime_metadata"]
        self.assertIsNone(runtime_metadata.get("study_universe"))
        mesh_workflow = runtime_metadata["mesh_workflow"]
        self.assertEqual(mesh_workflow["build_target"], "mesh")
        self.assertIsNone(mesh_workflow.get("domain_mesh_mode"))
        body_mesh = next(
            entry for entry in mesh_workflow["per_geometry"]
            if entry["geometry"] == "m2_body"
        )
        self.assertEqual(body_mesh["source"], str(MESH_ASSET).replace("\\", "/"))
        self.assertEqual(body_mesh["order"], 1)
        charge_boundaries = stage_ir["current_modules"][0]["boundaries"]
        selectors_by_boundary = {
            boundary["id"]: [surface["surface_id"] for surface in boundary["surfaces"]]
            for boundary in charge_boundaries
        }
        self.assertEqual(selectors_by_boundary["source"], ["left"])
        self.assertEqual(selectors_by_boundary["drain"], ["right"])
        self.assertEqual(
            set(selectors_by_boundary["sidewalls"]),
            {"back", "front", "bottom", "top"},
        )
        self.assertEqual(stage_ir["current_modules"][0]["model"], "magnetoresistive_poisson")
        self.assertEqual(stage_ir["current_modules"][0]["coupling"], "bidirectional")
        self.assertEqual(
            stage_ir["current_modules"][0]["solver"]["operator_version"],
            "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        )
        # The FEM M2 planner (crates/fullmag-plan/src/spin_transport.rs,
        # resolve_m1_fem_spin_transport) accepts only these spin engines; the
        # charge block keeps block_gmres as ProblemIR requires.
        self.assertIn(stage_ir["spin_transport_modules"][0]["solver"]["engine"], {"auto", "gmres"})
        self.assertEqual(stage_ir["current_modules"][0]["solver"]["engine"], "block_gmres")
        self.assertEqual(
            stage_ir["spin_transport_modules"][0]["solver"]["operator_version"],
            "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        )
        self.assertEqual(stage_ir["spin_torque_modules"][0]["solve_id"], "m2_spin")
        self.assertEqual(
            stage_ir["physics_graph"]["edges"],
            [
                {
                    "kind": "current_to_oersted",
                    "source_id": "m2_charge",
                    "status": "active",
                    "target_id": "oersted:m2_charge",
                },
                {
                    "kind": "current_to_spin_transport",
                    "source_id": "m2_charge",
                    "status": "active",
                    "target_id": "m2_spin",
                },
                {
                    "kind": "spin_transport_to_torque",
                    "source_id": "m2_spin",
                    "status": "active",
                    "target_id": "m2_torque",
                },
            ],
        )

        runtime = stage_ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
        self.assertEqual(
            runtime,
            {
                "backend": "fem",
                "device": "cpu",
                "gpu_count": 0,
                "device_index": None,
                "cpu_threads": None,
                "execution_mode": "strict",
                "execution_precision": "double",
                "parallel_execution": {
                    "mode": "serial",
                    "max_cpu_percent": 90.0,
                    "max_memory_percent": 80.0,
                    "memory_reserve_bytes": 1073741824,
                    "max_workers": None,
                    "threads_per_worker": 1,
                },
            },
        )

    def test_public_mesh_asset_is_reproducible_and_tags_electrode_faces(self) -> None:
        generator_spec = importlib.util.spec_from_file_location(
            "fem_reciprocal_m2_public_mesh_generator", MESH_GENERATOR
        )
        self.assertIsNotNone(generator_spec)
        self.assertIsNotNone(generator_spec.loader)
        generator = importlib.util.module_from_spec(generator_spec)
        generator_spec.loader.exec_module(generator)

        shipped_mesh = MeshData.load(MESH_ASSET)
        with tempfile.TemporaryDirectory() as temporary_directory:
            reproduced_path = Path(temporary_directory) / MESH_ASSET.name
            generator.build_mesh_data().save(reproduced_path)
            reproduced_mesh = MeshData.load(reproduced_path)

        for field_name in (
            "nodes", "cell_types", "cell_offsets", "cell_nodes", "element_markers",
            "facet_types", "facet_roles", "facet_offsets", "facet_nodes",
            "boundary_markers", "cell_global_ordinals", "facet_global_ordinals",
            "cell_mesh_parts",
        ):
            with self.subTest(field=field_name):
                np.testing.assert_array_equal(
                    getattr(reproduced_mesh, field_name),
                    getattr(shipped_mesh, field_name),
                )

        bounds_min = shipped_mesh.nodes.min(axis=0)
        bounds_max = shipped_mesh.nodes.max(axis=0)
        face_axes = {
            "left": (0, bounds_min[0]),
            "right": (0, bounds_max[0]),
            "back": (1, bounds_min[1]),
            "front": (1, bounds_max[1]),
            "bottom": (2, bounds_min[2]),
            "top": (2, bounds_max[2]),
        }
        marker_sets: dict[str, set[int]] = {}
        for face_name, (axis, coordinate) in face_axes.items():
            markers = {
                int(marker)
                for index, marker in enumerate(shipped_mesh.boundary_markers)
                if np.allclose(
                    shipped_mesh.nodes[shipped_mesh.facet_node_ids(index), axis],
                    coordinate,
                    rtol=0.0,
                    atol=1.0e-24,
                )
            }
            marker_sets[face_name] = markers
            self.assertEqual(markers, {MESH_MARKERS[face_name]})

        self.assertTrue(marker_sets["left"].isdisjoint(marker_sets["right"]))
        self.assertEqual(
            set().union(*(marker_sets[name] for name in ("back", "front", "bottom", "top"))),
            {103, 104, 105, 106},
        )

    def test_canonical_script_export_is_repeatable_and_keeps_relative_mesh_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            first = self.render_canonical_script(root / "first.py")
            second = self.render_canonical_script(root / "second.py")

        self.assertEqual(first, second)
        self.assertIn('source="examples/fem_reciprocal_m2_public_mesh.npz"', first)
        self.assertIn('SurfaceRef("m2_body", "left"', first)
        self.assertIn('SurfaceRef("m2_body", "right"', first)
        self.assertIn("study.build_mesh()", first)


if __name__ == "__main__":
    unittest.main()
