"""Source-only tests for the recorded native Krylov environment boundary."""
import hashlib
import json
import os
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

import docker_dev
import fullmag_docker_runtime
import docker_volume_dev
import docker_backend_cache

BASE = {"FULLMAG_MIXED_P1_DEVICE": "gpu", "FULLMAG_ARTIFACT_FIELD_STORAGE": "json"}
HISTORICAL = {
    "FULLMAG_MODAL_EPS_PREFILTER_ABS": "1e-9",
    "FULLMAG_MODAL_SHIFTED_KSP_RTOL": "1e-9",
    "FULLMAG_MODAL_GMRES_RESTART": "8",
    "FULLMAG_MODAL_SHIFTED_KSP_TYPE": "fgmres",
}


class ModalLauncherTuningTests(unittest.TestCase):
    def test_old_receipt_hash_is_byte_compatible(self):
        encoded = json.dumps({"schema": "fullmag.operator-probe-environment.v1", "values": BASE},
                             ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
        expected = hashlib.sha256(encoded + b"\n").hexdigest()
        for module in (docker_dev, fullmag_docker_runtime):
            self.assertEqual(module._operator_probe_environment_sha256(BASE), expected)

    def test_historical_controls_are_recorded_identically_by_both_consumers(self):
        values = {**BASE, **HISTORICAL}
        for module in (docker_dev, fullmag_docker_runtime):
            self.assertEqual(module._normalize_operator_probe_environment(values), values)
        self.assertEqual(docker_dev._operator_probe_environment_sha256(values),
                         fullmag_docker_runtime._operator_probe_environment_sha256(values))
        self.assertNotEqual(docker_dev._operator_probe_environment_sha256(BASE),
                            docker_dev._operator_probe_environment_sha256(values))

    def test_absent_tuning_preserves_native_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(docker_dev._operator_probe_environment_from_host(), BASE)
        with patch.dict(os.environ, {**HISTORICAL, "UNRELATED_SECRET": "ignored"}, clear=True):
            self.assertEqual(docker_dev._operator_probe_environment_from_host(), {**BASE, **HISTORICAL})

    def test_volume_overlay_cannot_restore_unrecorded_tuning(self):
        document = {"services": {
            "backend": {"environment": {**BASE, **HISTORICAL}},
            "frontend": {"environment": {}},
        }}
        record = docker_volume_dev._operator_probe_record(BASE)
        docker_volume_dev._reassert_operator_probe_environment(document, record)
        environment = document["services"]["backend"]["environment"]
        self.assertFalse(set(HISTORICAL).intersection(environment))
        record = docker_volume_dev._operator_probe_record({**BASE, **HISTORICAL})
        docker_volume_dev._reassert_operator_probe_environment(document, record)
        for name, value in HISTORICAL.items():
            self.assertEqual(environment[name], value)
        self.assertFalse(set(HISTORICAL).intersection(document["services"]["frontend"]["environment"]))
        environment["FULLMAG_MODAL_GMRES_RESTART"] = "30"
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "differs"):
            docker_volume_dev._operator_probe_record_from_retained(record, document)
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "unrecorded"):
            docker_volume_dev._operator_probe_record_from_retained(
                docker_volume_dev._operator_probe_record(BASE), document)

    def test_rendered_compose_contains_frozen_tuning_not_ambient_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            template = root / "compose.yaml"
            template.write_text("services: {}\n")
            record = docker_volume_dev._operator_probe_record({**BASE, **HISTORICAL})
            backend_start = {**record, "source_root": "/source", "git_common_dir": "/git",
                             "package_root": "/package", "backend_cache": {
                                 "state": "ready", "schema": docker_backend_cache.SCHEMA,
                                 "compose_overlay": str(template), "environment": {
                                     "FULLMAG_BACKEND_PACKAGE": "/package",
                                     "FULLMAG_MODAL_SHIFTED_KSP_TYPE": "gmres"}}}
            rendered = {"services": {"backend": {"environment": {}}, "frontend": {}}}
            with patch.object(fullmag_docker_runtime, "docker", return_value=json.dumps(rendered)), \
                    patch.dict(os.environ, {"FULLMAG_MODAL_SHIFTED_KSP_TYPE": "gmres"}):
                result = fullmag_docker_runtime.compose_spec(
                    "sha256:" + "a" * 64, root, 3197, root / "host.json",
                    repo=root, template=template, backend_start=backend_start,
                    inputs_path=root / "inputs.json", package=root / "package",
                    provenance=root / "provenance.json", workspace_state_root=root / "data",
                    device_access="cpu")
            environment = result["services"]["backend"]["environment"]
            for name, value in HISTORICAL.items():
                self.assertEqual(environment[name], value)
            self.assertEqual(environment["FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256"],
                             record["operator_probe_environment_sha256"])
            self.assertNotIn("environment", result["services"]["frontend"])

    def test_invalid_tuning_and_unknown_controls_fail_closed(self):
        for module in (docker_dev, fullmag_docker_runtime):
            for name, value in [("FULLMAG_MODAL_SHIFTED_KSP_RTOL", "nan"),
                                ("FULLMAG_MODAL_SHIFTED_KSP_RTOL", "0"),
                                ("FULLMAG_MODAL_GMRES_RESTART", "999999"),
                                ("FULLMAG_MODAL_SHIFTED_KSP_TYPE", "preonly"),
                                ("UNRELATED", "secret")]:
                with self.subTest(module=module.__name__, name=name, value=value):
                    with self.assertRaises((ValueError, docker_dev.DirectDockerError)):
                        module._normalize_operator_probe_environment({**BASE, name: value})
            with self.assertRaises((ValueError, docker_dev.DirectDockerError)):
                module._normalize_operator_probe_environment(HISTORICAL)


if __name__ == "__main__":
    unittest.main()
