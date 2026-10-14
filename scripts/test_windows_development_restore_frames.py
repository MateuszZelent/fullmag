"""Interpreted restore-frame contract checks; no native runtime qualification."""
import unittest

from windows import verify_workspace_browser as proof


NONCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OLD = "11111111-1111-4111-8111-111111111111"
NEW = "22222222-2222-4222-8222-222222222222"
REQUEST = "33333333-3333-4333-8333-333333333333"
EXPECTED = {"nonce": NONCE, "generation_id": "a" * 32}
BEFORE = {"api_instance_id": OLD}


def frame(version=2):
    value = {"schema": proof.RESTORED_SCHEMA_V1, "nonce": NONCE,
             "new_api_instance_id": NEW, "api_pid": 20, "old_api_exit_code": 0,
             "helper_processes": [{"pid": 30, "waited": True, "exit_code": 0}]}
    if version == 2:
        value.update(schema=proof.RESTORED_SCHEMA_V2, request_id=REQUEST,
                     generation_id="a" * 32, old_api_instance_id=OLD, old_api_pid=10)
    return value


class RestoreFrameChecks(unittest.TestCase):
    def test_v1_remains_compatible_without_inventing_request_identity(self):
        result = proof.validate_restored_frame(frame(1), EXPECTED, BEFORE)
        self.assertNotIn("request_id", result)

    def test_v2_preserves_exact_request_scope_and_returns_detached_copy(self):
        value = frame()
        result = proof.validate_restored_frame(value, EXPECTED, BEFORE, 10)
        self.assertEqual(result["request_id"], REQUEST)
        result["helper_processes"][0]["pid"] = 99
        self.assertEqual(value["helper_processes"][0]["pid"], 30)

    def test_foreign_missing_or_noncanonical_bindings_are_rejected(self):
        for key, bad in (("nonce", REQUEST), ("request_id", REQUEST.replace("-", "")),
                         ("generation_id", "b" * 32), ("old_api_instance_id", NEW),
                         ("old_api_pid", 11), ("old_api_pid", True),
                         ("api_pid", True), ("new_api_instance_id", OLD)):
            with self.subTest(key=key, bad=bad), self.assertRaises(proof.storage.StorageError):
                proof.validate_restored_frame({**frame(), key: bad}, EXPECTED, BEFORE, 10)
        value = frame()
        del value["request_id"]
        with self.assertRaises(proof.storage.StorageError):
            proof.validate_restored_frame(value, EXPECTED, BEFORE, 10)

    def test_unknown_fields_including_secret_material_are_rejected(self):
        for key in ("status_token_sha256", "status_token", "unexpected"):
            with self.subTest(key=key), self.assertRaises(proof.storage.StorageError):
                proof.validate_restored_frame({**frame(), key: "not permitted"}, EXPECTED, BEFORE, 10)

    def test_unknown_duplicate_or_unwaited_custody_is_rejected(self):
        for helpers in ([], [{"pid": 30, "waited": False, "exit_code": 0}],
                        [{"pid": 30, "waited": True, "exit_code": True}],
                        frame()["helper_processes"] * 2):
            with self.subTest(helpers=helpers), self.assertRaises(proof.storage.StorageError):
                proof.validate_restored_frame({**frame(), "helper_processes": helpers}, EXPECTED, BEFORE, 10)
        with self.assertRaises(proof.storage.StorageError):
            proof.validate_restored_frame(frame(), EXPECTED, BEFORE)

    def test_source_exit_one_is_observation_not_automatic_failure(self):
        value = frame()
        value["old_api_exit_code"] = 1
        self.assertEqual(proof.validate_restored_frame(value, EXPECTED, BEFORE, 10)["old_api_exit_code"], 1)

    def test_legacy_proof_is_explicitly_nonqualifying_for_authenticated_binding(self):
        legacy = proof.validate_restored_frame(frame(1), EXPECTED, BEFORE)
        self.assertEqual(proof.restore_protocol_scope(legacy), {
            "schema": proof.RESTORED_SCHEMA_V1, "authenticated_request_binding": False,
            "qualification": "legacy_v1_without_request_identity"})
        current = proof.validate_restored_frame(frame(), EXPECTED, BEFORE, 10)
        self.assertTrue(proof.restore_protocol_scope(current)["authenticated_request_binding"])

    def test_old_api_cannot_be_counted_again_as_a_terminal_helper(self):
        value = frame()
        value["helper_processes"][0]["pid"] = 10
        with self.assertRaises(proof.storage.StorageError):
            proof.validate_restored_frame(value, EXPECTED, BEFORE, 10)


if __name__ == "__main__":
    unittest.main()
