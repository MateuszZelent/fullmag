from __future__ import annotations

import math
import inspect
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
import fullmag.world as flat_world
from fullmag.runtime.scene_document import (
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.loader import LoadedProblem
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script


class CanonicalLlgSolverContractTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def _configure_study(self) -> object:
        study = fm.study("llg_solver_contract")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        return study

    def _dynamics_ir(self) -> dict[str, object]:
        return flat_world._build_problem().to_ir(include_geometry_assets=False)["study"][
            "dynamics"
        ]

    def _solver_state(self) -> tuple[object, ...]:
        state = flat_world._state
        return (
            state._fixed_timestep,
            state._adaptive_timestep_policy,
            state._integrator,
            state._gamma,
            state._demag_interval_s,
        )

    def test_fixed_policy_uses_fix_dt_with_staged_run(self) -> None:
        study = self._configure_study()
        study.solver(integrator="rk45", fix_dt=1e-15, g=2.115)
        study.stages.add_run(until=2e-12)

        dynamics = self._dynamics_ir()

        self.assertEqual(dynamics["integrator"], "rk45")
        self.assertEqual(dynamics["fixed_timestep"], 1e-15)
        self.assertIsNone(dynamics.get("adaptive_timestep"))
        self.assertGreater(dynamics["gyromagnetic_ratio"], 0.0)

    def test_adaptive_policy_preserves_explicit_initial_and_bounds(self) -> None:
        study = self._configure_study()
        study.solver(
            integrator="rk45",
            dt_initial=1e-15,
            dt_min=1e-16,
            dt_max=1e-14,
            max_err=1e-6,
            g=2.115,
        )
        study.stages.add_run(until=2e-12)

        adaptive = self._dynamics_ir()["adaptive_timestep"]

        self.assertEqual(adaptive["dt_initial"], 1e-15)
        self.assertEqual(adaptive["dt_min"], 1e-16)
        self.assertEqual(adaptive["dt_max"], 1e-14)
        self.assertEqual(adaptive["atol"], 1e-6)
        self.assertEqual(adaptive["rtol"], 0.0)

    def test_adaptive_policy_preserves_omitted_initial(self) -> None:
        study = self._configure_study()
        study.solver(
            integrator="rk23",
            dt_min=1e-16,
            dt_max=1e-14,
            max_err=1e-6,
        )

        adaptive = self._dynamics_ir()["adaptive_timestep"]

        self.assertIsNone(adaptive["dt_initial"])

    def test_adaptive_policy_preserves_initial_equal_to_minimum(self) -> None:
        study = self._configure_study()
        study.solver(
            integrator="rk45",
            dt_initial=1e-16,
            dt_min=1e-16,
            dt_max=1e-14,
            max_err=1e-6,
        )

        adaptive = self._dynamics_ir()["adaptive_timestep"]

        self.assertEqual(adaptive["dt_initial"], 1e-16)
        self.assertEqual(adaptive["dt_min"], 1e-16)

    def test_rejects_fixed_adaptive_and_deprecated_alias_conflicts(self) -> None:
        conflict_cases = (
            {"fix_dt": 1e-15, "dt_initial": 1e-15},
            {"fix_dt": 1e-15, "dt_min": 1e-16},
            {"fix_dt": 1e-15, "dt_max": 1e-14},
            {"fix_dt": 1e-15, "max_err": 1e-6},
            {"dt": 1e-15, "fix_dt": 1e-15},
            {"max_error": 1e-6, "max_err": 1e-6},
        )
        for kwargs in conflict_cases:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fm.solver(**kwargs)

    def test_rejects_invalid_values_bounds_and_integrators(self) -> None:
        invalid_cases = (
            {"fix_dt": 0.0},
            {"fix_dt": math.inf},
            {"dt_initial": -1e-15, "max_err": 1e-6},
            {"dt_min": 0.0, "max_err": 1e-6},
            {"dt_max": math.nan, "max_err": 1e-6},
            {"max_err": -1e-6},
            {"dt_min": 1e-14, "dt_max": 1e-16, "max_err": 1e-6},
            {
                "dt_initial": 1e-15,
                "dt_min": 2e-15,
                "dt_max": 1e-14,
                "max_err": 1e-6,
            },
            {
                "dt_initial": 2e-14,
                "dt_min": 1e-16,
                "dt_max": 1e-14,
                "max_err": 1e-6,
            },
            {"integrator": "rk4", "max_err": 1e-6},
            {"integrator": "bogus"},
        )
        for kwargs in invalid_cases:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fm.solver(**kwargs)

    def test_deprecated_aliases_are_deterministic(self) -> None:
        self._configure_study()
        with self.assertWarns(DeprecationWarning):
            fm.solver(dt=2e-15, max_error=1e-6, dt_min=1e-16, integrator="rk23")

        adaptive = self._dynamics_ir()["adaptive_timestep"]

        self.assertEqual(adaptive["dt_initial"], 2e-15)
        self.assertEqual(adaptive["atol"], 1e-6)
        self.assertEqual(adaptive["rtol"], 0.0)

    def test_solver_validation_is_atomic_and_uses_prior_integrator(self) -> None:
        self._configure_study()
        fm.solver(integrator="rk4", fix_dt=2e-15, gamma=2.1e5)
        before = self._solver_state()

        with self.assertRaisesRegex(ValueError, "adaptive timestep requires"):
            fm.solver(dt_min=1e-16, dt_max=1e-14, max_err=1e-6)

        self.assertEqual(self._solver_state(), before)

    def test_chained_integrator_change_cannot_invalidate_existing_policy(self) -> None:
        self._configure_study()
        fm.solver(integrator="rk45", dt_min=1e-16, dt_max=1e-14, max_err=1e-6)
        before = self._solver_state()

        with self.assertRaisesRegex(ValueError, "adaptive timestep requires"):
            fm.solver(integrator="rk4")

        self.assertEqual(self._solver_state(), before)

    def test_nonfinite_auxiliary_solver_values_leave_state_unchanged(self) -> None:
        self._configure_study()
        fm.solver(fix_dt=2e-15, gamma=2.1e5, demag_interval_s=1e-13)
        for kwargs in ({"gamma": math.inf}, {"g": math.nan}, {"demag_interval_s": math.inf}):
            before = self._solver_state()
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fm.solver(**kwargs)
            self.assertEqual(self._solver_state(), before)

    def test_advanced_timestep_accepts_one_zero_tolerance_and_rejects_invalid_values(self) -> None:
        self.assertEqual(fm.AdaptiveTimestep(atol=0.0, rtol=1e-4).atol, 0.0)
        self.assertEqual(fm.AdaptiveTimestep(atol=1e-6, rtol=0.0).rtol, 0.0)
        invalid = (
            {"atol": 0.0, "rtol": 0.0},
            {"atol": math.nan, "rtol": 1e-4},
            {"atol": 1e-6, "rtol": math.inf},
            {"atol": 1e-6, "rtol": 1e-4, "growth_limit": math.nan},
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fm.AdaptiveTimestep(**kwargs)

    def test_advanced_timestep_round_trip_is_lossless(self) -> None:
        source = """
        import fullmag as fm

        study = fm.study("advanced_adaptive")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.solver(
            integrator="rk45",
            adaptive_timestep=fm.AdaptiveTimestep(
                atol=2e-7,
                rtol=3e-5,
                dt_initial=None,
                dt_min=1e-16,
                dt_max=1e-13,
                safety=0.8,
                growth_limit=1.7,
                shrink_limit=0.3,
                max_spin_rotation=0.2,
                norm_tolerance=1e-5,
            ),
        )
        study.stages.add_run(until=2e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "advanced.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            overrides = builder_overrides_from_scene_document(scene)
            rewritten = rewrite_loaded_problem_script(loaded, overrides=overrides)[
                "rendered_source"
            ]
            rewritten_path = Path(tmp_dir) / "advanced_rewritten.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        self.assertIn("adaptive_timestep=fm.AdaptiveTimestep(", rewritten)
        expected = loaded.problem.study.to_ir()["dynamics"]["adaptive_timestep"]
        actual = reloaded.problem.study.to_ir()["dynamics"]["adaptive_timestep"]
        self.assertEqual(actual, expected)

    def test_advanced_timestep_rejects_convenience_mix_without_mutation(self) -> None:
        self._configure_study()
        fm.solver(fix_dt=2e-15)
        before = self._solver_state()

        with self.assertRaises(ValueError):
            fm.solver(
                max_err=1e-6,
                adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, rtol=1e-4),
            )

        self.assertEqual(self._solver_state(), before)

    def test_stage_overrides_export_convenience_and_advanced_adaptive_policies(self) -> None:
        source = """
        import fullmag as fm

        study = fm.study("stage_policy_export")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.solver(integrator="rk45", fix_dt=1e-15)
        study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped")
        """
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "stage_policy.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)

            convenience = rewrite_loaded_problem_script(
                loaded,
                overrides={
                    "stages": [
                        {
                            "kind": "relax",
                            "integrator": "rk45",
                            "fixed_timestep": None,
                            "adaptive_timestep": {
                                "tolerance_mode": "max_error",
                                "atol": 1e-6,
                                "rtol": 0.0,
                                "dt_initial": 2e-15,
                                "dt_min": 1e-16,
                                "dt_max": 1e-13,
                                "safety": 0.9,
                                "growth_limit": 2.0,
                                "shrink_limit": 0.2,
                            },
                        }
                    ]
                },
            )["rendered_source"]
            self.assertIn("max_err=1e-06", convenience)
            self.assertIn("dt_initial=2e-15", convenience)
            self.assertIn("dt_min=1e-16", convenience)
            self.assertIn("dt_max=1e-13", convenience)
            self.assertNotIn("_from_max_error", convenience)
            convenience_path = Path(tmp_dir) / "stage_policy_convenience.py"
            convenience_path.write_text(convenience, encoding="utf-8")
            reloaded = fm.load_problem_from_script(
                convenience_path, lightweight_assets=True
            )
            stage_policy = reloaded.stages[0].problem.study.to_ir()["dynamics"][
                "adaptive_timestep"
            ]
            self.assertEqual(stage_policy["tolerance_mode"], "max_error")
            self.assertEqual(stage_policy["dt_initial"], 2e-15)
            self.assertEqual(stage_policy["dt_min"], 1e-16)
            self.assertEqual(stage_policy["atol"], 1e-6)
            self.assertEqual(stage_policy["rtol"], 0.0)

            advanced = rewrite_loaded_problem_script(
                loaded,
                overrides={
                    "stages": [
                        {
                            "kind": "relax",
                            "integrator": "rk45",
                            "fixed_timestep": None,
                            "adaptive_timestep": {
                                "tolerance_mode": "advanced",
                                "atol": 1e-8,
                                "rtol": 1e-5,
                                "dt_initial": None,
                                "dt_min": 1e-16,
                                "dt_max": 1e-13,
                                "safety": 0.9,
                                "growth_limit": 2.0,
                                "shrink_limit": 0.2,
                            },
                        }
                    ]
                },
            )["rendered_source"]
            self.assertIn("adaptive_timestep=fm.AdaptiveTimestep(", advanced)
            self.assertIn("rtol=1e-05", advanced)
            advanced_path = Path(tmp_dir) / "stage_policy_advanced.py"
            advanced_path.write_text(advanced, encoding="utf-8")
            reloaded = fm.load_problem_from_script(advanced_path, lightweight_assets=True)
            stage_policy = reloaded.stages[0].problem.study.to_ir()["dynamics"][
                "adaptive_timestep"
            ]
            self.assertEqual(stage_policy["tolerance_mode"], "advanced")
            self.assertEqual(stage_policy["atol"], 1e-8)
            self.assertEqual(stage_policy["rtol"], 1e-5)

    def test_stage_convenience_policy_constructs_lowers_and_rejects_legacy_mixing(self) -> None:
        study = self._configure_study()
        stage = fm.relax_stage(
            solver="rk45",
            dt_initial=2e-15,
            dt_min=1e-16,
            dt_max=1e-13,
            max_err=1e-6,
        )
        self.assertEqual(stage.dt_initial, 2e-15)
        self.assertEqual(stage.max_err, 1e-6)
        study.stages.add_relax(
            stage_id="relax",
            solver="rk45",
            dt_initial=2e-15,
            dt_min=1e-16,
            dt_max=1e-13,
            max_err=1e-6,
        )

        adaptive = flat_world._state._declared_stages[0].problem.study.to_ir()[
            "dynamics"
        ]["adaptive_timestep"]
        self.assertEqual(adaptive["tolerance_mode"], "max_error")
        self.assertEqual(adaptive["dt_initial"], 2e-15)
        self.assertEqual(adaptive["dt_min"], 1e-16)
        self.assertEqual(adaptive["dt_max"], 1e-13)
        self.assertEqual(adaptive["atol"], 1e-6)

        conflicts = (
            {"solver": "rk45", "dt_initial": 2e-15, "dt": 1e-15, "max_err": 1e-6},
            {"solver": "rk45", "max_err": 1e-6, "max_error": 1e-6},
            {"solver": "rk45", "dt_initial": 2e-15, "max_error": 1e-6},
            {
                "solver": "rk45",
                "max_err": 1e-6,
                "adaptive_timestep": fm.AdaptiveTimestep(atol=1e-6),
            },
        )
        for kwargs in conflicts:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fm.relax_stage(**kwargs)

    def test_explicit_advanced_policy_is_not_rewritten_as_convenience_mode(self) -> None:
        study = self._configure_study()
        study.solver(
            integrator="rk45",
            adaptive_timestep=fm.AdaptiveTimestep(
                atol=1e-6,
                rtol=0.0,
                dt_min=1e-16,
                dt_max=1e-14,
            ),
        )
        study.stages.add_run(until=2e-12)
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "explicit_advanced.py"
            loaded = LoadedProblem(
                problem=flat_world._build_problem(),
                source_path=path,
                script_source="",
                entrypoint_kind="workspace",
                default_until_seconds=2e-12,
            )
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn("adaptive_timestep=fm.AdaptiveTimestep(", rewritten)
        self.assertNotIn("max_err=", rewritten)

    def test_tolerance_mode_is_not_public_constructor_repr_or_equality_state(self) -> None:
        self.assertNotIn("_tolerance_mode", inspect.signature(fm.AdaptiveTimestep).parameters)
        advanced = fm.AdaptiveTimestep(atol=1e-6, rtol=0.0)
        convenience = fm.AdaptiveTimestep._from_max_error(max_err=1e-6)

        self.assertNotIn("tolerance_mode", repr(convenience))
        self.assertEqual(advanced, convenience)
        self.assertEqual(advanced.to_ir()["tolerance_mode"], "advanced")
        self.assertEqual(convenience.to_ir()["tolerance_mode"], "max_error")
        self.assertEqual(dict(convenience.to_ir())["tolerance_mode"], "max_error")
        with self.assertRaises(TypeError):
            fm.AdaptiveTimestep(atol=1e-6, _tolerance_mode="max_error")

    def test_partial_advanced_scene_override_merges_and_preserves_presence(self) -> None:
        source = """
        import fullmag as fm

        study = fm.study("advanced_partial")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        study.solver(integrator="rk45", adaptive_timestep=fm.AdaptiveTimestep(
            atol=2e-7, rtol=3e-5, dt_initial=2e-16, dt_min=1e-16,
            dt_max=1e-13, safety=0.8, growth_limit=1.7, shrink_limit=0.3,
            max_spin_rotation=0.2, norm_tolerance=1e-5,
        ))
        study.stages.add_run(until=2e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "advanced_partial.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            scene["study"]["solver"]["adaptive_timestep"] = {
                "safety": 0.75,
                "dt_initial": None,
            }
            overrides = builder_overrides_from_scene_document(scene)
            advanced_override = overrides["solver"]["adaptive_timestep"]
            self.assertEqual(set(advanced_override), {"safety", "dt_initial"})
            rewritten = rewrite_loaded_problem_script(loaded, overrides=overrides)[
                "rendered_source"
            ]
            rewritten_path = Path(tmp_dir) / "advanced_partial_rewritten.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        adaptive = reloaded.problem.study.dynamics.adaptive_timestep
        self.assertEqual(adaptive.atol, 2e-7)
        self.assertEqual(adaptive.rtol, 3e-5)
        self.assertIsNone(adaptive.dt_initial)
        self.assertEqual(adaptive.dt_min, 1e-16)
        self.assertEqual(adaptive.dt_max, 1e-13)
        self.assertEqual(adaptive.safety, 0.75)
        self.assertEqual(adaptive.growth_limit, 1.7)
        self.assertEqual(adaptive.max_spin_rotation, 0.2)

    def test_partial_convenience_override_merges_and_validates_bounds(self) -> None:
        source = """
        import fullmag as fm

        study = fm.study("convenience_partial")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        study.solver(integrator="rk45", dt_initial=2e-16, dt_min=1e-16,
                     dt_max=1e-13, max_err=1e-6)
        study.stages.add_run(until=2e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "convenience_partial.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))
            scene["study"]["solver"] = {"dt_initial": None, "dt_max": 5e-14}
            overrides = builder_overrides_from_scene_document(scene)
            self.assertEqual(
                set(overrides["solver"]), {"dt_initial", "dt_max", "relax"}
            )
            rewritten = rewrite_loaded_problem_script(loaded, overrides=overrides)[
                "rendered_source"
            ]
            self.assertIn("dt_min=1e-16", rewritten)
            self.assertIn("dt_max=5e-14", rewritten)
            self.assertIn("max_err=1e-06", rewritten)

            scene["study"]["solver"] = {"dt_min": 2e-13}
            bad_bounds = builder_overrides_from_scene_document(scene)
            with self.assertRaises(ValueError):
                rewrite_loaded_problem_script(loaded, overrides=bad_bounds)

            scene["study"]["solver"] = {"max_err": None}
            invalid_clear = builder_overrides_from_scene_document(scene)
            with self.assertRaises(ValueError):
                rewrite_loaded_problem_script(loaded, overrides=invalid_clear)

    def test_chained_convenience_updates_preserve_unspecified_policy_values(self) -> None:
        self._configure_study()
        fm.solver(
            integrator="rk45",
            dt_initial=2e-16,
            dt_min=1e-16,
            dt_max=1e-13,
            max_err=1e-6,
        )

        fm.solver(max_err=2e-6)
        policy = flat_world._state._adaptive_timestep_policy
        self.assertEqual(policy.dt_initial, 2e-16)
        self.assertEqual(policy.dt_min, 1e-16)
        self.assertEqual(policy.dt_max, 1e-13)
        self.assertEqual(policy.atol, 2e-6)

        fm.solver(dt_max=5e-14)
        policy = flat_world._state._adaptive_timestep_policy
        self.assertEqual(policy.dt_initial, 2e-16)
        self.assertEqual(policy.dt_min, 1e-16)
        self.assertEqual(policy.dt_max, 5e-14)
        self.assertEqual(policy.atol, 2e-6)

    def test_script_override_switches_adaptive_base_to_fixed_policy(self) -> None:
        study = self._configure_study()
        study.solver(
            integrator="rk45", dt_min=1e-16, dt_max=1e-13, max_err=1e-6
        )
        loaded = LoadedProblem(
            problem=flat_world._build_problem(),
            source_path=Path("adaptive_to_fixed.py"),
            script_source="",
            entrypoint_kind="workspace",
            default_until_seconds=2e-12,
        )

        rewritten = rewrite_loaded_problem_script(
            loaded, overrides={"solver": {"fixed_timestep": 2e-15}}
        )["rendered_source"]

        solver_line = next(line for line in rewritten.splitlines() if ".solver(" in line)
        self.assertIn("fix_dt=2e-15", solver_line)
        self.assertNotIn("max_err=", solver_line)
        self.assertNotIn("adaptive_timestep=", solver_line)

    def test_script_override_switches_fixed_base_to_adaptive_policy(self) -> None:
        study = self._configure_study()
        study.solver(integrator="rk45", fix_dt=2e-15)
        loaded = LoadedProblem(
            problem=flat_world._build_problem(),
            source_path=Path("fixed_to_adaptive.py"),
            script_source="",
            entrypoint_kind="workspace",
            default_until_seconds=2e-12,
        )

        rewritten = rewrite_loaded_problem_script(
            loaded,
            overrides={
                "solver": {
                    "dt_min": 1e-16,
                    "dt_max": 1e-13,
                    "max_err": 1e-6,
                }
            },
        )["rendered_source"]

        solver_line = next(line for line in rewritten.splitlines() if ".solver(" in line)
        self.assertIn("dt_min=1e-16", solver_line)
        self.assertIn("max_err=1e-06", solver_line)
        self.assertNotIn("fix_dt=", solver_line)

    def test_fixed_builder_scene_round_trip_ignores_empty_adaptive_keys(self) -> None:
        source = """
        import fullmag as fm

        study = fm.study("fixed_round_trip")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        study.solver(integrator="rk45", fix_dt=2e-15)
        study.stages.add_run(until=2e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "fixed_round_trip.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            draft = export_builder_draft(loaded)
            draft["solver"].update(
                {
                    "dt_initial": None,
                    "dt_min": None,
                    "dt_max": None,
                    "max_err": None,
                    "adaptive_timestep": None,
                }
            )
            scene = build_scene_document_from_builder(draft)
            overrides = builder_overrides_from_scene_document(scene)
            rewritten = rewrite_loaded_problem_script(loaded, overrides=overrides)[
                "rendered_source"
            ]
            rewritten_path = Path(tmp_dir) / "fixed_rewritten.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        solver_line = next(line for line in rewritten.splitlines() if ".solver(" in line)
        self.assertIn("fix_dt=2e-15", solver_line)
        self.assertNotIn("max_err=", solver_line)
        dynamics = reloaded.problem.study.dynamics
        self.assertEqual(dynamics.fixed_timestep, 2e-15)
        self.assertIsNone(dynamics.adaptive_timestep)

    def test_script_override_rejects_advanced_and_active_convenience_mix(self) -> None:
        study = self._configure_study()
        study.solver(
            integrator="rk45",
            adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, rtol=1e-4),
        )
        loaded = LoadedProblem(
            problem=flat_world._build_problem(),
            source_path=Path("mixed_override.py"),
            script_source="",
            entrypoint_kind="workspace",
            default_until_seconds=2e-12,
        )

        with self.assertRaisesRegex(ValueError, "exactly one timestep policy"):
            rewrite_loaded_problem_script(
                loaded,
                overrides={
                    "solver": {
                        "adaptive_timestep": {"safety": 0.75},
                        "max_err": 2e-6,
                    }
                },
            )

    def test_script_override_rejects_incompatible_effective_integrator(self) -> None:
        study = self._configure_study()
        study.solver(
            integrator="rk45", dt_min=1e-16, dt_max=1e-13, max_err=1e-6
        )
        loaded = LoadedProblem(
            problem=flat_world._build_problem(),
            source_path=Path("invalid_integrator_override.py"),
            script_source="",
            entrypoint_kind="workspace",
            default_until_seconds=2e-12,
        )

        with self.assertRaisesRegex(ValueError, "adaptive timestep requires"):
            rewrite_loaded_problem_script(
                loaded, overrides={"solver": {"integrator": "rk4"}}
            )

    def test_canonical_script_and_scene_round_trip_preserve_omitted_initial(self) -> None:
        source = """
        import fullmag as fm

        study = fm.study("canonical_adaptive")
        study.engine("fdm")
        study.cell(5e-9, 5e-9, 5e-9)
        body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="track")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1, 0, 0)
        study.solver(integrator="rk45", dt_min=1e-16, dt_max=1e-14, max_err=1e-6)
        study.stages.add_run(until=2e-12)
        """
        with TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "canonical_adaptive.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            loaded = fm.load_problem_from_script(path, lightweight_assets=True)
            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            overrides = builder_overrides_from_scene_document(scene)
            rewritten = rewrite_loaded_problem_script(loaded, overrides=overrides)[
                "rendered_source"
            ]
            rewritten_path = Path(tmp_dir) / "canonical_adaptive_rewritten.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

        solver_line = next(line for line in rewritten.splitlines() if ".solver(" in line)
        self.assertIn("dt_min=1e-16", solver_line)
        self.assertIn("dt_max=1e-14", solver_line)
        self.assertIn("max_err=1e-06", solver_line)
        self.assertNotIn("dt_initial=", solver_line)
        adaptive = reloaded.problem.study.to_ir()["dynamics"]["adaptive_timestep"]
        self.assertIsNone(adaptive["dt_initial"])


if __name__ == "__main__":
    unittest.main()
