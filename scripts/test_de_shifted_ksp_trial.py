import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from de_shifted_ksp_trial import validate_shifted_ksp_trial
from validate_de_smoke_rows import SAMPLING


CRITERION_SCHEMA = "floquet_shifted_ksp_true_residual_criterion.v1"


def _window(index, *, method="gmres", rtol=1e-9, atol=1e-50,
            rhs_norm=1.0, true_residual_norm=5e-10, maximum_ratio=0.75,
            solve_count=2):
    return {
        "index": index,
        "unsupported_reason": "",
        "ksp_type": method,
        "ksp_rtol": rtol,
        "ksp_atol": atol,
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
        "ksp_last_true_residual_norm": true_residual_norm,
        "ksp_last_rhs_norm": rhs_norm,
        "ksp_last_true_relative_residual": (
            true_residual_norm / rhs_norm if rhs_norm else 0.0
        ),
        "ksp_true_residual_sample_count": solve_count,
        "ksp_true_residual_measurement_failure_count": 0,
        "ksp_true_residual_criterion": {
            "schema_version": CRITERION_SCHEMA,
            "reference_norm": "rhs_norm_zero_initial_guess",
            "solve_count": solve_count,
            "measured_count": solve_count,
            "violation_count": 0,
            "unavailable_count": 0,
            "maximum_tolerance_ratio": maximum_ratio,
        },
    }


def _sample(index, wavevector, *, method="gmres", rtol=1e-9, atol=1e-50,
            windows=None, sampling="k2"):
    vector = (
        [wavevector, 0.0, 0.0]
        if sampling.startswith("bv-")
        else [0.0, wavevector, 0.0]
    )
    return {
        "sample_index": index,
        "diagnostics": {
            "k_vector_len": 3,
            "k_vector_rad_m": vector,
            "ksp_type": method,
            "ksp_rtol": rtol,
            "ksp_atol": atol,
            "ksp_breakdown_tolerance": None if method == "fgmres" else 0.2,
            "subwindows": windows if windows is not None else [
                _window(0, method=method, rtol=rtol, atol=atol)
            ],
        },
    }


def _diagnostics(sampling="k2", *, method="gmres", rtol=1e-9, atol=1e-50,
                 sample_indices=None):
    # This mirrors the accepted #203 solver.v1.json envelope: global KSP
    # policy, sample_solver_diagnostics[*].diagnostics, then subwindows[*].
    # The newer producer adds each window's ksp_type/tolerances and the
    # per-solve criterion; #203 itself predates those fields.
    indices = (list(range(len(SAMPLING[sampling])) if sample_indices is None
                else sample_indices))
    records = [
        _sample(index, SAMPLING[sampling][index], method=method,
                rtol=rtol, atol=atol, sampling=sampling)
        for index in indices
    ]
    return {
        "schema_version": "solver.v1",
        "ksp_type": method,
        "ksp_rtol": rtol,
        "ksp_atol": atol,
        "ksp_breakdown_tolerance": None if method == "fgmres" else 0.2,
        "sample_solver_diagnostics": records,
    }


def _nearest_diagnostics(sampling="k25", *, method="gmres", rtol=1e-9,
                         atol=1e-50, target_frequency_hz=12.5e9,
                         restart=30):
    diagnostics = _diagnostics(sampling, method=method, rtol=rtol, atol=atol)
    diagnostics["ksp_restart"] = restart
    sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
    sample.pop("subwindows")
    sample["ksp_restart"] = restart
    telemetry = _window(0, method=method, rtol=rtol, atol=atol)
    telemetry.pop("index")
    telemetry.pop("unsupported_reason")
    sample.update(telemetry)
    sample.update({
        "solver_adapter": "floquet_airbox_cpu_schur_slepc",
        "status": "ok",
        "solve_complete": True,
        "target_kind": "nearest_frequency",
        "target_frequency_hz": target_frequency_hz,
        "spectrum_completeness": "selected_only",
        "window_complete": False,
        "eps_dimensions_available": True,
        "eps_nev": 2,
        "eps_ncv": 4,
        "eps_mpd": 3,
    })
    return diagnostics


def _write_case(root, diagnostics):
    case_dir = Path(root) / "de-smoke-k2"
    diagnostics_dir = case_dir / "eigen" / "diagnostics"
    diagnostics_dir.mkdir(parents=True, exist_ok=True)
    (diagnostics_dir / "solver.v1.json").write_text(
        json.dumps(diagnostics), encoding="utf-8"
    )
    return case_dir


class ShiftedKspTrialValidatorTests(unittest.TestCase):
    def test_de_and_bv_sample_vectors_use_their_declared_axes(self):
        cases = (("k2", 0, [0.0, 2e6, 0.0]),
                 ("bv-k25", 0, [25e6, 0.0, 0.0]))
        for sampling, sample_index, expected_vector in cases:
            with self.subTest(sampling=sampling):
                diagnostics = _diagnostics(sampling)
                with TemporaryDirectory() as tmp:
                    report = validate_shifted_ksp_trial(
                        _write_case(tmp, diagnostics), sampling, "gmres", "1e-9"
                    )
                self.assertEqual(
                    report["by_sample"][sample_index]["k_vector_rad_m"],
                    expected_vector,
                )

                actual = diagnostics["sample_solver_diagnostics"][sample_index][
                    "diagnostics"]["k_vector_rad_m"]
                actual[0], actual[1] = actual[1], actual[0]
                with TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "vector"):
                    validate_shifted_ksp_trial(
                        _write_case(tmp, diagnostics), sampling, "gmres", "1e-9"
                    )

    def test_repeated_wavevectors_and_all_executed_windows_keep_sample_identity(self):
        diagnostics = _diagnostics("parallel-probe")
        diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"] = [
            _window(0), _window(1, true_residual_norm=2e-10, maximum_ratio=0.8)
        ]
        with TemporaryDirectory() as tmp:
            case_dir = _write_case(tmp, diagnostics)
            report = validate_shifted_ksp_trial(
                case_dir, "parallel-probe", "gmres", "1e-9"
            )
        self.assertEqual(report["status"], "pass")
        self.assertEqual(sorted(report["by_sample"]), [0, 1, 2])
        self.assertEqual(report["by_sample"][0]["subwindow_count"], 2)
        self.assertEqual(report["by_sample"][0]["subwindows"][1]["index"], 1)

    def test_gamma_is_ignored_but_nonzero_sample_indices_are_required(self):
        diagnostics = _diagnostics("two")
        gamma, nonzero = diagnostics["sample_solver_diagnostics"]
        gamma["diagnostics"] = {"k_vector_len": 99, "ksp_type": "other"}
        gamma["diagnostics"].pop("subwindows", None)
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "two", "gmres", "1e-9"
            )
        self.assertEqual(sorted(report["by_sample"]), [1])

        diagnostics["sample_solver_diagnostics"] = [gamma]
        with TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "missing"):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "two", "gmres", "1e-9"
            )

    def test_global_sample_and_window_types_must_match_requested_method(self):
        cases = []
        global_mismatch = _diagnostics()
        global_mismatch["ksp_type"] = "fgmres"
        cases.append(("global mismatch", global_mismatch))
        local_mismatch = _diagnostics()
        local_mismatch["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_type"
        ] = "fgmres"
        cases.append(("window mismatch", local_mismatch))
        sample_mismatch = _diagnostics()
        sample_mismatch["sample_solver_diagnostics"][0]["diagnostics"]["ksp_type"] = "fgmres"
        cases.append(("sample mismatch", sample_mismatch))
        missing_window_type = _diagnostics()
        del missing_window_type["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_type"
        ]
        cases.append(("missing local type", missing_window_type))
        for case_name, diagnostics in cases:
            with self.subTest(case=case_name), TemporaryDirectory() as tmp, \
                    self.assertRaisesRegex(ValueError, "ksp_type"):
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
                )

    def test_an_earlier_shifted_solve_violation_fails_even_when_last_solve_passes(self):
        diagnostics = _diagnostics()
        window = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0]
        window["ksp_true_residual_criterion"].update({
            "violation_count": 1,
            "maximum_tolerance_ratio": 2.0,
        })
        with TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "criterion"):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
            )

    def test_missing_criterion_and_nonzero_initial_guess_are_rejected(self):
        missing = _diagnostics()
        del missing["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_true_residual_criterion"
        ]
        wrong_reference = _diagnostics()
        wrong_reference["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_true_residual_criterion"
        ]["reference_norm"] = "current_iterate_residual"
        for diagnostics in (missing, wrong_reference):
            with self.subTest(diagnostics=diagnostics), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
                )

    def test_absolute_tolerance_and_zero_rhs_use_the_absolute_bound(self):
        diagnostics = _diagnostics(atol=1e-6)
        windows = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"]
        windows[0] = _window(
            0, rtol=1e-9, atol=1e-6, rhs_norm=100.0,
            true_residual_norm=5e-7, maximum_ratio=0.5,
        )
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
            )
        self.assertEqual(report["status"], "pass")

        diagnostics = _diagnostics(atol=1e-6)
        diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0] = _window(
            0, rtol=1e-9, atol=1e-6, rhs_norm=0.0,
            true_residual_norm=5e-7, maximum_ratio=0.5,
        )
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
            )
        self.assertEqual(report["status"], "pass")

    def test_zero_threshold_requires_exact_zero_true_residual(self):
        diagnostics = _diagnostics(atol=0.0)
        window = _window(0, rtol=1e-9, atol=0.0, rhs_norm=0.0,
                         true_residual_norm=0.0, maximum_ratio=0.0)
        diagnostics["ksp_atol"] = 0.0
        diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["ksp_atol"] = 0.0
        diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"] = [window]
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
            )
        self.assertEqual(report["status"], "pass")

        window["ksp_last_true_residual_norm"] = 1e-30
        with TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "last"):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
            )

    def test_unavailable_or_failed_diagnostics_and_boolean_counts_are_rejected(self):
        mutations = []
        unavailable = _diagnostics()
        criterion = unavailable["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_true_residual_criterion"
        ]
        criterion["unavailable_count"] = 1
        mutations.append(unavailable)
        last_unavailable = _diagnostics()
        last_unavailable["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_last_true_residual_available"
        ] = False
        mutations.append(last_unavailable)
        boolean_count = _diagnostics()
        boolean_count["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_true_residual_criterion"
        ]["solve_count"] = True
        mutations.append(boolean_count)
        for diagnostics in mutations:
            with self.subTest(case=len(diagnostics["sample_solver_diagnostics"])), \
                    TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
                )

    def test_invalid_wavevector_and_loose_local_rtol_are_rejected(self):
        invalid_vector = _diagnostics()
        invalid_vector["sample_solver_diagnostics"][0]["diagnostics"]["k_vector_rad_m"] = [
            0.0, -2e6, 0.0
        ]
        loose_rtol = _diagnostics()
        loose_rtol["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_rtol"
        ] = 2e-9
        for case_name, diagnostics in (
                ("vector", invalid_vector), ("local rtol", loose_rtol)):
            with self.subTest(case=case_name), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
                )

    def test_nonfinite_aggregate_ratio_and_inconsistent_last_ratio_fail(self):
        nonfinite = _diagnostics()
        nonfinite["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_true_residual_criterion"
        ]["maximum_tolerance_ratio"] = float("nan")
        inconsistent = _diagnostics()
        inconsistent["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_true_residual_criterion"
        ]["maximum_tolerance_ratio"] = 0.1
        for diagnostics in (nonfinite, inconsistent):
            with self.subTest(diagnostics=diagnostics), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
                )

    def test_exhausted_window_still_requires_every_shifted_solve(self):
        diagnostics = _diagnostics("k-25", method="fgmres")
        window = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0]
        window.update(unsupported_reason="no_positive_frequency_eigenpair_in_window",
                      stop_reason="window_exhausted", candidate_modes=12,
                      positive_frequency_candidates=10, frequency_window_candidates=0,
                      residual_evaluation_candidates=0, residual_rejections=0,
                      non_real_rotated_eigenvalues=0, eigenpair_evaluation_failures=0,
                      mode_vector_failures=0, potential_reconstruction_failures=0)
        with TemporaryDirectory() as tmp:
            self.assertEqual(validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k-25", "fgmres", "1e-9")["status"], "pass")
        for field in ("frequency_window_candidates", "residual_evaluation_candidates",
                      "residual_rejections", "non_real_rotated_eigenvalues",
                      "eigenpair_evaluation_failures", "mode_vector_failures",
                      "potential_reconstruction_failures"):
            for value in (1, None, False):
                with self.subTest(field=field, value=value), TemporaryDirectory() as tmp:
                    window[field] = value
                    with self.assertRaises(ValueError):
                        validate_shifted_ksp_trial(
                            _write_case(tmp, diagnostics), "k-25", "fgmres", "1e-9")
                    window[field] = 0
        window["ksp_true_residual_criterion"]["violation_count"] = 1
        with TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "criterion"):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k-25", "fgmres", "1e-9")

    def test_runtime_native_schema_preserves_all_solve_checks(self):
        diagnostics = _diagnostics("k-25", method="fgmres")
        diagnostics["schema_version"] = "frequency_domain_modal_solver_diagnostics.v1"
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k-25", "fgmres", "1e-9")
        self.assertEqual(report["status"], "pass")
        diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["subwindows"][0][
            "ksp_true_residual_criterion"]["violation_count"] = 1
        with TemporaryDirectory() as tmp, self.assertRaises(ValueError):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k-25", "fgmres", "1e-9")

    def test_unknown_or_missing_native_schema_is_rejected(self):
        for schema in (None, "future.v9", "eigen_spectrum.v3", [], {}):
            with self.subTest(schema=schema), TemporaryDirectory() as tmp:
                diagnostics = _diagnostics(method="fgmres")
                diagnostics["schema_version"] = schema
                with self.assertRaisesRegex(ValueError, "schema"):
                    validate_shifted_ksp_trial(
                        _write_case(tmp, diagnostics), "k2", "fgmres", "1e-9")

    def test_fgmres_accepts_null_breakdown_tolerance(self):
        diagnostics = _diagnostics(method="fgmres")
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k2", "fgmres", "1e-9"
            )
        self.assertEqual(report["status"], "pass")
        self.assertIsNone(report["by_sample"][0]["breakdown_tolerance"])

    def test_nearest_accepts_single_de_bv_positive_negative_gmres_and_fgmres(self):
        cases = (
            ("k2", "gmres", 30),
            ("k-10", "fgmres", None),
            ("k25", "gmres", 30),
            ("k-25", "gmres", 30),
            ("bv-k25", "fgmres", None),
            ("bv-k-25", "fgmres", None),
        )
        for sampling, method, requested_restart in cases:
            with self.subTest(sampling=sampling, method=method):
                diagnostics = _nearest_diagnostics(sampling, method=method)
                with TemporaryDirectory() as tmp:
                    report = validate_shifted_ksp_trial(
                        _write_case(tmp, diagnostics), sampling, method, "1e-9",
                        spectral_target="nearest",
                        target_frequency_hz=12.5e9,
                        gmres_restart=requested_restart,
                    )
                self.assertEqual(report["status"], "pass")
                self.assertEqual(report["qualification"], "NOT VERIFIED")
                self.assertEqual(report["selection_scope"], "selected_only")
                self.assertIs(report["window_complete"], False)
                self.assertEqual(report["target_frequency_hz"], 12.5e9)
                self.assertEqual(report["requested_target_frequency_hz"], 12.5e9)
                self.assertEqual(report["resolved_target_frequency_hz"], 12.5e9)
                self.assertEqual(report["sample_count"], 1)
                sample_report = report["by_sample"][0]
                self.assertIn("single_solve", sample_report)
                self.assertNotIn("subwindow_count", sample_report)
                self.assertNotIn("subwindows", sample_report)
                self.assertEqual(sample_report["gmres_restart"], 30)
                self.assertEqual(sample_report["target_frequency_hz"], 12.5e9)

    def test_nearest_requires_a_positive_strict_target_and_restart_integer(self):
        for target in (None, True, False, 0, -1, "12.5e9", float("nan"), float("inf")):
            with self.subTest(target=target), TemporaryDirectory() as tmp, \
                    self.assertRaisesRegex(ValueError, "target_frequency_hz"):
                validate_shifted_ksp_trial(
                    _write_case(tmp, _nearest_diagnostics()), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=target,
                )

        for restart in (True, False, 0, -1, 30.0, "30"):
            with self.subTest(restart=restart), TemporaryDirectory() as tmp, \
                    self.assertRaisesRegex(ValueError, "gmres_restart"):
                validate_shifted_ksp_trial(
                    _write_case(tmp, _nearest_diagnostics()), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                    gmres_restart=restart,
                )

    def test_nearest_rejects_zero_or_multi_sample_sampling(self):
        for sampling in (
            "k0", "bv-k0", "parallel-probe", "positive-six",
            "bv-positive-six", "two",
        ):
            with self.subTest(sampling=sampling), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                validate_shifted_ksp_trial(
                    _write_case(tmp, _nearest_diagnostics("k25")), sampling,
                    "gmres", "1e-9", spectral_target="nearest",
                    target_frequency_hz=12.5e9,
                )

    def test_nearest_binds_adapter_status_target_scope_and_requested_frequency(self):
        mutations = (
            ("adapter", {"solver_adapter": "slepc_modal_eigen"}),
            ("status", {"status": "solve_error"}),
            ("solve incomplete", {"solve_complete": False}),
            ("target kind", {"target_kind": "frequency_window"}),
            ("target frequency", {"target_frequency_hz": 12.6e9}),
            ("spectrum scope", {"spectrum_completeness": "complete"}),
            ("window complete", {"window_complete": True}),
        )
        for case, changes in mutations:
            with self.subTest(case=case), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                diagnostics = _nearest_diagnostics()
                diagnostics["sample_solver_diagnostics"][0]["diagnostics"].update(changes)
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                )

    def test_nearest_requires_indexed_sample_criterion_and_never_falls_back_to_global(self):
        missing_samples = _nearest_diagnostics()
        missing_samples["sample_solver_diagnostics"] = None
        missing_samples["ksp_true_residual_criterion"] = {
            "schema_version": CRITERION_SCHEMA,
            "reference_norm": "rhs_norm_zero_initial_guess",
            "solve_count": 1,
            "measured_count": 1,
            "violation_count": 0,
            "unavailable_count": 0,
            "maximum_tolerance_ratio": 0.5,
        }
        missing_criterion = _nearest_diagnostics()
        del missing_criterion["sample_solver_diagnostics"][0]["diagnostics"][
            "ksp_true_residual_criterion"]
        window_fallback = _nearest_diagnostics()
        sample = window_fallback["sample_solver_diagnostics"][0]["diagnostics"]
        criterion = sample.pop("ksp_true_residual_criterion")
        sample["subwindows"] = [{**_window(0), "ksp_true_residual_criterion": criterion}]
        for diagnostics in (missing_samples, missing_criterion, window_fallback):
            with self.subTest(diagnostics=diagnostics), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                )

    def test_nearest_rejects_duplicate_missing_and_invalid_sample_indices(self):
        duplicate = _nearest_diagnostics()
        duplicate["sample_solver_diagnostics"].append(
            duplicate["sample_solver_diagnostics"][0])
        missing = _nearest_diagnostics()
        missing["sample_solver_diagnostics"][0]["sample_index"] = 1
        invalid = _nearest_diagnostics()
        invalid["sample_solver_diagnostics"][0]["sample_index"] = True
        for diagnostics in (duplicate, missing, invalid):
            with self.subTest(diagnostics=diagnostics), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                )

    def test_nearest_binds_signed_axis_vector_and_rejects_subwindow_exception(self):
        diagnostics = _nearest_diagnostics("k-25")
        sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
        sample["k_vector_rad_m"] = [0.0, 25e6, 0.0]
        with TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "vector"):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k-25", "gmres", "1e-9",
                spectral_target="nearest", target_frequency_hz=12.5e9,
            )

        diagnostics = _nearest_diagnostics()
        sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
        sample["unsupported_reason"] = "no_positive_frequency_eigenpair_in_window"
        sample["subwindows"] = [_window(0)]
        with TemporaryDirectory() as tmp, self.assertRaises(ValueError):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                spectral_target="nearest", target_frequency_hz=12.5e9,
            )

    def test_nearest_rejects_window_exhausted_stop_reason_without_subwindows(self):
        diagnostics = _nearest_diagnostics()
        sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
        self.assertNotIn("subwindows", sample)
        self.assertNotIn("unsupported_reason", sample)
        sample["stop_reason"] = "window_exhausted"
        with TemporaryDirectory() as tmp, self.assertRaisesRegex(
            ValueError, "window exhausted stop reason"
        ):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                spectral_target="nearest", target_frequency_hz=12.5e9,
            )

    def test_nearest_binds_sample_global_and_requested_restart(self):
        for case, mutate, requested_restart in (
            ("sample mismatch", lambda d: d["sample_solver_diagnostics"][0]["diagnostics"].update(ksp_restart=31), None),
            ("global mismatch", lambda d: d.update(ksp_restart=True), None),
            ("cli mismatch", lambda d: None, 29),
        ):
            with self.subTest(case=case), TemporaryDirectory() as tmp, \
                    self.assertRaisesRegex(ValueError, "restart"):
                diagnostics = _nearest_diagnostics()
                mutate(diagnostics)
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                    gmres_restart=requested_restart,
                )

    def test_nearest_requires_available_consistent_eps_dimensions_and_positive_reasons(self):
        mutations = (
            ("dimensions unavailable", {"eps_dimensions_available": False}),
            ("missing nev", {"eps_nev": None}),
            ("boolean nev", {"eps_nev": True}),
            ("zero nev", {"eps_nev": 0}),
            ("ncv less than nev", {"eps_ncv": 1}),
            ("mpd greater than ncv", {"eps_mpd": 5}),
            ("negative EPS reason", {"eps_converged_reason": -1}),
            ("negative KSP reason", {"ksp_converged_reason": -2}),
            ("boolean EPS reason", {"eps_converged_reason": True}),
            ("boolean KSP reason", {"ksp_converged_reason": True}),
        )
        for case, changes in mutations:
            with self.subTest(case=case), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                diagnostics = _nearest_diagnostics()
                diagnostics["sample_solver_diagnostics"][0]["diagnostics"].update(changes)
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                )

    def test_nearest_keeps_true_residual_and_earlier_solve_criterion_authoritative(self):
        diagnostics = _nearest_diagnostics()
        sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
        sample["ksp_final_residual"] = 1.0
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                spectral_target="nearest", target_frequency_hz=12.5e9,
            )
        self.assertEqual(report["status"], "pass")

        for field, value in (
            ("violation_count", 1),
            ("unavailable_count", 1),
            ("maximum_tolerance_ratio", 1.1),
            ("measured_count", 1),
            ("solve_count", True),
        ):
            with self.subTest(field=field), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                diagnostics = _nearest_diagnostics()
                sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
                criterion = sample["ksp_true_residual_criterion"]
                criterion[field] = value
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                )

    def test_nearest_rejects_unavailable_telemetry_and_inconsistent_rhs_criterion(self):
        mutations = (
            {"ksp_diagnostics_available": False},
            {"ksp_last_true_residual_available": False},
            {"ksp_pc_side": None},
            {"ksp_norm_type": 0},
            {"ksp_last_true_residual_norm": None},
            {"ksp_last_rhs_norm": 0.0},
            {"ksp_true_residual_sample_count": 1},
            {"ksp_true_residual_measurement_failure_count": 1},
        )
        for changes in mutations:
            with self.subTest(changes=changes), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                diagnostics = _nearest_diagnostics()
                diagnostics["sample_solver_diagnostics"][0]["diagnostics"].update(changes)
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                )

        diagnostics = _nearest_diagnostics()
        sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
        sample["ksp_last_true_residual_norm"] = 2e-9
        sample["ksp_true_residual_criterion"]["maximum_tolerance_ratio"] = 1.0
        with TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "last true residual"):
            validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                spectral_target="nearest", target_frequency_hz=12.5e9,
            )

    def test_nearest_requires_consistent_true_residual_configuration_and_zero_pc_side(self):
        mutations = (
            ("missing pre-EPS config", {"shifted_ksp_configuration_before_eps": None}),
            ("wrong pre-EPS PC", {"shifted_ksp_configuration_before_eps": {
                "phase": "before_eps_solve", "pc_side": 0, "norm_type": 2}}),
            ("wrong post-EPS norm", {"ksp_norm_type": 1}),
            ("global atol mismatch", {"ksp_atol": 1e-40}),
            ("global type mismatch", {"ksp_type": "fgmres"}),
            ("global rtol mismatch", {"ksp_rtol": 2e-9}),
            ("breakdown mismatch", {"ksp_breakdown_tolerance": 0.3}),
        )
        for case, changes in mutations:
            with self.subTest(case=case), TemporaryDirectory() as tmp, \
                    self.assertRaises(ValueError):
                diagnostics = _nearest_diagnostics()
                diagnostics["sample_solver_diagnostics"][0]["diagnostics"].update(changes)
                validate_shifted_ksp_trial(
                    _write_case(tmp, diagnostics), "k25", "gmres", "1e-9",
                    spectral_target="nearest", target_frequency_hz=12.5e9,
                )

    def test_frequency_window_default_and_four_positional_arguments_remain_compatible(self):
        diagnostics = _diagnostics()
        with TemporaryDirectory() as tmp:
            report = validate_shifted_ksp_trial(
                _write_case(tmp, diagnostics), "k2", "gmres", "1e-9"
            )
        self.assertEqual(report["status"], "pass")
        self.assertNotIn("selection_scope", report)
        self.assertNotIn("window_complete", report)
        self.assertEqual(report["by_sample"][0]["subwindow_count"], 1)


if __name__ == "__main__":
    unittest.main()
