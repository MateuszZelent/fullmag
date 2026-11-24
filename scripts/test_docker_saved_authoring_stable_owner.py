"""Stable native-owner checkpoint checks; no lifecycle or native build."""
import copy
import hashlib
import unittest
from docker_build_control import BuildControlError, canonical
import docker_saved_authoring_generated as generated
import test_docker_saved_authoring_generated as old
import docker_volume_dev as dev

class StableOwnerV2Tests(old.GeneratedAuthoringRestartTests):
    def fixture(self):
        values = list(super().fixture())
        pin, proof = values[1], values[7]
        pin["schema"] = generated.SCHEMA_V2
        owner = proof["process_receipt"]["service_owner"]
        owner.update(schema_version="runtime-service-owner.v1", protocol="runtime-service.v1",
                     state="ready", acquired_at="2026-11-08T18:00:00Z")
        owner["heartbeat_at"] = "2026-11-08T19:00:00Z"
        pin.pop("service_owner_sha256")
        pin["service_owner_identity_sha256"] = generated.service_owner_digest(pin, owner, canonical)
        return tuple(values)

    def test_v2_accepts_only_heartbeat_change(self):
        _, pin, scene, _, _, _, _, proof, _ = self.fixture()
        proof["process_receipt"]["service_owner"]["heartbeat_at"] = "2026-11-08T19:00:01Z"
        self.validate(pin, proof, scene)

    def test_v2_refuses_every_other_owner_field_and_unknown_fields(self):
        _, pin, scene, _, _, _, _, proof, _ = self.fixture()
        owner = proof["process_receipt"]["service_owner"]
        for key in owner:
            if key == "heartbeat_at":
                continue
            changed = copy.deepcopy(proof)
            value = changed["process_receipt"]["service_owner"][key]
            changed["process_receipt"]["service_owner"][key] = (
                value + "-changed" if isinstance(value, str) else
                value + 1 if isinstance(value, int) else
                value + [{}] if isinstance(value, list) else {"changed": True})
            with self.subTest(field=key), self.assertRaises(BuildControlError):
                self.validate(pin, changed, scene)
        changed = copy.deepcopy(proof)
        changed["process_receipt"]["service_owner"]["unknown"] = "new"
        with self.assertRaises(BuildControlError):
            self.validate(pin, changed, scene)

    def test_v2_rejects_missing_heartbeat_and_mixed_digest_fields(self):
        _, pin, scene, _, _, _, _, proof, _ = self.fixture()
        for heartbeat in [None, "", 7]:
            changed = copy.deepcopy(proof)
            changed["process_receipt"]["service_owner"]["heartbeat_at"] = heartbeat
            with self.subTest(heartbeat=heartbeat), self.assertRaises(BuildControlError):
                self.validate(pin, changed, scene)
        missing = copy.deepcopy(proof)
        del missing["process_receipt"]["service_owner"]["heartbeat_at"]
        with self.assertRaises(BuildControlError):
            self.validate(pin, missing, scene)
        mixed = copy.deepcopy(pin)
        mixed["service_owner_sha256"] = "d" * 64
        with self.assertRaises(BuildControlError):
            self.validate(mixed)
        mixed = copy.deepcopy(pin)
        mixed["schema"] = generated.SCHEMA
        with self.assertRaises(BuildControlError):
            self.validate(mixed)

    def test_v2_keeps_nested_heartbeat_in_identity(self):
        _, pin, scene, _, _, _, _, proof, _ = self.fixture()
        owner = proof["process_receipt"]["service_owner"]
        owner["extra_context"] = {"heartbeat_at": "nested-old"}
        pin["service_owner_identity_sha256"] = generated.service_owner_digest(pin, owner, canonical)
        self.validate(pin, proof, scene)
        owner["extra_context"]["heartbeat_at"] = "nested-new"
        with self.assertRaises(BuildControlError):
            self.validate(pin, proof, scene)

class LegacyOwnerV1Tests(unittest.TestCase):
    def test_v1_still_refuses_heartbeat_change(self):
        _, pin, scene, _, _, _, _, proof, _ = old.GeneratedAuthoringRestartTests().fixture()
        owner = proof["process_receipt"]["service_owner"]
        owner.update(schema_version="runtime-service-owner.v1", protocol="runtime-service.v1",
                     state="ready", acquired_at="2026-11-08T18:00:00Z")
        owner["heartbeat_at"] = "2026-11-08T19:00:00Z"
        pin["service_owner_sha256"] = hashlib.sha256(canonical(owner)).hexdigest()
        old.GeneratedAuthoringRestartTests().validate(pin, proof, scene)
        owner["heartbeat_at"] = "2026-11-08T19:00:01Z"
        with self.assertRaises(BuildControlError):
            old.GeneratedAuthoringRestartTests().validate(pin, proof, scene)
