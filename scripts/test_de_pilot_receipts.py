"""Receipt regression fixtures are not numerical FEM evidence."""
import copy
import hashlib
import json
from pathlib import Path
from unittest.mock import patch
from tempfile import TemporaryDirectory
import unittest
from de_pilot_receipts import (
    verify_required_artifact_hash,
    read_required_artifact_bytes,
    validate_de_pilot_receipts,
)


def receipts(pilot="de-smoke-k0"):
    schema = "de100-pilot" if pilot == "de100" else "de-smoke"
    identity = {"model_sha256": "a" * 64, "job": {"job_id": "b" * 32},
                "source": {"source_digest": "c" * 64}}
    request = {**copy.deepcopy(identity), "schema": f"fullmag.{schema}.request.v1",
               "cases": [pilot], "operation": pilot + "-numerical-pilot"}
    result = {**copy.deepcopy(identity), "schema": f"fullmag.{schema}.result.v1",
              "pilot": pilot, "status": "completed_unqualified", "return_code": 0}
    return request, result


class ReceiptTests(unittest.TestCase):
    def test_accepts_legacy_and_separately_bound_models(self):
        for pilot in ("de100", "de-smoke-k0", "de-smoke-k2"):
            request, result = receipts(pilot)
            validate_de_pilot_receipts(request, result, pilot)
            request["model_source"] = {"commit": "d" * 40}
            result["model_source"] = copy.deepcopy(request["model_source"])
            validate_de_pilot_receipts(request, result, pilot)

    def test_rejects_boolean_float_and_unsuccessful_exit_codes(self):
        for code in (False, True, 0.0, "0", None, 1):
            with self.subTest(code=code):
                request, result = receipts()
                result["return_code"] = code
                with self.assertRaisesRegex(ValueError, "completed managed"):
                    validate_de_pilot_receipts(request, result, "de-smoke-k0")

    def test_rejects_changed_or_one_sided_model_source(self):
        for bad in ({"commit": "e" * 40}, None, {}, False):
            with self.subTest(bad=bad):
                request, result = receipts()
                request["model_source"] = {"commit": "d" * 40}
                if bad is not None:
                    result["model_source"] = bad
                with self.assertRaisesRegex(ValueError, "model_source"):
                    validate_de_pilot_receipts(request, result, "de-smoke-k0")
        request, result = receipts()
        result["model_source"] = {"commit": "d" * 40}
        with self.assertRaisesRegex(ValueError, "model_source"):
            validate_de_pilot_receipts(request, result, "de-smoke-k0")

    def test_rejects_mismatched_receipt_and_case_identity(self):
        changes = [("result", "pilot", "de-smoke-k2"),
                   ("result", "schema", "fullmag.de100-pilot.result.v1"),
                   ("result", "source", {}), ("result", "job", {"job_id": "e" * 32}),
                   ("request", "model_sha256", None),
                   ("request", "cases", ["de-smoke-k2"]),
                   ("request", "operation", "de-smoke-k2-numerical-pilot")]
        for side, key, value in changes:
            with self.subTest(side=side, key=key):
                request, result = receipts()
                (request if side == "request" else result)[key] = value
                with self.assertRaises(ValueError):
                    validate_de_pilot_receipts(request, result, "de-smoke-k0")

    def test_comparison_entrypoint_rejects_bad_receipt_before_artifact_access(self):
        from compare_de_100nm_pilot import main
        for code in (False, 0.0):
            with self.subTest(code=code), TemporaryDirectory() as directory:
                request, result = receipts("de100")
                result["return_code"] = code
                root = Path(directory)
                (root / "run-request.json").write_text(json.dumps(request))
                (root / "run-result.json").write_text(json.dumps(result))
                with self.assertRaisesRegex(ValueError, "completed managed"):
                    main([str(root)])
                self.assertFalse((root / "analytic-comparison").exists())
        with TemporaryDirectory() as directory:
            request, result = receipts("de100")
            request["model_source"] = {"commit": "d" * 40}
            result["model_source"] = {"commit": "e" * 40}
            root = Path(directory)
            (root / "run-request.json").write_text(json.dumps(request))
            (root / "run-result.json").write_text(json.dumps(result))
            with self.assertRaisesRegex(ValueError, "model_source"):
                main([str(root)])
            self.assertFalse((root / "analytic-comparison").exists())

    def test_legacy_request_without_case_fields_is_supported(self):
        request, result = receipts("de100")
        del request["cases"], request["operation"]
        validate_de_pilot_receipts(request, result, "de100")

    def test_streaming_hash_reads_large_artifacts_in_bounded_chunks(self):
        with TemporaryDirectory() as tmp:
            run = Path(tmp)
            artifact = run / "de100" / "large.bin"
            artifact.parent.mkdir()
            payload = b"verified" * (300_000)
            artifact.write_bytes(payload)
            expected = {"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            result = {"artifacts": {"required_artifact_hashes": {"large.bin": expected}}}
            sizes = []
            original_open = Path.open
            class ObservedStream:
                def __init__(self, stream): self.stream = stream
                def __enter__(self): return self
                def __exit__(self, *args): self.stream.close()
                def fileno(self): return self.stream.fileno()
                def read(self, size):
                    sizes.append(size)
                    return self.stream.read(size)
            def observed_open(path, *args, **kwargs):
                return ObservedStream(original_open(path, *args, **kwargs))
            with patch.object(Path, "open", observed_open):
                self.assertEqual(verify_required_artifact_hash(result, run, "de100", "large.bin"), expected)
            self.assertGreater(len(sizes), 2)
            self.assertTrue(all(0 < size <= 1024 * 1024 for size in sizes))

    def test_required_artifact_reader_is_bound_to_contained_relative_path(self):
        with TemporaryDirectory() as tmp:
            run = Path(tmp)
            case = run / "de100"
            artifact = case / "eigen/dispersion.csv"
            artifact.parent.mkdir(parents=True)
            payload = b"bound dispersion bytes\n"
            artifact.write_bytes(payload)
            result = {
                "artifacts": {
                    "required_artifact_hashes": {
                        "eigen/dispersion.csv": {
                            "size": len(payload),
                            "sha256": hashlib.sha256(payload).hexdigest(),
                        }
                    }
                }
            }

            self.assertEqual(
                read_required_artifact_bytes(
                    result, run, "de100", "eigen/dispersion.csv"
                ),
                payload,
            )
            self.assertEqual(
                verify_required_artifact_hash(result, run, "de100", "eigen/dispersion.csv"),
                {"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()},
            )
            with self.assertRaisesRegex(ValueError, "normalized relative path"):
                read_required_artifact_bytes(
                    {
                        "artifacts": {
                            "required_artifact_hashes": {
                                "../outside.csv": result["artifacts"][
                                    "required_artifact_hashes"
                                ]["eigen/dispersion.csv"]
                            }
                        }
                    },
                    run,
                    "de100",
                    "../outside.csv",
                )


if __name__ == "__main__":
    unittest.main()
