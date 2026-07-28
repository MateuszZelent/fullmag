from __future__ import annotations

import json
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal, get_args, get_origin, get_type_hints

import fullmag as fm
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import (
    _requested_sampling_period_from_ir,
    export_builder_draft,
    rewrite_loaded_problem_script,
)


def _load_text(script: str, directory: Path, name: str = "problem.py"):
    path = directory / name
    path.write_text(textwrap.dedent(script), encoding="utf-8")
    return fm.load_problem_from_script(path, lightweight_assets=True)


_SCRIPT = """
import fullmag as fm

study = fm.study("drive-roundtrip")
study.engine("fem")
film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
study.antenna_object(fm.Box(20e-9, 40e-9, 5e-9), name="source-mask")

study.field_drives.add(fm.RegionalFieldDrive(
    id="global-sinc",
    name="Global sinc",
    target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3,
    direction=(0, 1, 0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.SincPulse(cutoff_hz=20e9, t0=100e-12),
    time_origin="stage_local",
    activation=fm.DriveActivation.stage_ids(["excite"]),
))
study.field_drives.add(fm.RegionalFieldDrive(
    id="masked-pwl",
    name="Masked PWL",
    target=fm.FieldTarget.object("film"),
    amplitude_B_T=0.5e-3,
    direction=(0, 0, 1),
    spatial_profile=fm.GeometryMaskFieldProfile(
        object_id="source-mask",
        envelope=fm.SincFieldProfile(
            axis=(1, 0, 0), period_m=20e-9, center_m=0, width_m=40e-9, window="hann"
        ),
    ),
    waveform=fm.PiecewiseLinear([(0, 0), (1e-12, 1), (2e-12, 0)]),
    time_origin="absolute",
    activation=fm.DriveActivation.all_time_evolution(),
))
study.stages.add_relax(stage_id="relax", max_steps=2, dt=1e-15)
study.stages.add_run(stage_id="excite", until=4e-12)
"""


def _requested_layered_mesh(loaded: object) -> dict[str, object]:
    problem = loaded.stages[-1].problem  # type: ignore[attr-defined]
    per_geometry = problem.runtime_metadata["mesh_workflow"]["per_geometry"]
    return dict(per_geometry[0])


class LayeredMeshAuthoringRoundTripTests(unittest.TestCase):
    def _load_layered(self, root: Path, call: str, name: str) -> object:
        return _load_text(
            f"""
            import fullmag as fm

            study = fm.study("layered-roundtrip")
            study.engine("fem")
            film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.alpha = 0.01
            {call}
            study.stages.add_run(stage_id="run", until=1e-12)
            """,
            root,
            name,
        )

    def test_prismatic_thin_film_preserves_requested_layered_mesh_ir(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            loaded = self._load_layered(
                Path(tmp_dir),
                'film.mesh.thin_film(maximum_element_size=3e-9, layers=1, topology="prismatic", exact_layers=True, order=1)',
                "thin_film.py",
            )

        mesh = _requested_layered_mesh(loaded)
        self.assertEqual(mesh["topology"], "prismatic")
        self.assertEqual(mesh["sweep_direction"], "auto")
        self.assertEqual(mesh["element_family"], "prism")
        self.assertEqual(mesh["transition_policy"], "pyramid_to_tetrahedra")
        self.assertIs(mesh["exact_layer_count"], True)
        self.assertEqual(mesh["through_thickness_elements"], 1)

    def test_public_layered_mesh_enum_arguments_use_literal_types(self) -> None:
        thin_film_hints = get_type_hints(fm.world.GeometryMeshHandle.thin_film)
        swept_hints = get_type_hints(fm.world.GeometryMeshHandle.swept)

        topology_literal = next(
            argument
            for argument in get_args(thin_film_hints["topology"])
            if get_origin(argument) is Literal
        )
        transition_literal = next(
            argument
            for argument in get_args(thin_film_hints["transition"])
            if get_origin(argument) is Literal
        )
        self.assertIs(get_origin(topology_literal), Literal)
        self.assertEqual(
            set(get_args(topology_literal)),
            {"tetrahedral", "prismatic"},
        )
        self.assertIs(get_origin(transition_literal), Literal)
        self.assertEqual(
            set(get_args(transition_literal)),
            {"pyramid_to_tetrahedra", "reject"},
        )
        self.assertIs(get_origin(swept_hints["distribution"]), Literal)
        self.assertEqual(
            set(get_args(swept_hints["distribution"])),
            {"fixed", "linear", "exponential"},
        )
        self.assertIs(get_origin(swept_hints["face_meshing"]), Literal)
        self.assertEqual(
            set(get_args(swept_hints["face_meshing"])),
            {"triangular", "quadrilateral"},
        )

    def test_ui_scene_exports_canonical_prismatic_python_and_round_trips_ir(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = self._load_layered(
                root,
                'film.mesh.thin_film(layers=1, topology="prismatic", exact_layers=True, order=1)',
                "source.py",
            )
            expected = _requested_layered_mesh(loaded)
            scene = json.loads(json.dumps(build_scene_document_from_builder(export_builder_draft(loaded))))
            builder = build_builder_from_scene_document(scene)
            rendered = rewrite_loaded_problem_script(loaded, overrides=builder)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertIn(".mesh.thin_film(", rendered)
        self.assertIn('topology="prismatic"', rendered)
        self.assertIn("exact_layers=True", rendered)
        self.assertEqual(_requested_layered_mesh(rewritten), expected)

    def test_swept_defaults_and_prismatic_thin_film_lower_to_equivalent_hints(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            thin = self._load_layered(
                root,
                'film.mesh.thin_film(layers=1, topology="prismatic", order=1)',
                "thin.py",
            )
            swept = self._load_layered(root, "film.mesh.swept(elements=1)", "swept.py")

        keys = (
            "sweep_direction",
            "through_thickness_elements",
            "through_thickness_distribution",
            "element_family",
            "transition_policy",
            "exact_layer_count",
        )
        thin_mesh = _requested_layered_mesh(thin)
        swept_mesh = _requested_layered_mesh(swept)
        self.assertEqual(
            {key: thin_mesh[key] for key in keys},
            {key: swept_mesh[key] for key in keys},
        )

    def test_legacy_thin_film_remains_tetrahedral_across_authoring_round_trip(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = self._load_layered(
                root,
                "film.mesh.thin_film(maximum_element_size=3e-9, layers=1)",
                "legacy.py",
            )
            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            builder = build_builder_from_scene_document(scene)
            rendered = rewrite_loaded_problem_script(loaded, overrides=builder)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "legacy_rewritten.py")

        before = _requested_layered_mesh(loaded)
        after = _requested_layered_mesh(rewritten)
        self.assertEqual(
            before,
            {
                "geometry": "film",
                "mode": "custom",
                "hmax": 3e-9,
                "maximum_element_size": 3e-9,
                "hmin": 5e-9,
                "minimum_element_size": 5e-9,
                "interface_hmax": 3e-9,
                "interface_thickness": 3e-9,
                "transition_distance": 24e-9,
                "edge_hmax": 5e-9,
                "edge_thickness": 3e-9,
                "edge_transition_distance": 12e-9,
                "corner_hmax": 5e-9,
                "corner_extent": 3e-9,
                "corner_transition_distance": 12e-9,
                "mesh_strategy": "thin_film_tetrahedral",
                "through_thickness_elements": 1,
                "through_thickness_distribution": "fixed",
                "sweep_face_meshing": "triangular",
            },
        )
        self.assertEqual(after, before)
        self.assertNotIn("topology=", rendered)

    def test_scene_rewrite_rejects_non_integral_or_non_positive_layer_counts(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            thin_loaded = self._load_layered(
                root,
                'film.mesh.thin_film(layers=1, topology="prismatic")',
                "scene_thin.py",
            )
            swept_loaded = self._load_layered(
                root,
                "film.mesh.swept(elements=1)",
                "scene_swept.py",
            )

            for loaded in (thin_loaded, swept_loaded):
                for invalid in (True, 1.5, 0, -1):
                    with self.subTest(strategy=_requested_layered_mesh(loaded)["mesh_strategy"], invalid=invalid):
                        builder = export_builder_draft(loaded)
                        builder["geometries"][0]["mesh"]["through_thickness_elements"] = invalid
                        with self.assertRaises((TypeError, ValueError)):
                            rewrite_loaded_problem_script(loaded, overrides=builder)

    def test_extended_prismatic_exact_false_round_trips_without_early_rejection(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = self._load_layered(
                root,
                'study.mode("extended"); film.mesh.thin_film(layers=1, topology="prismatic", exact_layers=False)',
                "extended.py",
            )
            builder = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(builder)
            rendered = rewrite_loaded_problem_script(loaded, overrides=builder)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "extended_rewritten.py")

        self.assertEqual(builder["requested_mode"], "extended")
        self.assertEqual(scene["study"]["requested_mode"], "extended")
        self.assertIs(_requested_layered_mesh(loaded)["exact_layer_count"], False)
        self.assertIn("exact_layers=False", rendered)
        self.assertIs(_requested_layered_mesh(rewritten)["exact_layer_count"], False)

    def test_prismatic_thin_film_with_generic_controls_preserves_typed_export(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = self._load_layered(
                root,
                'film.mesh.thin_film(layers=2, topology="prismatic").configure(compute_quality=True, growth_rate=1.3, algorithm_3d=1)',
                "controlled.py",
            )
            before = _requested_layered_mesh(loaded)
            rendered = rewrite_loaded_problem_script(
                loaded, overrides=export_builder_draft(loaded)
            )["rendered_source"]
            rewritten = _load_text(str(rendered), root, "controlled_rewritten.py")

        self.assertIn(".mesh(", rendered)
        self.assertIn(".thin_film(", rendered)
        self.assertIn('topology="prismatic"', rendered)
        self.assertIn("compute_quality=True", rendered)
        self.assertIn("growth_rate=1.3", rendered)
        self.assertIn("algorithm_3d=1", rendered)
        self.assertEqual(_requested_layered_mesh(rewritten), before)

    def test_prismatic_then_explicit_swept_direction_exports_swept_call(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = self._load_layered(
                root,
                'film.mesh.thin_film(layers=1, topology="prismatic").swept(elements=2, sweep_direction="x", transition="reject")',
                "sequence.py",
            )
            rendered = rewrite_loaded_problem_script(
                loaded, overrides=export_builder_draft(loaded)
            )["rendered_source"]
            rewritten = _load_text(str(rendered), root, "sequence_rewritten.py")

        self.assertIn(".swept(", rendered)
        self.assertIn('sweep_direction="x"', rendered)
        self.assertIn('transition="reject"', rendered)
        self.assertNotIn(".thin_film(", rendered)
        self.assertEqual(_requested_layered_mesh(rewritten), _requested_layered_mesh(loaded))


class ScriptBuilderRegionalDriveRoundTripTests(unittest.TestCase):
    def test_planar_monitors_roundtrip_through_scene_and_canonical_python(self) -> None:
        script = """
        import fullmag as fm

        study = fm.study("planar-roundtrip")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.monitors.add_planar(
            monitor_id="plane",
            name="Plane",
            target=fm.MonitorTarget.object("film"),
            frame=fm.PlanarFrame.xy(
                position=0.0,
                extent=fm.PlanarExtent.target_bounds(padding=1e-9),
            ),
            operator=fm.PlaneSample(),
        )
        study.monitors.add_planar(
            monitor_id="slab",
            name="Slab",
            target=fm.MonitorTarget.magnetic_domain(),
            frame=fm.PlanarFrame.yz(
                position=2e-9,
                extent=fm.PlanarExtent.magnetic_domain(),
            ),
            operator=fm.SlabAverage(thickness=3e-9),
        )
        study.monitors.add_planar(
            monitor_id="depth",
            name="Depth",
            target=fm.MonitorTarget.domain(),
            frame=fm.PlanarFrame(
                origin=(0.0, 0.0, 0.0),
                normal=(1.0, 1.0, 1.0),
                u_axis=(1.0, -1.0, 0.0),
                extent=fm.PlanarExtent.universe(padding=2e-9),
            ),
            operator=fm.DepthProjection(
                reduction="thickness_integral",
                empty_policy="exclude_empty",
            ),
        )
        study.monitors.add_planar(
            monitor_id="surface",
            name="Surface",
            target=fm.MonitorTarget.object("film"),
            frame=fm.PlanarFrame.xz(
                position=0.0,
                extent=fm.PlanarExtent.explicit(
                    u=(-50e-9, 50e-9),
                    v=(-2.5e-9, 2.5e-9),
                ),
            ),
            operator=fm.SurfaceProjection(
                boundary=fm.SurfaceBoundary.object_boundary(),
                visibility_policy="frontmost",
            ),
        )
        study.stages.add_run(stage_id="run", until=1e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            builder = build_builder_from_scene_document(scene)
            rendered = rewrite_loaded_problem_script(
                loaded,
                overrides=builder,
            )["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        expected = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)[
            "planar_monitors"
        ]
        actual = rewritten.stages[-1].problem.to_ir(include_geometry_assets=False)[
            "planar_monitors"
        ]
        self.assertEqual(scene["monitors"]["planar"], expected)
        self.assertEqual(builder["planar_monitors"], expected)
        self.assertEqual(actual, expected)
        self.assertEqual(rendered.count("study.monitors.add_planar("), 4)
        self.assertNotIn('"quantity"', rendered)
        self.assertNotIn('"resolution"', rendered)

    def test_add_field_drive_roundtrip_preserves_pipeline_order_without_global_leakage(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("ordered-drive")
        study.engine("fem")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.add_minimize(stage_id="relax", method="bb", max_steps=2)
        study.stages.add_field_drive(
            fm.RegionalFieldDrive(
                id="k0-sinc",
                name="K0 sinc",
                target=fm.FieldTarget.global_domain(),
                amplitude_B_T=1e-3,
                direction=(0, 1, 0),
                spatial_profile=fm.UniformFieldProfile(),
                waveform=fm.SincPulse(cutoff_hz=40e9, t0=50e-12),
                time_origin="stage_local",
            ),
            stage_id="add-antenna",
        )
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertNotIn("study.field_drives.add(", rendered)
        relax_at = rendered.index('study.stages.add_relax(stage_id="relax"')
        add_at = rendered.index("study.stages.add_field_drive(")
        run_at = rendered.index('study.stages.add_run(stage_id="excite"')
        self.assertLess(relax_at, add_at)
        self.assertLess(add_at, run_at)
        self.assertEqual(
            [
                stage.action["kind"] if stage.action else stage.problem.study.to_ir()["kind"]
                for stage in rewritten.stages
            ],
            ["relaxation", "add_field_drive", "time_evolution"],
        )
        self.assertEqual(rewritten.stages[0].problem.field_drives, ())
        self.assertEqual(
            [drive.id for drive in rewritten.stages[2].problem.field_drives],
            ["k0-sinc"],
        )

    def test_remove_field_drive_roundtrip_preserves_drive_and_action_ids(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("remove-drive-roundtrip")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.add_field_drive(fm.RegionalFieldDrive(
            id="antenna", name="Antenna", target=fm.FieldTarget.global_domain(),
            amplitude_B_T=1e-3, direction=(0, 1, 0),
            spatial_profile=fm.UniformFieldProfile(), waveform=fm.Constant(),
        ), stage_id="add-antenna")
        study.stages.add_run(stage_id="driven", until=1e-12)
        study.stages.remove_field_drive("antenna", stage_id="remove-antenna")
        study.stages.add_run(stage_id="free", until=1e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertIn(
            'study.stages.remove_field_drive("antenna", stage_id="remove-antenna")',
            rendered,
        )
        self.assertEqual(rewritten.stages[2].action["drive_id"], "antenna")
        self.assertEqual(rewritten.stages[2].stage_id, "remove-antenna")
        self.assertEqual([drive.id for drive in rewritten.stages[1].problem.field_drives], ["antenna"])
        self.assertEqual(rewritten.stages[3].problem.field_drives, ())

    def test_independent_autosave_and_fft_stages_roundtrip_before_simple_run(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("sampling-roundtrip")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave(
            5e-13,
            quantities=["time", "step", "mx", "my", "mz", "E_drive"],
            stage_id="table-on",
        )
        study.stages.autosave("m", every=2e-12, stage_id="autosave-m")
        study.stages.autosave("H_drive", every=5e-13, stage_id="autosave-drive")
        study.stages.fft_response("my", stage_id="analyse-k0")
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertIn("study.stages.tableautosave(", rendered)
        self.assertIn('study.stages.autosave("m", every=2e-12', rendered)
        self.assertIn('study.stages.fft_response("my"', rendered)
        self.assertIn('study.stages.add_run(stage_id="excite", until=2e-09)', rendered)
        self.assertNotIn("table_autosave=", rendered)
        self.assertNotIn("outputs=[", rendered)
        self.assertNotIn("spin_wave_response=", rendered)
        before = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)
        after = rewritten.stages[-1].problem.to_ir(include_geometry_assets=False)
        self.assertEqual(before["study"]["sampling"], after["study"]["sampling"])
        self.assertEqual(
            before["problem_meta"]["runtime_metadata"]["spin_wave_response"],
            after["problem_meta"]["runtime_metadata"]["spin_wave_response"],
        )

    def test_automatic_sampling_stages_roundtrip_as_literal_auto(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("auto-sampling-roundtrip")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave("auto", quantities=["t", "mx"], stage_id="table-auto")
        study.stages.autosave("m", every="auto", stage_id="field-auto")
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")

        self.assertIn('study.stages.tableautosave("auto"', rendered)
        self.assertIn('study.stages.autosave("m", every="auto"', rendered)
        before = loaded.stages[-1].problem.to_ir(include_geometry_assets=False)
        after = rewritten.stages[-1].problem.to_ir(include_geometry_assets=False)
        self.assertEqual(before["study"]["sampling"], after["study"]["sampling"])

    def test_auto_sampling_export_ignores_resolved_cadence(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("auto-sampling-resolved")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave("auto", stage_id="table-auto")
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "source.py")
            loaded.stages[0].action["table_autosave"]["resolved_sample_period_s"] = 7.6923e-11
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('study.stages.tableautosave("auto"', rendered)
        self.assertNotIn("7.6923e-11", rendered)

    def test_resolved_auto_output_ir_imports_as_requested_auto_intent(self) -> None:
        policy = {
            "kind": "auto_sinc_cutoff",
            "nyquist_guard_factor": 1.3,
        }
        for kind in ("field_resolved_auto", "scalar_resolved_auto"):
            with self.subTest(kind=kind):
                self.assertEqual(
                    _requested_sampling_period_from_ir(
                        {
                            "kind": kind,
                            "name": "m" if kind.startswith("field") else "mx",
                            "every_seconds": 7.6923e-11,
                            "requested_policy": policy,
                        },
                        "every_seconds",
                    ),
                    "auto",
                )

    def test_ordered_resolved_auto_outputs_rewrite_as_literal_auto(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("resolved-auto-output-roundtrip")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.autosave("m", every="auto", stage_id="field-auto")
        study.stages.autosave("mx", every="auto", stage_id="scalar-auto")
        study.stages.add_run(stage_id="excite", until=2e-9)
        """
        policy = {
            "kind": "auto_sinc_cutoff",
            "nyquist_guard_factor": 1.3,
        }
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(script, Path(tmp_dir), "source.py")
            for index, kind in enumerate(("field_resolved_auto", "scalar_resolved_auto")):
                output = loaded.stages[index].action["output"]
                output.clear()
                output.update(
                    {
                        "kind": kind,
                        "name": "m" if kind.startswith("field") else "mx",
                        "every_seconds": 7.6923e-11,
                        "requested_policy": policy,
                    }
                )
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('study.stages.autosave("m", every="auto"', rendered)
        self.assertIn('study.stages.autosave("mx", every="auto"', rendered)
        self.assertNotIn("7.6923e-11", rendered)

    def test_resolved_auto_output_rejects_invalid_requested_policy(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported automatic sampling period policy"):
            _requested_sampling_period_from_ir(
                {
                    "kind": "field_resolved_auto",
                    "name": "m",
                    "every_seconds": 7.6923e-11,
                    "requested_policy": {
                        "kind": "auto_sinc_cutoff",
                        "nyquist_guard_factor": 1.2,
                    },
                },
                "every_seconds",
            )

    def test_table_autosave_override_rejects_invalid_numeric_ir_cadence(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("invalid-imported-sampling")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.add_run(stage_id="run", until=2e-9)
        """
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(script, Path(tmp_dir), "source.py")
            for invalid in (0.0, -1e-12, float("nan"), float("inf"), "1e-12", True):
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        rewrite_loaded_problem_script(
                            loaded,
                            overrides={
                                "table_autosave": {
                                    "kind": "table_autosave",
                                    "sample_period_s": invalid,
                                }
                            },
                        )

    def test_ordered_sampling_stages_reject_invalid_numeric_ir_cadence(self) -> None:
        script = """
        import fullmag as fm
        study = fm.study("invalid-ordered-sampling")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.stages.tableautosave(1e-12, stage_id="table")
        study.stages.autosave("m", every=1e-12, stage_id="field")
        study.stages.add_run(stage_id="run", until=2e-9)
        """
        invalid_values = (0.0, -1e-12, float("nan"), float("inf"), "1e-12", True)
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            for stage_index, payload_key, cadence_key in (
                (0, "table_autosave", "sample_period_s"),
                (1, "output", "every_seconds"),
            ):
                for invalid in invalid_values:
                    with self.subTest(stage_index=stage_index, invalid=invalid):
                        loaded = _load_text(script, root, f"source-{stage_index}.py")
                        loaded.stages[stage_index].action[payload_key][cadence_key] = invalid
                        with self.assertRaises(ValueError):
                            rewrite_loaded_problem_script(loaded)

    def test_canonical_rewrite_preserves_drives_and_stage_ids(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(_SCRIPT, root, "source.py")
            before = loaded.problem.to_ir(include_geometry_assets=False)["field_drives"]
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "rewritten.py")
            after = rewritten.problem.to_ir(include_geometry_assets=False)["field_drives"]

        self.assertIn("study.field_drives.add(fm.RegionalFieldDrive(", rendered)
        self.assertIn('stage_id="relax"', rendered)
        self.assertIn('stage_id="excite"', rendered)
        self.assertEqual(before, after)
        self.assertEqual(
            [stage.stage_id for stage in rewritten.stages],
            ["relax", "excite"],
        )

    def test_scene_document_keeps_field_drives_as_typed_state(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(_SCRIPT, Path(tmp_dir))
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
        expected = loaded.problem.to_ir(include_geometry_assets=False)["field_drives"]
        self.assertEqual(scene["field_drives"]["drives"], expected)
        self.assertNotIn("field_drives", scene["current_modules"])

    def test_legacy_prescribed_mask_migrates_one_way(self) -> None:
        legacy = """
        import fullmag as fm
        study = fm.study("legacy-mask")
        film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
        study.antenna_object(fm.Box(20e-9, 40e-9, 5e-9), name="source-mask")
        study.antenna_field_source(
            name="legacy-drive",
            model="prescribed_zeeman_mask",
            object="source-mask",
            B=1e-3,
            direction=(0, 1, 0),
            spatial_profile={"kind": "uniform"},
            waveform=fm.SincPulse(cutoff_hz=20e9, t0=100e-12),
        )
        study.stages.add_run(stage_id="excite", until=1e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(legacy, root)
            ir = loaded.problem.to_ir(include_geometry_assets=False)
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertEqual(ir["current_modules"], [])
        self.assertEqual(ir["field_drives"][0]["kind"], "regional")
        self.assertEqual(
            ir["field_drives"][0]["migration"],
            {"migrated_from": "prescribed_zeeman_mask"},
        )
        self.assertNotIn('model="prescribed_zeeman_mask"', rendered)
        self.assertIn("RegionalFieldDrive", rendered)

    def test_canonical_scene_roundtrip_json_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(_SCRIPT, root, "first.py")
            first_scene = build_scene_document_from_builder(export_builder_draft(loaded))
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            loaded_again = _load_text(str(rendered), root, "second.py")
            second_scene = build_scene_document_from_builder(export_builder_draft(loaded_again))
        self.assertEqual(
            json.dumps(first_scene["field_drives"], sort_keys=True),
            json.dumps(second_scene["field_drives"], sort_keys=True),
        )

    def test_flat_thermal_noise_roundtrip_preserves_temperature_and_seed(self) -> None:
        script = """
        import fullmag as fm
        fm.engine("fdm")
        film = fm.geometry(fm.Box(40e-9, 20e-9, 5e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        fm.thermal_noise(300.0, seed=123)
        fm.run(1e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(script, root, "thermal_source.py")
            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            rewritten = _load_text(str(rendered), root, "thermal_rewritten.py")

        before = loaded.problem.to_ir(include_geometry_assets=False)
        after = rewritten.problem.to_ir(include_geometry_assets=False)
        self.assertIn("fm.thermal_noise(temperature=300, seed=123)", rendered)
        self.assertEqual(after["temperature"], before["temperature"])
        self.assertEqual(after["energy_terms"], before["energy_terms"])


if __name__ == "__main__":
    unittest.main()
