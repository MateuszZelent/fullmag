"""Contract tests for explicit Fullmag Docker bridge subnet handling."""
from __future__ import annotations

from copy import deepcopy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from docker_build_control import BuildControlError
import docker_dev_network as module


def completed(stdout=b"", returncode=0, stderr=b""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def compose_document():
    return {
        "name": "fullmag-worktree-example",
        "services": {"backend": {"networks": ["fullmag"]}},
        "networks": {
            "fullmag": {
                "name": "fullmag-net-0123456789abcdef",
                "driver": "bridge",
                "ipam": {"driver": "default", "options": {"keep": "this"}, "config": []},
                "labels": {"keep": "these"},
            },
        },
    }


def network_document(identifier, name, subnets=(), *, driver="bridge", ipam_driver="default"):
    return {
        "Id": identifier,
        "Name": name,
        "Driver": driver,
        "IPAM": {
            "Driver": ipam_driver,
            "Config": [{"Subnet": subnet} for subnet in subnets],
        },
    }


class RequestedSubnetTests(unittest.TestCase):
    def test_parse_accepts_canonical_rfc1918_ipv4_networks(self):
        self.assertIsNone(module.parse_requested_subnet(None))
        for value in (
            "10.0.0.0/16",
            "172.16.1.0/24",
            "172.31.255.248/29",
            "192.168.1.0/24",
        ):
            with self.subTest(value=value):
                self.assertEqual(module.parse_requested_subnet(value), value)

    def test_parse_rejects_noncanonical_or_unsupported_ranges(self):
        for value in (
            False,
            True,
            4,
            b"10.0.0.0/24",
            "10.0.0.1/24",
            "10.0.0.0/15",
            "10.0.0.0/30",
            "10.0.0.0/024",
            "172.32.0.0/16",
            "192.169.0.0/16",
            "100.64.0.0/24",
            "169.254.0.0/24",
            "224.0.0.0/24",
            "240.0.0.0/24",
            "8.8.8.0/24",
            "fd00::/64",
            "not-an-ip-network",
        ):
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                module.parse_requested_subnet(value)

    def test_apply_none_is_a_true_noop_and_explicit_value_changes_only_ipam_config(self):
        document = compose_document()
        before = deepcopy(document)
        module.apply_requested_subnet(document, None)
        self.assertEqual(document, before)

        module.apply_requested_subnet(document, "172.16.1.0/24")
        expected = deepcopy(before)
        expected["networks"]["fullmag"]["ipam"]["config"] = [{"subnet": "172.16.1.0/24"}]
        self.assertEqual(document, expected)

    def test_apply_rejects_non_project_or_non_bridge_network_documents(self):
        variants = []
        multiple = compose_document()
        multiple["networks"]["other"] = {"driver": "bridge"}
        variants.append(multiple)
        external = compose_document()
        external["networks"]["fullmag"]["external"] = True
        variants.append(external)
        wrong_driver = compose_document()
        wrong_driver["networks"]["fullmag"]["driver"] = "overlay"
        variants.append(wrong_driver)
        wrong_ipam = compose_document()
        wrong_ipam["networks"]["fullmag"]["ipam"]["driver"] = "custom"
        variants.append(wrong_ipam)
        missing_ipam = compose_document()
        del missing_ipam["networks"]["fullmag"]["ipam"]
        variants.append(missing_ipam)

        for document in variants:
            before = deepcopy(document)
            with self.subTest(document=document), self.assertRaises(BuildControlError):
                module.apply_requested_subnet(document, "10.20.0.0/24")
            self.assertEqual(document, before)

    def test_retained_subnet_requires_exactly_one_matching_persisted_subnet(self):
        document = compose_document()
        document["networks"]["fullmag"]["ipam"]["config"] = [
            {"subnet": "10.20.0.0/24", "gateway": "10.20.0.1"}
        ]
        before = deepcopy(document)
        self.assertIsNone(module.validate_retained_subnet(document, "10.20.0.0/24"))
        self.assertEqual(document, before)
        self.assertIsNone(module.validate_retained_subnet({}, None))

        for changed in (
            "10.20.0.0/25",
            "10.21.0.0/24",
        ):
            with self.subTest(changed=changed), self.assertRaises(BuildControlError):
                module.validate_retained_subnet(document, changed)
        document["networks"]["fullmag"]["ipam"]["config"].append({"subnet": "10.22.0.0/24"})
        with self.assertRaises(BuildControlError):
            module.validate_retained_subnet(document, "10.20.0.0/24")

    def test_retained_subnet_is_derived_without_mutating_document(self):
        document = compose_document()
        document["networks"]["fullmag"]["ipam"]["config"] = [
            {"subnet": "172.16.2.0/24", "gateway": "172.16.2.1"}
        ]
        before = deepcopy(document)

        self.assertEqual(module.retained_requested_subnet(document), "172.16.2.0/24")
        self.assertEqual(module.retained_requested_subnet(document, "172.16.2.0/24"), "172.16.2.0/24")
        self.assertEqual(document, before)

    def test_retained_subnet_preserves_legacy_absence_and_rejects_bad_pins(self):
        no_ipam = compose_document()
        del no_ipam["networks"]["fullmag"]["ipam"]
        empty = compose_document()
        legacy = compose_document()
        del legacy["networks"]
        self.assertIsNone(module.retained_requested_subnet(no_ipam))
        self.assertIsNone(module.retained_requested_subnet(empty))
        self.assertIsNone(module.retained_requested_subnet(legacy))
        with self.assertRaises(BuildControlError):
            module.retained_requested_subnet(no_ipam, "172.16.2.0/24")
        with self.assertRaises(BuildControlError):
            module.retained_requested_subnet(empty, "172.16.2.0/24")
        with self.assertRaises(BuildControlError):
            module.retained_requested_subnet(legacy, "172.16.2.0/24")

        multiple = compose_document()
        multiple["networks"]["fullmag"]["ipam"]["config"] = [
            {"subnet": "172.16.2.0/24"}, {"subnet": "172.17.2.0/24"}
        ]
        with self.assertRaises(BuildControlError):
            module.retained_requested_subnet(multiple)

        malformed = compose_document()
        malformed["networks"]["fullmag"]["ipam"]["config"] = [{"subnet": "172.16.2.1/24"}]
        with self.assertRaises(BuildControlError):
            module.retained_requested_subnet(malformed)

        for subnet_record in ({"subnet": ""}, {"subnet": "   "}, {}):
            with self.subTest(subnet_record=subnet_record):
                malformed = compose_document()
                malformed["networks"]["fullmag"]["ipam"]["config"] = [subnet_record]
                with self.assertRaises(BuildControlError):
                    module.retained_requested_subnet(malformed)
        blank = compose_document()
        blank["networks"]["fullmag"]["ipam"]["config"] = [{"subnet": ""}]
        with patch.object(module, "parse_requested_subnet", return_value=None):
            with self.assertRaisesRegex(BuildControlError, "subnet is missing"):
                module.retained_requested_subnet(blank)

        retained = compose_document()
        retained["networks"]["fullmag"]["ipam"]["config"] = [{"subnet": "172.16.2.0/24"}]
        with self.assertRaises(BuildControlError):
            module.retained_requested_subnet(retained, "172.16.3.0/24")


class RequestedSubnetAvailabilityTests(unittest.TestCase):
    def capture_for(self, documents, *, listed_ids=None, inspect_override=None, list_result=None):
        by_id = {document["Id"]: document for document in documents}
        ids = list(listed_ids) if listed_ids is not None else list(by_id)
        calls = []

        def capture(*args, **kwargs):
            calls.append((args, kwargs))
            if args[:2] == ("network", "ls"):
                return list_result or completed("".join(identifier + "\n" for identifier in ids).encode())
            if args[:2] == ("network", "inspect"):
                if inspect_override is not None:
                    return inspect_override
                selected = [by_id[identifier] for identifier in args[2:] if identifier in by_id]
                return completed(json.dumps(selected, separators=(",", ":")).encode())
            self.fail(f"unexpected Docker observation: {args}")

        return capture, calls

    def test_overlapping_foreign_network_is_rejected_across_different_masks(self):
        foreign = network_document("a" * 64, "other-bridge", ["10.42.0.128/25"])
        capture, _ = self.capture_for([foreign])
        with patch.object(module, "docker_capture", side_effect=capture):
            with self.assertRaisesRegex(BuildControlError, "overlap"):
                module.check_requested_subnet_available("10.42.0.0/24", "fullmag-net-0123456789abcdef")

    def test_existing_named_network_is_allowed_only_with_exact_subnet(self):
        own = network_document("b" * 64, "fullmag-net-0123456789abcdef", ["172.16.1.0/24"])
        capture, _ = self.capture_for([own])
        with patch.object(module, "docker_capture", side_effect=capture):
            self.assertIsNone(module.check_requested_subnet_available("172.16.1.0/24", own["Name"]))

        changed = network_document("b" * 64, own["Name"], ["172.16.1.0/25"])
        capture, _ = self.capture_for([changed])
        with patch.object(module, "docker_capture", side_effect=capture):
            with self.assertRaisesRegex(BuildControlError, "does not match"):
                module.check_requested_subnet_available("172.16.1.0/24", own["Name"])

    def test_exact_owned_network_does_not_hide_overlap_with_another_network(self):
        own = network_document("b" * 64, "fullmag-net-0123456789abcdef", ["192.168.50.0/24"])
        foreign = network_document("c" * 64, "other-bridge", ["192.168.50.0/25"])
        capture, _ = self.capture_for([own, foreign])
        with patch.object(module, "docker_capture", side_effect=capture):
            with self.assertRaisesRegex(BuildControlError, "overlap"):
                module.check_requested_subnet_available("192.168.50.0/24", own["Name"])

    def test_no_requested_subnet_skips_docker_inventory(self):
        with patch.object(module, "docker_capture") as capture:
            self.assertIsNone(module.check_requested_subnet_available(None, "fullmag-net-0123456789abcdef"))
            capture.assert_not_called()

    def test_network_list_and_inspection_are_bounded_and_complete(self):
        documents = [
            network_document(f"{index + 1:064x}", f"bridge-{index}")
            for index in range(module.MAX_INSPECT_BATCH + 1)
        ]
        capture, calls = self.capture_for(documents)
        with patch.object(module, "docker_capture", side_effect=capture):
            self.assertIsNone(module.check_requested_subnet_available("10.99.0.0/24", "missing-project-network"))
        self.assertEqual(calls[0][0][:3], ("network", "ls", "--quiet"))
        self.assertIn("--no-trunc", calls[0][0])
        inspect_calls = [call for call in calls if call[0][:2] == ("network", "inspect")]
        self.assertGreater(len(inspect_calls), 1)
        self.assertTrue(all(1 <= len(call[0]) - 2 <= module.MAX_INSPECT_BATCH for call in inspect_calls))

    def test_incomplete_or_failed_daemon_reads_are_rejected(self):
        identifier = "d" * 64
        listed_only = self.capture_for([], listed_ids=[identifier])[0]
        with patch.object(module, "docker_capture", side_effect=listed_only):
            with self.assertRaisesRegex(BuildControlError, "incomplete"):
                module.check_requested_subnet_available("10.90.0.0/24", "missing")

        capture, _ = self.capture_for([], list_result=completed(returncode=1, stderr=b"daemon unavailable"))
        with patch.object(module, "docker_capture", side_effect=capture):
            with self.assertRaisesRegex(BuildControlError, "daemon unavailable"):
                module.check_requested_subnet_available("10.90.0.0/24", "missing")

        capture, _ = self.capture_for([], listed_ids=[identifier], inspect_override=completed(b"not-json"))
        with patch.object(module, "docker_capture", side_effect=capture):
            with self.assertRaisesRegex(BuildControlError, "JSON"):
                module.check_requested_subnet_available("10.90.0.0/24", "missing")

    def test_duplicate_or_inconsistent_network_identities_are_rejected(self):
        identifier = "e" * 64
        first = network_document(identifier, "bridge-a")
        duplicate_id = self.capture_for([first], listed_ids=[identifier, identifier])[0]
        with patch.object(module, "docker_capture", side_effect=duplicate_id):
            with self.assertRaisesRegex(BuildControlError, "duplicate"):
                module.check_requested_subnet_available("10.91.0.0/24", "missing")

        wrong = network_document("f" * 64, "bridge-a")
        mismatched_inspect = self.capture_for([first], inspect_override=completed(json.dumps([wrong]).encode()))[0]
        with patch.object(module, "docker_capture", side_effect=mismatched_inspect):
            with self.assertRaises(BuildControlError):
                module.check_requested_subnet_available("10.91.0.0/24", "missing")


if __name__ == "__main__":
    unittest.main()
