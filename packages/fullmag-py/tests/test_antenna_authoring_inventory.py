"""Interpreted declaration/execution separation; symbolic fixtures never solve fields or LLG."""
import faulthandler
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import fullmag.world as world
from fullmag.model.domain_frame import build_domain_frame

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.helper import main as helper_main
from fullmag.model._incomplete import IncompletePhysicsError


BASE = """
import fullmag as fm
from dataclasses import replace
study = fm.study('antenna-inventory-regression')
study.engine('fdm')
study.device('cpu', precision='double')
study.objects.mesh.defaults(cell_size=(10e-9,10e-9,10e-9))
study.disable_demag()
film=study.geometry(fm.Box(100e-9,40e-9,10e-9),name='film')
film.Ms=800e3
film.Aex=13e-12
film.alpha=0.01
study.antenna_object(fm.Box(200e-9,20e-9,10e-9),name='antenna',object_id='antenna')
study.add_antenna_port_mode(port_mode=fm.AntennaPortMode(id='port',source_object_id='antenna',current_transport_id='transport',branches=(fm.AntennaPortBranch('signal','signal-in','signal-out',1),fm.AntennaPortBranch('return','return-in','return-out',-1))))
definition=fm.AntennaFieldSolveStage(id='solve',source_object_id='antenna',current_transport_id='transport',port_mode_ids=('port',),conservative_current_view_ref='transport:rt0',field_sampling_domain=fm.FieldTarget.global_domain(),target_refs=(fm.FieldTarget.object('film'),),outputs=(fm.AntennaNamedOutput('basis','H_ant_basis'),))
solution=fm.AntennaStageOutputRef('solve','basis')
projection=fm.AntennaTargetProjection(id='projection',solution=solution,target=fm.FieldTarget.object('film'),output_id='projected')
drive=fm.SolvedAntennaDrive(id='drive',name='Symbolic drive',projection_ref='projection',port_mode_id='port',peak_current_a=0.01,waveform=fm.Sinusoidal(frequency_hz=1e9))
request=fm.AntennaSpectrumRequest(id='spectrum',solution_ref=solution,port_mode_id='port',target=fm.FieldTarget.global_domain(),transform='spatial_fft',sampling_plane=fm.AntennaSpectrumSamplingPlane(origin_m=(0,0,0),axis_u=(1,0,0),axis_v=(0,1,0),extent_u_m=200e-9,extent_v_m=100e-9,sample_count_u=8,sample_count_v=8),window='rectangular',normalization='integral_si',component='u',output_id='spectrum-output')
"""
DECLARE = """
study.declare_antenna_field_solve(definition=definition)
study.declare_antenna_target_projection(projection=projection)
study.declare_solved_antenna_drive(drive=drive)
study.declare_antenna_spectrum_request(request=request)
"""
COLLECTIONS = ("antenna_field_solve_stages", "antenna_target_projections", "solved_antenna_drives", "antenna_spectrum_requests")


class AntennaAuthoringInventoryTests(unittest.TestCase):
    def setUp(self):
        root = Path(os.environ["FULLMAG_TEST_TEMP_ROOT"]).resolve(strict=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.previous_tempdir = tempfile.tempdir
        tempfile.tempdir = str(root)
        self.addCleanup(setattr, tempfile, "tempdir", self.previous_tempdir)
        self.counter = 0

    def load(self, tail):
        self.counter += 1
        path = self.root / f"source-{self.counter}.py"
        path.write_text(BASE + tail, encoding="utf-8")
        loaded = load_problem_from_script(path, lightweight_assets=True)
        self.assertFalse(loaded.auto_execute_stages)
        return loaded

    def reimport(self, source):
        self.counter += 1
        path = self.root / f"export-{self.counter}.py"
        path.write_text(source, encoding="utf-8")
        loaded = load_problem_from_script(path, lightweight_assets=True)
        self.assertFalse(loaded.auto_execute_stages)
        return loaded

    def assert_no_active_drives(self, problem):
        self.assertEqual(problem.solved_antenna_drives, ())
        self.assertEqual(problem.antenna_target_projections, ())
        self.assertEqual(problem.antenna_spectrum_requests, ())

    def assert_full_inventory(self, loaded):
        draft = export_builder_draft(loaded)
        for collection, identifier in zip(COLLECTIONS, ("solve", "projection", "drive", "spectrum")):
            self.assertEqual([entry["id"] for entry in draft[collection]], [identifier], collection)
        return draft

    def test_definitions_only_workspace_has_no_actions_and_exports_all_inventory(self):
        loaded = self.load(DECLARE)
        self.assertEqual(loaded.stages, ())
        self.assertEqual(loaded.problem.antenna_field_solve_stages, ())
        self.assert_no_active_drives(loaded.problem)
        self.assert_full_inventory(loaded)
        for source in (render_loaded_problem_as_script(loaded), render_scene_document_as_script(build_scene_document_from_builder(export_builder_draft(loaded)))):
            result = self.reimport(source)
            self.assertEqual(result.stages, ())
            self.assert_no_active_drives(result.problem)
            self.assert_full_inventory(result)

    def test_declaration_then_run_does_not_activate_fields_or_create_actions(self):
        loaded = self.load(DECLARE + "study.stages.add_run(stage_id='run',until=1e-12)\n")
        self.assertEqual([stage.stage_id for stage in loaded.stages], ["run"])
        self.assertEqual(loaded.stages[0].problem.antenna_field_solve_stages, ())
        self.assert_no_active_drives(loaded.stages[0].problem)
        self.assert_no_active_drives(loaded.pipeline_base_problem())
        self.assert_full_inventory(loaded)
        root_ir = loaded.to_ir(requested_backend="fdm", execution_mode="strict", execution_precision="double", include_geometry_assets=False)
        self.assertEqual(root_ir["solved_antenna_drives"], [])
        self.assertEqual(root_ir["antenna_target_projections"], [])
        self.assertEqual(root_ir["antenna_spectrum_requests"], [])
        self.assertEqual(root_ir["antenna_field_solve_stages"], [])

    def test_future_declaration_after_run_does_not_leak_to_earlier_snapshot(self):
        loaded = self.load("study.stages.add_run(stage_id='before',until=1e-12)\n" + DECLARE)
        self.assert_no_active_drives(loaded.stages[0].problem)
        self.assert_no_active_drives(loaded.problem)
        self.assert_full_inventory(loaded)
        rebuilt = self.reimport(render_loaded_problem_as_script(loaded))
        self.assertEqual([stage.stage_id for stage in rebuilt.stages], ["before"])
        self.assert_no_active_drives(rebuilt.stages[0].problem)
        self.assert_full_inventory(rebuilt)

    def test_run_activation_run_keeps_order_and_no_future_drive_leak(self):
        loaded = self.load(DECLARE + """
study.stages.add_run(stage_id='before',until=1e-12)
study.stages.add_antenna_field_solve(id='solve',definition=definition)
study.add_solved_antenna_drive(drive=drive,projection=projection)
study.stages.add_run(stage_id='after',until=2e-12)
""")
        self.assertEqual([stage.stage_id for stage in loaded.stages], ["before", "solve", "drive", "after"])
        self.assert_no_active_drives(loaded.stages[0].problem)
        self.assertEqual([item.id for item in loaded.stages[-1].problem.solved_antenna_drives], ["drive"])
        self.assert_no_active_drives(loaded.pipeline_base_problem())
        rebuilt = self.reimport(render_loaded_problem_as_script(loaded))
        self.assertEqual([stage.stage_id for stage in rebuilt.stages], ["before", "solve", "drive", "after"])
        self.assert_no_active_drives(rebuilt.stages[0].problem)
        self.assertEqual([item.id for item in rebuilt.stages[-1].problem.solved_antenna_drives], ["drive"])
        self.assert_full_inventory(rebuilt)

    def test_standalone_projection_definition_needs_no_fictitious_drive_action(self):
        loaded = self.load("study.declare_antenna_field_solve(definition=definition)\nstudy.declare_antenna_target_projection(projection=projection)\n")
        self.assertEqual(loaded.stages, ())
        self.assert_no_active_drives(loaded.problem)
        draft = export_builder_draft(loaded)
        self.assertEqual([item["id"] for item in draft["antenna_target_projections"]], ["projection"])
        self.assertEqual(draft["solved_antenna_drives"], [])
        rebuilt = self.reimport(render_scene_document_as_script(build_scene_document_from_builder(draft)))
        self.assertEqual(rebuilt.stages, ())
        self.assertEqual(export_builder_draft(rebuilt)["antenna_target_projections"], draft["antenna_target_projections"])

    def test_conflicting_declarations_and_active_bindings_are_rejected(self):
        for tail in (
            "study.declare_antenna_field_solve(definition=replace(definition,current_transport_id='different'))",
            "study.declare_antenna_target_projection(projection=replace(projection,output_id='different'))",
            "study.declare_solved_antenna_drive(drive=replace(drive,peak_current_a=2))",
            "study.declare_antenna_spectrum_request(request=replace(request,output_id='different'))",
            "study.stages.add_antenna_field_solve(id='solve',definition=replace(definition,current_transport_id='different'))",
        ):
            with self.subTest(tail=tail), self.assertRaises(ValueError):
                self.load(DECLARE + tail + "\n")

    def test_duplicate_declaration_ids_are_rejected_even_for_identical_payload(self):
        for tail in (
            "study.declare_antenna_field_solve(definition=definition)",
            "study.declare_antenna_target_projection(projection=projection)",
            "study.declare_solved_antenna_drive(drive=drive)",
            "study.declare_antenna_spectrum_request(request=request)",
        ):
            with self.subTest(tail=tail), self.assertRaises(ValueError):
                self.load(DECLARE + tail + "\n")

    def test_public_declaration_methods_require_their_typed_contracts(self):
        for tail in (
            "study.declare_antenna_field_solve(definition=projection)",
            "study.declare_antenna_target_projection(projection=drive)",
            "study.declare_solved_antenna_drive(drive=request)",
            "study.declare_antenna_spectrum_request(request=definition)",
        ):
            with self.subTest(tail=tail), self.assertRaises(TypeError):
                self.load(tail + "\n")

    def test_existing_active_methods_remain_active_without_declaration_calls(self):
        loaded = self.load("""
study.stages.add_antenna_field_solve(id='solve',definition=definition)
study.add_solved_antenna_drive(drive=drive,projection=projection)
study.stages.add_run(stage_id='run',until=1e-12)
""")
        self.assertEqual([stage.stage_id for stage in loaded.stages], ["solve", "drive", "run"])
        self.assertEqual([item.id for item in loaded.stages[-1].problem.solved_antenna_drives], ["drive"])
        self.assert_no_active_drives(loaded.pipeline_base_problem())

    def test_dangling_declaration_references_are_rejected(self):
        for prefix, declaration in (
            ("", "study.declare_antenna_target_projection(projection=projection)"),
            ("", "study.declare_solved_antenna_drive(drive=drive)"),
            ("", "study.declare_antenna_spectrum_request(request=request)"),
            (DECLARE, "study.declare_antenna_target_projection(projection=replace(projection,id='other',solution=fm.AntennaStageOutputRef('solve','missing')))"),
            (DECLARE, "study.declare_solved_antenna_drive(drive=replace(drive,id='other',projection_ref='missing'))"),
            (DECLARE, "study.declare_solved_antenna_drive(drive=replace(drive,id='other',port_mode_id='missing'))"),
            (DECLARE, "study.declare_antenna_spectrum_request(request=replace(request,id='other',output_id='other-output',port_mode_id='missing'))"),
        ):
            with self.subTest(declaration=declaration), self.assertRaises(ValueError):
                self.load(prefix + declaration + "\n")

    def test_full_scene_inventory_without_authored_actions_is_not_discarded(self):
        loaded = self.load("study.stages.add_run(stage_id='run',until=1e-12)\n")
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        declarations = self.load(DECLARE)
        draft = self.assert_full_inventory(declarations)
        for collection in COLLECTIONS:
            scene[collection] = draft[collection]
        result = self.reimport(render_scene_document_as_script(scene))
        self.assertEqual([stage.stage_id for stage in result.stages], ["run"])
        self.assert_no_active_drives(result.stages[0].problem)
        self.assert_full_inventory(result)

    def incomplete_scene_path(self):
        loaded = self.load(DECLARE)
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        scene["study"]["exchange_enabled"] = False
        scene["study"]["demag_enabled"] = False
        for obj in scene["objects"]:
            for interaction in obj.get("physics_stack", []):
                interaction["enabled"] = False
        path = self.root / "incomplete-scene.json"
        path.write_text(json.dumps(scene), encoding="utf-8")
        return path

    def test_incomplete_scene_strict_render_does_not_write_executable_source(self):
        scene_path = self.incomplete_scene_path()
        output = self.root / "strict.py"
        with self.assertRaises(IncompletePhysicsError):
            helper_main(["render-scene-document", "--scene-json", str(scene_path),
                         "--output", str(output)])
        self.assertFalse(output.exists())

    def test_incomplete_scene_persistence_reports_no_export_and_preserves_existing_source(self):
        scene_path = self.incomplete_scene_path()
        output = self.root / "preserved.py"
        original = b"# Previously saved user source\n"
        for existing in (False, True):
            with self.subTest(existing=existing):
                if existing:
                    output.write_bytes(original)
                response = io.StringIO()
                with contextlib.redirect_stdout(response):
                    status = helper_main(["render-scene-document", "--scene-json", str(scene_path),
                                          "--output", str(output), "--allow-incomplete"])
                self.assertEqual(status, 0)
                payload = json.loads(response.getvalue())
                self.assertIs(payload["written"], False)
                self.assertEqual(payload["bytes_written"], 0)
                self.assertEqual(output.exists(), existing)
                if existing:
                    self.assertEqual(output.read_bytes(), original)

    def test_declarations_do_not_require_magnetic_execution_physics(self):
        for antenna_only in (False, True):
            with self.subTest(antenna_only=antenna_only):
                source = BASE
                if antenna_only:
                    source = source.replace("film=study.geometry(fm.Box(100e-9,40e-9,10e-9),name='film')\nfilm.Ms=800e3\nfilm.Aex=13e-12\nfilm.alpha=0.01\n", "")
                    source = source.replace("fm.FieldTarget.object('film')", "fm.FieldTarget.global_domain()")
                source += "study.disable_exchange()\nstudy.disable_demag()\n" + DECLARE
                world.begin_script_capture(self.root)
                try:
                    with patch.object(world, "_build_problem", side_effect=AssertionError("declaration must not build execution physics")):
                        exec(compile(source, "authoring-only.py", "exec"), {})
                    inventory = world.capture_antenna_authoring_inventory()
                    for collection in COLLECTIONS:
                        self.assertEqual(len(getattr(inventory, collection)), 1)
                    self.assertEqual(world.capture_declared_stages(), [])
                    self.assertFalse(world._state._wait_for_solve)
                    for collection in COLLECTIONS:
                        self.assertEqual(getattr(world._state, f"_{collection}"), [])
                finally:
                    self.assertEqual(world.finish_script_capture(), [])

    def test_invalid_declaration_preserves_inventory_without_building_problem(self):
        world.begin_script_capture(self.root)
        try:
            namespace = {}
            exec(compile(BASE + DECLARE, "declarations.py", "exec"), namespace)
            previous = world.capture_antenna_authoring_inventory()
            for statement in (
                "study.declare_solved_antenna_drive(drive=replace(drive,id='bad',projection_ref='missing'))",
                "study.declare_antenna_target_projection(projection=replace(projection,id='bad',solution=fm.AntennaStageOutputRef('solve','missing')))",
                "study.declare_antenna_spectrum_request(request=replace(request,id='bad',output_id='spectrum-output'))",
            ):
                with self.subTest(statement=statement), patch.object(world, "_build_problem", side_effect=AssertionError("unexpected Problem")):
                    with self.assertRaises(ValueError):
                        exec(statement, namespace)
                    self.assertIs(world.capture_antenna_authoring_inventory(), previous)
                    self.assertEqual(world.capture_declared_stages(), [])
        finally:
            world.finish_script_capture()

    def test_declaration_does_not_weaken_strict_execution_for_incomplete_magnet(self):
        with self.assertRaises(IncompletePhysicsError):
            self.load("study.disable_exchange()\nstudy.disable_demag()\n" + DECLARE)

    def test_active_solve_can_be_declared_without_rebuilding_execution_state(self):
        world.begin_script_capture(self.root)
        try:
            namespace = {}
            exec(compile(BASE + "study.stages.add_antenna_field_solve(id='solve',definition=definition)\n", "active-first.py", "exec"), namespace)
            stages = world.capture_declared_stages()
            active = tuple(world._state._antenna_field_solve_stages)
            with patch.object(world, "_build_problem", side_effect=AssertionError("unexpected Problem")):
                exec("study.declare_antenna_field_solve(definition=definition)", namespace)
                previous = world.capture_antenna_authoring_inventory()
                with self.assertRaises(ValueError):
                    exec("study.declare_antenna_field_solve(definition=replace(definition,id='solve',current_transport_id='different'))", namespace)
                self.assertIs(world.capture_antenna_authoring_inventory(), previous)
            self.assertEqual(previous.antenna_field_solve_stages, active)
            self.assertEqual(world.capture_declared_stages(), stages)
            self.assertEqual(tuple(world._state._antenna_field_solve_stages), active)
        finally:
            world.finish_script_capture()

    def test_conflicting_active_solve_is_rejected_before_inventory_publication(self):
        world.begin_script_capture(self.root)
        try:
            namespace = {}
            exec(compile(BASE + "study.stages.add_antenna_field_solve(id='solve',definition=definition)\n", "active-conflict.py", "exec"), namespace)
            previous = world.capture_antenna_authoring_inventory()
            stages = world.capture_declared_stages()
            with patch.object(world, "_build_problem", side_effect=AssertionError("unexpected Problem")):
                with self.assertRaisesRegex(ValueError, "conflicting antenna_field_solve_stages"):
                    exec("study.declare_antenna_field_solve(definition=replace(definition,current_transport_id='different'))", namespace)
            self.assertIs(world.capture_antenna_authoring_inventory(), previous)
            self.assertEqual(world.capture_declared_stages(), stages)
        finally:
            world.finish_script_capture()

    def test_exported_domain_frame_includes_auxiliary_antenna_geometry(self):
        loaded = self.load(DECLARE)
        expected = build_domain_frame(
            geometries=[
                *(magnet.geometry for magnet in loaded.problem.magnets),
                *loaded.problem.auxiliary_geometries,
            ],
            source_root=self.root,
            study_universe=None,
        )
        magnetic_only = build_domain_frame(
            geometries=[magnet.geometry for magnet in loaded.problem.magnets],
            source_root=self.root,
            study_universe=None,
        )
        self.assertNotEqual(expected, magnetic_only)
        self.assertEqual(export_builder_draft(loaded)["domain_frame"], expected)

    def test_exported_domain_frame_preserves_explicit_universe_with_antenna(self):
        loaded = self.load("study.universe(size=(1e-6,1e-6,1e-6))\n" + DECLARE)
        expected = build_domain_frame(
            geometries=[
                *(magnet.geometry for magnet in loaded.problem.magnets),
                *loaded.problem.auxiliary_geometries,
            ],
            source_root=self.root,
            study_universe=loaded.problem.runtime_metadata["study_universe"],
        )
        self.assertEqual(export_builder_draft(loaded)["domain_frame"], expected)


if __name__ == "__main__":
    faulthandler.dump_traceback_later(45, exit=True)
    unittest.main(verbosity=2)
