"""Canonical Python authoring contract for prescribed spin-orbit torque."""

from __future__ import annotations

import math
import unittest
import warnings

import fullmag as fm
import fullmag.model as model
from fullmag.model.problem import API_VERSION, IR_VERSION, SERIALIZER_VERSION


class TestTimeEnvelopes(unittest.TestCase):
    def test_every_variant_serializes_to_the_canonical_ir_shape(self) -> None:
        cases = [
            (fm.ConstantEnvelope(2.0), {"kind": "constant", "value": 2.0}),
            (
                fm.SinusoidalEnvelope(
                    amplitude=2.0,
                    frequency_hz=3.0,
                    phase_rad=0.25,
                    offset=-1.0,
                ),
                {
                    "kind": "sinusoidal",
                    "amplitude": 2.0,
                    "frequency_hz": 3.0,
                    "phase_rad": 0.25,
                    "offset": -1.0,
                },
            ),
            (
                fm.PulseEnvelope(amplitude=4.0, t_on_s=1e-9, t_off_s=3e-9),
                {"kind": "pulse", "amplitude": 4.0, "t_on_s": 1e-9, "t_off_s": 3e-9},
            ),
            (
                fm.PiecewiseLinearEnvelope(
                    [fm.TimeEnvelopePoint(0.0, 0.0), fm.TimeEnvelopePoint(2e-9, 1.0)]
                ),
                {
                    "kind": "piecewise_linear",
                    "points": [
                        {"time_s": 0.0, "value": 0.0},
                        {"time_s": 2e-9, "value": 1.0},
                    ],
                },
            ),
            (
                fm.SincEnvelope(amplitude=3.0, center_s=2e-9, bandwidth_hz=5e9, offset=0.5),
                {
                    "kind": "sinc",
                    "amplitude": 3.0,
                    "center_s": 2e-9,
                    "bandwidth_hz": 5e9,
                    "offset": 0.5,
                },
            ),
            (
                fm.TabulatedEnvelope("artifact://drive"),
                {
                    "kind": "tabulated",
                    "artifact_ref": "artifact://drive",
                    "interpolation": "linear",
                    "extrapolation": "error",
                },
            ),
            (
                fm.TabulatedEnvelope(
                    "artifact://drive",
                    interpolation="previous",
                    extrapolation="hold",
                    bandwidth_hz=1e9,
                ),
                {
                    "kind": "tabulated",
                    "artifact_ref": "artifact://drive",
                    "interpolation": "previous",
                    "extrapolation": "hold",
                    "bandwidth_hz": 1e9,
                },
            ),
        ]
        for envelope, expected in cases:
            with self.subTest(envelope=type(envelope).__name__):
                self.assertEqual(envelope.to_ir(), expected)

    def test_canonical_defaults_are_exact(self) -> None:
        self.assertEqual(
            fm.SinusoidalEnvelope(amplitude=1.0, frequency_hz=0.0).to_ir(),
            {
                "kind": "sinusoidal",
                "amplitude": 1.0,
                "frequency_hz": 0.0,
                "phase_rad": 0.0,
                "offset": 0.0,
            },
        )
        self.assertEqual(
            fm.SincEnvelope(amplitude=1.0, bandwidth_hz=1.0).to_ir(),
            {
                "kind": "sinc",
                "amplitude": 1.0,
                "center_s": 0.0,
                "bandwidth_hz": 1.0,
                "offset": 0.0,
            },
        )

    def test_valid_boundary_values_are_accepted(self) -> None:
        self.assertEqual(fm.SinusoidalEnvelope(1.0, 0.0).frequency_hz, 0.0)
        self.assertEqual(fm.PulseEnvelope(1.0, -1.0, 0.0).t_off_s, 0.0)
        self.assertEqual(fm.SincEnvelope(1.0, 0.0, math.nextafter(0.0, 1.0)).center_s, 0.0)

    def test_invalid_numeric_boundaries_are_rejected(self) -> None:
        invalid_factories = [
            lambda: fm.ConstantEnvelope(math.nan),
            lambda: fm.SinusoidalEnvelope(math.inf, 1.0),
            lambda: fm.SinusoidalEnvelope(1.0, -1.0),
            lambda: fm.PulseEnvelope(1.0, 1.0, 1.0),
            lambda: fm.PulseEnvelope(1.0, 2.0, 1.0),
            lambda: fm.PiecewiseLinearEnvelope(
                [fm.TimeEnvelopePoint(0.0, 1.0), fm.TimeEnvelopePoint(0.0, 2.0)]
            ),
            lambda: fm.PiecewiseLinearEnvelope([fm.TimeEnvelopePoint(math.nan, 1.0)]),
            lambda: fm.SincEnvelope(1.0, 0.0, 0.0),
            lambda: fm.TabulatedEnvelope(""),
            lambda: fm.TabulatedEnvelope("x", interpolation="cubic"),
            lambda: fm.TabulatedEnvelope("x", extrapolation="repeat"),
            lambda: fm.TabulatedEnvelope("x", bandwidth_hz=0.0),
        ]
        for factory in invalid_factories:
            with self.subTest(factory=factory), self.assertRaises((TypeError, ValueError)):
                factory()


class TestPrescribedSotDrives(unittest.TestCase):
    def test_signed_scalar_preserves_sign_and_normalizes_sigma_only_in_ir(self) -> None:
        envelope = fm.ConstantEnvelope(-0.5)
        drive = fm.SignedScalarDrive(-2e11, sigma=(0.0, 3.0, 0.0), envelope=envelope)
        self.assertEqual(drive.sigma, (0.0, 3.0, 0.0))
        self.assertEqual(
            drive.to_ir(),
            {
                "kind": "signed_scalar",
                "current_density_Apm2": -2e11,
                "sigma_hat": [0.0, 1.0, 0.0],
                "envelope": {"kind": "constant", "value": -0.5},
            },
        )

    def test_vector_source_preserves_authored_axes_and_normalizes_only_in_ir(self) -> None:
        drive = fm.VectorCurrentDrive(
            current_source="charge",
            drive_direction=(2.0, 0.0, 0.0),
            interface_normal=(0.0, 0.0, 7.0),
        )
        self.assertEqual(drive.drive_direction, (2.0, 0.0, 0.0))
        self.assertEqual(drive.interface_normal, (0.0, 0.0, 7.0))
        self.assertEqual(
            drive.to_ir(),
            {
                "kind": "vector_current_source",
                "current_source_id": "charge",
                "drive_direction": [1.0, 0.0, 0.0],
                "interface_normal": [0.0, 0.0, 1.0],
            },
        )

    def test_nonfinite_near_zero_and_parallel_axes_fail_closed(self) -> None:
        invalid_factories = [
            lambda: fm.SignedScalarDrive(math.inf, sigma=(0.0, 1.0, 0.0)),
            lambda: fm.SignedScalarDrive(1.0, sigma=(1e-13, 0.0, 0.0)),
            lambda: fm.VectorCurrentDrive("", (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
            lambda: fm.VectorCurrentDrive("charge", (math.nan, 0.0, 0.0), (0.0, 0.0, 1.0)),
            lambda: fm.VectorCurrentDrive("charge", (1.0, 0.0, 0.0), (2.0, 0.0, 0.0)),
            lambda: fm.VectorCurrentDrive("charge", (1.0, 0.0, 0.0), (1.0, 1e-13, 0.0)),
        ]
        for factory in invalid_factories:
            with self.subTest(factory=factory), self.assertRaises(ValueError):
                factory()


class TestPrescribedSpinOrbitTorque(unittest.TestCase):
    def test_canonical_v1_json_is_exact(self) -> None:
        torque = fm.PrescribedSpinOrbitTorque(
            name="sot",
            target=fm.RegionRef("free", "core"),
            drive=fm.SignedScalarDrive(-2e11, sigma=(0.0, 2.0, 0.0)),
            xi_dl=0.12,
            xi_fl=-0.01,
            free_layer_thickness_m=1.5e-9,
        )
        self.assertEqual(
            torque.to_ir_module(),
            {
                "kind": "prescribed_sot",
                "schema_version": "prescribed_sot.v1",
                "id": "sot",
                "target": {"object_id": "free", "region_id": "core"},
                "formula_version": "prescribed_sot.fullmag.v1",
                "drive": {
                    "kind": "signed_scalar",
                    "current_density_Apm2": -2e11,
                    "sigma_hat": [0.0, 1.0, 0.0],
                },
                "xi_dl": 0.12,
                "xi_fl": -0.01,
                "free_layer_thickness_m": 1.5e-9,
            },
        )

    def test_constructor_rejects_invalid_module_values(self) -> None:
        drive = fm.SignedScalarDrive(1.0, sigma=(0.0, 1.0, 0.0))
        for kwargs in (
            {"name": ""},
            {"xi_dl": math.nan},
            {"xi_fl": math.inf},
            {"free_layer_thickness_m": 0.0},
        ):
            values = {
                "name": "sot",
                "target": fm.RegionRef("free"),
                "drive": drive,
                "xi_dl": 0.1,
                "xi_fl": 0.0,
                "free_layer_thickness_m": 1e-9,
            }
            values.update(kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                fm.PrescribedSpinOrbitTorque(**values)

    def test_deprecated_alias_scalar_arguments_emit_canonical_v1(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            torque = fm.SpinOrbitTorque(
                name="compat_sot",
                target=fm.RegionRef("free"),
                charge_current_density_a_per_m2=-3e11,
                damping_like_efficiency=0.2,
                field_like_efficiency=0.03,
                spin_polarization=(0.0, 4.0, 0.0),
                ferromagnet_thickness_m=2e-9,
            )
        self.assertTrue(any(item.category is DeprecationWarning for item in caught))
        ir = torque.to_ir_module()
        self.assertEqual(ir["kind"], "prescribed_sot")
        self.assertEqual(ir["formula_version"], "prescribed_sot.fullmag.v1")
        self.assertEqual(ir["drive"]["current_density_Apm2"], -3e11)  # type: ignore[index]

    def test_deprecated_alias_current_source_fails_without_axes(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "current_source.*drive_direction.*interface_normal",
        ):
            fm.SpinOrbitTorque(
                name="compat_sot",
                target=fm.RegionRef("free"),
                current_source="charge",
                damping_like_efficiency=0.2,
                spin_polarization=(0.0, 1.0, 0.0),
                ferromagnet_thickness_m=2e-9,
            )

    def test_legacy_v0_bridge_preserves_global_scope_zero_sigma_and_raw_sign(self) -> None:
        torque = fm.PrescribedSpinOrbitTorque.from_legacy_v0(
            module_index=4,
            target=None,
            raw_charge_current_density_Apm2=-3e11,
            raw_spin_polarization=(0.0, 0.0, 0.0),
            xi_dl=0.2,
            xi_fl=-0.03,
            free_layer_thickness_m=2e-9,
            compatibility_origin={
                "source_ir_version": "0.2.0",
                "authored_kind": "spin_orbit_torque",
            },
        )
        self.assertEqual(
            torque.to_ir_module(),
            {
                "kind": "prescribed_sot",
                "schema_version": "prescribed_sot.v1",
                "id": "legacy_prescribed_sot_4",
                "target": None,
                "formula_version": "prescribed_sot.legacy_fullmag.v0",
                "drive": {
                    "kind": "legacy_scalar_magnitude",
                    "raw_charge_current_density_Apm2": -3e11,
                },
                "raw_spin_polarization": [0.0, 0.0, 0.0],
                "xi_dl": 0.2,
                "xi_fl": -0.03,
                "free_layer_thickness_m": 2e-9,
                "compatibility_origin": {
                    "source_ir_version": "0.2.0",
                    "authored_kind": "spin_orbit_torque",
                },
            },
        )

    def test_legacy_v0_bridge_preserves_source_norm_mode(self) -> None:
        torque = fm.PrescribedSpinOrbitTorque.from_legacy_v0(
            module_index=0,
            target=None,
            current_source_id="charge",
            raw_spin_polarization=(0.0, 0.0, 1.0),
            xi_dl=0.1,
            xi_fl=0.0,
            free_layer_thickness_m=1e-9,
            compatibility_origin={
                "source_ir_version": "0.2.0",
                "authored_kind": "spin_orbit_torque",
            },
        )
        self.assertEqual(
            torque.to_ir_module()["drive"],
            {"kind": "legacy_current_source_norm", "current_source_id": "charge"},
        )

    def test_legacy_v0_bridge_rejects_forged_origin_or_ambiguous_drive(self) -> None:
        common = {
            "module_index": 0,
            "target": None,
            "raw_spin_polarization": (0.0, 0.0, 0.0),
            "xi_dl": 0.1,
            "xi_fl": 0.0,
            "free_layer_thickness_m": 1e-9,
            "compatibility_origin": {
                "source_ir_version": "0.2.0",
                "authored_kind": "spin_orbit_torque",
            },
        }
        with self.assertRaises(ValueError):
            fm.PrescribedSpinOrbitTorque.from_legacy_v0(**common)
        with self.assertRaises(ValueError):
            fm.PrescribedSpinOrbitTorque.from_legacy_v0(
                **common,
                raw_charge_current_density_Apm2=1.0,
                current_source_id="charge",
            )
        forged = dict(common)
        forged["compatibility_origin"] = {
            "source_ir_version": "0.3.0",
            "authored_kind": "prescribed_sot",
        }
        with self.assertRaises(ValueError):
            fm.PrescribedSpinOrbitTorque.from_legacy_v0(
                **forged,
                raw_charge_current_density_Apm2=1.0,
            )


class TestPublicContract(unittest.TestCase):
    def test_version_constants_are_0_3_0(self) -> None:
        self.assertEqual((IR_VERSION, API_VERSION, SERIALIZER_VERSION), ("0.3.0",) * 3)

    def test_all_canonical_constructs_are_exported_from_both_namespaces(self) -> None:
        names = (
            "RegionRef",
            "TimeEnvelopePoint",
            "ConstantEnvelope",
            "SinusoidalEnvelope",
            "PulseEnvelope",
            "PiecewiseLinearEnvelope",
            "SincEnvelope",
            "TabulatedEnvelope",
            "SignedScalarDrive",
            "VectorCurrentDrive",
            "PrescribedSpinOrbitTorque",
        )
        for name in names:
            with self.subTest(name=name):
                self.assertIs(getattr(fm, name), getattr(model, name))


if __name__ == "__main__":
    unittest.main()
