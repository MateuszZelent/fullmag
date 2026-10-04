"""Interpreted checks of the native CLI's private stdin consumer."""
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_windows_development_acquisition_handoff as acquisition_tests
from windows import development_handoff as capsule
from windows import stage_acquisition_handoff as consumer


class StageConsumerTests(unittest.TestCase):
    def setUp(self):
        acquisition_tests.AcquisitionHandoffTests.setUp(self)
        self.request = {"schema": consumer.REQUEST_SCHEMA,
            "acquisition_json": json.dumps(self.acquisition), "source_identity": self.source,
            "candidate_bundle_root": str(self.candidate), "frontend_payload": self.frontend}

    def test_private_request_returns_only_staged_ack(self):
        result = consumer.stage_request(str(self.repo), self.request)
        self.assertEqual(result["schema"], "fullmag.development-acquisition-handoff.v1")
        self.assertEqual(result["handoff"]["state"], "staged")
        self.assertNotIn("owner_token", result)

    def run_main(self, raw, active="1", profile="windows-native-fdm-cpu-dev"):
        output, errors = io.BytesIO(), io.StringIO()
        with patch.object(consumer.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(raw))), \
             patch.object(consumer.sys, "stdout", SimpleNamespace(buffer=output)), \
             patch.object(consumer.sys, "stderr", errors), \
             patch.dict(consumer.os.environ, {"FULLMAG_NATIVE_RUNTIME_ACTIVE": active,
                                              "FULLMAG_STORAGE_PROFILE": profile}):
            code = consumer.main(["--repo-root", str(self.repo)])
        return code, output.getvalue(), errors.getvalue()

    def test_closed_stdin_produces_bounded_ack(self):
        code, raw, errors = self.run_main(json.dumps(self.request).encode())
        self.assertEqual(code, 0)
        self.assertEqual(errors, "")
        self.assertLess(len(raw), consumer.MAX_ACK_BYTES)
        self.assertEqual(json.loads(raw)["acquisition_nonce"], self.acquisition["nonce"])

    def test_release_or_unmanaged_route_refused_before_write(self):
        for active, profile in (("0", "windows-native-fdm-cpu-dev"), ("1", "windows-native-fdm-cpu")):
            with self.subTest(active=active, profile=profile):
                code, raw, _ = self.run_main(json.dumps(self.request).encode(), active, profile)
                self.assertEqual(code, 2)
                self.assertEqual(raw, b"")
                self.assertFalse((self.runtime / capsule.HANDOFF_DIRECTORY).exists())

    def test_extra_keys_and_invalid_json_refused_without_echoing_payload(self):
        request = {**self.request, "owner_token": "private-canary"}
        for raw in (json.dumps(request).encode(), b'{"schema":1,"schema":2}'):
            code, output, errors = self.run_main(raw)
            self.assertEqual(code, 2)
            self.assertEqual(output, b"")
            self.assertNotIn("private-canary", errors)
            self.assertFalse((self.runtime / capsule.HANDOFF_DIRECTORY).exists())

    def test_oversize_stdin_rejected_before_write(self):
        with patch.object(consumer, "MAX_REQUEST_BYTES", 20):
            code, output, _ = self.run_main(b" " * 21)
        self.assertEqual(code, 2)
        self.assertEqual(output, b"")
        self.assertFalse((self.runtime / capsule.HANDOFF_DIRECTORY).exists())


if __name__ == "__main__":
    unittest.main()
