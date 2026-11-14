"""Mask antennas in the study: authoring, stages and ProblemIR."""

from __future__ import annotations

import textwrap
import unittest
import warnings
from math import pi, sin
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
import fullmag.world as flat_world
from fullmag import GHz, mT, nm


def static_mask(x, y, z, b):
    return (0.0, 0.0, b)


def sine(t, frequency):
    return sin(2 * pi * frequency * t)


def wave_mask_sin(x, y, z, k, B0):
    return (B0 * sin(k * x), 0, 0)


def study_with_film(name: str = "mask-antenna"):
    fm.reset()
    study = fm.study(name)
    film = study.geometry(fm.Box(100e-9, 50e-9, 10e-9), name="film")
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.01
    film.m = fm.texture.uniform(1, 0, 0)
    study.exchange()
    return study, film


def my_antenna(wavelength, frequency, B0):
    """A user module: plain Python returning (mask, time) pairs."""
    k = 2 * pi / wavelength
    return (
        (fm.mask(wave_mask_sin, k=k, B0=B0), fm.time(sine, frequency=frequency)),
        (fm.mask(static_mask, b=B0 / 10), None),
    )


class MaskAntennaTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def test_add_returns_self_and_appends_terms(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        result = antenna.add(fm.mask(static_mask, b=1e-3), fm.time(sine, frequency=1e9))
        self.assertIs(result, antenna)
        antenna.add(fm.mask(static_mask, b=2e-3))
        self.assertEqual(len(antenna.terms), 2)
        self.assertIsNone(antenna.terms[1].time)

    def test_bare_callable_is_rejected_with_hint(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        with self.assertRaisesRegex(TypeError, r"fm\.mask\(f, name=value"):
            antenna.add(static_mask)
        with self.assertRaisesRegex(TypeError, r"fm\.time\(g"):
            antenna.add(fm.mask(static_mask, b=1e-3), sine)

    def test_ninth_term_is_rejected(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        for _ in range(8):
            antenna.add(fm.mask(static_mask, b=1e-3))
        with self.assertRaisesRegex(fm.MaskFunctionError, "8 terms"):
            antenna.add(fm.mask(static_mask, b=1e-3))

    def test_lowers_to_ir(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(
            film,
            fm.Box(60 * nm, 50 * nm, 5 * nm),
            position=(0.0, 0.0, -2.5 * nm),
            frame="world",
            time_origin="absolute",
            name="Antenna",
        )
        antenna.add(fm.mask(static_mask, b=0.2 * mT), fm.time(sine, frequency=3.6 * GHz))
        ir = antenna.to_ir()
        self.assertEqual(ir["schema_version"], "mask_field_drive.v1")
        self.assertEqual(ir["id"], "antenna")
        self.assertEqual(ir["name"], "Antenna")
        self.assertEqual(ir["target"], {"kind": "object", "object_id": "film"})
        self.assertEqual(
            ir["shape"],
            {"kind": "box", "size": [60 * nm, 50 * nm, 5 * nm], "center": [0.0, 0.0, 0.0]},
        )
        self.assertEqual(ir["position_m"], [0.0, 0.0, -2.5e-9])
        self.assertEqual((ir["frame"], ir["time_origin"]), ("world", "absolute"))
        self.assertEqual(ir["activation"], {"kind": "all_time_evolution"})
        self.assertEqual(ir["terms"][0]["mask"]["kind"], "function")
        self.assertEqual(ir["terms"][0]["mask"]["function"]["outputs"], ["0.0", "0.0", "b"])
        self.assertEqual(ir["terms"][0]["time"]["outputs"], ["sin(2 * pi * frequency * t)"])

    def test_add_field_drive_registers_stage_action(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3), fm.time(sine, frequency=1e9))
        study.stages.add_run(stage_id="before", until=1e-12)
        study.stages.add_field_drive(antenna, stage_id="add_source")
        study.stages.add_run(stage_id="run", until=1e-12)
        stages = flat_world._state._declared_stages
        add_stage = next(stage for stage in stages if stage.stage_id == "add_source")
        self.assertEqual(add_stage.entrypoint_kind, "flat_add_mask_field_drive")
        self.assertEqual(add_stage.action["kind"], "add_mask_field_drive")
        self.assertEqual(add_stage.action["drive"], antenna.to_ir())
        before = next(stage for stage in stages if stage.stage_id == "before")
        run = next(stage for stage in stages if stage.stage_id == "run")
        ir_before = before.problem.to_ir(include_geometry_assets=False)
        ir_run = run.problem.to_ir(include_geometry_assets=False)
        self.assertNotIn("mask_field_drives", ir_before)
        self.assertEqual([drive["id"] for drive in ir_run["mask_field_drives"]], ["antenna"])

    def test_regional_drive_still_emits_add_field_drive(self) -> None:
        study, _ = study_with_film()
        drive = fm.RegionalFieldDrive(
            id="regional",
            name="Regional",
            target=fm.FieldTarget.global_domain(),
            amplitude_B_T=1e-3,
            direction=(0, 1, 0),
            spatial_profile=fm.UniformFieldProfile(),
            waveform=fm.Constant(),
        )
        study.stages.add_field_drive(drive, stage_id="add_regional")
        stage = flat_world._state._declared_stages[-1]
        self.assertEqual(stage.action["kind"], "add_field_drive")

    def test_terms_are_final_once_added(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3))
        study.stages.add_field_drive(antenna)
        with self.assertRaisesRegex(fm.MaskFunctionError, "already added"):
            antenna.add(fm.mask(static_mask, b=1e-3))

    def test_field_drives_add_accepts_mask_antenna(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3))
        study.field_drives.add(antenna)
        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)
        self.assertEqual(ir["mask_field_drives"][0]["id"], "antenna")

    def test_remove_field_drive_removes_mask_antenna(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3))
        study.stages.add_field_drive(antenna)
        study.stages.remove_field_drive("antenna", stage_id="remove")
        stage = flat_world._state._declared_stages[-1]
        self.assertEqual(stage.action, {"kind": "remove_field_drive", "drive_id": "antenna"})
        self.assertNotIn(
            "mask_field_drives",
            flat_world._build_problem().to_ir(include_geometry_assets=False),
        )

    def test_duplicate_ids_are_rejected(self) -> None:
        study, film = study_with_film()
        first = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9), id="a")
        first.add(fm.mask(static_mask, b=1e-3))
        study.field_drives.add(first)
        with self.assertRaisesRegex(ValueError, "duplicate antenna id"):
            study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9), id="a")

    def test_generated_ids_are_unique(self) -> None:
        study, film = study_with_film()
        first = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        second = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        self.assertEqual((first.id, second.id), ("antenna", "antenna_2"))

    def test_user_module_returning_pairs_works(self) -> None:
        study, film = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
        for field, drive in my_antenna(196 * nm, 4.5 * GHz, 1 * mT):
            antenna.add(field, drive)
        ir = antenna.to_ir()
        self.assertEqual(len(ir["terms"]), 2)
        self.assertNotIn("time", ir["terms"][1])

    def test_target_must_be_a_magnet(self) -> None:
        study, _ = study_with_film()
        with self.assertRaises(TypeError):
            study.add_simpleantenna.arbitrary_mask(object(), fm.Box(50e-9, 50e-9, 10e-9))
        antenna = study.add_simpleantenna.arbitrary_mask("nope", fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3))
        study.field_drives.add(antenna)
        with self.assertRaisesRegex(ValueError, "mask_target_unknown"):
            flat_world._build_problem()

    def test_scoped_factories_bind_object_and_region(self) -> None:
        study, film = study_with_film()
        region = film.add_region("left", fm.Box(50e-9, 50e-9, 10e-9))
        on_film = film.add_simpleantenna.arbitrary_mask(fm.Box(50e-9, 50e-9, 10e-9))
        on_region = region.add_simpleantenna.arbitrary_mask(
            name="RF source",
            shape=fm.Box(40e-9, 40e-9, 10e-9),
            position=(0.0, 0.0, 0.0),
            frame="world",
            time_origin="absolute",
        )
        on_all = study.add_simpleantenna.arbitrary_mask("global", fm.Box(50e-9, 50e-9, 10e-9))
        by_region = study.add_simpleantenna.arbitrary_mask(region, fm.Box(50e-9, 50e-9, 10e-9))
        self.assertEqual(on_film.target.to_ir(), {"kind": "object", "object_id": "film"})
        expected_region = {"kind": "region", "object_id": "film", "region_id": region.region_id}
        self.assertEqual(on_region.target.to_ir(), expected_region)
        self.assertEqual(by_region.target.to_ir(), expected_region)
        self.assertEqual(on_all.target.to_ir(), {"kind": "global"})
        self.assertEqual(on_region.id, "rf_source")
        for antenna in (on_film, on_region, on_all):
            antenna.add(fm.mask(static_mask, b=1e-3))
            study.field_drives.add(antenna)
        ir = flat_world._build_problem().to_ir(include_geometry_assets=False)
        self.assertEqual(
            [drive["target"]["kind"] for drive in ir["mask_field_drives"]],
            ["object", "region", "global"],
        )

    def test_scoped_target_override_is_rejected(self) -> None:
        study, film = study_with_film()
        region = film.add_region("left", fm.Box(50e-9, 50e-9, 10e-9))
        for scoped in (film.add_simpleantenna, region.add_simpleantenna):
            with self.assertRaisesRegex(ValueError, "scoped_target_override_not_allowed"):
                scoped.arbitrary_mask(fm.Box(50e-9, 50e-9, 10e-9), target="global")

    def test_unknown_region_target_is_rejected(self) -> None:
        study, _ = study_with_film()
        antenna = study.add_simpleantenna.arbitrary_mask(
            fm.FieldTarget.region("film", "film:missing"), fm.Box(50e-9, 50e-9, 10e-9)
        )
        antenna.add(fm.mask(static_mask, b=1e-3))
        study.field_drives.add(antenna)
        with self.assertRaisesRegex(ValueError, "mask_target_unknown"):
            flat_world._build_problem()

    def test_term_names(self) -> None:
        study, film = study_with_film()
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3), name="left")
        with self.assertRaisesRegex(ValueError, "already has a term named 'left'"):
            antenna.add(fm.mask(static_mask, b=1e-3), name="left")
        with self.assertRaisesRegex(ValueError, "term name"):
            antenna.add(fm.mask(static_mask, b=1e-3), name="1bad")
        antenna.add(fm.mask(static_mask, b=2e-3))
        terms = antenna.to_ir()["terms"]
        self.assertEqual(terms[0]["name"], "left")
        self.assertNotIn("name", terms[1])

    def test_update_field_drive_patches_following_stages(self) -> None:
        study, film = study_with_film()
        antenna = film.add_simpleantenna.arbitrary_mask(
            fm.Box(50e-9, 50e-9, 10e-9), time_origin="absolute"
        )
        antenna.add(fm.mask(static_mask, b=0.2 * mT), fm.time(sine, frequency=3.6 * GHz))
        study.stages.add_field_drive(antenna, stage_id="source_on")
        study.stages.add_run(stage_id="run_initial", until=2e-9)
        study.stages.update_field_drive(
            antenna,
            mask_parameters={"b": 0.1 * mT},
            time_parameters={"frequency": 4.0 * GHz},
            stage_id="source_changed",
        )
        study.stages.add_run(stage_id="run_changed", until=2e-9)
        study.stages.remove_field_drive(antenna.id, stage_id="source_off")
        study.stages.add_run(stage_id="run_without_source", until=1e-9)
        study.stages.add_field_drive(antenna, stage_id="source_on_again")
        study.stages.add_run(stage_id="run_again", until=1e-9)
        stages = {stage.stage_id: stage for stage in flat_world._state._declared_stages}
        update = stages["source_changed"]
        self.assertEqual(update.entrypoint_kind, "flat_update_mask_field_drive")
        self.assertEqual(
            update.action,
            {
                "kind": "update_mask_field_drive",
                "drive_id": "antenna",
                "mask_parameters": {"b": 0.1 * mT},
                "time_parameters": {"frequency": 4.0 * GHz},
            },
        )

        def values(stage_id: str) -> tuple[float, float] | None:
            ir = stages[stage_id].problem.to_ir(include_geometry_assets=False)
            drives = ir.get("mask_field_drives", [])
            if not drives:
                return None
            term = drives[0]["terms"][0]
            return (
                term["mask"]["function"]["parameters"][0]["value"],
                term["time"]["parameters"][0]["value"],
            )

        self.assertEqual(values("run_initial"), (0.2 * mT, 3.6 * GHz))
        self.assertEqual(values("run_changed"), (0.1 * mT, 4.0 * GHz))
        self.assertIsNone(values("run_without_source"))
        self.assertEqual(values("run_again"), (0.2 * mT, 3.6 * GHz))
        self.assertEqual(antenna.terms[0].mask.parameters[0].value, 0.2 * mT)

    def test_update_field_drive_selects_named_term(self) -> None:
        study, film = study_with_film()
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3), fm.time(sine, frequency=1e9), name="left")
        antenna.add(fm.mask(static_mask, b=2e-3), fm.time(sine, frequency=1e9), name="right")
        study.stages.add_field_drive(antenna, stage_id="on")
        study.stages.update_field_drive(
            "antenna", time_parameters={"frequency": 2e9}, term="right", stage_id="update"
        )
        study.stages.add_run(stage_id="run", until=1e-12)
        run = next(s for s in flat_world._state._declared_stages if s.stage_id == "run")
        terms = run.problem.to_ir(include_geometry_assets=False)["mask_field_drives"][0]["terms"]
        self.assertEqual(
            [term["time"]["parameters"][0]["value"] for term in terms], [1e9, 2e9]
        )
        self.assertEqual(flat_world._state._declared_stages[-2].action["term"], "right")

    def test_update_field_drive_rejections(self) -> None:
        study, film = study_with_film()
        antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(50e-9, 50e-9, 10e-9))
        antenna.add(fm.mask(static_mask, b=1e-3), fm.time(sine, frequency=1e9))
        antenna.add(fm.mask(static_mask, b=2e-3))
        with self.assertRaisesRegex(ValueError, "not active at this point"):
            study.stages.update_field_drive(antenna, mask_parameters={"b": 1.0})
        study.stages.add_field_drive(antenna, stage_id="on")
        regional = fm.RegionalFieldDrive(
            id="regional",
            name="Regional",
            target=fm.FieldTarget.global_domain(),
            amplitude_B_T=1e-3,
            direction=(0, 1, 0),
            spatial_profile=fm.UniformFieldProfile(),
            waveform=fm.Constant(),
        )
        study.stages.add_field_drive(regional, stage_id="regional_on")
        count = len(flat_world._state._declared_stages)
        cases = [
            ({"mask_parameters": {"b": 1.0}}, "select one with term="),
            ({"mask_parameters": {"nope": 1.0}, "term": 0}, "no such parameter"),
            ({"time_parameters": {"frequency": 1.0}, "term": 1}, "is static"),
            ({"term": 0}, "give mask_parameters"),
            ({"mask_parameters": {"b": float("nan")}, "term": 0}, "finite"),
            ({"mask_parameters": {"b": 1.0}, "term": "missing"}, "no term named"),
            ({"mask_parameters": {"b": 1.0}, "term": 5}, "no term 5"),
        ]
        for kwargs, message in cases:
            with self.subTest(message):
                with self.assertRaisesRegex(ValueError, f"mask_update_invalid.*{message}"):
                    study.stages.update_field_drive(antenna, **kwargs)
        with self.assertRaisesRegex(ValueError, "not a mask antenna"):
            study.stages.update_field_drive("regional", mask_parameters={"b": 1.0})
        self.assertEqual(len(flat_world._state._declared_stages), count)

    def test_antenna_never_added_warns(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            def b_static(x, y, z, b):
                return (0.0, 0.0, b)

            study = fm.study("never-added")
            film = study.geometry(fm.Box(100e-9, 50e-9, 10e-9), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.alpha = 0.01
            study.exchange()
            antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50e-9, 50e-9, 10e-9))
            antenna.add(fm.mask(b_static, b=1e-3))
            study.stages.add_run(stage_id="run", until=1e-12)
            """
        )
        with TemporaryDirectory() as directory:
            path = Path(directory) / "never_added.py"
            path.write_text(script, encoding="utf-8")
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                fm.load_problem_from_script(path, lightweight_assets=True)
        self.assertTrue(
            any("never added" in str(warning.message) for warning in caught),
            [str(warning.message) for warning in caught],
        )

    def test_script_with_mask_antenna_loads(self) -> None:
        script = textwrap.dedent(
            """
            from math import pi, sin
            import fullmag as fm
            from fullmag import GHz, mT, nm

            def antenna_mask(x, y, z, B01, k):
                return (B01 * sin(k * x), 0.0, 0.0)

            def antenna_time(t, frequency):
                return sin(2 * pi * frequency * t)

            study = fm.study("script-antenna")
            film = study.geometry(fm.Box(100 * nm, 50 * nm, 10 * nm), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.alpha = 0.01
            study.exchange()
            antenna = study.add_simpleantenna.arbitrary_mask(film, fm.Box(50 * nm, 50 * nm, 10 * nm))
            antenna.add(
                fm.mask(antenna_mask, B01=0.2 * mT, k=2 * pi / (279 * nm)),
                fm.time(antenna_time, frequency=3.6 * GHz),
            )
            study.stages.add_field_drive(antenna, stage_id="add_source")
            study.stages.add_run(stage_id="run", until=1e-12)
            """
        )
        with TemporaryDirectory() as directory:
            path = Path(directory) / "antenna.py"
            path.write_text(script, encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            captured = fm.load_problem_from_script(
                path, lightweight_assets=True, source_bytes=script.encode("utf-8")
            )
        for result in (loaded, captured):
            run = next(stage for stage in result.stages if stage.stage_id == "run")
            ir = run.problem.to_ir(include_geometry_assets=False)
            self.assertEqual(ir["mask_field_drives"][0]["terms"][0]["mask"]["function"]["outputs"][0], "B01 * sin(k * x)")

    def test_scene_export_refuses_mask_antennas(self) -> None:
        from fullmag.runtime.script_builder import MaskAntennasNotInScene, export_builder_draft

        body = textwrap.dedent(
            """
            import fullmag as fm

            def b_static(x, y, z, b):
                return (0.0, 0.0, b)

            study = fm.study("scene-guard")
            film = study.geometry(fm.Box(100e-9, 50e-9, 10e-9), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.alpha = 0.01
            study.exchange()
            antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(50e-9, 50e-9, 10e-9))
            antenna.add(fm.mask(b_static, b=1e-3))
            """
        )
        variants = {
            "whole_study": "study.field_drives.add(antenna)\nstudy.stages.add_run(stage_id='run', until=1e-12)\n",
            "stage_action": "study.stages.add_field_drive(antenna, stage_id='on')\nstudy.stages.add_run(stage_id='run', until=1e-12)\n",
        }
        for name, tail in variants.items():
            with self.subTest(name), TemporaryDirectory() as directory:
                path = Path(directory) / f"{name}.py"
                path.write_text(body + tail, encoding="utf-8")
                loaded = fm.load_problem_from_script(path, lightweight_assets=True)
                with self.assertRaisesRegex(
                    MaskAntennasNotInScene, "mask_field_drive_unsupported_lane:scene"
                ):
                    export_builder_draft(loaded)


if __name__ == "__main__":
    unittest.main()
