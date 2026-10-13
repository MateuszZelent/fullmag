import math
import unittest
import csv
import copy
import hashlib
import json
import importlib.util
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
from compare_de_100nm_pilot import compare_branch, reference, read_modes, finite_airbox_gamma_hz, load_comparison_input
from de_pilot_receipts import read_required_artifact_bytes


def bind_dispersion_artifact(result, case_dir):
    payload = (case_dir / "eigen/dispersion.csv").read_bytes()
    artifacts = result.setdefault("artifacts", {})
    artifacts.setdefault("case", result.get("pilot"))
    artifacts.setdefault("required_artifacts", ["eigen/dispersion.csv"])
    artifacts.setdefault("required_artifact_hashes", {})["eigen/dispersion.csv"] = {
        "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def write_spectrum_v3(path, rows, residual=1.78e-14):
    samples = []
    for row in rows:
        sample_index = row["sample_index"]
        full = row["ky_rad_per_m"] == 0.0
        mode = {
            "sample_index": sample_index,
            "raw_mode_index": row["raw_mode_index"],
            "frequency_hz": row["frequency_hz"],
            "residual_relative_l2": residual,
            "block_residuals": {
                "eps_q": residual,
                "eps_phi": residual,
                "eps_gauge": 0.0,
                "eps_full": residual if full else None,
                "eps_reduced": None if full else residual,
                "certification_tolerance": 1e-8,
                "scope": "native_descriptor" if full else "reduced_original_blocks_only",
                "certified": full,
                "reduced_pencil_certified": not full,
                "full_descriptor_certified": full,
            },
        }
        samples.append({"sample_index": sample_index,
                        "sample_id": f"k-sample-{sample_index:04}",
                        "modes": [mode]})
    path.write_text(json.dumps({"schema_version": "eigen_spectrum.v3",
                                "sample_count": len(samples),
                                "samples": samples}))

class ComparisonTests(unittest.TestCase):
    def test_csv_requires_complete_finite_de_sampling(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "dispersion.csv"
            rows = [dict(sample_index=i, raw_mode_index=0, branch_id=2,
                         kx_rad_per_m=0, ky_rad_per_m=k*1e6, kz_rad_per_m=0,
                         frequency_hz=reference(k*1e6), residual_norm=1e-9)
                    for i,k in enumerate(range(-40,41,10))]
            def write():
                with path.open("w", newline="") as stream:
                    writer=csv.DictWriter(stream,fieldnames=list(rows[0]))
                    writer.writeheader();writer.writerows(rows)
            write()
            self.assertEqual(len(read_modes(path)),9)
            rows[0]["frequency_hz"] = float("nan")
            write()
            with self.assertRaises(ValueError):
                read_modes(path)
            rows[0]["frequency_hz"] = reference(-40e6)
            rows.pop()
            write()
            with self.assertRaises(ValueError):
                read_modes(path)

    def test_read_modes_uses_supplied_payload_after_csv_path_tamper(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "dispersion.csv"
            original_rows = [dict(
                sample_index=0,
                raw_mode_index=0,
                branch_id=2,
                kx_rad_per_m=0,
                ky_rad_per_m=2e6,
                kz_rad_per_m=0,
                frequency_hz=reference(2e6),
                residual_norm="",
            )]
            with path.open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=list(original_rows[0]))
                writer.writeheader()
                writer.writerows(original_rows)
            verified_payload = path.read_bytes()
            write_spectrum_v3(path.parent / "spectrum.v3.json", original_rows)

            tampered_rows = [dict(original_rows[0])]
            tampered_rows[0]["frequency_hz"] += 1e6
            with path.open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=list(tampered_rows[0]))
                writer.writeheader()
                writer.writerows(tampered_rows)
            self.assertNotEqual(path.read_bytes(), verified_payload)

            result = read_modes(path, (2e6,), payload=verified_payload)

            self.assertEqual(result[0]["frequency_hz"], original_rows[0]["frequency_hz"])

    def test_csv_joins_relative_residual_from_native_spectrum_v3(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "dispersion.csv"
            rows = [dict(sample_index=i, raw_mode_index=0, branch_id=2,
                         kx_rad_per_m=0, ky_rad_per_m=k,
                         kz_rad_per_m=0, frequency_hz=reference(k), residual_norm="")
                    for i, k in enumerate((0.0, 2e6))]
            with path.open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
            write_spectrum_v3(path.parent / "spectrum.v3.json", rows)

            result = read_modes(path, (0.0, 2e6))

            self.assertEqual(result[0]["residual_norm"], None)
            self.assertEqual(result[1]["residual_relative_l2"], 1.78e-14)
            self.assertEqual(result[1]["residual_scope"], "reduced_original_blocks_only")

    def test_csv_cannot_omit_a_mode_present_in_native_spectrum(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "dispersion.csv"
            rows = [dict(sample_index=0, raw_mode_index=0, branch_id=0,
                         kx_rad_per_m=0, ky_rad_per_m=2e6, kz_rad_per_m=0,
                         frequency_hz=reference(2e6), residual_norm="")]
            with path.open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
            spectrum_path = path.parent / "spectrum.v3.json"
            write_spectrum_v3(spectrum_path, rows)
            spectrum = json.loads(spectrum_path.read_text())
            extra = {**spectrum["samples"][0]["modes"][0], "raw_mode_index": 1}
            spectrum["samples"][0]["modes"].append(extra)
            spectrum_path.write_text(json.dumps(spectrum))
            with self.assertRaisesRegex(ValueError, "mode coverage"):
                read_modes(path, (2e6,))

    def test_smoke_comparison_reads_model_and_rejects_mismatches(self):
        with TemporaryDirectory() as tmp:
            run = Path(tmp)
            case = run/"de-smoke-k2"
            (case/"eigen").mkdir(parents=True)
            identity = {"model_sha256": "a"*64, "job": {"job_id": "b"*32},
                        "source": {"snapshot_sha256": "c"*64}}
            request = {**identity, "schema": "fullmag.de-smoke.request.v1", "sampling": "k2"}
            result = {**identity, "schema": "fullmag.de-smoke.result.v1", "pilot": "de-smoke-k2",
                      "status": "completed_unqualified", "return_code": 0}
            model = {"schema": "fullmag.de-smoke.v1", "sampling": "k2",
                     "orientation": "M0=x,k=y,normal=z", "outer_boundary_kind": "poisson_dirichlet",
                     "film_thickness_m": 10e-9, "air_padding_each_side_m": 2e-6,
                     "saturation_magnetization_a_per_m": 800000, "exchange_stiffness_j_per_m": 13e-12,
                     "external_induction_t": .1, "mu0_t_m_a": 4 * math.pi * 1e-7,
                     "gamma0_m_per_a_s": 221100., "ky_rad_per_m": [2e6]}
            metadata = {"problem_meta": {"runtime_metadata": {"de_smoke": model}}}
            (run/"run-request.json").write_text(json.dumps(request))
            (run/"run-result.json").write_text(json.dumps(result))
            def write_metadata():
                (case/"metadata.json").write_text(json.dumps(metadata))
            write_metadata()
            (case/"eigen/dispersion.csv").write_text(
                "sample_index,raw_mode_index,branch_id,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz,residual_norm\n"
                "0,0,0,0,2000000,0,9720000000,1e-12\n")
            expected_dispersion_bytes = (case/"eigen/dispersion.csv").read_bytes()
            bind_dispersion_artifact(result, case)
            (run/"run-result.json").write_text(json.dumps(result))
            # Operator-probe validation has its own suite; this fixture exercises
            # model selection, identity and numerical CSV mapping only.
            with patch("validate_de_smoke_rows.validate_rows") as validation, \
                    patch("compare_de_100nm_pilot.read_modes", wraps=read_modes) as mode_parser:
                loaded = load_comparison_input(run)
                validation.assert_called_once()
                self.assertEqual(
                    validation.call_args.kwargs["verified_csv_bytes"],
                    expected_dispersion_bytes,
                )
                self.assertEqual(
                    mode_parser.call_args.kwargs["payload"],
                    expected_dispersion_bytes,
                )
                parameters, ks, padding = loaded[2:5]
                self.assertEqual(parameters["film_thickness_m"], 10e-9)
                self.assertEqual(ks, (2e6,))
                self.assertEqual(padding, 2e-6)
                self.assertAlmostEqual(reference(2e6, parameters)/1e9, 9.725724284, places=7)
                self.assertNotAlmostEqual(reference(2e6, parameters)/1e9, reference(2e6)/1e9, places=3)
                self.assertEqual(len(compare_branch(loaded[1], 0, parameters, ks)), 1)
                model["schema"] = "unknown"
                write_metadata()
                with self.assertRaises(ValueError):
                    load_comparison_input(run)
                model["schema"] = "fullmag.de-smoke.v1"
                del model["film_thickness_m"]
                write_metadata()
                with self.assertRaisesRegex(ValueError, "film_thickness_m"):
                    load_comparison_input(run)
                model["film_thickness_m"] = 10e-9
                model["ky_rad_per_m"] = [3e6]
                write_metadata()
                with self.assertRaisesRegex(ValueError, "sampling metadata mismatch"):
                    load_comparison_input(run)
                result["status"] = "failed"
                (run/"run-result.json").write_text(json.dumps(result))
                with self.assertRaisesRegex(ValueError, "completed managed"):
                    load_comparison_input(run)
                result["status"] = "completed_unqualified"
                result["source"] = {"snapshot_sha256": "f"*64}
                (run/"run-result.json").write_text(json.dumps(result))
                with self.assertRaisesRegex(ValueError, "identity mismatch"):
                    load_comparison_input(run)

    def test_dispersion_csv_must_match_exact_run_result_binding_before_parse(self):
        with TemporaryDirectory() as tmp:
            run = Path(tmp)
            pilot = "de-smoke-k2"
            case = run / pilot
            (case / "eigen").mkdir(parents=True)
            identity = {"model_sha256": "a" * 64, "job": {"job_id": "b" * 32},
                        "source": {"snapshot_sha256": "c" * 64}}
            request = {**identity, "schema": "fullmag.de-smoke.request.v1", "sampling": "k2"}
            result = {**identity, "schema": "fullmag.de-smoke.result.v1", "pilot": pilot,
                      "status": "completed_unqualified", "return_code": 0}
            model = {"schema": "fullmag.de-smoke.v1", "sampling": "k2",
                     "orientation": "M0=x,k=y,normal=z", "outer_boundary_kind": "poisson_dirichlet",
                     "film_thickness_m": 10e-9, "air_padding_each_side_m": 2e-6,
                     "saturation_magnetization_a_per_m": 800000,
                     "exchange_stiffness_j_per_m": 13e-12, "external_induction_t": .1,
                     "mu0_t_m_a": 4 * math.pi * 1e-7, "gamma0_m_per_a_s": 221100.,
                     "ky_rad_per_m": [2e6]}
            metadata = {"problem_meta": {"runtime_metadata": {"de_smoke": model}}}
            (run / "run-request.json").write_text(json.dumps(request))
            (case / "metadata.json").write_text(json.dumps(metadata))
            source = case / "eigen/dispersion.csv"
            source.write_text(
                "sample_index,raw_mode_index,branch_id,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz,residual_norm\n"
                "0,0,0,0,2000000,0,9720000000,1e-12\n"
            )
            original_bytes = source.read_bytes()
            bind_dispersion_artifact(result, case)
            bound_digest = result["artifacts"]["required_artifact_hashes"][
                "eigen/dispersion.csv"
            ]["sha256"]
            baseline_result = copy.deepcopy(result)
            (run / "run-result.json").write_text(json.dumps(result))

            with patch("validate_de_smoke_rows.validate_rows"):
                loaded = load_comparison_input(run)
            self.assertEqual(loaded[-1], bound_digest)
            self.assertEqual(
                read_required_artifact_bytes(result, run, pilot, "eigen/dispersion.csv"),
                original_bytes,
            )

            for mutation in ("missing", "wrong-path", "changed-size", "same-size-edit"):
                with self.subTest(mutation=mutation):
                    result = copy.deepcopy(baseline_result)
                    source.write_bytes(original_bytes)
                    hashes = result["artifacts"]["required_artifact_hashes"]
                    if mutation == "missing":
                        result["artifacts"].pop("required_artifact_hashes")
                    elif mutation == "wrong-path":
                        result["artifacts"]["required_artifact_hashes"] = {
                            "eigen/other.csv": hashes["eigen/dispersion.csv"]
                        }
                    elif mutation == "changed-size":
                        hashes["eigen/dispersion.csv"]["size"] += 1
                    else:
                        tampered_bytes = original_bytes.replace(
                            b"9720000000", b"9720000001", 1
                        )
                        self.assertEqual(len(tampered_bytes), len(original_bytes))
                        source.write_bytes(tampered_bytes)
                    (run / "run-result.json").write_text(json.dumps(result))

                    with patch("validate_de_smoke_rows.validate_rows") as validate_rows, \
                            patch("compare_de_100nm_pilot.read_modes") as parse_modes:
                        with self.assertRaisesRegex(ValueError, "required artifact"):
                            load_comparison_input(run)
                    validate_rows.assert_not_called()
                    parse_modes.assert_not_called()

    def test_supported_de_sampling_includes_k25_and_rejects_bv(self):
        from validate_de_smoke_rows import SAMPLING
        for sampling in ("k25", "k-25", "bv-k25", "unknown"):
            with self.subTest(sampling=sampling), TemporaryDirectory() as tmp:
                run = Path(tmp)
                pilot = "de-smoke-" + sampling
                case = run / pilot
                (case / "eigen").mkdir(parents=True)
                identity = {"model_sha256": "a" * 64, "job": {"job_id": "b" * 32},
                            "source": {"snapshot_sha256": "c" * 64}}
                request = {**identity, "schema": "fullmag.de-smoke.request.v1", "sampling": sampling}
                result = {**identity, "schema": "fullmag.de-smoke.result.v1", "pilot": pilot,
                          "status": "completed_unqualified", "return_code": 0}
                ks = SAMPLING.get(sampling, (25e6,))
                model = {"schema": "fullmag.de-smoke.v1", "sampling": sampling,
                         "orientation": "M0=x,k=y,normal=z", "outer_boundary_kind": "poisson_dirichlet",
                         "film_thickness_m": 10e-9, "air_padding_each_side_m": 2e-6,
                         "saturation_magnetization_a_per_m": 800000, "exchange_stiffness_j_per_m": 13e-12,
                         "external_induction_t": .1, "mu0_t_m_a": 4 * math.pi * 1e-7,
                         "gamma0_m_per_a_s": 221100., "ky_rad_per_m": list(ks)}
                (run / "run-request.json").write_text(json.dumps(request))
                (run / "run-result.json").write_text(json.dumps(result))
                (case / "metadata.json").write_text(json.dumps(
                    {"problem_meta": {"runtime_metadata": {"de_smoke": model}}}))
                (case / "eigen/dispersion.csv").write_text(
                    "sample_index,raw_mode_index,branch_id,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz,residual_norm\n"
                    f"0,0,0,0,{ks[0]},0,13578981798.831879,1e-12\n")
                bind_dispersion_artifact(result, case)
                (run / "run-result.json").write_text(json.dumps(result))
                # Probe validation is independently covered; this regression tests routing.
                with patch("validate_de_smoke_rows.validate_rows"):
                    if sampling.startswith("bv-") or sampling == "unknown":
                        with self.assertRaisesRegex(ValueError, "Unsupported DE pilot"):
                            load_comparison_input(run)
                    else:
                        loaded = load_comparison_input(run)
                        self.assertEqual(loaded[3], ks)
                        self.assertEqual(loaded[2]["film_thickness_m"], 10e-9)
                        self.assertAlmostEqual(reference(ks[0], loaded[2]) / 1e9,
                                               13.67386817535, places=7)

    def test_nearest_alias_is_selected_only_and_validates_native_contract(self):
        with TemporaryDirectory() as tmp:
            run = Path(tmp)
            pilot = "de-smoke-nearest-k2"
            case = run / pilot
            (case / "eigen").mkdir(parents=True)
            identity = {"model_sha256": "a" * 64, "job": {"job_id": "b" * 32},
                        "source": {"snapshot_sha256": "c" * 64}}
            request = {**identity, "schema": "fullmag.de-smoke.request.v1",
                       "sampling": "k2", "modal_target": "nearest",
                       "spectral_target": "nearest", "target_frequency_hz": 12.5e9}
            result = {**identity, "schema": "fullmag.de-smoke.result.v1",
                      "pilot": pilot, "status": "completed_unqualified", "return_code": 0}
            model = {"schema": "fullmag.de-smoke.v1", "sampling": "k2",
                     "orientation": "M0=x,k=y,normal=z", "outer_boundary_kind": "poisson_dirichlet",
                     "film_thickness_m": 10e-9, "air_padding_each_side_m": 2e-6,
                     "saturation_magnetization_a_per_m": 800000, "exchange_stiffness_j_per_m": 13e-12,
                     "external_induction_t": .1, "mu0_t_m_a": 4 * math.pi * 1e-7,
                     "gamma0_m_per_a_s": 221100., "ky_rad_per_m": [2e6],
                     "modal_target": "nearest", "target_frequency_hz": 12.5e9,
                     "selection_scope": "selected_only", "window_complete": False}
            (run / "run-request.json").write_text(json.dumps(request))
            (run / "run-result.json").write_text(json.dumps(result))
            (case / "metadata.json").write_text(json.dumps(
                {"problem_meta": {"runtime_metadata": {"de_smoke": model}}}))
            (case / "eigen/dispersion.csv").write_text(
                "sample_index,raw_mode_index,branch_id,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz,residual_norm\n"
                "0,0,0,0,2000000,0,12500000000,1e-12\n")
            bind_dispersion_artifact(result, case)
            (run / "run-result.json").write_text(json.dumps(result))
            with patch("validate_de_smoke_rows.validate_rows") as rows_validation, \
                    patch("compare_de_100nm_pilot.validate_selected_only_diagnostics") as native_validation:
                loaded = load_comparison_input(run)
            rows_validation.assert_called_once()
            self.assertEqual(rows_validation.call_args.kwargs["selection_scope"], "selected_only")
            self.assertEqual(
                rows_validation.call_args.kwargs["verified_csv_bytes"],
                (case/"eigen/dispersion.csv").read_bytes(),
            )
            native_validation.assert_called_once()
            self.assertEqual(loaded[3], (2e6,))

    def test_numerical_sample_indices_cannot_swap_wavevectors(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp)/"dispersion.csv"
            path.write_text(
                "sample_index,raw_mode_index,branch_id,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz,residual_norm\n"
                "0,0,0,0,2000000,0,9700000000,1e-12\n"
                "1,0,0,0,0,0,9300000000,1e-12\n")
            with self.assertRaisesRegex(ValueError, "declared sample"):
                read_modes(path, (0, 2e6))

    @unittest.skipUnless(importlib.util.find_spec("matplotlib"), "plotting requires matplotlib")
    def test_two_point_plot_writes_metadata_parameters_and_unqualified_report(self):
        import compare_de_100nm_pilot as comparison
        with TemporaryDirectory() as tmp:
            run = Path(tmp)
            source = run/"dispersion.csv"
            metadata = run/"metadata.json"
            source.write_text("synthetic rendering fixture, not a FEM result")
            metadata.write_text("{}")
            parameters = {**comparison.PARAMETERS, "film_thickness_m": 10e-9}
            ks = (0.0, 2e6)
            rows = [{"sample_index": i, "raw_mode_index": 0, "branch_id": 0,
                     "kx_rad_per_m": 0., "ky_rad_per_m": k, "kz_rad_per_m": 0.,
                     "frequency_hz": reference(k, parameters), "residual_norm": 1e-12,
                     "residual_scope": "native_descriptor" if i == 0 else "reduced_original_blocks_only",
                     "residual_relative_l2": 1e-10 if i == 0 else 1e-9}
                    for i, k in enumerate(ks)]
            request = {"model_sha256": "a"*64, "job": {"job_id": "b"*32}}
            receipt_bound_sha256 = "f" * 64
            loaded = (request, rows, parameters, ks, 2e-6, source, metadata,
                      receipt_bound_sha256)
            with patch.object(comparison, "load_comparison_input", return_value=loaded):
                self.assertEqual(comparison.main([str(run), "--branch-id", "0"]), 0)
            output = run/"analytic-comparison"
            report = json.loads((output/"comparison.json").read_text())
            self.assertEqual(report["qualification"], "NOT VERIFIED")
            self.assertEqual(report["dispersion_sha256"], receipt_bound_sha256)
            self.assertEqual(report["parameters_from_metadata"]["film_thickness_m"], 10e-9)
            self.assertEqual(report["mode_rows"], 2)
            self.assertEqual(report["max_abs_relative_difference"], 0.)
            self.assertEqual(report["residual_scope"], "mixed")
            self.assertEqual(report["residual_scope_counts"],
                             {"native_descriptor": 1, "reduced_original_blocks_only": 1})
            self.assertEqual(report["max_relative_residual_l2_by_scope"],
                             {"native_descriptor": 1e-10, "reduced_original_blocks_only": 1e-9})
            self.assertGreater((output/"dispersion.png").stat().st_size, 1000)
            self.assertTrue((output/"dispersion.pdf").read_bytes().startswith(b"%PDF"))
            self.assertEqual(len((output/"branch-comparison.csv").read_text().splitlines()), 3)

    def test_finite_airbox_control_is_distinct_and_converges(self):
        finite = finite_airbox_gamma_hz()
        self.assertAlmostEqual(finite/1e9,9.205971992409074,places=9)
        self.assertLess(finite,finite_airbox_gamma_hz(4e-6))
        self.assertLess(finite_airbox_gamma_hz(4e-6),reference(0))
        self.assertAlmostEqual(finite_airbox_gamma_hz(1.0)/reference(0),1.0,places=7)

    def test_gamma_and_reciprocity(self):
        expected=221100/(2*math.pi)*math.sqrt((.1/(4e-7*math.pi))*(.1/(4e-7*math.pi)+800000))
        self.assertAlmostEqual(reference(0),expected,places=4)
        self.assertEqual(reference(-40e6),reference(40e6))

    def test_no_automatic_branch_substitution(self):
        rows=[dict(branch_id=4,ky_rad_per_m=k*1e6,frequency_hz=reference(k*1e6)) for k in range(-40,41,10)]
        with self.assertRaises(ValueError):
            compare_branch(rows,3)
        self.assertEqual(len(compare_branch(rows,4)),9)

    def test_partial_branch_is_rejected(self):
        with self.assertRaises(ValueError):
            compare_branch([dict(branch_id=4,ky_rad_per_m=0,frequency_hz=reference(0))],4)

if __name__ == "__main__":
    unittest.main()
