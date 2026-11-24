"""Interpreted authority derivation checks for the managed relocation factory."""
from types import SimpleNamespace
from unittest.mock import patch
import copy
import json
import unittest

from docker_build_control import canonical, BuildControlError
import docker_group_ledger_relocation as relocation
import docker_group_ledger_relocation_host as host
import test_docker_group_ledger_relocation as fixtures


class FactoryTests(unittest.TestCase):
    def test_factory_derives_package_and_source_pins_from_bootstrap_authority(self):
        fixture = fixtures.LedgerRelocationRequestTests(); fixture.setUp()
        control, expected = fixture.control, fixture.request
        engine = "daemon-test"
        expected["daemon_id_sha256"] = relocation.sha(engine.encode())
        terminal = {"state": "succeeded", "image_id": expected["native_program"]["image_id"],
            "native_program": {"package_mount": {"volume": expected["native_program"]["package_volume"],
                "subpath": expected["native_program"]["package_subpath"]},
                "candidate_receipt_sha256": expected["native_program"]["receipt_sha256"],
                "sha256": expected["native_program"]["cli_sha256"]},
            "source_group_ledger": {"volume_name": expected["source_volume"], "host_id": expected["host_id"]},
            "docker_engine_id": engine, "source": expected["source_commit"],
            "bootstrap_backend_container": expected["bootstrap"]["container_id"],
            "bootstrap_started_at": expected["bootstrap"]["started_at"]}
        result = {"candidate": expected["native_program"]["candidate"]}
        control.read = lambda path: result if path.endswith("/result.json") else terminal
        digest = relocation.sha(canonical(terminal))
        def docker(*args):
            if args[0] == "info": return SimpleNamespace(stdout=engine.encode())
            return SimpleNamespace(stdout=json.dumps([{"Name": args[-1]}]).encode())
        with patch.object(host, "docker_capture", side_effect=docker), patch.object(relocation, "_revalidate_bootstrap") as guard:
            request = host.factory(control, "5" * 32, digest, expected["native_program"]["image_id"])
        self.assertEqual(request["native_program"], expected["native_program"])
        self.assertEqual(request["source_volume"], expected["source_volume"])
        self.assertIsNone(request["expected_inspection"])
        guard.assert_called_once_with(control, request)
        with self.assertRaisesRegex(BuildControlError, "terminal pin"):
            host.factory(control, "5" * 32, "0" * 64, expected["native_program"]["image_id"])
        with patch.object(host, "docker_capture", return_value=SimpleNamespace(stdout=b"foreign")):
            with self.assertRaisesRegex(BuildControlError, "daemon changed"):
                host.factory(control, "5" * 32, digest, expected["native_program"]["image_id"])


if __name__ == "__main__":
    unittest.main()
