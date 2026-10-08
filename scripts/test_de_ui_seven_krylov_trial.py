import copy
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import de_gamma_krylov_trial
import run_de_100nm_pilot as pilot
from de_ui_seven_krylov_trial import validate_ui_seven_krylov_trial
from validate_de_smoke_rows import SAMPLING, UI_SEVEN_SAMPLING


TARGET_HZ = 10e9
EPS_PREFILTER = "1e-9"
KSP_RTOL = "1e-9"
KSP_RESTART = "30"
KSP_TYPE = "fgmres"
CRITERION_SCHEMA = "floquet_shifted_ksp_true_residual_criterion.v1"


def _nearest_contract():
    return {
        "status": "ok",
        "solve_complete": True,
        "requested_mode_count": 1,
        "target_kind": "nearest_frequency",
        "target_frequency_hz": TARGET_HZ,
        "spectrum_completeness": "selected_only",
        "window_complete": False,
    }


def _true_residual_fields(*, mutation=None):
    criterion = {
        "schema_version": CRITERION_SCHEMA,
        "reference_norm": "rhs_norm_zero_initial_guess",
        "solve_count": 4,
        "measured_count": 4,
        "violation_count": 0,
        "unavailable_count": 0,
        "maximum_tolerance_ratio": 0.75,
    }
    if mutation == "violation":
        criterion["violation_count"] = 1
    return {
        "shifted_ksp_configuration_before_eps": {
            "phase": "before_eps_solve",
            "pc_side": 1,
            "norm_type": 2,
        },
        "ksp_diagnostics_available": True,
        "ksp_converged_reason": 2,
        "eps_converged_reason": 1,
        "ksp_pc_side": 1,
        "ksp_norm_type": 2,
        "ksp_last_true_residual_available": True,
        "ksp_last_true_residual_norm": 0.75e-9,
        "ksp_last_rhs_norm": 1.0,
        "ksp_true_residual_sample_count": 4,
        "ksp_true_residual_measurement_failure_count": 0,
        "ksp_true_residual_criterion": criterion,
    }


def _sample_query():
    return {
        "phase": "queried_after_eps",
        "eps_tolerance": 1e-9,
        "eps_max_iterations": None,
        "shifted_ksp_type": KSP_TYPE,
        "shifted_ksp_rtol": 1e-9,
        "shifted_ksp_max_iterations": 2000,
        "shifted_ksp_restart": 30,
    }


def _ui_seven_diagnostics():
    records = []
    for sample_index, ky in enumerate(SAMPLING[UI_SEVEN_SAMPLING]):
        vector = [0.0, ky, 0.0]
        if ky == 0.0:
            sample = {
                **_nearest_contract(),
                "solver_adapter": de_gamma_krylov_trial._K0_SOLVER_ADAPTER,
                "engine_id": de_gamma_krylov_trial._K0_ENGINE_ID,
                "k_vector_len": 3,
                "k_vector_rad_m": vector,
                "q_dof_count": 20,
                "modal_krylov_tuning": _sample_query(),
            }
        else:
            sample = {
                **_nearest_contract(),
                "solver_adapter": "floquet_airbox_cpu_schur_slepc",
                "k_vector_len": 3,
                "k_vector_rad_m": vector,
                "ksp_type": KSP_TYPE,
                "ksp_rtol": 1e-9,
                "ksp_atol": 1e-50,
                "ksp_breakdown_tolerance": None,
                "ksp_restart": 30,
                "eps_dimensions_available": True,
                "eps_nev": 2,
                "eps_ncv": 30,
                "eps_mpd": 20,
                **_true_residual_fields(),
            }
        records.append({
            "sample_index": sample_index,
            "k_vector": vector,
            "diagnostics": sample,
        })
    return {
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "sample_count": 7,
        "requested_mode_count": 1,
        "target_kind": "nearest_frequency",
        "target_frequency_hz": TARGET_HZ,
        "spectrum_completeness": "selected_only",
        "window_complete": False,
        "ksp_type": KSP_TYPE,
        "ksp_rtol": 1e-9,
        "ksp_restart": 30,
        "sample_solver_diagnostics": records,
    }


def _write_case(root, diagnostics):
    path = Path(root) / "eigen" / "diagnostics" / "solver.v1.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(diagnostics), encoding="utf-8")
    return path.parents[2]


class UiSevenKrylovTrialTests(unittest.TestCase):
    def _validate(self, case_dir, **overrides):
        request = {
            "target_frequency_hz": TARGET_HZ,
            "requested_type": KSP_TYPE,
            "requested_rtol": KSP_RTOL,
            "eps_prefilter": EPS_PREFILTER,
            "gmres_restart": KSP_RESTART,
        }
        request.update(overrides)
        return validate_ui_seven_krylov_trial(case_dir, **request)

    def test_ui_seven_receipt_checks_six_shifted_solves_and_gamma_query(self):
        with TemporaryDirectory() as tmp:
            case_dir = _write_case(tmp, _ui_seven_diagnostics())
            report = self._validate(case_dir)

        self.assertEqual(report["schema"], "fullmag.de-smoke-ui-seven-krylov-trial.v1")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["qualification"], "NOT VERIFIED")
        self.assertEqual(report["purpose"], "ui_diagnostic")
        self.assertEqual(report["selection_scope"], "selected_only")
        self.assertIs(report["window_complete"], False)
        self.assertEqual(report["sample_count"], 7)
        self.assertEqual(report["shifted_sample_indices"], [0, 1, 2, 4, 5, 6])
        self.assertEqual(report["requested_type"], "fgmres")
        self.assertEqual(report["requested_rtol"], 1e-9)
        self.assertEqual(report["requested_eps_prefilter"], 1e-9)
        self.assertEqual(report["requested_gmres_restart"], 30)
        self.assertEqual(report["gamma_sample"]["sample_index"], 3)
        self.assertEqual(report["gamma_sample"]["modal_krylov_tuning"]["phase"], "queried_after_eps")
        self.assertNotIn("window_certificate", report["gamma_sample"])
        for sample in report["shifted_samples"].values():
            self.assertEqual(sample["ksp_restart"], 30)
            self.assertEqual(sample["single_solve"]["true_residual_criterion"]["violation_count"], 0)
            self.assertNotIn("subwindows", sample)

    def test_ui_seven_native_type_rtol_restart_and_residual_drift_fail_closed(self):
        mutations = (
            ("sample type", lambda d: d["sample_solver_diagnostics"][0]["diagnostics"].update(ksp_type="gmres")),
            ("sample rtol", lambda d: d["sample_solver_diagnostics"][0]["diagnostics"].update(ksp_rtol=1e-8)),
            ("sample restart", lambda d: d["sample_solver_diagnostics"][0]["diagnostics"].update(ksp_restart=16)),
            ("Gamma type", lambda d: d["sample_solver_diagnostics"][3]["diagnostics"]["modal_krylov_tuning"].update(shifted_ksp_type="gmres")),
            ("Gamma rtol", lambda d: d["sample_solver_diagnostics"][3]["diagnostics"]["modal_krylov_tuning"].update(shifted_ksp_rtol=1e-8)),
            ("Gamma EPS", lambda d: d["sample_solver_diagnostics"][3]["diagnostics"]["modal_krylov_tuning"].update(eps_tolerance=1e-8)),
            ("Gamma restart", lambda d: d["sample_solver_diagnostics"][3]["diagnostics"]["modal_krylov_tuning"].update(shifted_ksp_restart=16)),
            ("true residual", lambda d: d["sample_solver_diagnostics"][5]["diagnostics"].update(_true_residual_fields(mutation="violation"))),
        )
        for label, mutate in mutations:
            with self.subTest(mutation=label), TemporaryDirectory() as tmp:
                diagnostics = copy.deepcopy(_ui_seven_diagnostics())
                mutate(diagnostics)
                with self.assertRaises(ValueError):
                    self._validate(_write_case(tmp, diagnostics))

    def test_runner_dispatches_ui_seven_to_one_nearest_receipt_only(self):
        with TemporaryDirectory() as tmp:
            case_dir = _write_case(tmp, _ui_seven_diagnostics())
            artifacts = pilot._validate_krylov_trials(
                case_dir, UI_SEVEN_SAMPLING, "fgmres", "1e-9", "1e-9", "30",
                spectral_target="nearest", target_frequency_hz=TARGET_HZ,
            )
        self.assertEqual(set(artifacts), {"ui_seven_krylov_trial"})
        with self.assertRaises(pilot.managed.BenchmarkError):
            pilot._validate_krylov_trials(
                Path("case"), "two", "fgmres", "1e-9", "1e-9", "30",
                spectral_target="nearest", target_frequency_hz=TARGET_HZ,
            )

if __name__ == "__main__":
    unittest.main()
