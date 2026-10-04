"""Interpreted regressions for the K0 common-Krylov query receipt."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unittest

import de_gamma_krylov_trial as trial


SOLVER_ADAPTER = "k0_poisson_airbox_cpu_schur_slepc"
ENGINE_ID = "native_fem.frequency_domain.k0_poisson_airbox_cpu_schur_slepc.v1"


def _query(**updates):
    value = {
        "phase": "queried_after_eps",
        "eps_tolerance": 1e-9,
        "eps_max_iterations": None,
        "shifted_ksp_type": "fgmres",
        "shifted_ksp_rtol": 1e-9,
        "shifted_ksp_max_iterations": 100,
        "shifted_ksp_restart": 8,
    }
    value.update(updates)
    return value


def _gamma_sample(query=None, *, vector=(0.0, 0.0, 0.0)):
    query = copy.deepcopy(query or _query())
    certificate = {
        "schema_version": "poisson_airbox_frequency_window_certificate.v1",
        "base_schedule": {"planned_subwindow_count": 16},
        "refinement_schedule": {"planned_subwindow_count": 34},
    }
    subwindows = [
        {
            "pass": pass_name,
            "subwindow_index": index,
            "status": "ok",
            "modal_krylov_tuning": copy.deepcopy(query),
        }
        for pass_name, count in (("base", 16), ("refinement", 34))
        for index in range(count)
    ]
    return {
        "solver_adapter": SOLVER_ADAPTER,
        "engine_id": ENGINE_ID,
        "k_vector_len": 3,
        "k_vector_rad_m": list(vector),
        "q_dof_count": 4,
        "modal_krylov_tuning": copy.deepcopy(query),
        "window_certificate": certificate,
        "subwindows": subwindows,
    }


def _diagnostics(sampling="k0"):
    query = _query()
    root = {
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
    }
    gamma = _gamma_sample(query)
    wavevectors = trial.SAMPLING[sampling]
    if len(wavevectors) == 1 and wavevectors == (0.0,):
        root.update({
            "q_dof_count": 4,
            "modal_krylov_tuning": copy.deepcopy(query),
            **gamma,
        })
    else:
        root.update({
            "solver_adapter": "floquet_airbox_cpu_schur_slepc",
            "engine_id": "native_fem.frequency_domain.floquet_airbox_cpu_schur_slepc.v1",
            "ksp_type": "gmres",
            "ksp_rtol": 1e-9,
        })
        records = []
        for index, wavevector in enumerate(wavevectors):
            if wavevector == 0.0:
                sample_diagnostics = gamma
            else:
                sample_diagnostics = {"k_vector_rad_m": [0.0, wavevector, 0.0]}
            records.append({"sample_index": index, "diagnostics": sample_diagnostics})
        root["sample_solver_diagnostics"] = records
    return root


def _write_case(root, diagnostics):
    path = Path(root) / "eigen" / "diagnostics" / "solver.v1.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(diagnostics, allow_nan=True), encoding="utf-8")
    return path.parents[2]


def _replace_all_queries(diagnostics, query):
    diagnostics["modal_krylov_tuning"] = copy.deepcopy(query)
    records = diagnostics.get("sample_solver_diagnostics")
    if records is not None:
        for record in records:
            sample = record["diagnostics"]
            if sample.get("solver_adapter") == SOLVER_ADAPTER:
                sample["modal_krylov_tuning"] = copy.deepcopy(query)
                for window in sample.get("subwindows", []):
                    window["modal_krylov_tuning"] = copy.deepcopy(query)
    else:
        diagnostics["solver_adapter"] = SOLVER_ADAPTER
        diagnostics["engine_id"] = ENGINE_ID
        diagnostics["modal_krylov_tuning"] = copy.deepcopy(query)
        for window in diagnostics.get("subwindows", []):
            window["modal_krylov_tuning"] = copy.deepcopy(query)


def _indexed_gamma_diagnostics():
    diagnostics = _diagnostics()
    diagnostics.update({
        "solver_adapter": SOLVER_ADAPTER,
        "engine_id": ENGINE_ID,
        "q_dof_count": 4,
        "modal_krylov_tuning": _query(),
        "sample_solver_diagnostics": [
            {"sample_index": 0, "diagnostics": _gamma_sample()}
        ],
    })
    return diagnostics


def _queries_by_level(diagnostics):
    sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
    return {
        "global": [diagnostics["modal_krylov_tuning"]],
        "sample": [sample["modal_krylov_tuning"]],
        "window": [sample["subwindows"][0]["modal_krylov_tuning"]],
    }


def _all_krylov_queries(diagnostics):
    sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
    return [
        diagnostics["modal_krylov_tuning"],
        sample["modal_krylov_tuning"],
        *(window["modal_krylov_tuning"] for window in sample["subwindows"]),
    ]


def _set_all_eps_dimensions(diagnostics, dimensions):
    for query in _all_krylov_queries(diagnostics):
        query["eps_dimensions"] = copy.deepcopy(dimensions)


def _eps_dimensions(*, query_succeeded=True, nev=0, ncv=4, mpd=-1):
    return {
        "query_succeeded": query_succeeded,
        "nev": nev,
        "ncv": ncv,
        "mpd": mpd,
    }


class GammaKrylovTrialTests(unittest.TestCase):
    def _validate(self, case_dir, sampling="k0", **kwargs):
        return trial.validate_gamma_krylov_trial(
            case_dir,
            sampling,
            "fgmres",
            "1e-9",
            eps_prefilter="1e-9",
            gmres_restart="10",
            **kwargs,
        )

    def test_standalone_gamma_accepts_exact_after_eps_query(self):
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, _diagnostics())
            report = self._validate(case)
            self.assertEqual(report["schema"], "k0_common_krylov_configuration_trial.v1")
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["qualification"], "NOT VERIFIED")
            self.assertEqual(report["by_sample"][0]["subwindow_count"], 50)
            self.assertEqual(report["by_sample"][0]["subwindows"][0]["shifted_ksp_restart"], 8)

    def test_mixed_sampling_maps_only_indexed_gamma_record(self):
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, _diagnostics("two"))
            report = self._validate(case, sampling="two")
            self.assertEqual(list(report["by_sample"]), [0])
            self.assertEqual(report["by_sample"][0]["k_vector_rad_m"], [0.0, 0.0, 0.0])

    def test_legacy_payload_keeps_eps_dimensions_absent_from_report(self):
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, _diagnostics())
            report = self._validate(case)
            self.assertNotIn("eps_dimensions", report)
            sample = report["by_sample"][0]
            self.assertNotIn("eps_dimensions", sample)
            self.assertNotIn("eps_dimensions", sample["subwindows"][0])

    def test_global_sample_and_window_dimensions_are_preserved_independently(self):
        diagnostics = _indexed_gamma_diagnostics()
        global_dimensions = _eps_dimensions(nev=0, ncv=-1, mpd=-(2 ** 63))
        sample_dimensions = _eps_dimensions(
            nev=(2 ** 63) - 1, ncv=-(2 ** 63), mpd=0
        )
        window_dimensions = _eps_dimensions(nev=3, ncv=11, mpd=-7)
        queries = _queries_by_level(diagnostics)
        queries["global"][0]["eps_dimensions"] = global_dimensions
        queries["sample"][0]["eps_dimensions"] = sample_dimensions
        queries["window"][0]["eps_dimensions"] = window_dimensions

        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            report = self._validate(case)
            sample = report["by_sample"][0]
            self.assertEqual(report["eps_dimensions"], global_dimensions)
            self.assertEqual(sample["eps_dimensions"], sample_dimensions)
            self.assertEqual(sample["subwindows"][0]["eps_dimensions"], window_dimensions)

    def test_failed_dimensions_query_with_null_values_is_preserved(self):
        diagnostics = _indexed_gamma_diagnostics()
        dimensions = _eps_dimensions(
            query_succeeded=False, nev=None, ncv=None, mpd=None
        )
        _set_all_eps_dimensions(diagnostics, dimensions)

        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            report = self._validate(case)
            self.assertEqual(report["qualification"], "NOT VERIFIED")
            self.assertEqual(report["eps_dimensions"], dimensions)
            self.assertEqual(report["by_sample"][0]["eps_dimensions"], dimensions)
            self.assertEqual(
                report["by_sample"][0]["subwindows"][0]["eps_dimensions"],
                dimensions,
            )

    def test_subwindow_dimensions_may_differ_and_are_retained(self):
        diagnostics = _indexed_gamma_diagnostics()
        sample = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
        sample["modal_krylov_tuning"]["eps_dimensions"] = _eps_dimensions(
            nev=4, ncv=8, mpd=12
        )
        for window in sample["subwindows"]:
            window["modal_krylov_tuning"]["eps_dimensions"] = _eps_dimensions(
                nev=4, ncv=8, mpd=12
            )
        window_dimensions = _eps_dimensions(nev=2, ncv=6, mpd=9)
        sample["subwindows"][1]["modal_krylov_tuning"][
            "eps_dimensions"
        ] = window_dimensions

        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            report = self._validate(case)
            windows = report["by_sample"][0]["subwindows"]
            self.assertEqual(
                windows[0]["eps_dimensions"],
                _eps_dimensions(nev=4, ncv=8, mpd=12),
            )
            self.assertEqual(windows[1]["eps_dimensions"], window_dimensions)

    def test_mixed_sweep_does_not_invent_global_dimensions(self):
        diagnostics = _diagnostics("two")
        dimensions = _eps_dimensions(nev=0, ncv=-1, mpd=-3)
        gamma = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
        gamma["modal_krylov_tuning"]["eps_dimensions"] = copy.deepcopy(dimensions)
        for window in gamma["subwindows"]:
            window["modal_krylov_tuning"]["eps_dimensions"] = copy.deepcopy(dimensions)

        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            report = self._validate(case, sampling="two")
            self.assertNotIn("eps_dimensions", report)
            self.assertEqual(report["by_sample"][0]["eps_dimensions"], dimensions)

    def test_malformed_eps_dimensions_fail_at_global_sample_and_window_paths(self):
        base = _eps_dimensions()
        cases = [
            ("null object", None, " must be an object"),
            ("scalar object", 7, " must be an object"),
            ("array object", [], " must be an object"),
        ]
        for field in ("query_succeeded", "nev", "ncv", "mpd"):
            missing = copy.deepcopy(base)
            del missing[field]
            cases.append((f"missing {field}", missing, f".{field} is missing"))
        extra = copy.deepcopy(base)
        extra["unexpected"] = 1
        cases.append(("extra key", extra, " has unexpected key 'unexpected'"))
        for invalid_status in (1.0, "true", 1):
            malformed = copy.deepcopy(base)
            malformed["query_succeeded"] = invalid_status
            cases.append(
                (
                    f"invalid status {invalid_status!r}",
                    malformed,
                    ".query_succeeded must be a boolean",
                )
            )
        for invalid_dimension in (True, 1.0, "1"):
            malformed = copy.deepcopy(base)
            malformed["nev"] = invalid_dimension
            cases.append(
                (
                    f"invalid NEV {invalid_dimension!r}",
                    malformed,
                    ".nev must be an integer when query_succeeded is true",
                )
            )
        malformed = copy.deepcopy(base)
        malformed["mpd"] = None
        cases.append(
            (
                "null dimension after successful query",
                malformed,
                ".mpd must be an integer when query_succeeded is true",
            )
        )
        malformed = _eps_dimensions(
            query_succeeded=False, nev=None, ncv=3, mpd=None
        )
        cases.append(
            (
                "non-null dimension after failed query",
                malformed,
                ".ncv must be null when query_succeeded is false",
            )
        )
        for label, dimension in (
            ("above signed int64", 2 ** 63),
            ("below signed int64", -(2 ** 63) - 1),
        ):
            malformed = copy.deepcopy(base)
            malformed["mpd"] = dimension
            cases.append((label, malformed, ".mpd must be within signed 64-bit range"))

        path_prefixes = {
            "global": "global.modal_krylov_tuning",
            "sample": "sample 0.modal_krylov_tuning",
            "window": "sample 0 subwindow 0.modal_krylov_tuning",
        }
        for level, path_prefix in path_prefixes.items():
            for label, malformed, error_suffix in cases:
                with self.subTest(level=level, malformed=label), TemporaryDirectory() as tmp:
                    diagnostics = _indexed_gamma_diagnostics()
                    _set_all_eps_dimensions(diagnostics, base)
                    query = _queries_by_level(diagnostics)[level][0]
                    query["eps_dimensions"] = copy.deepcopy(malformed)
                    case = _write_case(tmp, diagnostics)
                    error_path = re.escape(
                        f"{path_prefix}.eps_dimensions{error_suffix}"
                    )
                    with self.assertRaisesRegex(ValueError, error_path):
                        self._validate(case)

    def test_mixed_sampling_rejects_missing_or_duplicate_gamma_indices(self):
        for mutation in ("missing", "duplicate"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as tmp:
                diagnostics = _diagnostics("two")
                if mutation == "missing":
                    diagnostics["sample_solver_diagnostics"] = [
                        diagnostics["sample_solver_diagnostics"][1]
                    ]
                else:
                    diagnostics["sample_solver_diagnostics"].append(
                        copy.deepcopy(diagnostics["sample_solver_diagnostics"][0])
                    )
                case = _write_case(tmp, diagnostics)
                with self.assertRaises(ValueError):
                    self._validate(case, sampling="two")

    def test_standalone_indexed_gamma_compares_its_own_global_k0_query(self):
        diagnostics = _diagnostics()
        sample = _gamma_sample()
        diagnostics.update({
            "solver_adapter": SOLVER_ADAPTER,
            "engine_id": ENGINE_ID,
            "q_dof_count": 4,
            "modal_krylov_tuning": _query(eps_max_iterations=20),
            "sample_solver_diagnostics": [{"sample_index": 0, "diagnostics": sample}],
        })
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            with self.assertRaisesRegex(ValueError, "disagrees with the sample/global"):
                self._validate(case)

    def test_sample_requires_real_native_solver_adapter_identity(self):
        mutations = ("missing_adapter", "wrong_adapter", "solver_model_only")
        for mutation in mutations:
            with self.subTest(mutation=mutation), TemporaryDirectory() as tmp:
                diagnostics = _diagnostics()
                if mutation == "missing_adapter":
                    diagnostics.pop("solver_adapter")
                elif mutation == "wrong_adapter":
                    diagnostics["solver_adapter"] = "slepc_modal_eigen"
                else:
                    diagnostics.pop("solver_adapter")
                    diagnostics["solver_model"] = SOLVER_ADAPTER
                case = _write_case(tmp, diagnostics)
                with self.assertRaisesRegex(ValueError, "solver_adapter"):
                    self._validate(case)

    def test_gamma_record_rejects_nonzero_native_vector(self):
        diagnostics = _diagnostics()
        diagnostics["k_vector_rad_m"] = [0.0, 1.0, 0.0]
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            with self.assertRaisesRegex(ValueError, "Gamma point"):
                self._validate(case)

    def test_malformed_query_categories_fail_closed(self):
        cases = (
            ("type", {"shifted_ksp_type": "preonly"}),
            ("norm", {"shifted_ksp_rtol": float("nan")}),
            ("budget", {"shifted_ksp_max_iterations": 0}),
            ("phase", {"phase": "configured_before_eps"}),
        )
        for label, update in cases:
            with self.subTest(label=label), TemporaryDirectory() as tmp:
                diagnostics = _diagnostics()
                malformed = _query(**update)
                _replace_all_queries(diagnostics, malformed)
                case = _write_case(tmp, diagnostics)
                with self.assertRaises(ValueError):
                    self._validate(case)

    def test_subwindow_query_must_be_after_eps_and_match_sample(self):
        diagnostics = _diagnostics()
        diagnostics["subwindows"][17]["modal_krylov_tuning"]["phase"] = "configured_before_eps"
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            with self.assertRaisesRegex(ValueError, "queried_after_eps"):
                self._validate(case)

    def test_restart_is_clamped_to_split_q_dimension(self):
        diagnostics = _diagnostics()
        clamped = _query(shifted_ksp_restart=7)
        _replace_all_queries(diagnostics, clamped)
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            with self.assertRaisesRegex(ValueError, "clamped request"):
                self._validate(case)

    def test_restart_request_clamps_to_two_q_dofs(self):
        diagnostics = _diagnostics()
        _replace_all_queries(diagnostics, _query(shifted_ksp_restart=8))
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            report = self._validate(case)
            self.assertEqual(report["requested_gmres_restart"], 10)
            self.assertEqual(report["by_sample"][0]["subwindows"][0]["shifted_ksp_restart"], 8)

    def test_local_subwindow_indices_are_scoped_by_pass(self):
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, _diagnostics())
            report = self._validate(case)
            windows = report["by_sample"][0]["subwindows"]
            self.assertEqual(len(windows), 50)
            self.assertEqual((windows[0]["pass"], windows[0]["subwindow_index"]), ("base", 0))
            self.assertEqual((windows[16]["pass"], windows[16]["subwindow_index"]), ("refinement", 0))

    def test_subwindow_indices_match_each_declared_native_schedule(self):
        for mutation in ("duplicate_base", "missing_refinement_tail", "missing_refinement_pass"):
            with self.subTest(mutation=mutation), TemporaryDirectory() as tmp:
                diagnostics = _diagnostics()
                if mutation == "duplicate_base":
                    diagnostics["subwindows"][1]["subwindow_index"] = 0
                elif mutation == "missing_refinement_tail":
                    diagnostics["subwindows"].pop()
                else:
                    diagnostics["subwindows"] = [
                        window for window in diagnostics["subwindows"] if window["pass"] == "base"
                    ]
                case = _write_case(tmp, diagnostics)
                with self.assertRaises(ValueError):
                    self._validate(case)

    def test_legacy_payload_without_after_eps_query_is_rejected(self):
        diagnostics = _diagnostics()
        diagnostics.pop("modal_krylov_tuning")
        diagnostics["subwindows"] = []
        with TemporaryDirectory() as tmp:
            case = _write_case(tmp, diagnostics)
            with self.assertRaises(ValueError):
                self._validate(case)


if __name__ == "__main__":
    unittest.main()
