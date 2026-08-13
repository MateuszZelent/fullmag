from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("compare_fdm_racetrack_mumax.py")


def load_module():
    spec = importlib.util.spec_from_file_location("compare_fdm_racetrack_mumax", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load racetrack MuMax comparator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sample(
    time_s: float,
    *,
    m: tuple[float, float, float] = (1.0, 0.0, 0.0),
    q: float = -1.0,
    centre_m: tuple[float, float] = (1.0e-8, 2.0e-8),
) -> dict[str, object]:
    return {
        "time_s": time_s,
        "m": [list(m)],
        "energy_J": 2.0e-18,
        "topological_charge": q,
        "centre_m": list(centre_m),
    }


def fullmag_manifest() -> dict[str, object]:
    return {
        "schema_version": "fullmag_racetrack_common_limit_input.v1",
        "grid": {"shape": [1, 1, 1], "digest_sha256": "grid-digest"},
        "torque_export": {
            "schema_version": "fullmag_transport_torque_export.v1",
            "field_digest_sha256": "torque-digest",
            "units": "s^-1",
            "formula_version": "transport_torque_angular_momentum.fullmag.v1",
        },
        "common_limit": {"integrator": "heun_fixed", "fixed_timestep_s": 1.0e-13, "demag_policy": "literal"},
        "trajectory": [sample(0.0), sample(1.0e-12, centre_m=(1.1e-8, 2.1e-8))],
    }


def mumax_manifest(*, torque_digest: str = "torque-digest") -> dict[str, object]:
    return {
        "schema_version": "mumax_racetrack_common_limit_input.v1",
        "mumax": {
            "version": "3.10",
            "binary_digest_sha256": "mumax-digest",
            "input_script_digest_sha256": "script-digest",
            "output_ovf_digest_sha256": "output-digest",
        },
        "grid": {"shape": [1, 1, 1], "digest_sha256": "grid-digest"},
        "injected_torque": {
            "source_field_digest_sha256": torque_digest,
            "units": "s^-1",
            "identity_confirmed": True,
            "formula_version": "transport_torque_angular_momentum.fullmag.v1",
        },
        "common_limit": {"integrator": "heun_fixed", "fixed_timestep_s": 1.0e-13, "demag_policy": "literal"},
        "trajectory": [sample(0.0), sample(1.0e-12, centre_m=(1.1e-8, 2.1e-8))],
    }


class CompareFdmRacetrackMumaxTests(unittest.TestCase):
    def test_matching_common_limit_inputs_pass_with_named_metrics(self) -> None:
        module = load_module()

        report = module.compare_common_limit(
            fullmag_manifest(), mumax_manifest(), thresholds=module.DEFAULT_THRESHOLDS
        )

        self.assertEqual(report["schema_version"], "racetrack_mumax_common_limit_v1")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["metrics"]["m_rms"], 0.0)
        self.assertEqual(report["metrics"]["theta_h_rad_error"], 0.0)

    def test_rejects_axis_sign_change(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["trajectory"] = [sample(0.0), sample(1.0e-12, m=(-1.0, 0.0, 0.0))]

        with self.assertRaisesRegex(module.ComparisonError, "m_rms"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_different_sample_times(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["trajectory"] = [sample(0.0), sample(2.0e-12)]

        with self.assertRaisesRegex(module.ComparisonError, "sample time"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_missing_sample(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["trajectory"] = [sample(0.0)]

        with self.assertRaisesRegex(module.ComparisonError, "trajectory must contain"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_topology_loss(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["trajectory"] = [sample(0.0), sample(1.0e-12, q=0.0)]

        with self.assertRaisesRegex(module.ComparisonError, "topology_lost"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_uses_separate_field_and_observable_thresholds(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["trajectory"] = [sample(0.0, m=(1.0, 1.0e-3, 0.0)), sample(1.0e-12)]
        thresholds = {**module.DEFAULT_THRESHOLDS, "m_rms": 1.0, "energy_relative": 1.0e-12}
        mumax["trajectory"][0]["energy_J"] = 3.0e-18

        with self.assertRaisesRegex(module.ComparisonError, "energy_relative"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=thresholds)

    def test_rejects_missing_mumax_digest(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        del mumax["mumax"]["binary_digest_sha256"]

        with self.assertRaisesRegex(module.ComparisonError, "MuMax binary digest"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_absent_or_mismatched_torque_identity(self) -> None:
        module = load_module()

        with self.assertRaisesRegex(module.ComparisonError, "torque identity"):
            module.compare_common_limit(
                fullmag_manifest(), mumax_manifest(torque_digest="other-digest"), thresholds=module.DEFAULT_THRESHOLDS
            )

    def test_rejects_injected_torque_with_a_different_formula(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["injected_torque"]["formula_version"] = "prescribed_current.v1"

        with self.assertRaisesRegex(module.ComparisonError, "torque formula"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_different_common_limit_integrator(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["common_limit"]["integrator"] = "rk4_fixed"

        with self.assertRaisesRegex(module.ComparisonError, "common-limit"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)


if __name__ == "__main__":
    unittest.main()
