from __future__ import annotations

import ast
import copy
import inspect
import textwrap
import unittest
import warnings
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_execution_config
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_scene_document_as_script,
    rewrite_loaded_problem_script,
)


def _load(script_body: str):
    with TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "stages.py"
        path.write_text(textwrap.dedent(script_body), encoding="utf-8")
        return fm.load_problem_from_script(path, lightweight_assets=True)


_PREAMBLE = """
import fullmag as fm
study = fm.study("stable-stage-ids")
study.engine("fem")
body = study.geometry(fm.Box(10e-9, 10e-9, 5e-9), name="film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.01
body.m = fm.texture.uniform(1, 0, 0)
"""


class StudyStageIdTests(unittest.TestCase):

    def test_captured_stages_keep_their_own_region_textures(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
core = body.add_region("core", fm.Box(5e-9, 5e-9, 5e-9))
core.texture = fm.texture.uniform(0, 1, 0)
study.stages.add_relax(stage_id="first", max_steps=2, dt=1e-13)
core.texture = fm.texture.uniform(0, 0, 1)
study.stages.add_relax(stage_id="second", max_steps=2, dt=1e-13)
"""
        )

        directions = []
        for stage in loaded.stages:
            region = stage.problem.to_ir(include_geometry_assets=False)["object_regions"][0]
            texture = region["texture_override"]["initial_magnetization"]
            directions.append(texture["preset_params"]["direction"])
        self.assertEqual(directions, [[0, 1, 0], [0, 0, 1]])

    def test_sampling_helper_keeps_explicit_run_snapshots_and_reset_order(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_run(stage_id="before", until=1e-12)
study.stages.tableautosave(5e-14, quantities=["mx", "my"], stage_id="table")
body.m = fm.texture.uniform(0, 1, 0)
study.stages.add_run(stage_id="after", until=1e-12)
"""
        )

        before, configuration, after = loaded.stages
        self.assertEqual(
            [before.stage_id, configuration.stage_id, after.stage_id],
            ["before", "table", "after"],
        )
        self.assertIsNone(before.problem.study.to_ir()["sampling"].get("table_autosave"))
        self.assertEqual(
            after.problem.study.to_ir()["sampling"]["table_autosave"]["sample_period_s"],
            5e-14,
        )
        self.assertEqual(configuration.action["kind"], "table_autosave")
        self.assertFalse(configuration.magnetization_assignments)
        assignment, = after.magnetization_assignments
        self.assertEqual(assignment.initializer.to_ir()["preset_params"]["direction"], [0, 1, 0])
        before_ir = before.problem.to_ir(include_geometry_assets=False)
        after_ir = after.problem.to_ir(include_geometry_assets=False)
        for problem, direction in ((before_ir, [1, 0, 0]), (after_ir, [0, 1, 0])):
            texture = problem["magnets"][0]["initial_magnetization"]
            self.assertEqual(texture["preset_params"]["direction"], direction)

        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        config = scene_document_to_execution_config(
            scene,
            requested_backend="fem",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
        )
        self.assertFalse(config.get("stages"))
        base = config["ir"]
        self.assertIsNone(base["study"]["sampling"].get("table_autosave"))
        self.assertEqual(
            base["magnets"][0]["initial_magnetization"]["preset_params"]["direction"],
            [1, 0, 0],
        )
        nodes = config["study_pipeline"]["nodes"]
        self.assertEqual([node["id"] for node in nodes], ["before", "table", "after"])
        self.assertEqual(nodes[1]["payload"]["table_autosave"]["sample_period_s"], 5e-14)
        self.assertEqual(
            nodes[2]["payload"]["magnetization_assignments"],
            loaded.study_pipeline_document()["nodes"][2]["payload"]["magnetization_assignments"],
        )

    def test_script_export_keeps_an_explicit_repeat_of_the_same_texture(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(stage_id="first", max_steps=2, dt=1e-13)
body.m = fm.texture.uniform(1, 0, 0)
study.stages.add_relax(stage_id="second", max_steps=2, dt=1e-13)
study.stages.add_relax(stage_id="third", max_steps=2, dt=1e-13)
"""
        )
        pipeline = loaded.study_pipeline_document()
        self.assertEqual(pipeline["version"], "study_pipeline.v2")
        first_node, second_node, third_node = pipeline["nodes"]
        self.assertNotIn("magnetization_assignments", first_node["payload"])
        self.assertNotIn("magnetization_assignments", third_node["payload"])
        batch = second_node["payload"]["magnetization_assignments"]
        self.assertEqual(batch["schema_version"], "fullmag.magnetization-assignments.v1")
        assignment, = batch["assignments"]
        self.assertEqual(assignment["object_id"], "film")
        self.assertIsNone(assignment["region_id"])
        self.assertEqual(assignment["initializer"]["preset_params"]["direction"], [1, 0, 0])

        rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
        statements = ast.parse(str(rendered)).body
        relax_lines = [
            statement.lineno
            for statement in statements
            if isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Call)
            and isinstance(statement.value.func, ast.Attribute)
            and statement.value.func.attr == "add_relax"
        ]
        texture_lines = [
            statement.lineno
            for statement in statements
            if isinstance(statement, ast.Assign)
            and any(
                isinstance(target, ast.Attribute) and target.attr == "m"
                for target in statement.targets
            )
        ]

        self.assertEqual(len(relax_lines), 3)
        first, second, third = relax_lines
        self.assertTrue(any(first < line < second for line in texture_lines))
        self.assertFalse(any(second < line < third for line in texture_lines))

    def test_scene_export_preserves_edited_relax_controls_and_texture_reset(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(stage_id="first", max_steps=2, dt=1e-13)
body.m = fm.texture.uniform(0, 1, 0)
study.stages.add_relax(stage_id="second", max_steps=3, dt=1e-13)
"""
        )
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        stage = scene["study"]["study_pipeline"]["nodes"][1]
        payload = stage["payload"]
        payload.pop("torque_tolerance", None)
        payload.pop("energy_tolerance", None)
        payload.update(
            torque_tolerance_apm=0.002,
            energy_tolerance_j=1e-20,
            max_steps="7",
            relax_alpha=0.2,
            demag_interval_s=2e-12,
        )

        reloaded = _load(render_scene_document_as_script(scene))
        first, second = reloaded.stages
        self.assertEqual(second.stage_id, "second")
        self.assertEqual(first.problem.study.max_steps, 2)
        self.assertEqual(second.problem.study.max_steps, 7)
        self.assertEqual(second.problem.study.torque_tolerance, 0.002)
        self.assertEqual(second.problem.study.energy_tolerance, 1e-20)
        self.assertEqual(second.problem.study.dynamics.field_refresh.demag_interval_s, 2e-12)
        self.assertEqual(second.problem.magnets[0].material.alpha, 0.2)
        self.assertEqual(len(second.magnetization_assignments), 1)

    def test_scene_export_preserves_resets_across_disabled_nodes(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
core = body.add_region("core", fm.Box(5e-9, 5e-9, 5e-9), region_id="core-id")
core.texture = fm.texture.uniform(0, 1, 0)
study.stages.add_relax(stage_id="first", max_steps=2, dt=1e-13)
body.m = fm.texture.uniform(1, 0, 0)
study.stages.add_relax(stage_id="disabled", max_steps=2, dt=1e-13)
body.m = fm.texture.uniform(-1, 0, 0)
study.stages.add_relax(stage_id="disabled-group-member", max_steps=2, dt=1e-13)
core.texture = fm.texture.uniform(0, 0, 1)
study.stages.add_relax(stage_id="third", max_steps=2, dt=1e-13)
study.stages.add_relax(stage_id="fourth", max_steps=2, dt=1e-13)
"""
        )
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        nodes = scene["study"]["study_pipeline"]["nodes"]
        first, disabled, grouped, third, fourth = nodes
        disabled["enabled"] = False
        nodes[:] = [
            first,
            disabled,
            {
                "id": "group",
                "label": "Disabled group",
                "node_kind": "group",
                "enabled": False,
                "children": [grouped],
            },
            third,
            fourth,
        ]

        reloaded = _load(render_scene_document_as_script(scene))
        self.assertEqual(reloaded.study_pipeline_document()["nodes"], nodes)
        first_stage, third_stage, fourth_stage = reloaded.stages
        self.assertEqual(
            [stage.stage_id for stage in reloaded.stages],
            ["first", "third", "fourth"],
        )
        self.assertFalse(first_stage.magnetization_assignments)
        self.assertFalse(fourth_stage.magnetization_assignments)
        self.assertEqual(
            [
                {
                    "object_id": assignment.object_id,
                    "region_id": assignment.region_id,
                    "initializer": assignment.initializer.to_ir(),
                }
                for assignment in third_stage.magnetization_assignments
            ],
            disabled["payload"]["magnetization_assignments"]["assignments"]
            + third["payload"]["magnetization_assignments"]["assignments"],
        )
        initial_region = reloaded.stages[0].problem.to_ir(include_geometry_assets=False)["object_regions"][0]
        self.assertEqual(
            initial_region["texture_override"]["initial_magnetization"]["preset_params"]["direction"],
            [0, 1, 0],
        )

    def test_scene_round_trip_keeps_stage_local_reset_separate_from_script_assignment(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
core = body.add_region("core", fm.Box(5e-9, 5e-9, 5e-9), region_id="core-id")
study.stages.add_relax(stage_id="a", max_steps=2, dt=1e-13)
core.texture = fm.texture.uniform(0, 1, 0)
study.stages.add_relax(stage_id="b", max_steps=2, dt=1e-13)
study.stages.add_relax(stage_id="c", max_steps=2, dt=1e-13)
"""
        )
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        nodes = scene["study"]["study_pipeline"]["nodes"]
        stage_local = {
            "schema_version": "fullmag.magnetization-assignments.v1",
            "assignments": [{
                "object_id": "film", "region_id": "core-id",
                "initializer": {"kind": "uniform", "value": [0, 0, 1]},
            }],
        }
        nodes[1]["payload"]["stage_magnetization_assignments"] = stage_local

        for flat in (False, True):
            for enabled in (False, True):
                with self.subTest(flat=flat, enabled=enabled):
                    scene = copy.deepcopy(scene)
                    scene["study"]["study_pipeline"]["nodes"][1]["enabled"] = enabled
                    candidate = copy.deepcopy(scene)
                    if flat:
                        candidate["study"]["stages"] = [
                            {**node["payload"], "stage_id": node["id"], "enabled": node["enabled"]}
                            for node in candidate["study"].pop("study_pipeline")["nodes"]
                        ]

                    reloaded = _load(render_scene_document_as_script(candidate))
                    authored = reloaded.study_pipeline_document()["nodes"]
                    self.assertEqual(authored[1]["id"], "b")
                    self.assertEqual(authored[1]["enabled"], enabled)
                    self.assertEqual(authored[1]["payload"]["stage_magnetization_assignments"], stage_local)
                    self.assertEqual([stage.stage_id for stage in reloaded.stages],
                                     ["a", "b", "c"] if enabled else ["a", "c"])
                    # Only the independent setter belongs to Python's persistent capture.
                    assignments = reloaded.stages[1].magnetization_assignments
                    self.assertEqual(len(assignments), 1)
                    self.assertEqual(assignments[0].initializer.to_ir()["preset_params"]["direction"], [0, 1, 0])
                    config = scene_document_to_execution_config(
                        candidate, requested_backend="fem", requested_device="cpu",
                        requested_precision="double", requested_mode="strict",
                    )
                    config_b = config["study_pipeline"]["nodes"][1]
                    self.assertEqual(config_b["payload"]["stage_magnetization_assignments"], stage_local)
                    self.assertEqual(config_b["enabled"], enabled)
                    if flat:
                        ids = [
                            stage["ir"]["problem_meta"]["runtime_metadata"]["active_stage_id"]
                            for stage in config["stages"]
                        ]
                        self.assertEqual(ids, ["a", "b", "c"] if enabled else ["a", "c"])
                    else:
                        self.assertEqual(config["stages"], [])

    def test_script_round_trip_keeps_initial_and_scoped_textures_per_stage(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
core = body.add_region("core", fm.Box(5e-9, 5e-9, 5e-9))
core.texture = fm.texture.uniform(0, 1, 0)
study.stages.add_relax(stage_id="first", max_steps=2, dt=1e-13)
core.set_texture(fm.texture.uniform(0, 0, 1))
body.m.set(fm.texture.uniform(0, 1, 0))
study.stages.add_relax(stage_id="second", max_steps=2, dt=1e-13)
"""
        )
        rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
        reloaded = _load(str(rendered))

        directions = []
        for stage in reloaded.stages:
            ir = stage.problem.to_ir(include_geometry_assets=False)
            body_texture = ir["magnets"][0]["initial_magnetization"]
            region_texture = ir["object_regions"][0]["texture_override"]["initial_magnetization"]
            directions.append((
                body_texture["preset_params"]["direction"],
                region_texture["preset_params"]["direction"],
            ))
        self.assertEqual(directions, [
            ([1, 0, 0], [0, 1, 0]),
            ([0, 1, 0], [0, 0, 1]),
        ])

    def test_transport_current_action_mutates_exact_electrodes_for_subsequent_run(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
region = fm.RegionRef("film")
study.current_transport(
    name="charge",
    model="ohmic_poisson",
    domain=[region],
    materials=[fm.ChargeTransportMaterialAssignment(
        region, fm.ChargeTransportMaterial(5e6)
    )],
    boundaries=[
        fm.NormalCurrentElectrode(
            "left", [fm.SurfaceRef("film", "x-", (-1, 0, 0))],
            outward_current_density_Apm2=0.0,
        ),
        fm.NormalCurrentElectrode(
            "right", [fm.SurfaceRef("film", "x+", (1, 0, 0))],
            outward_current_density_Apm2=0.0,
        ),
    ],
    gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(),
)
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"left": -1e12, "right": 1e12},
    stage_id="drive-positive",
)
study.stages.add_run(stage_id="run-positive", until=1e-12)
"""
        )

        action, run = loaded.stages
        self.assertEqual(
            action.action,
            {
                "kind": "set_transport_current",
                "module_id": "charge",
                "terminal_outward_current_density_Apm2": {
                    "left": -1e12,
                    "right": 1e12,
                },
            },
        )
        self.assertEqual(
            [
                boundary.outward_current_density_Apm2
                for boundary in run.problem.current_modules[0].boundaries
            ],
            [-1e12, 1e12],
        )
        node = loaded.study_pipeline_document()["nodes"][0]
        self.assertEqual(node["stage_kind"], "set_transport_current")
        self.assertEqual(node["label"], "Set Transport Current 1")
        self.assertEqual(node["payload"]["module_id"], "charge")

    def test_imported_relax_stage_has_a_nonempty_canonical_pipeline_label(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(
    stage_id="relax-1",
    algorithm="llg_overdamped",
    dt=1e-13,
    max_steps=2,
)
"""
        )

        node = loaded.study_pipeline_document()["nodes"][0]
        self.assertEqual(node["id"], "relax-1")
        self.assertEqual(node["stage_kind"], "relax")
        self.assertEqual(node["label"], "Relax 1")

    def test_transport_current_action_rejects_inexact_electrode_coverage(self) -> None:
        transport = """
region = fm.RegionRef("film")
study.current_transport(
    name="charge", model="ohmic_poisson", domain=[region],
    materials=[fm.ChargeTransportMaterialAssignment(
        region, fm.ChargeTransportMaterial(5e6)
    )],
    boundaries=[
        fm.NormalCurrentElectrode(
            "left", [fm.SurfaceRef("film", "x-", (-1, 0, 0))],
            outward_current_density_Apm2=0.0,
        ),
        fm.NormalCurrentElectrode(
            "right", [fm.SurfaceRef("film", "x+", (1, 0, 0))],
            outward_current_density_Apm2=0.0,
        ),
    ],
    gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(),
)
"""
        for values, message in (
            ('{"left": -1e12}', "must cover exactly.*missing.*right"),
            (
                '{"left": -1e12, "right": 1e12, "ghost": 0.0}',
                "must cover exactly.*unexpected.*ghost",
            ),
        ):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, message):
                _load(
                    _PREAMBLE
                    + transport
                    + f"""
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={values},
)
"""
                )

    def test_load_state_action_is_public_and_names_the_restart_artifact(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_load_state(
    artifact_name="relaxed_zero_current",
    dataset="m",
    stage_id="restart-positive",
)
study.stages.add_run(stage_id="run-positive", until=1e-12)
"""
        )

        restart = loaded.stages[0]
        self.assertEqual(
            restart.action,
            {
                "kind": "load_state",
                "artifact_name": "relaxed_zero_current",
                "state_path": None,
                "format": None,
                "dataset": "m",
                "sample_index": None,
            },
        )
        node = loaded.study_pipeline_document()["nodes"][0]
        self.assertEqual(node["stage_kind"], "load_state")
        self.assertEqual(node["payload"]["artifact_name"], "relaxed_zero_current")

    def test_transport_current_and_restart_actions_survive_canonical_rewrite(self) -> None:
        source = (
            _PREAMBLE
            + """
region = fm.RegionRef("film")
study.current_transport(
    name="charge", model="ohmic_poisson", domain=[region],
    materials=[fm.ChargeTransportMaterialAssignment(
        region, fm.ChargeTransportMaterial(5e6)
    )],
    boundaries=[
        fm.NormalCurrentElectrode(
            "left", [fm.SurfaceRef("film", "x-", (-1, 0, 0))],
            outward_current_density_Apm2=0.0,
        ),
        fm.NormalCurrentElectrode(
            "right", [fm.SurfaceRef("film", "x+", (1, 0, 0))],
            outward_current_density_Apm2=0.0,
        ),
    ],
    gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(),
)
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"left": -1e12, "right": 1e12},
    stage_id="set-positive",
)
study.stages.add_load_state(
    artifact_name="relaxed_zero_current",
    dataset="m",
    sample_index=-1,
    stage_id="restart-positive",
)
study.stages.add_run(stage_id="run-positive", until=1e-12)
"""
        )
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source_path = root / "source.py"
            source_path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(source_path, lightweight_assets=True)
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten_path = root / "rewritten.py"
            rewritten_path.write_text(rendered, encoding="utf-8")
            reloaded = fm.load_problem_from_script(
                rewritten_path, lightweight_assets=True
            )

        self.assertIn("study.stages.set_transport_current(", rendered)
        self.assertIn("study.stages.add_load_state(", rendered)
        self.assertEqual(
            [stage.stage_id for stage in reloaded.stages],
            ["set-positive", "restart-positive", "run-positive"],
        )
        self.assertEqual(reloaded.stages[1].action["sample_index"], -1)

    def test_spin_torque_activation_is_an_explicit_stage_action(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.spin_torque(fm.ZhangLiSTT(
    current_density=(0.0, 0.0, 0.0),
    id="transport-torque",
    target=fm.RegionRef("film"),
    lande_g=2.0,
    operator_version="zl_mumax3_central_v1",
))
study.stages.set_spin_torque_enabled(
    module_id="transport-torque",
    enabled=False,
    stage_id="disable-transport-torque",
)
study.stages.add_relax(stage_id="relax-zero-current", dt=1e-13)
study.stages.set_spin_torque_enabled(
    module_id="transport-torque",
    enabled=True,
    stage_id="enable-transport-torque",
)
study.stages.add_run(stage_id="run-after-enable", until=1e-12)
"""
        )

        disabled, relax, enabled, run_after_enable = loaded.stages
        self.assertEqual(
            disabled.action,
            {
                "kind": "set_spin_torque_enabled",
                "module_id": "transport-torque",
                "enabled": False,
            },
        )
        self.assertEqual(relax.stage_id, "relax-zero-current")
        self.assertEqual(enabled.action["enabled"], True)
        disabled_graph = disabled.problem.to_ir(include_geometry_assets=False)["physics_graph"]
        relax_graph = relax.problem.to_ir(include_geometry_assets=False)["physics_graph"]
        enabled_graph = enabled.problem.to_ir(include_geometry_assets=False)["physics_graph"]
        self.assertEqual(disabled_graph["modules"][-1]["activation"], "active")
        self.assertEqual(relax_graph["modules"][-1]["activation"], "inactive")
        self.assertEqual(enabled_graph["modules"][-1]["activation"], "inactive")
        run_graph = run_after_enable.problem.to_ir(include_geometry_assets=False)["physics_graph"]
        self.assertEqual(run_graph["modules"][-1]["activation"], "active")
        self.assertEqual(
            [node["stage_kind"] for node in loaded.study_pipeline_document()["nodes"]],
            ["set_spin_torque_enabled", "relax", "set_spin_torque_enabled", "run"],
        )
        rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
        reloaded = _load(rendered)
        self.assertIn("study.stages.set_spin_torque_enabled(", rendered)
        self.assertEqual(reloaded.stages[0].action, disabled.action)
        self.assertEqual(reloaded.stages[2].action, enabled.action)

    def test_tableadd_serializes_object_magnetization_expression(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.tableautosave(1e-12, quantities=["step", "mx", "my", "mz"])
study.tableadd(body.m)
"""
        )

        table = loaded.problem.to_ir(include_geometry_assets=False)["study"][
            "sampling"
        ]["table_autosave"]
        self.assertEqual(table["expressions"], ["film.m"])

    def test_relax_and_run_stage_handles_own_autosave_without_leaking(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=20,
).autosave(fm.StageAutosave(
    target="main",
    table=fm.TableAutosave(every_steps=10, quantities=["step", "mx"]),
    fields=[fm.FieldAutosave("m", every_steps=20)],
))
study.stages.add_run(stage_id="run", until=4e-12).autosave(fm.StageAutosave(
    target="main",
    table=fm.TableAutosave(t_sampl=1e-12, quantities=["step", "t", "mx"]),
    fields=[fm.FieldAutosave("m", every=2e-12)],
))
study.stages.add_run(stage_id="plain", until=8e-12)
"""
        )

        self.assertEqual(loaded.stages[0].autosave.target, "main")
        self.assertEqual(loaded.stages[1].autosave.target, "main")
        self.assertIsNone(loaded.stages[2].autosave)
        relax_ir = loaded.stages[0].to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            script_source=loaded.script_source,
            source_root=loaded.source_path.parent,
            include_geometry_assets=False,
            study_pipeline=loaded.study_pipeline_document(),
        )
        run_ir = loaded.stages[1].to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            script_source=loaded.script_source,
            source_root=loaded.source_path.parent,
            include_geometry_assets=False,
            study_pipeline=loaded.study_pipeline_document(),
        )
        self.assertEqual(
            relax_ir["study"]["sampling"]["stage_autosave"],
            loaded.stages[0].autosave.to_ir(),
        )
        self.assertEqual(
            run_ir["study"]["sampling"]["stage_autosave"],
            loaded.stages[1].autosave.to_ir(),
        )
        self.assertNotIn(
            "stage_autosave",
            loaded.pipeline_base_problem().study.to_ir()["sampling"],
        )

    def test_stage_handle_rejects_duplicate_autosave(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "run stage 'run' already has autosave configured",
        ):
            _load(
                _PREAMBLE
                + """
run = study.stages.add_run(stage_id="run", until=4e-12)
run.autosave(fm.StageAutosave(table=fm.TableAutosave(t_sampl=1e-12)))
run.autosave(fm.StageAutosave(table=fm.TableAutosave(t_sampl=2e-12)))
"""
            )

    def test_stage_handles_reject_wrong_clock_kind(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "relax stage autosave requires accepted-step cadence",
        ):
            _load(
                _PREAMBLE
                + """
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=20,
).autosave(
    fm.StageAutosave(table=fm.TableAutosave(t_sampl=1e-12))
)
"""
            )
        with self.assertRaisesRegex(
            ValueError,
            "run stage autosave requires physical-time cadence",
        ):
            _load(
                _PREAMBLE
                + """
study.stages.add_run(stage_id="run", until=4e-12).autosave(
    fm.StageAutosave(fields=[fm.FieldAutosave("m", every_steps=10)])
)
"""
            )

    def test_relax_stage_handle_owns_table_autosave_without_leaking(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=20,
).tableautosave(every_steps=10, quantities=["step", "mx"])
study.stages.add_run(stage_id="after", until=4e-12)
"""
        )

        pipeline = loaded.study_pipeline_document()
        self.assertIsNotNone(pipeline)
        relax_payload = pipeline["nodes"][0]["payload"]
        self.assertEqual(
            relax_payload["table_autosave"],
            {
                "kind": "table_autosave",
                "table_id": "default",
                "every_steps": 10,
                "quantities": ["step", "mx"],
            },
        )
        self.assertNotIn("table_autosave", pipeline["nodes"][1]["payload"])
        base_ir = loaded.pipeline_base_problem().study.to_ir()
        self.assertNotIn("table_autosave", base_ir["sampling"])

    def test_relax_stage_handle_rejects_duplicate_table_autosave(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "relax stage 'relax' already has table autosave configured",
        ):
            _load(
                _PREAMBLE
                + """
relax = study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=20,
)
relax.tableautosave(every_steps=10)
relax.tableautosave(every_steps=20)
"""
            )

    def test_persistent_table_autosave_warns_about_stage_local_migration(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            loaded = _load(
                _PREAMBLE
                + """
study.stages.tableautosave(every_steps=10)
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=20,
)
"""
            )

        self.assertTrue(
            any(
                issubclass(item.category, DeprecationWarning)
                and "add_relax(...).tableautosave(...)" in str(item.message)
                for item in caught
            )
        )
        self.assertEqual(
            loaded.study_pipeline_document()["nodes"][0]["stage_kind"],
            "table_autosave",
        )

    def test_build_entrypoint_run_pipeline_contains_only_run_owned_controls(self) -> None:
        loaded = _load(
            """
import fullmag as fm

DEFAULT_UNTIL = 4e-12

def build():
    body = fm.Box(10e-9, 10e-9, 5e-9, name="film")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    magnet = fm.Ferromagnet(
        name="film",
        geometry=body,
        material=material,
        m0=fm.texture.uniform(1, 0, 0),
    )
    return fm.Problem(
        name="build-run-pipeline",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator="rk4", fixed_timestep=1e-15),
            outputs=[fm.SaveScalar("E_total", every=1e-12)],
        ),
    )
"""
        )

        pipeline = loaded.study_pipeline_document()
        self.assertIsNotNone(pipeline)
        self.assertEqual(
            pipeline["nodes"][0]["payload"],
            {
                "kind": "run",
                "entrypoint_kind": "build",
                "integrator": "rk4",
                "fixed_timestep": "1e-15",
                "adaptive_timestep": None,
                "demag_interval_s": "",
                "until_seconds": "4e-12",
                "relax_algorithm": "",
                "torque_tolerance": "",
                "energy_tolerance": "",
                "max_steps": "",
                "sampling": {"outputs": [
                    {"kind": "scalar", "name": "E_total", "every_seconds": 1e-12},
                ]},
                "spin_wave_response": None,
            },
        )

    def test_run_relax_and_minimize_preserve_explicit_stage_ids(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(stage_id="relax", max_steps=2, dt=1e-15)
study.stages.add_minimize(stage_id="equilibrate", method="bb", max_steps=2)
study.stages.add_run(stage_id="excite", until=4e-12)
"""
        )
        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax", "equilibrate", "excite"],
        )
        excite_ir = loaded.stages[2].to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            script_source="",
            include_geometry_assets=False,
            study_pipeline=loaded.study_pipeline_document(),
            stage_start_time_s=2e-12,
        )
        self.assertEqual(
            excite_ir["problem_meta"]["runtime_metadata"]["stage_start_time_s"],
            2e-12,
        )
        self.assertEqual(
            excite_ir["problem_meta"]["runtime_metadata"]["active_stage_id"],
            "excite",
        )

    def test_omitted_stage_ids_are_deterministic(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_relax(max_steps=2, dt=1e-15)
study.stages.add_run(4e-12)
"""
        )
        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax-1", "run-1"],
        )

    def test_duplicate_stage_id_is_rejected_at_authoring_time(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate stage_id"):
            _load(
                _PREAMBLE
                + """
study.stages.add_relax(stage_id="same", max_steps=2, dt=1e-15)
study.stages.add_run(stage_id="same", until=4e-12)
"""
            )

    def test_add_field_drive_is_an_ordered_action_after_relaxation(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_minimize(stage_id="relax", method="bb", max_steps=2)
study.stages.add_field_drive(
    fm.RegionalFieldDrive(
        id="k0-sinc-antenna",
        name="Uniform transverse k0 sinc antenna",
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=1e-3,
        direction=(0.0, 1.0, 0.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.SincPulse(cutoff_hz=40e9, t0=50e-12),
        time_origin="stage_local",
    ),
    stage_id="add-antenna",
)
study.stages.add_run(stage_id="excite", until=2e-9)
"""
        )

        self.assertEqual(
            [stage.stage_id for stage in loaded.stages],
            ["relax", "add-antenna", "excite"],
        )
        self.assertEqual(loaded.stages[0].problem.field_drives, ())
        self.assertEqual(loaded.stages[1].problem.field_drives, ())
        for attribute in (
            "magnets",
            "energy",
            "dynamics",
            "discretization",
            "runtime",
            "auxiliary_geometries",
            "current_modules",
            "couplings",
            "pbc",
        ):
            self.assertEqual(
                getattr(loaded.stages[1].problem, attribute),
                getattr(loaded.stages[0].problem, attribute),
                f"{attribute} must pass unchanged from Relax to Add antenna",
            )
        self.assertEqual(loaded.stages[1].action["kind"], "add_field_drive")
        self.assertEqual(
            loaded.stages[1].action["drive"]["id"],
            "k0-sinc-antenna",
        )
        self.assertEqual(
            [drive.id for drive in loaded.stages[2].problem.field_drives],
            ["k0-sinc-antenna"],
        )
        for attribute in (
            "magnets",
            "energy",
            "dynamics",
            "discretization",
            "runtime",
            "auxiliary_geometries",
            "current_modules",
            "couplings",
            "pbc",
        ):
            self.assertEqual(
                getattr(loaded.stages[2].problem, attribute),
                getattr(loaded.stages[1].problem, attribute),
                f"{attribute} must pass unchanged from Add antenna to Run",
            )
        self.assertEqual(
            [drive.id for drive in loaded.workspace_problem.field_drives],
            ["k0-sinc-antenna"],
        )

        pipeline = loaded.study_pipeline_document()
        self.assertEqual(pipeline["nodes"][1]["stage_kind"], "add_field_drive")
        self.assertEqual(
            pipeline["nodes"][1]["payload"]["drive"]["id"],
            "k0-sinc-antenna",
        )

    def test_add_field_drive_rejects_duplicate_drive_id_at_action_boundary(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate field drive id"):
            _load(
                _PREAMBLE
                + """
drive = fm.RegionalFieldDrive(
    id="same-drive",
    name="First drive",
    target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3,
    direction=(0.0, 1.0, 0.0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.Constant(),
)
study.stages.add_field_drive(drive, stage_id="add-first")
study.stages.add_field_drive(
    fm.RegionalFieldDrive(
        id="same-drive",
        name="Second drive",
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=1e-3,
        direction=(0.0, 0.0, 1.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.Constant(),
    ),
    stage_id="add-second",
)
"""
            )

    def test_remove_field_drive_is_ordered_and_allows_readding_same_id(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
def drive(drive_id, name, direction):
    return fm.RegionalFieldDrive(
        id=drive_id,
        name=name,
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=1e-3,
        direction=direction,
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.Constant(),
    )

study.stages.add_field_drive(drive("first", "First", (0, 1, 0)), stage_id="add-first")
study.stages.add_field_drive(drive("second", "Second", (0, 0, 1)), stage_id="add-second")
study.stages.add_run(stage_id="both-active", until=1e-12)
study.stages.remove_field_drive("first", stage_id="remove-first")
study.stages.add_run(stage_id="second-only", until=1e-12)
study.stages.add_field_drive(drive("first", "Replacement", (1, 0, 0)), stage_id="readd-first")
study.stages.add_run(stage_id="replacement-active", until=1e-12)
"""
        )

        self.assertEqual(
            [stage.action["kind"] if stage.action else stage.problem.study.to_ir()["kind"] for stage in loaded.stages],
            [
                "add_field_drive", "add_field_drive", "time_evolution",
                "remove_field_drive", "time_evolution", "add_field_drive", "time_evolution",
            ],
        )
        remove = loaded.stages[3]
        self.assertEqual(remove.entrypoint_kind, "flat_remove_field_drive")
        self.assertEqual(remove.action, {"kind": "remove_field_drive", "drive_id": "first"})
        self.assertEqual([drive.id for drive in remove.problem.field_drives], ["first", "second"])
        self.assertEqual([drive.id for drive in loaded.stages[4].problem.field_drives], ["second"])
        self.assertEqual(
            [drive.name for drive in loaded.stages[6].problem.field_drives],
            ["Second", "Replacement"],
        )
        node = loaded.study_pipeline_document()["nodes"][3]
        self.assertEqual(node["stage_kind"], "remove_field_drive")
        self.assertEqual(node["payload"]["drive_id"], "first")

    def test_remove_field_drive_rejects_empty_unknown_and_repeated_ids(self) -> None:
        for script, message in (
            ('study.stages.remove_field_drive("")', "drive_id must be non-empty"),
            ('study.stages.remove_field_drive("missing")', "field drive id 'missing' does not exist"),
        ):
            with self.subTest(script=script), self.assertRaisesRegex(ValueError, message):
                _load(_PREAMBLE + script)

        with self.assertRaisesRegex(ValueError, "field drive id 'pulse' does not exist"):
            _load(
                _PREAMBLE
                + """
study.stages.add_field_drive(fm.RegionalFieldDrive(
    id="pulse", name="Pulse", target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3, direction=(0, 1, 0),
    spatial_profile=fm.UniformFieldProfile(), waveform=fm.Constant(),
))
study.stages.remove_field_drive("pulse")
study.stages.remove_field_drive("pulse")
"""
            )

    def test_remove_field_drive_stage_id_conflict_preserves_active_drive(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_field_drive(fm.RegionalFieldDrive(
    id="pulse", name="Pulse", target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3, direction=(0, 1, 0),
    spatial_profile=fm.UniformFieldProfile(), waveform=fm.Constant(),
), stage_id="occupied")
try:
    study.stages.remove_field_drive("pulse", stage_id="occupied")
except ValueError as error:
    assert "duplicate stage_id" in str(error)
else:
    raise AssertionError("duplicate stage_id must fail")
study.stages.add_run(stage_id="after-conflict", until=1e-12)
"""
        )

        self.assertEqual(
            [drive.id for drive in loaded.stages[-1].problem.field_drives],
            ["pulse"],
        )

    def test_autosave_and_fft_are_ordered_configuration_stages_not_run_arguments(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_minimize(stage_id="relax", method="bb", max_steps=2)
study.stages.tableautosave(
    5e-13,
    quantities=["time", "step", "mx", "my", "mz", "E_drive"],
    stage_id="table-on",
)
study.stages.autosave("m", every=2e-12, stage_id="autosave-m")
study.stages.autosave("H_drive", every=5e-13, stage_id="autosave-drive")
study.stages.fft_response("my", stage_id="analyse-k0")
study.stages.add_run(stage_id="excite", until=2e-9)
study.stages.tableautosave(enabled=False, stage_id="table-off")
study.stages.autosave(enabled=False, stage_id="autosave-off")
study.stages.fft_response(enabled=False, stage_id="analysis-off")
study.stages.add_run(stage_id="unsampled", until=1e-9)
"""
        )

        self.assertEqual(
            [stage.action["kind"] if stage.action else stage.problem.study.to_ir()["kind"] for stage in loaded.stages],
            [
                "relaxation",
                "table_autosave",
                "autosave",
                "autosave",
                "fft_response",
                "time_evolution",
                "table_autosave",
                "autosave",
                "fft_response",
                "time_evolution",
            ],
        )
        relax_sampling = loaded.stages[0].problem.study.to_ir()["sampling"]
        run_ir = loaded.stages[5].problem.to_ir(include_geometry_assets=False)
        run_sampling = run_ir["study"]["sampling"]
        self.assertIsNone(relax_sampling.get("table_autosave"))
        self.assertEqual(run_sampling["table_autosave"]["sample_period_s"], 5e-13)
        self.assertEqual(
            run_sampling["table_autosave"]["quantities"],
            ["t", "step", "mx", "my", "mz", "e_drive"],
        )
        self.assertEqual(
            run_sampling["outputs"],
            [
                {"kind": "field", "name": "m", "every_seconds": 2e-12},
                {"kind": "field", "name": "H_drive", "every_seconds": 5e-13},
            ],
        )
        self.assertEqual(
            run_ir["problem_meta"]["runtime_metadata"]["spin_wave_response"],
            {
                "schema_version": "spin_wave_response.request.v1",
                "analysis": "gamma",
                "response_component": "my",
                "weighting": "Ms_times_lumped_volume",
                "detrend": "linear",
                "window": "hann",
                "susceptibility_floor_fraction": 1e-6,
            },
        )
        unsampled_ir = loaded.stages[9].problem.to_ir(include_geometry_assets=False)
        self.assertIsNone(unsampled_ir["study"]["sampling"].get("table_autosave"))
        self.assertEqual(unsampled_ir["study"]["sampling"]["outputs"], [])
        self.assertNotIn(
            "spin_wave_response",
            unsampled_ir["problem_meta"]["runtime_metadata"],
        )
        for action_index in (1, 2, 3, 4, 6, 7, 8):
            for attribute in (
                "magnets",
                "energy",
                "dynamics",
                "discretization",
                "runtime",
                "auxiliary_geometries",
                "current_modules",
                "couplings",
                "pbc",
            ):
                self.assertEqual(
                    getattr(loaded.stages[action_index].problem, attribute),
                    getattr(loaded.stages[action_index - 1].problem, attribute),
                    f"{attribute} must pass unchanged through configuration stage {action_index}",
                )

    def test_stage_sampling_accepts_auto_and_preserves_policy_intent(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.tableautosave("auto", quantities=["t", "mx"], stage_id="table-auto")
study.stages.autosave("m", every="auto", stage_id="field-auto")
study.stages.autosave("E_total", every="auto", stage_id="scalar-auto")
study.stages.add_run(stage_id="excite", until=2e-9)
"""
        )

        sampling = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)["study"]["sampling"]
        policy = {
            "kind": "auto_sinc_cutoff",
            "nyquist_guard_factor": 1.3,
        }
        self.assertEqual(
            sampling["table_autosave"],
            {
                "kind": "table_autosave",
                "table_id": "default",
                "sample_period_policy": policy,
                "quantities": ["t", "mx"],
            },
        )
        self.assertEqual(
            sampling["outputs"],
            [
                {"kind": "field_auto", "name": "m", "sample_period_policy": policy},
                {
                    "kind": "scalar_auto",
                    "name": "E_total",
                    "sample_period_policy": policy,
                },
            ],
        )

    def test_add_run_primary_signature_contains_only_time_and_stage_id(self) -> None:
        fm.reset()
        study = fm.study("simple-run-signature")
        self.assertEqual(
            [
                name
                for name, parameter in inspect.signature(
                    study.stages.add_run
                ).parameters.items()
                if parameter.kind is not inspect.Parameter.VAR_KEYWORD
            ],
            ["until", "stage_id"],
        )

    def test_legacy_run_configuration_expands_to_visible_actions(self) -> None:
        loaded = _load(
            _PREAMBLE
            + """
study.stages.add_run(
    stage_id="excite",
    until=2e-9,
    outputs=[fm.SaveField("m", every=2e-12)],
    table_autosave=fm.TableAutosave(
        t_sampl=5e-13,
        quantities=["t", "mx", "my", "mz"],
    ),
    spin_wave_response=fm.GammaResponseAnalysis(response_component="my"),
)
"""
        )

        self.assertEqual(
            [stage.action["kind"] if stage.action else "run" for stage in loaded.stages],
            ["table_autosave", "autosave", "autosave", "fft_response", "run"],
        )
        self.assertEqual(loaded.stages[-1].stage_id, "excite")
        self.assertEqual(
            loaded.stages[-1].problem.study.to_ir()["sampling"]["outputs"],
            [{"kind": "field", "name": "m", "every_seconds": 2e-12}],
        )


if __name__ == "__main__":
    unittest.main()
