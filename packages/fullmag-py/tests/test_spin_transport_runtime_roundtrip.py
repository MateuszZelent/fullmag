from __future__ import annotations

import math
import unittest
import warnings
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.model.energy import Pulse
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime import script_builder
from fullmag.runtime.loader import LoadedProblem, load_problem_from_script
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script
from fullmag.runtime.script_builder import _render_spin_torques


def _problem(*, spin_torques=(), oersted_terms=(), runtime_metadata=None) -> fm.Problem:
    geometry = fm.Box(size=(30e-9, 20e-9, 2e-9), name="layer")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    magnet = fm.Ferromagnet(name="layer", geometry=geometry, material=material)
    return fm.Problem(
        name="runtime_roundtrip",
        magnets=[magnet],
        energy=[fm.Exchange(), fm.Demag(), *oersted_terms],
        current_modules=[
            fm.CurrentTransport(
                name="transport",
                current_density=(1e11, 0.0, 0.0),
                solve_region="layer",
            )
        ],
        spin_torques=spin_torques,
        runtime_metadata=runtime_metadata or {},
        study=fm.TimeEvolution(
            dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 2e-9))
        ),
    )


def _eval_rendered(lines: list[str]) -> object:
    fm.reset()
    return eval(lines[-1], {"fm": fm})


class SpinTorqueRuntimeRoundTripTests(unittest.TestCase):
    def test_legacy_slonczewski_round_trip_preserves_fixed_layer_semantics(self) -> None:
        module = fm.SlonczewskiSTT(
            current_density=(0.0, 0.0, -2e11),
            spin_polarization=(0.0, 0.0, 2.0),
            fixed_layer_position="bottom",
        )
        entry = module.to_ir_module()
        self.assertEqual(entry["formula_version"], "slonczewski.legacy_fullmag.v0")
        self.assertEqual(entry["spin_polarization"], [0.0, 0.0, 2.0])
        self.assertEqual(entry["fixed_layer_position"], "bottom")
        rendered = _render_spin_torques(_problem(spin_torques=[module]), surface="flat")
        rebuilt = _eval_rendered(rendered)
        self.assertEqual(rebuilt.to_ir_module(), entry)

    def test_canonical_slonczewski_normalized_round_trip_preserves_orientation(self) -> None:
        module = fm.SlonczewskiSTT(
            id="cpp",
            target=fm.RegionRef("layer"),
            current_density=(0.0, 0.0, -2e11),
            spin_polarization=(0.0, 1.0, 0.0),
            stack_normal=(0.0, 0.0, 4.0),
            degree=0.55,
            lambda_asymmetry=1.4,
            epsilon_prime=0.03,
            free_layer_thickness_m=1.5e-9,
        )
        entry = module.to_ir_module()
        self.assertEqual(entry["formula_version"], "slonczewski.fullmag.v1")
        self.assertEqual(entry["realization"]["realization_version"], "slonczewski_thin_layer_homogenized.v1")  # type: ignore[index]
        self.assertEqual(entry["stack_normal"], [0.0, 0.0, 1.0])

        rendered = _render_spin_torques(_problem(spin_torques=[module]), surface="flat")
        rebuilt = _eval_rendered(rendered)
        self.assertEqual(rebuilt.to_ir_module(), entry)

    def test_slonczewski_rejects_nonfinite_scalar_coefficients(self) -> None:
        base = {
            "id": "cpp",
            "target": fm.RegionRef("layer"),
            "current_density": (0.0, 0.0, 2e11),
            "spin_polarization": (0.0, 1.0, 0.0),
            "stack_normal": (0.0, 0.0, 1.0),
            "free_layer_thickness_m": 1.5e-9,
        }
        for name, value in (
            ("lambda_asymmetry", math.nan),
            ("epsilon_prime", math.inf),
            ("free_layer_thickness_m", math.nan),
        ):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, name):
                fm.SlonczewskiSTT(**{**base, name: value})

    def test_flat_registration_is_typed_returns_object_and_preserves_order(self) -> None:
        first = fm.ZhangLiSTT(current_density=(1e11, 0.0, 0.0))
        second = fm.SlonczewskiSTT(
            current_density=(0.0, 0.0, 2e11), spin_polarization=(0.0, 0.0, 1.0)
        )
        fm.reset()
        self.assertIs(fm.spin_torque(first), first)
        self.assertIs(fm.spin_torque(second), second)
        with self.assertRaises(TypeError):
            fm.spin_torque({"kind": "zhang_li"})  # type: ignore[arg-type]

    def test_scene_collection_key_presence_distinguishes_inherit_clear_and_invalid(self) -> None:
        inherited_scene = build_scene_document_from_builder({"revision": 1, "geometries": []})
        self.assertNotIn("spin_torques", inherited_scene)
        self.assertNotIn("oersted_terms", inherited_scene)
        inherited_builder = build_builder_from_scene_document(inherited_scene)
        inherited_overrides = builder_overrides_from_scene_document(inherited_scene)
        self.assertNotIn("spin_torques", inherited_builder)
        self.assertNotIn("oersted_terms", inherited_builder)
        self.assertNotIn("spin_torques", inherited_overrides)
        self.assertNotIn("oersted_terms", inherited_overrides)

        cleared_scene = build_scene_document_from_builder(
            {"revision": 1, "geometries": [], "spin_torques": [], "oersted_terms": []}
        )
        self.assertEqual(cleared_scene["spin_torques"], [])
        self.assertEqual(cleared_scene["oersted_terms"], [])
        self.assertEqual(builder_overrides_from_scene_document(cleared_scene)["spin_torques"], [])
        self.assertEqual(builder_overrides_from_scene_document(cleared_scene)["oersted_terms"], [])

        for invalid in (None, {}, "", False):
            for key in ("spin_torques", "oersted_terms"):
                with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                    build_scene_document_from_builder(
                        {"revision": 1, "geometries": [], key: invalid}
                    )
                with self.subTest(scene_key=key, invalid=invalid), self.assertRaises(ValueError):
                    builder_overrides_from_scene_document(
                        {"version": "scene.v2", "revision": 1, "objects": [], key: invalid}
                    )

    def test_prescribed_scalar_all_envelopes_render_canonically_without_loss(self) -> None:
        envelopes = (
            fm.ConstantEnvelope(0.25),
            fm.SinusoidalEnvelope(0.5, 9e9, phase_rad=0.3, offset=-0.1),
            fm.PulseEnvelope(0.75, 2e-12, 7e-12),
            fm.PiecewiseLinearEnvelope(
                [
                    fm.TimeEnvelopePoint(0.0, 0.0),
                    fm.TimeEnvelopePoint(2e-12, 1.0),
                    fm.TimeEnvelopePoint(5e-12, -0.5),
                ]
            ),
            fm.SincEnvelope(0.8, center_s=3e-12, bandwidth_hz=12e9, offset=0.2),
            fm.TabulatedEnvelope(
                "artifact://drive.csv",
                interpolation="previous",
                extrapolation="hold",
                bandwidth_hz=20e9,
            ),
        )
        for envelope in envelopes:
            with self.subTest(envelope=type(envelope).__name__):
                torque = fm.PrescribedSpinOrbitTorque(
                    "sot",
                    fm.RegionRef("layer", "free"),
                    fm.SignedScalarDrive(-4e11, (0.0, 3.0, 0.0), envelope),
                    xi_dl=0.17,
                    xi_fl=-0.03,
                    free_layer_thickness_m=1.7e-9,
                )
                rendered = _render_spin_torques(_problem(spin_torques=[torque]), surface="flat")
                rebuilt = _eval_rendered(rendered)
                self.assertIn("fm.PrescribedSpinOrbitTorque(", rendered[-1])
                self.assertNotIn("fm.SpinOrbitTorque(", rendered[-1])
                self.assertEqual(rebuilt.to_ir_module(), torque.to_ir_module())

    def test_vector_and_legacy_prescribed_sot_render_canonically_without_loss(self) -> None:
        vector = fm.PrescribedSpinOrbitTorque(
            "vector_sot",
            fm.RegionRef("layer"),
            fm.VectorCurrentDrive("transport", (2.0, 0.0, 0.0), (0.0, 0.0, -4.0)),
            xi_dl=0.2,
            xi_fl=0.04,
            free_layer_thickness_m=2e-9,
        )
        legacy = fm.PrescribedSpinOrbitTorque.from_legacy_v0(
            module_index=7,
            target=None,
            raw_charge_current_density_Apm2=-6e11,
            raw_spin_polarization=(0.0, 0.0, 0.0),
            xi_dl=0.13,
            xi_fl=-0.02,
            free_layer_thickness_m=1.2e-9,
            compatibility_origin={
                "source_ir_version": "0.2.0",
                "authored_kind": "spin_orbit_torque",
            },
        )
        for torque in (vector, legacy):
            rendered = _render_spin_torques(_problem(spin_torques=[torque]), surface="flat")
            rebuilt = _eval_rendered(rendered)
            self.assertIn("fm.PrescribedSpinOrbitTorque", rendered[-1])
            self.assertEqual(rebuilt.to_ir_module(), torque.to_ir_module())

    def test_deprecated_alias_is_rewritten_with_only_the_canonical_public_name(self) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            alias = fm.SpinOrbitTorque(
                charge_current_density_a_per_m2=-2e11,
                damping_like_efficiency=0.12,
                spin_polarization=(0.0, 1.0, 0.0),
                ferromagnet_thickness_m=1.4e-9,
                field_like_efficiency=-0.01,
                name="migrated_alias",
                target=fm.RegionRef("layer"),
            )
        rendered = _render_spin_torques(_problem(spin_torques=[alias]), surface="flat")
        rebuilt = _eval_rendered(rendered)
        self.assertIn("fm.PrescribedSpinOrbitTorque(", rendered[-1])
        self.assertNotIn("fm.SpinOrbitTorque(", rendered[-1])
        self.assertEqual(rebuilt.to_ir_module(), alias.to_ir_module())

    def test_scene_document_preserves_dedicated_spin_and_oersted_collections(self) -> None:
        spin_torques = [
            fm.PrescribedSpinOrbitTorque(
                "sot",
                fm.RegionRef("layer"),
                fm.SignedScalarDrive(3e11, (0.0, 1.0, 0.0)),
                xi_dl=0.1,
                free_layer_thickness_m=1e-9,
            ).to_ir_module()
        ]
        oersted_terms = [
            fm.OerstedCylinder(
                -0.003,
                22e-9,
                center=(1e-9, -2e-9, 3e-9),
                axis=(1.0, 2.0, 3.0),
                time_dependence=fm.PiecewiseLinear(
                    [(0.0, 0.0), (2e-12, 1.0), (8e-12, -0.25)]
                ),
            ).to_ir(),
            fm.OerstedField(source="transport").to_ir(),
        ]
        builder = {
            "revision": 4,
            "geometries": [],
            "spin_torques": spin_torques,
            "oersted_terms": oersted_terms,
        }
        scene = build_scene_document_from_builder(builder)
        inverse = build_builder_from_scene_document(scene)
        overrides = builder_overrides_from_scene_document(scene)
        self.assertEqual(scene["spin_torques"], spin_torques)
        self.assertEqual(scene["oersted_terms"], oersted_terms)
        self.assertEqual(inverse["spin_torques"], spin_torques)
        self.assertEqual(inverse["oersted_terms"], oersted_terms)
        self.assertEqual(overrides["spin_torques"], spin_torques)
        self.assertEqual(overrides["oersted_terms"], oersted_terms)
        rendered_spin = _render_spin_torques(
            _problem(), surface="flat", overrides=overrides
        )
        rendered_oersted = script_builder._render_oersted_terms(  # type: ignore[attr-defined]
            _problem(), overrides=overrides
        )
        self.assertEqual(_eval_rendered(rendered_spin).to_ir_module(), spin_torques[0])
        self.assertEqual(
            [_eval_rendered([line]).to_ir() for line in rendered_oersted[1:]],
            oersted_terms,
        )

    def test_spin_override_is_consumed_and_invalid_entries_fail_closed(self) -> None:
        torque = fm.PrescribedSpinOrbitTorque(
            "override_sot",
            fm.RegionRef("layer"),
            fm.SignedScalarDrive(2e11, (0.0, -1.0, 0.0)),
            xi_dl=0.21,
            free_layer_thickness_m=1e-9,
        )
        overrides = {"spin_torques": [torque.to_ir_module()]}
        rendered = _render_spin_torques(_problem(), surface="flat", overrides=overrides)
        self.assertEqual(_eval_rendered(rendered).to_ir_module(), torque.to_ir_module())
        bad_entries = (
            {"kind": "unknown"},
            {**torque.to_ir_module(), "formula_version": "prescribed_sot.future"},
            {**torque.to_ir_module(), "drive": {"kind": "unknown"}},
            {"kind": "prescribed_sot", "schema_version": "prescribed_sot.v1"},
        )
        for entry in bad_entries:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                _render_spin_torques(
                    _problem(), surface="flat", overrides={"spin_torques": [entry]}
                )

    def test_spin_override_rejects_nonfinite_wrong_typed_and_conflicting_fields(self) -> None:
        base = fm.PrescribedSpinOrbitTorque(
            "typed_sot",
            fm.RegionRef("layer"),
            fm.SignedScalarDrive(2e11, (0.0, 1.0, 0.0)),
            xi_dl=0.2,
            free_layer_thickness_m=1e-9,
        ).to_ir_module()
        malformed = (
            {**base, "xi_dl": True},
            {**base, "free_layer_thickness_m": float("nan")},
            {**base, "target": {"object_id": ""}},
            {**base, "drive": {**base["drive"], "sigma_hat": [0.0, "1", 0.0]}},
            {**base, "drive": {**base["drive"], "sigma_hat": [0.0, float("inf"), 0.0]}},
            {
                **base,
                "drive": {
                    **base["drive"],
                    "current_source_id": "transport",
                },
            },
        )
        for entry in malformed:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                _render_spin_torques(
                    _problem(), surface="flat", overrides={"spin_torques": [entry]}
                )

    def test_full_builder_scene_rewrite_loader_pipeline_preserves_physics_ir(self) -> None:
        high_precision = 1.2345678901234567e-9
        torques = [
            fm.PrescribedSpinOrbitTorque(
                "scalar",
                fm.RegionRef("layer"),
                fm.SignedScalarDrive(
                    3.141592653589793e11,
                    (0.0, 1.0, 0.0),
                    fm.SinusoidalEnvelope(
                        0.12345678901234566,
                        9.876543210987654e9,
                        phase_rad=0.3141592653589793,
                        offset=-0.2718281828459045,
                    ),
                ),
                xi_dl=0.12345678901234566,
                xi_fl=-0.012345678901234567,
                free_layer_thickness_m=high_precision,
            ),
            fm.PrescribedSpinOrbitTorque(
                "vector",
                fm.RegionRef("layer"),
                fm.VectorCurrentDrive("transport", (1.0, 2.0, 0.0), (0.0, 0.0, 1.0)),
                xi_dl=0.22222222222222224,
                free_layer_thickness_m=1.7654321098765433e-9,
            ),
            fm.PrescribedSpinOrbitTorque.from_legacy_v0(
                module_index=5,
                target=None,
                current_source_id="transport",
                raw_spin_polarization=(0.0, 0.0, 0.0),
                xi_dl=0.33333333333333337,
                xi_fl=-0.044444444444444446,
                free_layer_thickness_m=1.9876543210987654e-9,
                compatibility_origin={
                    "source_ir_version": "0.2.0",
                    "authored_kind": "spin_orbit_torque",
                },
            ),
        ]
        oersted = [
            fm.OerstedCylinder(
                -0.0031415926535897933,
                2.3456789012345678e-8,
                center=(1.2345678901234568e-9, -2.345678901234568e-9, 3.456789012345679e-9),
                axis=(1.2345678901234567, 2.345678901234568, -3.456789012345679),
                time_dependence=fm.PiecewiseLinear(
                    [
                        (0.0, -0.12345678901234568),
                        (1.2345678901234568e-12, 0.9876543210987654),
                        (9.876543210987653e-12, 1.2345678901234567),
                    ]
                ),
            ),
            fm.OerstedField(source="transport"),
        ]
        direct = _problem(spin_torques=torques, oersted_terms=oersted)
        direct_ir = direct.to_ir()
        expected_spin = direct_ir["spin_torque_modules"]
        expected_oersted = [
            term
            for term in direct_ir["energy_terms"]
            if term["kind"] in {"oersted_cylinder", "oersted_field"}
        ]

        with TemporaryDirectory() as tmpdir:
            source_path = Path(tmpdir) / "direct.py"
            source_path.write_text("# source placeholder\n", encoding="utf-8")
            loaded = LoadedProblem(
                problem=direct,
                source_path=source_path,
                script_source=source_path.read_text(encoding="utf-8"),
                entrypoint_kind="problem",
                default_until_seconds=1e-12,
            )
            builder = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(builder)
            inverse = build_builder_from_scene_document(scene)
            overrides = builder_overrides_from_scene_document(scene)
            rewritten = rewrite_loaded_problem_script(loaded, overrides=overrides)["rendered_source"]
            rewritten_path = Path(tmpdir) / "rewritten.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = load_problem_from_script(rewritten_path)

        self.assertEqual(builder["spin_torques"], expected_spin)
        self.assertEqual(builder["oersted_terms"], expected_oersted)
        self.assertEqual(inverse["spin_torques"], expected_spin)
        self.assertEqual(inverse["oersted_terms"], expected_oersted)
        self.assertEqual(overrides["spin_torques"], expected_spin)
        self.assertEqual(overrides["oersted_terms"], expected_oersted)
        reloaded_ir = reloaded.problem.to_ir()
        self.assertEqual(reloaded_ir["spin_torque_modules"], expected_spin)
        self.assertEqual(
            [
                term
                for term in reloaded_ir["energy_terms"]
                if term["kind"] in {"oersted_cylinder", "oersted_field"}
            ],
            expected_oersted,
        )

    def test_study_surface_registration_round_trips_through_existing_loader(self) -> None:
        torque = fm.PrescribedSpinOrbitTorque(
            "study_sot",
            fm.RegionRef("layer"),
            fm.SignedScalarDrive(2.3456789012345678e11, (0.0, 1.0, 0.0)),
            xi_dl=0.12345678901234566,
            free_layer_thickness_m=1.2345678901234567e-9,
        )
        term = fm.OerstedCylinder(
            -0.0012345678901234567,
            1.9876543210987654e-8,
            axis=(1.0, 2.0, 3.0),
        )
        direct = _problem(
            spin_torques=[torque],
            oersted_terms=[term],
            runtime_metadata={"script_api_surface": "study"},
        )
        with TemporaryDirectory() as tmpdir:
            source_path = Path(tmpdir) / "study_direct.py"
            source_path.write_text("# source placeholder\n", encoding="utf-8")
            loaded = LoadedProblem(
                problem=direct,
                source_path=source_path,
                script_source=source_path.read_text(encoding="utf-8"),
                entrypoint_kind="problem",
                default_until_seconds=1e-12,
            )
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn("study.spin_torque(", rewritten)
            self.assertIn("study.oersted(", rewritten)
            rewritten_path = Path(tmpdir) / "study_rewritten.py"
            rewritten_path.write_text(rewritten, encoding="utf-8")
            reloaded = load_problem_from_script(rewritten_path)
        ir = reloaded.problem.to_ir()
        self.assertEqual(ir["spin_torque_modules"], [torque.to_ir_module()])
        self.assertIn(term.to_ir(), ir["energy_terms"])


class OerstedRuntimeRoundTripTests(unittest.TestCase):
    def test_flat_oersted_registration_is_typed_and_returns_object(self) -> None:
        term = fm.OerstedCylinder(0.001, 10e-9)
        fm.reset()
        self.assertIs(fm.oersted(term), term)
        with self.assertRaises(TypeError):
            fm.oersted({"kind": "oersted_cylinder"})  # type: ignore[arg-type]

    def test_dynamic_arbitrary_axis_cylinder_and_source_field_render_without_loss(self) -> None:
        terms = (
            fm.OerstedCylinder(
                0.0015, 7e-9, time_dependence=fm.model.Constant()
            ),
            fm.OerstedCylinder(
                current=-0.004,
                radius=18e-9,
                center=(1e-9, -3e-9, 5e-9),
                axis=(1.0, 2.0, -3.0),
                time_dependence=fm.PiecewiseLinear(
                    [(0.0, -1.0), (1e-12, 0.5), (9e-12, 2.0)]
                ),
            ),
            fm.OerstedCylinder(
                0.002,
                9e-9,
                time_dependence=fm.Sinusoidal(13e9, phase_rad=0.4, offset=-0.2),
            ),
            fm.OerstedCylinder(
                0.003, 10e-9, time_dependence=Pulse(2e-12, 6e-12)
            ),
            fm.OerstedCylinder(
                0.001,
                8e-9,
                time_dependence=fm.SincPulse(22e9, t0=4e-12, amplitude=-0.7),
            ),
            fm.OerstedField(source="transport"),
        )
        rendered = script_builder._render_oersted_terms(  # type: ignore[attr-defined]
            _problem(oersted_terms=terms), overrides={}
        )
        rebuilt = [_eval_rendered([line]) for line in rendered[1:]]
        self.assertEqual([term.to_ir() for term in rebuilt], [term.to_ir() for term in terms])

    def test_oersted_overrides_are_consumed_and_invalid_entries_fail_closed(self) -> None:
        term = fm.OerstedField(source="transport").to_ir()
        rendered = script_builder._render_oersted_terms(  # type: ignore[attr-defined]
            _problem(), overrides={"oersted_terms": [term]}
        )
        self.assertEqual(_eval_rendered(rendered).to_ir(), term)
        for entry in (
            {"kind": "unknown"},
            {"kind": "oersted_cylinder", "current": 1.0},
            {"kind": "oersted_field", "source": "transport", "model": "future"},
            {
                "kind": "oersted_cylinder",
                "current": 1.0,
                "radius": 1.0,
                "center": [0.0, 0.0, 0.0],
                "axis": [0.0, 0.0, 1.0],
                "time_dependence": {"kind": "future"},
            },
        ):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                script_builder._render_oersted_terms(  # type: ignore[attr-defined]
                    _problem(), overrides={"oersted_terms": [entry]}
                )

    def test_oersted_override_rejects_nonfinite_wrong_typed_and_conflicting_fields(self) -> None:
        cylinder = fm.OerstedCylinder(0.001, 10e-9).to_ir()
        malformed = (
            {**cylinder, "current": True},
            {**cylinder, "radius": float("nan")},
            {**cylinder, "center": [0.0, "0", 0.0]},
            {**cylinder, "axis": [0.0, 0.0, float("inf")]},
            {**cylinder, "source": "transport"},
            {"kind": "oersted_field", "model": "from_current_solution", "source": ""},
        )
        for entry in malformed:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                script_builder._render_oersted_terms(  # type: ignore[attr-defined]
                    _problem(), overrides={"oersted_terms": [entry]}
                )


if __name__ == "__main__":
    unittest.main()
