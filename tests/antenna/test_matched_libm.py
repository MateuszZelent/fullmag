"""Interpreted binding checks; synthetic artifacts are not native field solves."""
import hashlib
import ctypes
import importlib
import json
import math
import os
import random
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from tests.antenna.test_verify_field_convergence import write_solution, write_v3_solution
from tests.antenna.verify_field_convergence import read_solution, verify


class MatchedLibmAdmissionTests(unittest.TestCase):
    def test_default_and_legacy_math_are_not_claimed_as_matched(self):
        with tempfile.TemporaryDirectory() as temporary:
            levels = (("coarse", 1.2), ("medium", 1.1), ("fine", 1.01))
            manifests = [write_v3_solution(Path(temporary), scale, asset_id=name) for name, scale in levels]
            report = verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)
            self.assertEqual(report["math_realization"]["kind"], "python_hypot_diagnostic_only")
            self.assertFalse(report["math_realization"]["producer_math_qualified"])
            manifests = [write_solution(Path(temporary), scale, asset_id=name) for name, scale in levels]
            report = verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02,
                            allow_legacy_local_estimator=True)
            self.assertEqual(report["math_realization"]["kind"], "not_applied_legacy_local_estimator")

    def test_requires_absolute_library_and_explicit_digest(self):
        module = importlib.import_module("tests.antenna.matched_libm")
        with self.assertRaisesRegex(ValueError, "absolute.*digest"):
            module.MatchedLibmHypot("libm.so.6", "a" * 64)

    def test_rejects_bad_digest_before_loading(self):
        module = importlib.import_module("tests.antenna.matched_libm")
        for digest in (None, True, "a" * 63, "A" * 64):
            with self.subTest(digest=digest), self.assertRaisesRegex(ValueError, "absolute.*digest"):
                module.MatchedLibmHypot(Path(__file__).resolve(), digest)

    def test_unsupported_runtime_has_no_fallback(self):
        module = importlib.import_module("tests.antenna.matched_libm")
        with mock.patch.object(module.sys, "platform", "win32"):
            with self.assertRaisesRegex(ValueError, "unsupported matched libm runtime"):
                module.MatchedLibmHypot(Path(__file__).resolve(), "a" * 64)

    def test_hash_mismatch_refused_before_dlopen(self):
        module = importlib.import_module("tests.antenna.matched_libm")
        with mock.patch.object(module.sys, "platform", "linux"), \
                mock.patch.object(module.platform, "machine", return_value="x86_64"), \
                mock.patch.object(module.ctypes, "CDLL") as loader:
            with self.assertRaisesRegex(ValueError, "library hash mismatch"):
                module.MatchedLibmHypot(Path(__file__).resolve(), "0" * 64)
            loader.assert_not_called()


class MatchedLibmRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = os.environ.get("FULLMAG_ANTENNA_LIBM_PATH")
        digest = os.environ.get("FULLMAG_ANTENNA_LIBM_SHA256")
        if not path or not digest:
            raise unittest.SkipTest("explicit matched runtime library pins unavailable")
        module = importlib.import_module("tests.antenna.matched_libm")
        cls.realization = module.MatchedLibmHypot(path, digest)

    def test_counterexamples_keep_exact_native_tolerance_bits(self):
        from tests.antenna.direct_quadrature_evidence import exact_tolerance
        cases = (
            (("0x1.f9cae5703188cp+2", "0x1.3964d3f687cb0p+2", "-0x1.94835fd3da3a0p+0"), "0x1.8b8b6d4969e69p-14"),
            (("0x1.d0bef38f5df2cp-9", "0x1.b661b53ac2dc0p-9", "-0x1.821839124ff1ep-9"), "0x1.f1ce06568df66p-25"),
            (("0x1.06398105ec97ep-2", "-0x1.26f9d4b458f22p-2", "-0x1.649fe4db87590p-5"), "0x1.045e9246dce6bp-18"),
        )
        for raw, expected in cases:
            values = tuple(float.fromhex(value) for value in raw)
            with self.subTest(raw=raw):
                self.assertEqual(exact_tolerance(values, math_realization=self.realization).hex(), expected)
                self.assertNotEqual(exact_tolerance(values).hex(), expected)

    def test_symbol_and_file_identity_are_reported(self):
        metadata = self.realization.description
        self.assertEqual(metadata["hypot_symbol_version"], "GLIBC_2.35")
        self.assertEqual(metadata["library_sha256"], os.environ["FULLMAG_ANTENNA_LIBM_SHA256"])
        self.assertEqual(metadata["rounding_mode"], "nearest_even")
        self.assertFalse(metadata["producer_math_qualified"])

    def test_pinned_diagnostic_corpus_has_no_tolerance_mismatch(self):
        from tests.antenna.direct_quadrature_evidence import exact_tolerance
        generator = random.Random(20261006)
        corpus = [tuple(math.ldexp(value, exponent) for value in (1.0, 1.0, 1.0))
                  for exponent in (-1022, -1000, -500, -100, -30, -10, 0, 10, 20, 100, 500, 1000)]
        for index in range(12000):
            exponent = generator.randint(-30, 20) if index < 6000 else generator.randint(-1022, 1000)
            corpus.append(tuple(math.ldexp(generator.uniform(-1.0, 1.0), exponent) for _ in range(3)))
        self.assertEqual(hashlib.sha256(b"".join(struct.pack("<3d", *raw) for raw in corpus)).hexdigest(),
                         "8639273ce39e0f2a85f6648d635ef4f1d3b540fdeb6303f64411eb30182c41ab")
        fma = self.realization._library.fma
        fma.argtypes = [ctypes.c_double, ctypes.c_double, ctypes.c_double]
        fma.restype = ctypes.c_double
        for index, raw in enumerate(corpus):
            reference = fma(1e-5, self.realization.norm(raw), 1e-9)
            self.assertEqual(exact_tolerance(raw, math_realization=self.realization).hex(),
                             reference.hex(), f"corpus target {index}")

    def test_changed_rounding_mode_refused_without_mutating_environment(self):
        with mock.patch.object(self.realization, "_fegetround", return_value=1):
            with self.assertRaisesRegex(ValueError, "rounding mode"):
                self.realization.norm((1.0, 2.0, 3.0))

    def test_realization_reaches_cold_decoder_and_one_ulp_mutation_refused(self):
        from tests.antenna.direct_quadrature_evidence import exact_tolerance
        with tempfile.TemporaryDirectory() as temporary:
            path = write_v3_solution(Path(temporary))
            manifest = json.loads(path.read_text(encoding="utf-8"))
            raw = tuple(float.fromhex(value) for value in (
                "0x1.f9cae5703188cp+2", "0x1.3964d3f687cb0p+2", "-0x1.94835fd3da3a0p+0"))
            tau = exact_tolerance(raw, math_realization=self.realization)
            payload = path.parent / "direct_quadrature.v1.bin"
            data = bytearray(payload.read_bytes())
            struct.pack_into("<3d", data, 312, *raw)
            struct.pack_into("<d", data, 344, tau)
            field = struct.pack("<3d", *(value * (1.0 / 3.0) for value in raw))
            (path.parent / "H_per_A.f64le").write_bytes(field)
            manifest["bases"][0]["magnetic_field_per_ampere"]["sha256"] = hashlib.sha256(field).hexdigest()

            def retain():
                payload.write_bytes(data)
                manifest["bases"][0]["quadrature_evidence"]["sha256"] = hashlib.sha256(data).hexdigest()
                path.write_text(json.dumps(manifest), encoding="utf-8")

            retain()
            self.assertEqual(len(read_solution(path, "wire-port", math_realization=self.realization)[0]), 1)
            with self.assertRaisesRegex(ValueError, "E\\+R"):
                read_solution(path, "wire-port")
            struct.pack_into("<d", data, 344, math.nextafter(tau, math.inf))
            retain()
            with self.assertRaisesRegex(ValueError, "E\\+R"):
                read_solution(path, "wire-port", math_realization=self.realization)

    def test_cli_propagates_explicit_realization_and_rejects_unpaired_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifests = [write_v3_solution(Path(temporary), scale, asset_id=name)
                         for name, scale in (("coarse", 1.2), ("medium", 1.1), ("fine", 1.01))]
            command = [sys.executable, "-B", str(Path(__file__).with_name("verify_field_convergence.py")),
                       "--manifests", *(str(path) for path in manifests), "--port-mode-id", "wire-port",
                       "--wire-start", "0", "0", "-1", "--wire-end", "0", "0", "1",
                       "--minimum-distance-m", "0.5", "--max-l2-relative", "0.02", "--max-linf-relative", "0.02",
                       "--libm-path", os.environ["FULLMAG_ANTENNA_LIBM_PATH"]]
            missing = subprocess.run(command, capture_output=True, text=True, timeout=15)
            self.assertEqual(missing.returncode, 2, missing.stdout + missing.stderr)
            result = subprocess.run(command + ["--libm-sha256", os.environ["FULLMAG_ANTENNA_LIBM_SHA256"]],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["math_realization"]["hypot_symbol_version"], "GLIBC_2.35")
            self.assertFalse(report["producer_provenance_qualified"])


if __name__ == "__main__":
    unittest.main()
