"""Acceptance gate for source-only antenna authoring, not a native solve."""
from __future__ import annotations

import ast
import json
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory

import fullmag as fm
import fullmag.world as world
from fullmag.runtime.loader import load_problem_from_script


EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "fem_antenna_current_source_inspection.py"


def standalone_fixture_code(*, include_stage=True, as_source=False):
    """Keep the scientific input; change only the probe's authored physics."""
    tree = ast.parse(EXAMPLE.read_text(encoding="utf-8"), filename=str(EXAMPLE))
    removed = set()
    changed = 0
    solve_calls = 0
    body = []
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            function = node.value.func
            if isinstance(function, ast.Attribute) and function.attr == "add_antenna_field_solve":
                solve_calls += 1
                if not include_stage:
                    continue
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "probe":
                if target.attr not in {"Ms", "Aex", "alpha", "m"}:
                    raise AssertionError(f"Unexpected probe physics: {target.attr}")
                removed.add(target.attr)
                continue
            if isinstance(target, ast.Name) and target.id == "probe":
                call = node.value
                if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute) or call.func.attr != "geometry":
                    raise AssertionError("Probe constructor changed; review the standalone fixture")
                call.func.attr = "geometry_object"
                call.keywords.append(ast.keyword(arg="type", value=ast.Constant(value="geometry")))
                changed += 1
        body.append(node)
    if removed != {"Ms", "Aex", "alpha", "m"} or changed != 1 or solve_calls != 1:
        raise AssertionError("Standalone fixture must remove exactly the magnetic probe state")
    tree.body = body
    if as_source:
        return ast.unparse(ast.fix_missing_locations(tree))
    return compile(ast.fix_missing_locations(tree), str(EXAMPLE), "exec")


class AntennaStandaloneAuthoringTests(unittest.TestCase):
    def setUp(self):
        fm.reset()

    def tearDown(self):
        world.finish_script_capture()
        fm.reset()

    def test_rust_pipeline_fixture_matches_actual_standalone_python_inputs(self):
        fixture_path = EXAMPLE.parents[1] / "tests" / "fixtures" / "runtime" / "antenna-standalone-pipeline.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        world.begin_script_capture(EXAMPLE.parent)
        exec(standalone_fixture_code(), {"__file__": str(EXAMPLE), "__name__": "__main__"})
        actual = world._build_problem().to_ir(source_root=EXAMPLE.parent)
        # Only filesystem/provenance inputs are normalized. Embedded meshes,
        # currents, interfaces, execution intent and physical definitions stay exact.
        for asset in actual["geometry_assets"]["fem_mesh_assets"]:
            asset.pop("mesh_source", None)
        for entry in actual["geometry"]["entries"]:
            entry["source"] = "assets/" + Path(entry["source"]).name
        actual["problem_meta"].pop("script_source", None)
        metadata = actual["problem_meta"]["runtime_metadata"]
        actual["problem_meta"]["runtime_metadata"] = {"runtime_selection": metadata["runtime_selection"]}
        self.assertEqual(fixture["ir"], actual)
        self.assertEqual(fixture["stages"], [])
        group, = fixture["study_pipeline"]["nodes"]
        first, repeated = group["children"]
        self.assertNotEqual(first["id"], repeated["id"])
        for node in (first, repeated):
            self.assertEqual(node["stage_kind"], "antenna_field_solve")
            self.assertEqual(node["payload"], {"stage_id": "inspect_antenna", "port_mode_id": "port"})
            self.assertNotEqual(node["id"], node["payload"]["stage_id"])

    def test_source_only_stage_has_no_magnetic_scaffold(self):
        baseline = load_problem_from_script(EXAMPLE, lightweight_assets=True).problem.to_ir(include_geometry_assets=False)
        world.begin_script_capture(EXAMPLE.parent)
        exec(standalone_fixture_code(), {"__file__": str(EXAMPLE), "__name__": "__main__"})
        ir = world._build_problem().to_ir(include_geometry_assets=False)
        stages = world.capture_declared_stages()
        self.assertEqual(len(stages), 1)
        self.assertEqual(stages[0].action["kind"], "antenna_field_solve")
        self.assertEqual(ir["magnets"], [])
        self.assertEqual(ir["energy_terms"], [])
        self.assertNotIn("dynamics", ir["study"])
        self.assertEqual(ir["study"]["kind"], "antenna_field_solve")
        for key in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages"):
            self.assertEqual(ir[key], baseline[key], key)
        for key in ("spin_transport_modules", "solved_antenna_drives", "antenna_target_projections", "antenna_spectrum_requests"):
            self.assertFalse(ir.get(key), key)

    def test_existing_magnetic_fixture_remains_explicit(self):
        ir = load_problem_from_script(EXAMPLE, lightweight_assets=True).problem.to_ir(include_geometry_assets=False)
        self.assertEqual([magnet["name"] for magnet in ir["magnets"]], ["probe"])

    def test_standalone_export_and_scene_round_trip_preserve_physics(self):
        from fullmag.runtime.script_builder import (
            export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script,
        )
        from fullmag.runtime.scene_document import build_scene_document_from_builder
        with TemporaryDirectory(prefix="standalone-authoring-") as temporary:
            path = Path(temporary) / "standalone.py"
            source = standalone_fixture_code(as_source=True).replace(
                "Path(__file__)", f"Path({str(EXAMPLE)!r})"
            )
            path.write_text(source, encoding="utf-8")
            loaded = load_problem_from_script(path, lightweight_assets=True)
            expected = loaded.problem.to_ir(include_geometry_assets=False)
            exported = render_loaded_problem_as_script(loaded)
            builder = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(builder)
            scene_exported = render_scene_document_as_script(scene)
            for index, text in enumerate((exported, scene_exported)):
                self.assertNotIn(".Ms =", text)
                self.assertNotIn(".m =", text)
                self.assertNotIn("fm.Exchange(", text)
                self.assertNotIn("fm.Demag(", text)
                rewritten = Path(temporary) / f"roundtrip-{index}.py"
                rewritten.write_text(text, encoding="utf-8")
                actual = load_problem_from_script(rewritten, lightweight_assets=True).problem.to_ir(include_geometry_assets=False)
                self.assertEqual(actual["study"]["kind"], "antenna_field_solve")
                self.assertEqual(actual["magnets"], [])
                self.assertEqual(actual["energy_terms"], [])
                for key in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages"):
                    self.assertEqual(actual[key], expected[key], key)

    def test_magnetic_stages_without_magnets_are_rejected_without_capture(self):
        for kind in ("run", "relax"):
            with self.subTest(kind=kind):
                world.begin_script_capture(EXAMPLE.parent)
                namespace = {"__file__": str(EXAMPLE), "__name__": "__main__"}
                exec(standalone_fixture_code(include_stage=False), namespace)
                before = world.capture_declared_stages()
                with self.assertRaisesRegex(ValueError, "[Nn]o magnets|at least one magnet"):
                    if kind == "run":
                        namespace["study"].stages.add_run(1.0e-12)
                    else:
                        namespace["study"].stages.add_relax(dt=1.0e-13)
                self.assertEqual(world.capture_declared_stages(), before)
                world.finish_script_capture()

    def test_flat_run_after_antenna_cannot_reuse_nonmagnetic_family(self):
        world.begin_script_capture(EXAMPLE.parent)
        exec(standalone_fixture_code(), {"__file__": str(EXAMPLE), "__name__": "__main__"})
        before = world.capture_declared_stages()
        with self.assertRaisesRegex(ValueError, "[Nn]o magnets"):
            fm.run(1e-12)
        self.assertEqual(world.capture_declared_stages(), before)
        self.assertEqual(world.capture_executed_stages(), [])

    def test_standalone_study_cannot_author_time_sampling(self):
        self.assertEqual(fm.AntennaFieldSolve().to_ir(), {
            "kind": "antenna_field_solve", "sampling": {"outputs": []},
        })
        with self.assertRaises(TypeError):
            fm.AntennaFieldSolve(outputs=[fm.SaveField("m", every=1e-12)])

    def test_runtime_selection_preserves_definitions_and_rejects_bad_ports_before_mutation(self):
        from copy import deepcopy
        from fullmag.runtime.run_config_export import _runtime_stage_action
        first = {"id": "first", "port_mode_ids": ["port"]}
        second = {"id": "second", "port_mode_ids": ["port"]}
        ir = {"study": fm.AntennaFieldSolve().to_ir(), "antenna_field_solve_stages": [first]}
        _runtime_stage_action({"kind": "antenna_field_solve", "definition": second}, stage_ir=ir)
        self.assertEqual(ir["antenna_field_solve_stages"], [first, second])
        self.assertEqual(ir["study"]["selection"], {"stage_id": "second", "port_mode_id": "port"})
        _runtime_stage_action({"kind": "antenna_field_solve", "definition": first}, stage_ir=ir)
        self.assertEqual(ir["study"]["selection"], {"stage_id": "first", "port_mode_id": "port"})
        self.assertEqual(ir["antenna_field_solve_stages"], [first, second])
        for ports in ([], ["port", "other"], [" "], [None], "port"):
            before = deepcopy(ir)
            with self.assertRaisesRegex(ValueError, "one explicit definition and port"):
                _runtime_stage_action({"kind": "antenna_field_solve", "definition": {"id": "invalid", "port_mode_ids": ports}}, stage_ir=ir)
            self.assertEqual(ir, before)

    def test_standalone_then_relax_preserves_nonmagnetic_stage_snapshot(self):
        from fullmag.runtime.run_config_export import export_run_config, RunConfigExportOptions
        with TemporaryDirectory(prefix="antenna-then-relax-") as temporary:
            path = Path(temporary) / "stages.py"
            source = standalone_fixture_code(as_source=True).replace(
                "Path(__file__)", f"Path({str(EXAMPLE)!r})"
            ) + '''
magnetic_probe = study.geometry(fm.ImportedGeometry(source=str(PROBE_MESH)), name="magnetic_probe")
magnetic_probe.Ms = 8.0e5
magnetic_probe.Aex = 13.0e-12
magnetic_probe.alpha = 0.02
magnetic_probe.m = fm.init.UniformMagnetization((0.0, 1.0, 0.0))
study.disable_exchange()
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 0.01)
study.stages.add_relax(stage_id="relax_after_antenna", max_steps=2, dt=1e-15)
'''
            path.write_text(source, encoding="utf-8")
            loaded = load_problem_from_script(path, lightweight_assets=True)
            self.assertEqual(len(loaded.stages), 2)
            config = export_run_config(
                loaded, loaded.problem.to_ir(include_geometry_assets=False),
                options=RunConfigExportOptions(include_geometry_assets=False),
            )
            before, after = [stage["ir"] for stage in config["stages"]]
            self.assertEqual(before["study"], {"kind": "antenna_field_solve", "sampling": {"outputs": []},
                                             "selection": {"stage_id": "inspect_antenna", "port_mode_id": "port"}})
            self.assertEqual(before["magnets"], [])
            self.assertEqual(before["energy_terms"], [])
            self.assertEqual(after["study"]["kind"], "relaxation")
            self.assertEqual([magnet["name"] for magnet in after["magnets"]], ["magnetic_probe"])
            self.assertEqual(after["magnets"][0]["initial_magnetization"], {
                "kind": "uniform", "value": [0.0, 1.0, 0.0],
            })
            for key in ("solved_antenna_drives", "antenna_target_projections"):
                self.assertFalse(after.get(key), key)

    def test_standalone_then_run_captures_independent_authored_magnetic_state(self):
        from fullmag.runtime.run_config_export import export_run_config, RunConfigExportOptions
        for integrator in ("heun", "rk4"):
            with self.subTest(integrator=integrator), TemporaryDirectory(prefix="antenna-then-run-") as temporary:
                path = Path(temporary) / "stages.py"
                source = standalone_fixture_code(as_source=True).replace(
                    "Path(__file__)", f"Path({str(EXAMPLE)!r})"
                ) + f'''
magnetic_probe = study.geometry(fm.ImportedGeometry(source=str(PROBE_MESH)), name="magnetic_probe")
magnetic_probe.Ms = 8.0e5
magnetic_probe.Aex = 13.0e-12
magnetic_probe.alpha = 0.02
magnetic_probe.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.disable_exchange()
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 0.01)
study.solver(integrator={integrator!r}, fix_dt=1e-15, g=2.0)
study.tableautosave(1e-15, quantities=["mx", "my", "mz"])
study.stages.add_run(1e-15, stage_id="run_after_antenna")
'''
                path.write_text(source, encoding="utf-8")
                loaded = load_problem_from_script(path, lightweight_assets=True)
                self.assertEqual(len(loaded.stages), 2)
                before, after = [stage.problem.to_ir(include_geometry_assets=False) for stage in loaded.stages]
                self.assertEqual(before["study"], {"kind": "antenna_field_solve", "sampling": {"outputs": []}})
                self.assertEqual(before["magnets"], [])
                self.assertEqual(before["energy_terms"], [])
                self.assertEqual(after["study"]["kind"], "time_evolution")
                self.assertEqual(after["study"]["dynamics"]["integrator"], integrator)
                self.assertEqual(after["study"]["dynamics"]["fixed_timestep"], 1e-15)
                self.assertEqual([magnet["name"] for magnet in after["magnets"]], ["magnetic_probe"])
                self.assertEqual(after["magnets"][0]["initial_magnetization"], {
                    "kind": "uniform", "value": [1.0, 0.0, 0.0],
                })
                self.assertEqual(after["study"]["sampling"]["outputs"], [])
                self.assertEqual(after["study"]["sampling"]["table_autosave"], {
                    "kind": "table_autosave", "table_id": "default",
                    "quantities": ["mx", "my", "mz"], "sample_period_s": 1e-15,
                })
                for key in ("solved_antenna_drives", "antenna_target_projections"):
                    self.assertFalse(after.get(key), key)
                config = export_run_config(loaded, after, options=RunConfigExportOptions(include_geometry_assets=False))
                self.assertEqual(config["stages"][0]["action"]["kind"], "antenna_field_solve")
                # Time evolution is dispatched from the stage IR, not a synthetic action.
                self.assertIsNone(config["stages"][1]["action"])
                self.assertEqual(config["stages"][1]["default_until_seconds"], 1e-15)
                self.assertEqual(config["stages"][1]["ir"]["study"]["kind"], "time_evolution")
                self.assertEqual(config["stages"][0]["ir"]["magnets"], [])
                self.assertEqual(config["stages"][1]["ir"]["magnets"], after["magnets"])
                self.assertEqual(config["stages"][1]["ir"]["study"]["dynamics"], after["study"]["dynamics"])
                self.assertEqual(config["stages"][1]["ir"]["study"]["sampling"], after["study"]["sampling"])


if __name__ == "__main__":
    unittest.main()
