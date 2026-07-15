from __future__ import annotations

import unittest
import warnings

import fullmag as fm
from fullmag.model.energy import Pulse
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime import script_builder
from fullmag.runtime.script_builder import _render_spin_torques


def _problem(*, spin_torques=(), oersted_terms=()) -> fm.Problem:
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
        study=fm.TimeEvolution(
            dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 2e-9))
        ),
    )


def _eval_rendered(lines: list[str]) -> object:
    return eval(lines[-1], {"fm": fm})


class SpinTorqueRuntimeRoundTripTests(unittest.TestCase):
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


class OerstedRuntimeRoundTripTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
