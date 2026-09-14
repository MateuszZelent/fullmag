"""Interpreted tests for the fail-closed COMSOL scientific gate."""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
import tempfile
import unittest


import validate_comsol_dispersion_scientific_gate as gate


REPO_ROOT = Path(__file__).resolve().parents[1]
PARAMETERS = REPO_ROOT / "docs/guides/comsol-dispersion-benchmark/parameters.json"
KPATH = REPO_ROOT / "docs/guides/comsol-dispersion-benchmark/kpath.csv"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def _canonical_path() -> list[dict[str, str]]:
    with KPATH.open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def _evidence(case_dir: Path, case: str) -> dict[str, object]:
    expected_pairs = [
        {"sample_index": sample, "band_index": band,
         "reference_frequency_hz": 10.0e9,
         "refined_frequency_hz": 10.0e9 * 1.001}
        for sample in (gate.EXPECTED_CONTROL_SAMPLES if case in gate.PATH_CASES else (0,))
        for band in range(gate.EXPECTED_TARGET_BANDS if case in gate.PATH_CASES else 1)
    ]
    for item in expected_pairs:
        item["relative_change"] = gate._relative_error(
            item["reference_frequency_hz"], item["refined_frequency_hz"]
        )
    convergence: dict[str, object] = {
        "mesh": {
            "status": "pass",
            "coarse": "L1",
            "fine": "L2",
            "comparisons": expected_pairs,
        },
        "airbox": {
            "status": "pass",
            "coarse": "2um",
            "fine": "4um",
            "comparisons": expected_pairs,
        },
        "mode_count": {
            "status": "pass",
            "baseline_requested_modes": 24,
            "check_requested_modes": 48,
            "comparisons": expected_pairs,
        },
    }
    if case == "c0":
        convergence["airbox"] = {
            "status": "not_applicable",
            "reason": "C0 disables dynamic demagnetization by construction",
        }
    return {
        "schema_version": gate.EVIDENCE_SCHEMA,
        "case_id": case,
        "numeric_run": {
            "frequency_source": "numeric_modal_solver",
            "analytic_solver_used_for_frequencies": False,
            "dynamic_demag_operator_source": "numeric_modal_solver",
        },
        "artifact_bindings": {
            "eigen/spectrum.v2.json": "unused",
            "eigen/branches.v2.json": "unused",
            "eigen/dispersion.csv": "unused",
            "frequency_domain/manifest.v1.json": "unused",
        },
        "analytic_controls": {
            "kittel": {"status": "pass"},
            "kalinikos_slab_n0": {
                "status": "pass",
                "samples": [
                    {"geometry": "backward_volume", "k_rad_per_m": 0.0,
                     "observed_frequency_hz": 9.309813711433355e9},
                    {"geometry": "damon_eshbach", "k_rad_per_m": 1.0e7,
                     "observed_frequency_hz": 0.0},
                ],
            },
        },
        "convergence": convergence,
    }


def _make_case(root: Path, case: str = "c1") -> Path:
    case_dir = root / case
    path_rows = _canonical_path()
    parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
    samples: list[dict[str, object]] = []
    branches: list[dict[str, object]] = [
        {"branch_id": band, "label": f"band_{band}", "points": []}
        for band in range(gate.EXPECTED_TARGET_BANDS)
    ]
    for index, row in enumerate(path_rows if case in gate.PATH_CASES else [path_rows[0]]):
        k = tuple(float(row[key]) for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
        if case == "c0":
            frequencies = [parameters["controls_infinite_film_hz"]["no_demag_gamma"] + band * 1.0e8 for band in range(gate.EXPECTED_TARGET_BANDS)]
        elif index == 0:
            frequencies = [parameters["controls_finite_dirichlet_box"]["with_demag_gamma_hz"] + band * 1.0e8 for band in range(gate.EXPECTED_TARGET_BANDS)]
        else:
            frequencies = [
                (gate._kalinikos_frequency_hz(abs(k[0]), "backward_volume", parameters) or 10.0e9) + band * 1.0e8
                for band in range(gate.EXPECTED_TARGET_BANDS)
            ]
        modes = [
            {"raw_mode_index": band, "frequency_real_hz": frequency, "frequency_imag_hz": 0.0}
            for band, frequency in enumerate(frequencies)
        ]
        samples.append({"sample_index": index, "k_vector": list(k), "modes": modes})
        for band, frequency in enumerate(frequencies):
            branches[band]["points"].append({
                "sample_index": index,
                "raw_mode_index": band,
                "frequency_real_hz": frequency,
                "frequency_imag_hz": 0.0,
                "tracking_confidence": 1.0,
            })
    _write_json(case_dir / "eigen/spectrum.v2.json", {
        "schema_version": "eigen_spectrum.v2",
        "sample_count": len(samples),
        "mode_count": gate.EXPECTED_TARGET_BANDS,
        "samples": samples,
    })
    _write_json(case_dir / "eigen/branches.v2.json", {
        "schema_version": "eigen_branches.v2",
        "branches": branches,
    })
    dispersion = case_dir / "eigen/dispersion.csv"
    dispersion.parent.mkdir(parents=True, exist_ok=True)
    with dispersion.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["sample_index", "kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz"])
        writer.writeheader()
        for sample in samples:
            for mode in sample["modes"]:
                writer.writerow({
                    "sample_index": sample["sample_index"],
                    "kx_rad_per_m": sample["k_vector"][0],
                    "ky_rad_per_m": sample["k_vector"][1],
                    "kz_rad_per_m": sample["k_vector"][2],
                    "frequency_hz": mode["frequency_real_hz"],
                })
    _write_json(case_dir / "frequency_domain/manifest.v1.json", {
        "schema_version": "frequency_domain_manifest.v1",
        "solver_model": "full_2x2_herring_kittel",
        "validation": {
            "dispersion_frequency_source": "numeric_modal_solver",
            "dynamic_demag_operator_source": "numeric_modal_solver",
        },
    })
    evidence = _evidence(case_dir, case)
    bindings = evidence["artifact_bindings"]
    bindings["eigen/spectrum.v2.json"] = _sha256(case_dir / "eigen/spectrum.v2.json")
    bindings["eigen/branches.v2.json"] = _sha256(case_dir / "eigen/branches.v2.json")
    bindings["eigen/dispersion.csv"] = _sha256(case_dir / "eigen/dispersion.csv")
    bindings["frequency_domain/manifest.v1.json"] = _sha256(case_dir / "frequency_domain/manifest.v1.json")
    _write_json(case_dir / gate.EVIDENCE_RELATIVE_PATH, evidence)
    return case_dir


class ScientificGateTests(unittest.TestCase):
    def test_full_c1_numeric_case_qualifies_only_with_bound_controls_and_convergence(self):
        with tempfile.TemporaryDirectory() as directory:
            report = gate.validate_case(
                _make_case(Path(directory), "c1"),
                "c1",
                parameters_path=PARAMETERS,
                kpath_path=KPATH,
            )
        self.assertEqual(report["status"], "qualified", report["reasons"])
        self.assertEqual(report["checks"]["tracked_branches"]["target_band_count"], 8)
        self.assertEqual(report["checks"]["spectrum_samples"]["sample_count"], 61)
        self.assertEqual(report["checks"]["kalinikos_slab_n0"]["status"], "pass")

    def test_missing_evidence_is_unqualified_with_explicit_reasons(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            (case_dir / gate.EVIDENCE_RELATIVE_PATH).unlink()
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("missing scientific evidence bundle" in reason for reason in report["reasons"]))
        self.assertTrue(any("missing convergence.mesh" in reason for reason in report["reasons"]))

    def test_analytic_frequency_source_cannot_qualify_numeric_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            manifest_path = case_dir / "frequency_domain/manifest.v1.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["validation"]["dispersion_frequency_source"] = "analytic_reference_model"
            _write_json(manifest_path, manifest)
            evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            evidence["artifact_bindings"]["frequency_domain/manifest.v1.json"] = _sha256(manifest_path)
            _write_json(evidence_path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("analytic reference is declared" in reason for reason in report["reasons"]))

    def test_incomplete_path_or_branch_is_rejected_even_with_nonempty_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            branches_path = case_dir / "eigen/branches.v2.json"
            branches = json.loads(branches_path.read_text(encoding="utf-8"))
            branches["branches"][0]["points"].pop()
            _write_json(branches_path, branches)
            evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            evidence["artifact_bindings"]["eigen/branches.v2.json"] = _sha256(branches_path)
            _write_json(evidence_path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("complete tracked branches" in reason for reason in report["reasons"]))

    def test_partial_case_selection_cannot_be_promoted(self):
        result = gate.validate_requested_cases({"c1": {"status": "qualified", "reasons": []}}, ("c1",))
        self.assertEqual(result["status"], "not_qualified")
        self.assertIn("requires cases c0,c1,a1", result["reasons"][0])


if __name__ == "__main__":
    unittest.main()
