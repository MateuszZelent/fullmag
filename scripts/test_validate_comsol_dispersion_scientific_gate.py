"""Interpreted tests for the fail-closed COMSOL scientific gate."""

from __future__ import annotations

import csv
import hashlib
import json
import importlib.util
import math
import struct
from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_comsol_dispersion_scientific_gate as gate


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "packages/fullmag-py/src"))
PARAMETERS = REPO_ROOT / "docs/guides/comsol-dispersion-benchmark/parameters.json"
KPATH = REPO_ROOT / "docs/guides/comsol-dispersion-benchmark/kpath.csv"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def _native_mode_diagnostics(mode):
    """Synthetic values using the actual native modal diagnostics field names."""
    frequency = mode["frequency_real_hz"]
    mode.update({
        "phasor_convention": "exp_i_omega_t", "eigenvalue_mapping": "lambda_eq_i_omega",
        "eigenvalue_real": 0.0, "eigenvalue_imag": math.tau * frequency,
        "omega_rad_s": math.tau * frequency, "residual_absolute_l2": 1e-12,
        "residual_relative_l2": 1e-12, "residual_linf": 1e-12, "mass_norm": 1.0,
        "tangent_leakage_mean_abs": 0.0, "tangent_leakage_max_abs": 0.0,
        "gamma0_rad_s_per_A_m": 221100.0, "mu0_T_m_per_A": 1.2566370614359173e-6,
        "gamma_rad_s_T": 221100.0 / 1.2566370614359173e-6,
        "damping_rate_hz": 0.0, "linewidth_fwhm_hz": 0.0,
    })


def _native_metadata(case, mesh_id, airbox_m, requested_modes):
    config_path = REPO_ROOT / "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py"
    spec = importlib.util.spec_from_file_location("comsol_gate_fixture_config", config_path)
    config = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = config
    spec.loader.exec_module(config)
    guide = config.guide_metadata(next(c for c in config.available_cases() if c.key == case))
    guide["geometry"]["air_padding_each_side_m"] = airbox_m
    film_min, film_max = [-1e-7, -1e-7, -5e-9], [1e-7, 1e-7, 5e-9]
    nodes = [[x, y, z] for z in (film_min[2], film_max[2]) for y in (film_min[1], film_max[1]) for x in (film_min[0], film_max[0])]
    node_pairs = [
        {"pair_id": "x_faces", "node_a": index, "node_b": index + 1}
        for index in (0, 2, 4, 6)
    ] + [
        {"pair_id": "y_faces", "node_a": index, "node_b": index + 2}
        for index in (0, 1, 4, 5)
    ]
    demag = case != "c0"
    plan = {
        "kind": "fem_eigen", "mesh_name": mesh_id,
        "mesh": {"mesh_name": mesh_id, "nodes": nodes,
            "periodic_node_pairs": node_pairs,
            "periodic_boundary_pairs": [
                {"pair_id": "x_faces", "translation": [2e-7, 0.0, 0.0]},
                {"pair_id": "y_faces", "translation": [0.0, 2e-7, 0.0]},
            ]},
        "hmax": {"mesh-L1": 5e-9, "mesh-L2": 2.5e-9, "mesh-L3": 1.25e-9}.get(mesh_id, 5e-9), "fe_order": 1,
        "material": {"name": "Permalloy", "saturation_magnetisation": 800000.0,
            "exchange_stiffness": 1.3e-11, "damping": 0.5,
            "uniaxial_anisotropy": None, "anisotropy_axis": None},
        "gyromagnetic_ratio": 221100.0, "external_field": [79577.47154594767, 0.0, 0.0],
        "operator": {"kind": "full_2x2", "include_demag": demag},
        "enable_demag": demag, "enable_exchange": True,
        "equilibrium_magnetization": [[1.0, 0.0, 0.0] for _ in nodes],
        "damping_policy": "ignore", "count": requested_modes,
        "spin_wave_bc": {"kind": "floquet" if demag else "periodic", "pair_ids": ["x_faces", "y_faces"]},
        "demag_realization": "poisson_dirichlet" if demag else None,
        "air_box_config": {"factor": 1.0 + 2.0 * airbox_m / 1e-8,
            "grading": 1.4, "boundary_marker": 99, "bc_kind": "dirichlet"},
        "domain_frame": {"object_bounds_min": film_min, "object_bounds_max": film_max,
            "mesh_bounds_min": [-1e-7, -1e-7, -5e-9 - airbox_m],
            "mesh_bounds_max": [1e-7, 1e-7, 5e-9 + airbox_m]},
    }
    return {"problem_meta": {"runtime_metadata": {"comsol_nonzero_k_dispersion": guide}},
            "execution_plan": {"backend_plan": plan}}


def _write_mode_fields(root, samples):
    """Synthetic native-layout Bloch fields, not a FEM eigenmode calculation."""
    metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
    nodes = metadata["execution_plan"]["backend_plan"]["mesh"]["nodes"]
    for sample in samples:
        index = sample["sample_index"]
        if index not in (0, 10, 20, 40, 50, 60):
            continue
        k = sample["k_vector"]
        for mode in sample["modes"][:8]:
            raw = mode["raw_mode_index"]
            values = []
            for node in nodes:
                argument = sum(a * b for a, b in zip(k, node))
                phase = complex(math.cos(argument), -math.sin(argument))
                for value in (0j, phase, 1j * phase):
                    values.extend((value.real, value.imag))
            data = struct.pack(f"<{len(values)}d", *values)
            relative = f"eigen/mode_fields/sample_{index:04}/mode_{raw:04}/vector.bin"
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            _write_json(root / f"eigen/modes/sample_{index:04}/mode_{raw:04}.json", {
                "sample_index": index, "raw_mode_index": raw, "k_vector": k,
                "payload_encoding": "f64_interleaved_real_imag_xyz",
                "binary_layout": "complex_f64_pairs_little_endian",
                "component_basis": "global_xyz", "mode_field_sample_count": len(nodes),
                "source_mesh_identity": {"indexing": "full_domain_node_order", "node_count": len(nodes)},
                "compatibility_binary_payload_path": relative,
                "payload_sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
            })


def _write_native_context(root, case, mesh_id, airbox_m, requested_modes, samples):
    _write_json(root / "metadata.json", _native_metadata(case, mesh_id, airbox_m, requested_modes))
    _write_json(root / "eigen/diagnostics/solver.v1.json", {
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "solver_model": gate.PRODUCTION_SOLVER_MODEL, "production_native_solver_available": True,
        "validation_only": False, "complete": True, "status": "ready",
        "requested_mode_count": requested_modes,
        "sample_count": len(samples), "mode_count": sum(len(sample["modes"]) for sample in samples),
    })


def _canonical_path() -> list[dict[str, str]]:
    with KPATH.open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def _bundle_descriptor(case_dir: Path, root: str) -> dict[str, object]:
    relative_paths = {
        "metadata": f"{root}/metadata.json",
        "metadata": f"{root}/metadata.json",
        "diagnostics": f"{root}/eigen/diagnostics/solver.v1.json",
        "spectrum": f"{root}/eigen/spectrum.v2.json",
        "branches": f"{root}/eigen/branches.v2.json",
        "manifest": f"{root}/frequency_domain/manifest.v1.json",
        "diagnostics": f"{root}/eigen/diagnostics/solver.v1.json",
    }
    return {
        "root": root,
        "artifacts": {
            logical: {"path": path, "sha256": _sha256(case_dir / path)}
            for logical, path in relative_paths.items()
        },
    }


def _write_bundle(
    case_dir: Path,
    root: str,
    samples: list[dict[str, object]],
    branches: list[dict[str, object]],
    *,
    mesh_id: str,
    airbox_m: float,
    requested_modes: int,
) -> dict[str, object]:
    for sample in samples:
        for mode in sample["modes"]:
            _native_mode_diagnostics(mode)
    _write_native_context(case_dir / root, case_dir.name, mesh_id, airbox_m, requested_modes, samples)
    _write_json(case_dir / root / "eigen/spectrum.v2.json", {
        "schema_version": "eigen_spectrum.v2",
        "sample_count": len(samples),
        "mode_count": sum(len(sample["modes"]) for sample in samples),
        "samples": samples,
    })
    _write_json(case_dir / root / "eigen/branches.v2.json", {
        "schema_version": "eigen_branches.v2",
        "branches": branches,
    })
    _write_json(case_dir / root / "frequency_domain/manifest.v1.json", {
        "schema_version": "frequency_domain_manifest.v1",
        "resolved_execution": {"reference_or_production": "production"},
        "solver_model": "full_2x2_herring_kittel",
        "mesh_identity": mesh_id,
        "geometry": {"air_padding_each_side_m": airbox_m},
        "requested_mode_count": requested_modes,
        "validation": {
            "dispersion_frequency_source": gate.NUMERIC_FREQUENCY_SOURCE,
            "dynamic_demag_operator_source": "numeric_modal_solver",
        },
    })
    return _bundle_descriptor(case_dir, root)


def _scaled_payload(
    samples: list[dict[str, object]], branches: list[dict[str, object]], scale: float
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    scaled_samples = json.loads(json.dumps(samples))
    scaled_branches = json.loads(json.dumps(branches))
    for sample in scaled_samples:
        for mode in sample["modes"]:
            mode["frequency_real_hz"] *= scale
    for branch in scaled_branches:
        for point in branch["points"]:
            point["frequency_real_hz"] *= scale
    return scaled_samples, scaled_branches


def _evidence(
    case_dir: Path,
    case: str,
    base_artifacts: dict[str, str],
    *,
    ks_bv: dict[str, object] | None = None,
    ks_de: dict[str, object] | None = None,
    convergence_runs: dict[str, dict[str, object]] | None = None,
) -> dict[str, object]:
    sample_indices = gate.EXPECTED_CONTROL_SAMPLES if case in gate.PATH_CASES else (0,)
    bands = range(gate.EXPECTED_TARGET_BANDS if case in gate.PATH_CASES else 1)
    comparisons = [{"sample_index": sample, "branch_id": band} for sample in sample_indices for band in bands]
    runs = convergence_runs or {}
    convergence: dict[str, object] = {
        "mesh": {"status": "pass", "runs": {"coarse": runs.get("mesh_coarse"), "medium": runs.get("mesh_medium"), "fine": runs.get("mesh_fine")}, "comparisons": comparisons},
        "airbox": {"status": "pass", "runs": {"coarse": runs.get("airbox_coarse"), "medium": runs.get("airbox_medium"), "fine": runs.get("airbox_fine")}, "comparisons": comparisons},
        "mode_count": {"status": "pass", "baseline_requested_modes": 24, "check_requested_modes": 48, "runs": {"baseline": runs.get("modes_24"), "check": runs.get("modes_48")}, "comparisons": comparisons},
    }
    if case == "c0":
        convergence["airbox"] = {"status": "not_applicable", "reason": "C0 disables dynamic demagnetization by construction"}
    controls: dict[str, object] = {"kittel": {"status": "pass"}}
    if case == "c1":
        controls["kalinikos_slab_n0"] = {
            "status": "pass",
            "samples": [
                {"geometry": "backward_volume", "k_rad_per_m": 1.0e7, "sample_index": 0, "branch_id": 0, "run": ks_bv},
                {"geometry": "damon_eshbach", "k_rad_per_m": 1.0e7, "sample_index": 0, "branch_id": 0, "run": ks_de},
            ],
        }
    return {
        "schema_version": gate.EVIDENCE_SCHEMA,
        "case_id": case,
        "numeric_run": {"frequency_source": gate.NUMERIC_FREQUENCY_SOURCE, "analytic_solver_used_for_frequencies": False, "dynamic_demag_operator_source": "numeric_modal_solver"},
        "artifact_bindings": base_artifacts,
        "analytic_controls": controls,
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
    for sample in samples:
        for mode in sample["modes"]:
            _native_mode_diagnostics(mode)
    _write_native_context(case_dir, case, "mesh-L1", 2e-6, 24, samples)
    _write_json(case_dir / "eigen/spectrum.v2.json", {
        "schema_version": "eigen_spectrum.v2",
        "sample_count": len(samples),
        "mode_count": sum(len(sample["modes"]) for sample in samples),
        "samples": samples,
    })
    _write_json(case_dir / "eigen/branches.v2.json", {
        "schema_version": "eigen_branches.v2",
        "branches": branches,
    })
    dispersion = case_dir / "eigen/dispersion.csv"
    dispersion.parent.mkdir(parents=True, exist_ok=True)
    with dispersion.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["sample_index", "kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz", "raw_mode_index", "branch_id"])
        writer.writeheader()
        for sample in samples:
            for mode in sample["modes"]:
                writer.writerow({
                    "sample_index": sample["sample_index"],
                    "kx_rad_per_m": sample["k_vector"][0],
                    "ky_rad_per_m": sample["k_vector"][1],
                    "kz_rad_per_m": sample["k_vector"][2],
                    "frequency_hz": mode["frequency_real_hz"],
                    "raw_mode_index": mode["raw_mode_index"],
                    "branch_id": mode["raw_mode_index"],
                })
    _write_json(case_dir / "frequency_domain/manifest.v1.json", {
        "schema_version": "frequency_domain_manifest.v1",
        "resolved_execution": {"reference_or_production": "production"},
        "solver_model": "full_2x2_herring_kittel",
        "mesh_identity": "base-mesh",
        "geometry": {"air_padding_each_side_m": 2.0e-6},
        "validation": {
            "dispersion_frequency_source": gate.NUMERIC_FREQUENCY_SOURCE,
            "dynamic_demag_operator_source": "numeric_modal_solver",
        },
    })
    base_bindings = {
        "metadata_sha256": _sha256(case_dir / "metadata.json"),
        "solver_diagnostics_sha256": _sha256(case_dir / "eigen/diagnostics/solver.v1.json"),
        "spectrum_v2_sha256": _sha256(case_dir / "eigen/spectrum.v2.json"),
        "branches_v2_sha256": _sha256(case_dir / "eigen/branches.v2.json"),
        "dispersion_csv_sha256": _sha256(case_dir / "eigen/dispersion.csv"),
        "manifest_sha256": _sha256(case_dir / "frequency_domain/manifest.v1.json"),
    }
    ks_bv = ks_de = None
    convergence_runs: dict[str, dict[str, object]] = {}
    if case == "c1":
        parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
        bv_frequency = gate._kalinikos_frequency_hz(1.0e7, "backward_volume", parameters)
        de_frequency = gate._kalinikos_frequency_hz(1.0e7, "damon_eshbach", parameters)
        ks_samples = [{"sample_index": 0, "k_vector": [1.0e7, 0.0, 0.0], "modes": [{"raw_mode_index": 0, "frequency_real_hz": bv_frequency, "frequency_imag_hz": 0.0}]}]
        ks_branches = [{"branch_id": 0, "points": [{"sample_index": 0, "raw_mode_index": 0, "frequency_real_hz": bv_frequency, "frequency_imag_hz": 0.0}]}]
        ks_bv = _write_bundle(case_dir, "validation/ks/bv", ks_samples, ks_branches, mesh_id="ks-bv", airbox_m=2.0e-6, requested_modes=1)
        ks_samples_de = [{"sample_index": 0, "k_vector": [0.0, 1.0e7, 0.0], "modes": [{"raw_mode_index": 0, "frequency_real_hz": de_frequency, "frequency_imag_hz": 0.0}]}]
        ks_branches_de = [{"branch_id": 0, "points": [{"sample_index": 0, "raw_mode_index": 0, "frequency_real_hz": de_frequency, "frequency_imag_hz": 0.0}]}]
        ks_de = _write_bundle(case_dir, "validation/ks/de", ks_samples_de, ks_branches_de, mesh_id="ks-de", airbox_m=2.0e-6, requested_modes=1)
    for name, mesh_id, airbox, scale, modes in (("mesh_coarse", "mesh-L1", 2.0e-6, 1.0, 24), ("mesh_medium", "mesh-L2", 2.0e-6, 1.001, 24), ("mesh_fine", "mesh-L3", 2.0e-6, 1.00125, 24), ("airbox_coarse", "mesh-L1", 2.0e-6, 1.0, 24), ("airbox_medium", "mesh-L1", 4.0e-6, 1.001, 24), ("airbox_fine", "mesh-L1", 8.0e-6, 1.00125, 24), ("modes_24", "mesh-L1", 2.0e-6, 1.0, 24), ("modes_48", "mesh-L1", 2.0e-6, 1.001, 48)):
        scaled_samples, scaled_branches = _scaled_payload(samples, branches, scale)
        convergence_runs[name] = _write_bundle(case_dir, f"validation/convergence/{name}", scaled_samples, scaled_branches, mesh_id=mesh_id, airbox_m=airbox, requested_modes=modes)
    evidence = _evidence(case_dir, case, base_bindings, ks_bv=ks_bv, ks_de=ks_de, convergence_runs=convergence_runs)
    _write_json(case_dir / gate.EVIDENCE_RELATIVE_PATH, evidence)
    _write_mode_fields(case_dir, samples)
    return case_dir


class ScientificGateTests(unittest.TestCase):
    def test_comparison_label_cannot_override_missing_native_execution(self):
        for changes in ({"production_native_solver_available": False}, {"validation_only": True}):
            with self.subTest(changes=changes):
                manifest = {"validation": {
                    "dispersion_frequency_source": gate.NUMERIC_FREQUENCY_SOURCE,
                    "dynamic_demag_operator_source": "numeric_modal_solver",
                }}
                diagnostics = {"solver_model": gate.PRODUCTION_SOLVER_MODEL,
                    "production_native_solver_available": True, "validation_only": False, **changes}
                reasons = []
                result = gate._validate_numeric_source(manifest, diagnostics, "c1", reasons)
                self.assertEqual(result["status"], "fail")
                self.assertTrue(reasons)

    def test_csv_corruption_is_rejected_after_rebinding_current_file_hash(self):
        for defect in ("nan", "frequency_mismatch", "duplicate_mode", "k_mismatch"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                case_dir = _make_case(Path(directory), "c1")
                csv_path = case_dir / "eigen/dispersion.csv"
                with csv_path.open(encoding="utf-8", newline="") as stream:
                    reader = csv.DictReader(stream)
                    fields, rows = reader.fieldnames, list(reader)
                if defect == "nan":
                    rows[-1]["frequency_hz"] = "NaN"
                elif defect == "frequency_mismatch":
                    rows[-1]["frequency_hz"] = str(float(rows[-1]["frequency_hz"]) * 1.1)
                elif defect == "duplicate_mode":
                    rows[-1] = dict(rows[-2])
                else:
                    rows[-1]["kx_rad_per_m"] = "1234567"
                with csv_path.open("w", encoding="utf-8", newline="") as stream:
                    writer = csv.DictWriter(stream, fieldnames=fields)
                    writer.writeheader()
                    writer.writerows(rows)
                evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
                evidence["artifact_bindings"]["dispersion_csv_sha256"] = _sha256(csv_path)
                _write_json(evidence_path, evidence)
                report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                self.assertEqual(report["status"], "not_qualified")
                self.assertTrue(any("dispersion.csv" in reason for reason in report["reasons"]))
                self.assertFalse(any("binding does not match" in reason for reason in report["reasons"]))

    def test_rehashed_wrong_phase_is_not_qualified(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            metadata_path = case_dir / "eigen/modes/sample_0010/mode_0000.json"
            mode = json.loads(metadata_path.read_text(encoding="utf-8"))
            path = case_dir / mode["compatibility_binary_payload_path"]
            data = path.read_bytes()
            values = list(struct.unpack(f"<{len(data)//8}d", data))
            values[8] += 0.5
            data = struct.pack(f"<{len(values)}d", *values)
            path.write_bytes(data)
            mode["payload_sha256"] = "sha256:" + hashlib.sha256(data).hexdigest()
            _write_json(metadata_path, mode)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertTrue(any("phase residual" in reason for reason in report["reasons"]))
            self.assertFalse(any("payload_sha256 does not match" in reason for reason in report["reasons"]))

    def test_valid_gamma_field_cannot_substitute_for_nonzero_k_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            metadata_path = case_dir / "eigen/modes/sample_0010/mode_0000.json"
            mode = json.loads(metadata_path.read_text(encoding="utf-8"))
            values = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0] * mode["mode_field_sample_count"]
            data = struct.pack(f"<{len(values)}d", *values)
            (case_dir / mode["compatibility_binary_payload_path"]).write_bytes(data)
            mode["payload_sha256"] = "sha256:" + hashlib.sha256(data).hexdigest()
            mode["k_vector"] = [0.0, 0.0, 0.0]
            _write_json(metadata_path, mode)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertEqual(report["checks"]["modal_field_phase"]["status"], "fail")
            self.assertTrue(any("wavevector differs from the numeric spectrum" in reason for reason in report["reasons"]))
            self.assertFalse(any("phase residual" in reason for reason in report["reasons"]))

    def test_missing_modal_field_prevents_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            (case_dir / "eigen/mode_fields/sample_0010/mode_0000/vector.bin").unlink()
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertEqual(report["checks"]["modal_field_phase"]["status"], "fail")

    def test_convergence_keeps_target_and_finite_element_order_fixed(self):
        for vary, field, original_value, changed_value in (
            ("mode_count", "target", {"kind": "frequency_window", "frequency_min_hz": 1e6, "frequency_max_hz": 30e9}, {"kind": "frequency_window", "frequency_min_hz": 1e6, "frequency_max_hz": 40e9}),
            ("mesh", "fe_order", 1, 2),
        ):
            with self.subTest(vary=vary):
                original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
                original["execution_plan"]["backend_plan"][field] = original_value
                changed = json.loads(json.dumps(original))
                changed["execution_plan"]["backend_plan"][field] = changed_value
                self.assertNotEqual(gate._backend_signature(original, vary=vary), gate._backend_signature(changed, vary=vary))

    def test_primary_and_comparison_schema_versions_are_required(self):
        for scope in ("primary", "comparison"):
            for payload in ("spectrum", "branches", "manifest"):
                with self.subTest(scope=scope, payload=payload), tempfile.TemporaryDirectory() as directory:
                    case_dir = _make_case(Path(directory), "c1")
                    root = "" if scope == "primary" else "validation/convergence/mesh_medium"
                    relative = {"spectrum": "eigen/spectrum.v2.json", "branches": "eigen/branches.v2.json", "manifest": "frequency_domain/manifest.v1.json"}[payload]
                    artifact_path = case_dir / root / relative
                    data = json.loads(artifact_path.read_text(encoding="utf-8"))
                    data["schema_version"] = "unknown.v999"
                    _write_json(artifact_path, data)
                    evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
                    if scope == "comparison":
                        evidence["convergence"]["mesh"]["runs"]["medium"] = _bundle_descriptor(case_dir, root)
                    else:
                        binding = {"spectrum": "spectrum_v2_sha256", "branches": "branches_v2_sha256", "manifest": "manifest_sha256"}[payload]
                        evidence["artifact_bindings"][binding] = _sha256(artifact_path)
                    _write_json(evidence_path, evidence)
                    report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                    self.assertEqual(report["status"], "not_qualified")
                    self.assertTrue(any(f".{payload} requires schema_version" in reason for reason in report["reasons"]))
                    self.assertFalse(any("binding does not match" in reason or "SHA256 does not match" in reason for reason in report["reasons"]))

    def test_mode_count_comparison_cannot_change_mesh_resolution(self):
        original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        changed = _native_metadata("c1", "mesh-L2", 2e-6, 48)
        self.assertNotEqual(gate._backend_signature(original, vary="mode_count"), gate._backend_signature(changed, vary="mode_count"))

    def test_airbox_comparison_preserves_magnetic_geometry_and_hmax(self):
        original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        for defect in ("hmax", "magnetic_bounds"):
            with self.subTest(defect=defect):
                changed = json.loads(json.dumps(original))
                plan = changed["execution_plan"]["backend_plan"]
                if defect == "hmax":
                    plan["hmax"] *= 0.5
                else:
                    plan["domain_frame"]["object_bounds_max"][2] *= 2
                self.assertNotEqual(gate._backend_signature(original, vary="airbox"), gate._backend_signature(changed, vary="airbox"))

    def test_uniform_equilibrium_can_be_resampled_on_a_refined_mesh(self):
        original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        refined = _native_metadata("c1", "mesh-L2", 2e-6, 24)
        plan = refined["execution_plan"]["backend_plan"]
        plan["equilibrium_magnetization"] *= 2
        self.assertEqual(gate._backend_signature(original, vary="mesh"), gate._backend_signature(refined, vary="mesh"))
        plan["equilibrium_magnetization"][-1] = [0.0, 1.0, 0.0]
        self.assertNotEqual(gate._backend_signature(original, vary="mesh"), gate._backend_signature(refined, vary="mesh"))

    def test_airbox_identity_uses_resolved_bounds_not_authoring_factor(self):
        plan = _native_metadata("c1", "mesh-L1", 2e-6, 24)["execution_plan"]["backend_plan"]
        self.assertAlmostEqual(gate._backend_airbox_value(plan), 2e-6, delta=1e-18)
        plan["air_box_config"]["factor"] *= 10
        self.assertAlmostEqual(gate._backend_airbox_value(plan), 2e-6, delta=1e-18)
        plan.pop("domain_frame")
        self.assertIsNone(gate._backend_airbox_value(plan))

    def test_two_levels_cannot_qualify_mesh_or_airbox_convergence(self):
        for key in ("mesh", "airbox"):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                case_dir = _make_case(Path(directory), "c1")
                path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                evidence = json.loads(path.read_text(encoding="utf-8"))
                evidence["convergence"][key]["runs"].pop("medium", None)
                _write_json(path, evidence)
                report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                self.assertEqual(report["status"], "not_qualified")
                self.assertEqual(report["checks"][f"{key}_convergence"]["status"], "fail")
                self.assertTrue(any(f"convergence.{key}" in reason and "three" in reason for reason in report["reasons"]))

    def test_three_level_convergence_rejects_reused_or_reversed_levels(self):
        for key in ("mesh", "airbox"):
            for defect in ("reused", "reversed"):
                with self.subTest(key=key, defect=defect), tempfile.TemporaryDirectory() as directory:
                    case_dir = _make_case(Path(directory), "c1")
                    path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                    evidence = json.loads(path.read_text(encoding="utf-8"))
                    runs = evidence["convergence"][key]["runs"]
                    if defect == "reused":
                        runs["medium"] = runs["coarse"]
                    else:
                        runs["medium"], runs["fine"] = runs["fine"], runs["medium"]
                    _write_json(path, evidence)
                    report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                    self.assertEqual(report["checks"][f"{key}_convergence"]["status"], "fail")
                    self.assertEqual(report["status"], "not_qualified")

    def test_small_but_growing_refinement_increments_are_not_convergence(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(path.read_text(encoding="utf-8"))
            samples = json.loads((case_dir / "eigen/spectrum.v2.json").read_text(encoding="utf-8"))["samples"]
            branches = json.loads((case_dir / "eigen/branches.v2.json").read_text(encoding="utf-8"))["branches"]
            samples, branches = _scaled_payload(samples, branches, 1.004)
            evidence["convergence"]["mesh"]["runs"]["fine"] = _write_bundle(
                case_dir, "validation/convergence/mesh_fine", samples, branches,
                mesh_id="mesh-L3", airbox_m=2e-6, requested_modes=24,
            )
            _write_json(path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertEqual(report["checks"]["mesh_convergence"]["status"], "fail")
            self.assertTrue(any("increments grow" in reason for reason in report["reasons"]))
            self.assertTrue(all(check["status"] == "pass" for check in report["checks"]["mesh_convergence"]["adjacent_comparisons"]))

    def test_all_cases_have_executable_positive_numeric_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            results = {}
            for case in ("c0", "c1", "a1"):
                with self.subTest(case=case):
                    results[case] = gate.validate_case(
                        _make_case(Path(directory), case), case,
                        parameters_path=PARAMETERS, kpath_path=KPATH,
                    )
                    self.assertEqual(results[case]["status"], "qualified", results[case]["reasons"][:8])
            self.assertEqual(gate.validate_requested_cases(results, ("c0", "c1", "a1"))["status"], "qualified")

    def test_resolved_spatial_material_override_cannot_claim_homogeneous_ks(self):
        metadata = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        metadata["execution_plan"]["backend_plan"]["material"]["ms_field"] = [800000.0, 1600000.0]
        reasons = []
        self.assertFalse(gate._validate_benchmark_metadata(
            metadata, "c1", json.loads(PARAMETERS.read_text(encoding="utf-8")),
            "inhomogeneous fixture", reasons, require_uniform_slab=True,
        ), "spatial Ms overrides the scalar and invalidates the homogeneous-film oracle")

    def test_canonical_guide_metadata_matches_resolved_c1_without_validation_toggle(self):
        metadata = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        self.assertNotIn("dispersion_validation", metadata["execution_plan"]["backend_plan"])
        reasons = []
        self.assertTrue(gate._validate_benchmark_metadata(
            metadata, "c1", json.loads(PARAMETERS.read_text(encoding="utf-8")),
            "canonical fixture", reasons, require_uniform_slab=True,
        ), reasons)
        self.assertEqual(reasons, [])

    def test_canonical_metadata_cannot_hide_changed_resolved_gamma(self):
        metadata = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        metadata["execution_plan"]["backend_plan"]["gyromagnetic_ratio"] *= 2.0
        reasons = []
        self.assertFalse(gate._validate_benchmark_metadata(
            metadata, "c1", json.loads(PARAMETERS.read_text(encoding="utf-8")),
            "canonical fixture", reasons, require_uniform_slab=True,
        ))
        self.assertTrue(any("gyromagnetic_ratio" in reason for reason in reasons))

    def test_full_c1_numeric_case_qualifies_only_with_bound_controls_and_convergence(self):
        with tempfile.TemporaryDirectory() as directory:
            report = gate.validate_case(
                _make_case(Path(directory), "c1"),
                "c1",
                parameters_path=PARAMETERS,
                kpath_path=KPATH,
            )
        self.assertEqual(report["status"], "qualified", report["reasons"][:12])
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
            evidence["artifact_bindings"]["manifest_sha256"] = _sha256(manifest_path)
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
            evidence["artifact_bindings"]["branches_v2_sha256"] = _sha256(branches_path)
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
