from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("compare_fdm_racetrack_mumax.py")
EXPORTER = Path(__file__).with_name("export_fullmag_transport_torque_for_mumax.py")
PARSER = Path(__file__).with_name("parse_mumax_common_limit.py")


def load_module():
    spec = importlib.util.spec_from_file_location("compare_fdm_racetrack_mumax", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load racetrack MuMax comparator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_exporter():
    spec = importlib.util.spec_from_file_location("export_fullmag_transport_torque_for_mumax", EXPORTER)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load Fullmag transport torque exporter")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_parser():
    spec = importlib.util.spec_from_file_location("parse_mumax_common_limit", PARSER)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load MuMax common-limit parser")
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
        "schema_version": "fullmag_racetrack_common_limit_input.v2",
        "grid": {"shape": [1, 1, 1], "digest_sha256": "grid-digest"},
        "torque_export": {
            "schema_version": "fullmag_transport_torque_mumax_export.v1",
            "source_torque": {
                "quantity": "T_tr_G",
                "field_digest_sha256": "source-torque-digest",
                "units": "s^-1",
                "formula_version": "transport_torque_angular_momentum.fullmag.v1",
            },
            "equivalent_field": {
                "quantity": "B_eq",
                "field_digest_sha256": "beq-digest",
                "source_torque_digest_sha256": "source-torque-digest",
                "units": "T",
                "formula_version": "B_eq_equals_m_cross_T_tr_G_over_gamma_e.v1",
            },
            "llg": {
                "convention": "gilbert_explicit_fullmag.v1",
                "alpha": 0.3,
                "gamma_rad_s_T": 1.76085963023e11,
            },
            "frozen_torque": {
                "enabled": True,
                "update_policy": "frozen_from_accepted_fullmag_snapshot",
                "dynamic_transport_recomputation": False,
            },
        },
        "common_limit": {
            "integrator": "heun_fixed",
            "fixed_timestep_s": 1.0e-13,
            "sample_interval_s": 1.0e-12,
            "duration_s": 1.0e-12,
            "alpha": 0.3,
            "gamma_rad_s_T": 1.76085963023e11,
            "demag_policy": "literal",
        },
        "trajectory": [sample(0.0), sample(1.0e-12, centre_m=(1.1e-8, 2.1e-8))],
    }


def mumax_manifest(*, source_torque_digest: str = "source-torque-digest", beq_digest: str = "beq-digest") -> dict[str, object]:
    return {
        "schema_version": "mumax_racetrack_common_limit_input.v2",
        "mumax": {
            "version": "3.10",
            "binary_digest_sha256": "mumax-digest",
            "input_script_digest_sha256": "script-digest",
            "output_ovf_digest_sha256": "output-digest",
            "table_digest_sha256": "table-digest",
        },
        "grid": {"shape": [1, 1, 1], "digest_sha256": "grid-digest"},
        "injected_torque": {
            "quantity": "B_eq",
            "source_torque_digest_sha256": source_torque_digest,
            "field_digest_sha256": beq_digest,
            "units": "T",
            "identity_confirmed": True,
            "formula_version": "B_eq_equals_m_cross_T_tr_G_over_gamma_e.v1",
            "frozen_torque": {
                "enabled": True,
                "update_policy": "frozen_from_accepted_fullmag_snapshot",
                "dynamic_transport_recomputation": False,
            },
        },
        "common_limit": {
            "integrator": "heun_fixed",
            "fixed_timestep_s": 1.0e-13,
            "sample_interval_s": 1.0e-12,
            "duration_s": 1.0e-12,
            "alpha": 0.3,
            "gamma_rad_s_T": 1.76085963023e11,
            "demag_policy": "literal",
        },
        "trajectory_source": {
            "kind": "mumax_table_autosave_v1",
            "initial_sample_recorded": True,
            "table_autosave_interval_s": 1.0e-12,
            "field_autosave_interval_s": 1.0e-12,
            "table_digest_sha256": "table-digest",
        },
        "trajectory": [sample(0.0), sample(1.0e-12, centre_m=(1.1e-8, 2.1e-8))],
    }


class CompareFdmRacetrackMumaxTests(unittest.TestCase):
    def test_parser_converts_centered_mumax_bubble_position_to_grid_frame(self) -> None:
        parser = load_parser()
        grid = {
            "shape": [256, 64, 1],
            "cell_size_m": [2.0e-9, 2.0e-9, 1.0e-9],
            "origin_m": [0.0, 0.0, 0.0],
        }
        centre = parser._bubble_position_in_grid_frame(
            {"ext_bubbleposx (m)": -1.0e-9, "ext_bubbleposy (m)": -1.0e-9}, grid
        )
        self.assertAlmostEqual(centre[0], 2.55e-7)
        self.assertAlmostEqual(centre[1], 6.3e-8)

    def test_matching_common_limit_inputs_pass_with_named_metrics(self) -> None:
        module = load_module()

        report = module.compare_common_limit(
            fullmag_manifest(), mumax_manifest(), thresholds=module.DEFAULT_THRESHOLDS
        )

        self.assertEqual(report["schema_version"], "racetrack_mumax_common_limit_v2")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["metrics"]["m_rms"], 0.0)
        self.assertEqual(report["metrics"]["theta_h_rad_error"], 0.0)

    def test_explicit_steps_table_source_passes_with_fixed_step_identity(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["trajectory_source"] = {
            "kind": "mumax_table_save_steps_v1",
            "initial_sample_recorded": True,
            "table_save_interval_s": 1.0e-12,
            "field_save_interval_s": 1.0e-12,
            "steps_per_sample": 10,
            "table_digest_sha256": "table-digest",
        }
        report = module.compare_common_limit(
            fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS
        )
        self.assertEqual(report["status"], "pass")

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

        with self.assertRaisesRegex(module.ComparisonError, "sample cadence"):
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

        with self.assertRaisesRegex(module.ComparisonError, "source T_tr_G digest"):
            module.compare_common_limit(
                fullmag_manifest(), mumax_manifest(source_torque_digest="other-digest"), thresholds=module.DEFAULT_THRESHOLDS
            )

    def test_rejects_injected_torque_with_a_different_formula(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["injected_torque"]["formula_version"] = "prescribed_current.v1"

        with self.assertRaisesRegex(module.ComparisonError, "B_eq formula"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_different_common_limit_integrator(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["common_limit"]["integrator"] = "rk4_fixed"

        with self.assertRaisesRegex(module.ComparisonError, "common-limit"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_missing_injected_beq_identity(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        del mumax["injected_torque"]["field_digest_sha256"]

        with self.assertRaisesRegex(module.ComparisonError, "B_eq digest"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_injected_field_with_non_tesla_units(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["injected_torque"]["units"] = "A/m"

        with self.assertRaisesRegex(module.ComparisonError, "B_eq in T"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_rejects_dynamic_transport_or_wrong_sample_cadence(self) -> None:
        module = load_module()
        mumax = mumax_manifest()
        mumax["injected_torque"]["frozen_torque"]["dynamic_transport_recomputation"] = True
        with self.assertRaisesRegex(module.ComparisonError, "dynamically recomputes"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

        mumax = mumax_manifest()
        mumax["trajectory"] = [sample(0.0), sample(9.0e-13, centre_m=(1.1e-8, 2.1e-8))]
        with self.assertRaisesRegex(module.ComparisonError, "sample cadence"):
            module.compare_common_limit(fullmag_manifest(), mumax, thresholds=module.DEFAULT_THRESHOLDS)

    def test_exporter_converts_tangent_gilbert_torque_to_tesla_and_records_digests(self) -> None:
        exporter = load_exporter()
        source = {
            "schema_version": "fullmag_transport_torque_snapshot.v1",
            "status": "accepted",
            "accepted": True,
            "grid": {
                "shape": [1, 1, 1],
                "cell_size_m": [2e-9, 2e-9, 1e-9],
                "origin_m": [0.0, 0.0, 0.0],
                "cell_order": "x_fastest_then_y_then_z",
            },
            "magnetization": {"quantity": "m", "units": "1", "values": [[0.0, 0.0, 1.0]]},
            "torque": {
                "quantity": "T_tr_G",
                "units": "s^-1",
                "formula_version": "transport_torque_angular_momentum.fullmag.v1",
                "values": [[2.0, 0.0, 0.0]],
            },
            "llg": {"convention": "gilbert_explicit_fullmag.v1", "alpha": 0.3, "gamma_rad_s_T": 4.0},
        }

        field, manifest = exporter.export_snapshot(source)

        self.assertEqual(field, [(0.0, 0.5, 0.0)])
        self.assertEqual(manifest["source_torque"]["units"], "s^-1")
        self.assertEqual(manifest["equivalent_field"]["units"], "T")
        self.assertEqual(manifest["equivalent_field"]["source_torque_digest_sha256"], manifest["source_torque"]["field_digest_sha256"])
        self.assertFalse(manifest["frozen_torque"]["dynamic_transport_recomputation"])
        alpha = 0.3
        m = (0.0, 0.0, 1.0)
        torque = (2.0, 0.0, 0.0)
        b_eq = field[0]
        cross = lambda left, right: (
            left[1] * right[2] - left[2] * right[1],
            left[2] * right[0] - left[0] * right[2],
            left[0] * right[1] - left[1] * right[0],
        )
        m_cross_b = cross(m, b_eq)
        field_rhs = tuple(
            -4.0 * (m_cross_b[axis] + alpha * cross(m, m_cross_b)[axis]) / (1.0 + alpha * alpha)
            for axis in range(3)
        )
        torque_rhs = tuple(
            (torque[axis] + alpha * cross(m, torque)[axis]) / (1.0 + alpha * alpha)
            for axis in range(3)
        )
        for actual, expected in zip(field_rhs, torque_rhs):
            self.assertAlmostEqual(actual, expected)

    def test_exporter_rejects_non_tangent_torque(self) -> None:
        exporter = load_exporter()
        with self.assertRaisesRegex(exporter.ExportError, "not tangent"):
            exporter.equivalent_field([(0.0, 0.0, 1.0)], [(0.0, 0.0, 1.0)], 1.0)


if __name__ == "__main__":
    unittest.main()
