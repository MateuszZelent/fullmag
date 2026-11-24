"""Readonly frozen-source authoring regressions; no native solve or authentication claim."""
import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import numpy as np
import fullmag as fm
from fullmag.runtime.antenna_source_preparation import decode_source_preparation, MAX_ASSET_BYTES
from fullmag.runtime.antenna_coincident_materialization import _material_binding, _exact_identity_preimage
from fullmag.runtime.script_builder import _render_antenna_field_solve_definition_expr, _source_preparation_capture_records
from fullmag.runtime.transport_identity import tagged_json_digest
from test_antenna_surface_policy import authored_problem, surface_stage
from test_antenna_coincident_cut import full_loop_mesh


def document_fixture():
    problem = authored_problem()
    geometry = problem.auxiliary_geometries[0]
    mesh, _, ids = full_loop_mesh()
    markers = np.arange(mesh.n_elements) % 4 + 1
    mesh = replace(mesh, element_markers=markers)
    parts, materials = _material_binding(problem.current_modules[0], geometry, mesh, "object")
    cut = {"id": "cut", "translation_m": [0., 0., 0.], "potential_drop_v": 0.25,
           "face_pairs": [{"minus_face_vertex_ids": list(ids[:3]), "plus_face_vertex_ids": list(ids[3:6])}]}
    closure = {"kind": "closed_geometry", "operator_version": "fem_closed_current_geometry.v2",
               "revision": "sha256:" + "b" * 64, "digest": "sha256:" + "b" * 64, "source_cuts": [cut]}
    observations = [{"id": "signal-in", "part_id": "signal", "selector": "local_u_min",
        "faces": [{"face_vertex_ids": list(ids[:3]), "part_cell_ordinal": 0, "bridge_cell_ordinal": 1}],
        "normal_convention": "outward_from_part"}]
    prepared = {"schema_version": "conservative_current_source.v2", "revision": "sha256:" + "b" * 64,
        "object_id": "object", "geometry_id": geometry.geometry_name, "mesh_digest": "sha256:" + "c" * 64,
        "authored_input_digest": "sha256:" + "b" * 64, "materials_digest": materials,
        "stable_vertex_ids": list(ids), "closure": closure, "material_parts": parts, "terminal_observations": observations}
    definition = problem.current_modules[0]
    preimage = {"schema": "antenna_coincident_prepared_input.v2", "object_id": "object",
        "geometry": geometry.to_ir(), "authored_closure": definition.structured_current_closure.to_ir(),
        "mesh_digest": prepared["mesh_digest"], "stable_vertex_ids": list(map(str, ids)),
        "closure": _exact_identity_preimage({key: value for key, value in closure.items() if key not in {"revision", "digest"}}),
        "materials_digest": materials, "material_parts": _exact_identity_preimage(parts),
        "terminal_observations": _exact_identity_preimage(observations), "port": problem.antenna_port_modes[0].to_ir(),
        "gauge": definition.gauge.to_ir(), "solver": definition.solver.to_ir(),
        "requested_execution": {}, "backend_policy": {}, "validation_profile": {}, "mesh_workflow": {}, "per_object_recipes": {}}
    locator = fm.AntennaRetainedCurrentSource(project_id="project-source", run_id="run-source", task_id="task-source",
        attempt_id="attempt-source", ownership_epoch="1", artifact_id="artifact-source", object_ref="a" * 64)
    owner = {key: value for key, value in locator.to_ir().items() if key not in {"kind", "object_ref"}}
    owner.update(study_step_id="step-source", native_stage_id="solve",
        package={"object_ref": locator.object_ref, "byte_count": 1},
        package_codec_id="fullmag.antenna.closed_loop_bundle", package_codec_version="v1", manifest_schema="antenna_field_solution.v2",
        output_manifest_artifact_id="artifact-manifest", output_manifest={"object_ref": "d" * 64, "byte_count": 1})
    mesh_ir = mesh.to_ir(geometry.geometry_name)
    mesh_ir.pop("mesh_statistics", None)
    document = {"schema_version": "antenna_source_preparation_asset.v1", "parent_owner": owner,
        "source_pins": {key: "sha256:" + "a" * 64 for key in ("prepared_execution_digest", "accepted_charge_field_digest", "accepted_source_state_digest", "view_identity_digest", "current_balance_certificate_digest")},
        "source_mesh": mesh_ir, "prepared_source": prepared,
        "source_object_segments": [{"object_id": "object", "geometry_id": geometry.geometry_name,
            "node_start": 0, "node_count": mesh.n_nodes, "element_start": 0, "element_count": mesh.n_elements,
            "boundary_face_start": 0, "boundary_face_count": mesh.n_boundary_faces}],
        "authored_input_preimage": preimage,
        "source_preparation": {"receipt_schema_version": "task_preparation_receipt.v1", "run_id": "run-source", "task_id": "task-source",
            "step_id": "step-source", "input_fingerprint": "a" * 64, "preparation_id": "prep-task-source", "plan_fingerprint": "sha256:" + "a" * 64,
            "payload_sha256": "b" * 64, "receipt_sha256": "c" * 64}}
    return problem, locator, document


class SourcePreparationAssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="source-preparation-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.problem, self.locator, self.document = document_fixture()
        self.path = self.root / "source.json"
        self.write(self.document)

    def write(self, document):
        payload = json.dumps(document, separators=(",", ":"), allow_nan=False).encode()
        self.path.write_bytes(payload)
        self.asset = fm.AntennaSourcePreparationAsset(self.path, hashlib.sha256(payload).hexdigest())
        self.stage = replace(surface_stage(), retained_current_source=self.locator, retained_source_preparation=self.asset)
        return payload

    def test_asset_identity_and_stage_omission(self):
        expected = "script-file-" + hashlib.sha256(b"source/source.json").hexdigest()
        self.assertEqual(self.asset.to_ir(source_root=self.root), {"asset_id": expected, "content_sha256": self.asset.content_sha256})
        self.assertNotIn("retained_source_preparation", surface_stage().to_ir())
        with self.assertRaises(ValueError):
            replace(surface_stage(), retained_source_preparation=self.asset)
        with self.assertRaises(ValueError):
            fm.AntennaSourcePreparationAsset(self.path, "A" * 64)
        with self.assertRaises(TypeError):
            replace(self.stage, retained_source_preparation={})

    def test_strict_document_and_all_nine_receipt_pins(self):
        self.assertEqual(decode_source_preparation(self.path.read_bytes()), self.document)
        for key in self.document["source_preparation"]:
            value = copy.deepcopy(self.document)
            del value["source_preparation"][key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                decode_source_preparation(json.dumps(value).encode())
        for payload in (b'{"schema_version":1,"schema_version":2}', b'{"x":NaN}', b" " * (MAX_ASSET_BYTES + 1)):
            with self.assertRaises(ValueError):
                decode_source_preparation(payload)
        value = copy.deepcopy(self.document); value["H"] = []
        with self.assertRaises(ValueError):
            decode_source_preparation(json.dumps(value).encode())

    def test_frozen_lowering_never_calls_mesh_cache_or_native_preparation(self):
        problem = replace(self.problem, antenna_field_solve_stages=[self.stage])
        with patch("fullmag.model.problem._fem_mesh_cache_dir", side_effect=AssertionError("cache mkdir")), patch("fullmag.meshing._antenna_coincident_cut.prepare_antenna_coincident_loop", side_effect=AssertionError("new preparation")):
            lowered = problem.to_ir(source_root=self.root)
        source = lowered["current_modules"][0]["conservative_current_source"]
        self.assertEqual(source["kind"], "retained_preparation_asset")
        self.assertEqual(source["historical_prepared_source"], self.document["prepared_source"])
        self.assertEqual(lowered["geometry_assets"]["fem_mesh_assets"][0]["mesh"], self.document["source_mesh"])
        self.assertNotIn("antenna_coincident_preparations", lowered["problem_meta"]["runtime_metadata"])
        self.assertEqual(self.document["authored_input_preimage"]["mesh_workflow"], {})

    def test_hash_parent_and_explicit_source_policy_refusals_precede_geometry(self):
        problem = replace(self.problem, antenna_field_solve_stages=[self.stage])
        with patch("fullmag.model.problem.build_geometry_assets_for_request", side_effect=AssertionError("geometry work")):
            self.path.write_bytes(self.path.read_bytes() + b" ")
            with self.assertRaisesRegex(ValueError, "content_sha256"):
                problem.to_ir(source_root=self.root)
            self.write(self.document)
            wrong = replace(self.stage, retained_current_source=replace(self.locator, attempt_id="another"))
            with self.assertRaisesRegex(ValueError, "another retained parent"):
                replace(problem, antenna_field_solve_stages=[wrong]).to_ir(source_root=self.root)
            problem = replace(problem, antenna_field_solve_stages=[self.stage], runtime_metadata={"mesh_workflow": {"per_geometry": [{"geometry": "loop", "mode": "custom", "hmax": 1e-6}]}})
            with self.assertRaisesRegex(ValueError, "mesh policy"):
                problem.to_ir(source_root=self.root)

    def test_relax_run_and_source_physics_changes_refuse_before_geometry(self):
        problem = replace(self.problem, antenna_field_solve_stages=[self.stage])
        with patch("fullmag.model.problem.build_geometry_assets_for_request", side_effect=AssertionError("geometry work")):
            for study in (fm.Relaxation(outputs=[]), fm.TimeEvolution(fm.LLG(), outputs=[])):
                with self.subTest(study=type(study).__name__), self.assertRaisesRegex(ValueError, "H-only"):
                    from fullmag.runtime.antenna_source_preparation import resolve_source_preparations
                    resolve_source_preparations(SimpleNamespace(study=study, antenna_field_solve_stages=[self.stage]),
                        source_root=self.root, mesh_workflow=None, runtime=problem.runtime, discretization=problem.discretization)
            geometry = replace(problem.auxiliary_geometries[0], return_width_m=2e-6)
            with self.assertRaisesRegex(ValueError, "authored geometry"):
                replace(problem, auxiliary_geometries=[geometry]).to_ir(source_root=self.root)
            module = problem.current_modules[0]
            assignment = replace(module.materials[0], material=fm.ChargeTransportMaterial(1.))
            changed = replace(module, materials=[assignment, *module.materials[1:]])
            with self.assertRaisesRegex(ValueError, "conductivity"):
                replace(problem, current_modules=[changed]).to_ir(source_root=self.root)

    def test_explicit_universe_carrier_stays_separate_from_frozen_source(self):
        from fullmag.meshing.persistence import save_mesh_artifact
        mesh = full_loop_mesh()[0]
        target = replace(mesh, nodes=mesh.nodes + np.asarray([0., 0., 5e-6]), element_markers=np.ones(mesh.n_elements, dtype=np.int32))
        path = self.root / "universe.fullmag-mesh"
        save_mesh_artifact(path, mesh=target, mesh_name="universe", authoring_document={}, region_markers=[{"geometry_name": "loop", "marker": 1}], boundary_map={"outer": 1})
        problem = replace(self.problem, antenna_field_solve_stages=[self.stage], runtime_metadata={"mesh_workflow": {
            "build_target": "domain", "domain_mesh_mode": "explicit_shared_domain_mesh",
            "domain_mesh_source": str(path), "domain_region_markers": [{"geometry_name": "loop", "marker": 1}]}})
        with patch("fullmag.model.problem._fem_mesh_cache_dir", side_effect=AssertionError("cache mkdir")), patch("fullmag.meshing._antenna_coincident_cut.prepare_antenna_coincident_loop", side_effect=AssertionError("new source")):
            ir = problem.to_ir(source_root=self.root)
        self.assertEqual(ir["geometry_assets"]["fem_mesh_assets"][0]["mesh"], self.document["source_mesh"])
        self.assertEqual(ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]["nodes"], target.nodes.tolist())
        self.assertNotEqual(ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]["nodes"], self.document["source_mesh"]["nodes"])
        self.assertEqual(ir["current_modules"][0]["conservative_current_source"]["historical_prepared_source"], self.document["prepared_source"])

    def test_actual_readonly_capture_exports_without_source_cache_mutation(self):
        import subprocess
        import sys
        from fullmag.runtime.loader import LoadedProblem, LoadedStage
        from fullmag.runtime.script_builder import render_loaded_problem_as_script
        from fullmag.meshing.persistence import save_mesh_artifact
        mesh = full_loop_mesh()[0]
        target = replace(mesh, nodes=mesh.nodes + np.asarray([0., 0., 5e-6]), element_markers=np.zeros(mesh.n_elements, dtype=np.int32))
        target_path = self.root / "universe.fullmag-mesh"
        save_mesh_artifact(target_path, mesh=target, mesh_name="universe", authoring_document={},
            region_markers=[], boundary_map={"outer": 1})
        problem = replace(self.problem, antenna_field_solve_stages=[self.stage], runtime_metadata={"script_api_surface": "study", "mesh_workflow": {
            "build_target": "domain", "domain_mesh_mode": "explicit_shared_domain_mesh",
            "domain_mesh_source": str(target_path), "domain_region_markers": []}})
        action = {"kind": "antenna_field_solve", "definition": self.stage.to_ir(source_root=self.root)}
        loaded = LoadedProblem(problem=problem, source_path=self.root / "author.py", script_source="", entrypoint_kind="flat_workspace",
            stages=(LoadedStage(problem=problem, entrypoint_kind="flat_antenna_field_solve", action=action),))
        script = self.root / "author.py"
        rendered = render_loaded_problem_as_script(loaded)
        self.assertIn("region_markers=[]", rendered)
        script.write_text(rendered)
        capture = Path(fm.__file__).parent / "runtime" / "accepted_source_capture.py"
        arguments = [sys.executable, "-B", str(capture), "--script", str(script), "--fullmag-root", str(Path(fm.__file__).parent)]
        inventory = subprocess.run([*arguments, "--phase", "inventory"], capture_output=True, text=True, timeout=60)
        self.assertEqual(inventory.returncode, 0, inventory.stderr)
        pins = json.loads(inventory.stdout)["capture"]
        result = subprocess.run([*arguments, "--phase", "export", "--expected-inventory", pins["inventory_sha256"]], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        captured = json.loads(result.stdout)
        self.assertIn("source/source.json", captured["capture"]["observed_reads"])
        self.assertIn("source/universe.fullmag-mesh", captured["capture"]["observed_reads"])
        self.assertLessEqual(captured["capture"]["runtime"]["source_bytes"], MAX_ASSET_BYTES)
        self.assertEqual(captured["config"]["ir"]["current_modules"][0]["conservative_current_source"]["kind"], "retained_preparation_asset")
        self.assertFalse((self.root / ".fullmag").exists())

    def test_loaded_and_scene_export_preserve_asset_id_and_real_source_path(self):
        from fullmag.runtime.loader import LoadedProblem, LoadedStage, load_problem_from_script
        from fullmag.runtime.script_builder import render_loaded_problem_as_script, export_builder_draft, render_scene_document_as_script
        from fullmag.runtime.scene_document import build_scene_document_from_builder
        problem = replace(self.problem, antenna_field_solve_stages=[self.stage])
        action = {"kind": "antenna_field_solve", "definition": self.stage.to_ir(source_root=self.root)}
        loaded = LoadedProblem(problem=problem, source_path=self.root / "author.py", script_source="", entrypoint_kind="flat_workspace",
            stages=(LoadedStage(problem=problem, entrypoint_kind="flat_antenna_field_solve", action=action),))
        records = _source_preparation_capture_records(loaded)
        script = render_loaded_problem_as_script(loaded)
        self.assertIn("AntennaSourcePreparationAsset", script)
        path = self.root / "roundtrip.py"
        path.write_text(script)
        imported = load_problem_from_script(path, lightweight_assets=True)
        self.assertEqual(imported.problem.antenna_field_solve_stages[0].to_ir(source_root=self.root), action["definition"])
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        scene_script = render_scene_document_as_script(scene, source_preparation_assets=records)
        path.write_text(scene_script)
        imported = load_problem_from_script(path, lightweight_assets=True)
        self.assertEqual(imported.problem.antenna_field_solve_stages[0].to_ir(source_root=self.root), action["definition"])

    def test_helper_cli_and_scene_ir_consume_only_the_supplied_capture_closure(self):
        import subprocess
        import sys
        from fullmag.runtime.loader import LoadedProblem, LoadedStage
        from fullmag.runtime.script_builder import export_builder_draft
        from fullmag.runtime.scene_document import build_scene_document_from_builder
        from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir, scene_document_to_execution_config
        problem = replace(self.problem, antenna_field_solve_stages=[self.stage])
        action = {"kind": "antenna_field_solve", "definition": self.stage.to_ir(source_root=self.root)}
        loaded = LoadedProblem(problem=problem, source_path=self.root / "author.py", script_source="", entrypoint_kind="flat_workspace",
            stages=(LoadedStage(problem=problem, entrypoint_kind="flat_antenna_field_solve", action=action),))
        records = _source_preparation_capture_records(loaded)
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        scene_path, records_path = self.root / "scene.json", self.root / "capture-records.json"
        scene_path.write_text(json.dumps(scene)); records_path.write_text(json.dumps(records))
        args = [sys.executable, "-B", "-m", "fullmag.runtime.helper", "render-scene-document", "--scene-json", str(scene_path), "--output", str(self.root / "export.py")]
        refused = subprocess.run(args, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("immutable input closure", refused.stderr)
        accepted = subprocess.run([*args, "--source-preparation-assets-json", str(records_path)], capture_output=True, text=True, timeout=30)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        result = scene_document_to_problem_ir(scene, requested_backend="fem", requested_device="cpu", requested_precision="double", requested_mode="strict",
            source_root=self.root, source_preparation_assets=records)
        # The geometry-light base excludes inert operations. The canonical
        # config inventory preserves them for the later typed action binding.
        self.assertEqual(result["antenna_field_solve_stages"], [])
        config = scene_document_to_execution_config(scene, requested_backend="fem", requested_device="cpu", requested_precision="double", requested_mode="strict",
            source_root=self.root, source_preparation_assets=records)
        self.assertEqual(config["antenna_inventory"]["antenna_field_solve_stages"][0]["retained_source_preparation"], action["definition"]["retained_source_preparation"])
        with self.assertRaisesRegex(ValueError, "root differs"):
            scene_document_to_problem_ir(scene, requested_backend="fem", requested_device="cpu", requested_precision="double", requested_mode="strict",
                source_root=self.root / "another-root", source_preparation_assets=records)

    def test_export_requires_exact_real_immutable_closure(self):
        reference = self.stage.to_ir(source_root=self.root)
        with self.assertRaisesRegex(ValueError, "immutable input closure"):
            _render_antenna_field_solve_definition_expr(reference)
        loaded = SimpleNamespace(source_path=self.root / "author.py", problem=replace(self.problem, antenna_field_solve_stages=[self.stage]), workspace_problem=None, stages=[])
        records = _source_preparation_capture_records(loaded)
        expression = _render_antenna_field_solve_definition_expr(reference, source_preparation_assets=records)
        self.assertIn(str(self.path), expression)
        restored = eval(expression, {"fm": fm})
        self.assertEqual(restored.to_ir(source_root=self.root), reference)
        records[next(iter(records))]["sha256"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "identity differs"):
            _render_antenna_field_solve_definition_expr(reference, source_preparation_assets=records)


if __name__ == "__main__":
    unittest.main()
