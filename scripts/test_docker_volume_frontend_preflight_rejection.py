"""Tests for the one proof-bound frontend healthy-idle preflight recovery."""
from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace
import unittest

import docker_volume_frontend_preflight_rejection as rejection
from docker_build_control import BuildControlError, canonical


class MemoryControl:
    def __init__(self):
        self.project = "fullmag-worktree-results"
        self.volume = "fullmag-build-control-results"
        self.identity = {
            "project_id": "project-123",
            "worktree_id": "results-snapshot-inspector",
            "checkout_kind": "worktree",
        }
        self.files = {}
        self._active_operation = None
        self.helper_id = "e" * 64

    def read_bytes(self, relative, *, optional=False, maximum=None):
        value = self.files.get(relative)
        if value is None:
            if optional:
                return None
            raise BuildControlError("Missing fixture control document: " + relative)
        if maximum is not None and len(value) > maximum:
            raise BuildControlError("Fixture control document exceeded its bound")
        return value

    def read(self, relative, *, optional=False):
        raw = self.read_bytes(relative, optional=optional)
        return None if raw is None else json.loads(raw.decode("utf-8"))

    def _pin_operation_helper(self, operation):
        if operation is not self._active_operation:
            raise BuildControlError("Wrong fixture operation")
        return self.helper_id


def _raw(document):
    return canonical(document) + b"\n"


class FrontendPreflightRejectionTests(unittest.TestCase):
    def fixture(self):
        control = MemoryControl()
        parent_attempt = "a" * 32
        child_attempt = "b" * 32
        source_identity = {
            "source_root": "/registered/results-worktree",
            "source_project_id": control.identity["project_id"],
            "source_worktree_id": control.identity["worktree_id"],
            "source_checkout_kind": control.identity["checkout_kind"],
        }
        parent_compose = {"name": control.project, "services": {}}
        parent_config = hashlib.sha256(canonical(parent_compose)).hexdigest()
        parent = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "succeeded",
            "attempt": parent_attempt,
            "compose_project": control.project,
            "control_volume": control.volume,
            "config_sha256": parent_config,
            "inputs": dict(source_identity),
        }
        parent_raw = _raw(parent)
        control.files.update({
            "development/verified.json": parent_raw,
            "development/attempts/" + parent_attempt + "/terminal.json": parent_raw,
            "development/attempts/" + parent_attempt + "/compose.json": _raw(parent_compose),
        })
        child = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "failed-confirmed",
            "attempt": child_attempt,
            "compose_project": control.project,
            "control_volume": control.volume,
            "error": "Traceback (most recent call last):\n" + rejection.ERROR_LINE,
            "inputs": {
                **source_identity,
                "frontend_refresh_from_attempt": parent_attempt,
                "frontend_refresh_from_config_sha256": parent_config,
            },
        }
        child_raw = _raw(child)
        child_root = "development/attempts/" + child_attempt + "/"
        control.files.update({
            "development/current.json": child_raw,
            child_root + "receipt.json": child_raw,
            child_root + "terminal.json": child_raw,
        })
        proof_path = "verification/frontend-preflight-rejection/operator.json"
        proof = {
            "schema": rejection.SCHEMA,
            "failed_attempt": child_attempt,
            "failed_current_sha256": hashlib.sha256(child_raw).hexdigest(),
            "failed_receipt_sha256": hashlib.sha256(child_raw).hexdigest(),
            "failed_terminal_sha256": hashlib.sha256(child_raw).hexdigest(),
            "parent_attempt": parent_attempt,
            "parent_config_sha256": parent_config,
            "verified_parent_sha256": hashlib.sha256(parent_raw).hexdigest(),
            "compose_project": control.project,
            "control_volume": control.volume,
            "source_identity": source_identity,
            "failure_line": rejection.ERROR_LINE,
        }
        self.write_proof(control, proof_path, proof)
        args = SimpleNamespace(
            attempt=parent_attempt,
            config_sha256=parent_config,
            frontend_preflight_rejection=proof_path,
            frontend_preflight_rejection_sha256=hashlib.sha256(_raw(proof)).hexdigest(),
            stop_only=False,
            allow_prepared_session=False,
            saved_authoring_checkpoint=None,
            saved_authoring_checkpoint_sha256=None,
            frontend_frozen_resume=None,
            frontend_frozen_resume_sha256=None,
        )
        return control, args, source_identity["source_root"], child, proof_path

    @staticmethod
    def write_proof(control, path, proof):
        control.files[path] = _raw(proof)

    @staticmethod
    def begin_operation(control, phase):
        token = "d" * 32
        operation = {
            "lease_ready": True,
            "receipt": {"phase": phase, "attempt": token},
            "helper_container_id": control.helper_id,
        }
        control._active_operation = operation
        control.files["active"] = (token + "\n").encode("ascii")
        return operation

    def test_valid_proof_is_bound_before_and_under_the_owning_lease(self):
        control, args, selected, _child, _path = self.fixture()
        before = rejection.validate(control, args, selected, mode="restart-idle")
        self.assertEqual(before["parent_attempt"], args.attempt)
        operation = self.begin_operation(control, "iteration")
        under_lease = rejection.validate(
            control, args, selected, mode="restart-idle", operation=operation
        )
        self.assertEqual(under_lease, before)

    def test_refresh_proof_uses_the_development_lease(self):
        control, args, selected, _child, _path = self.fixture()
        before = rejection.validate(control, args, selected, mode="refresh-frontend")
        operation = self.begin_operation(control, "development")
        self.assertEqual(
            rejection.validate(control, args, selected, mode="refresh-frontend", operation=operation),
            before,
        )

    def test_changed_failed_current_receipt_or_terminal_is_rejected(self):
        for relative in (
            "development/current.json",
            "development/attempts/" + "b" * 32 + "/receipt.json",
            "development/attempts/" + "b" * 32 + "/terminal.json",
        ):
            with self.subTest(relative=relative):
                control, args, selected, _child, _path = self.fixture()
                control.files[relative] += b" "
                with self.assertRaises(BuildControlError):
                    rejection.validate(control, args, selected, mode="refresh-frontend")

    def test_changed_verified_parent_is_rejected(self):
        control, args, selected, _child, _path = self.fixture()
        control.files["development/verified.json"] += b" "
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

    def test_bad_parent_linkage_and_bad_error_are_rejected_even_with_new_raw_pins(self):
        cases = (
            ("frontend_refresh_from_attempt", "f" * 32, None),
            ("source_root", "/another/worktree", None),
            ("error", None, "RuntimeError: a different refusal"),
        )
        for linkage_key, linkage_value, error_value in cases:
            with self.subTest(linkage_key=linkage_key):
                control, args, selected, child, proof_path = self.fixture()
                if linkage_key == "error":
                    child["error"] = error_value
                else:
                    child["inputs"][linkage_key] = linkage_value
                changed_raw = _raw(child)
                child_root = "development/attempts/" + child["attempt"] + "/"
                for relative in (
                    "development/current.json",
                    child_root + "receipt.json",
                    child_root + "terminal.json",
                ):
                    control.files[relative] = changed_raw
                proof = json.loads(control.files[proof_path].decode("utf-8"))
                proof["failed_current_sha256"] = hashlib.sha256(changed_raw).hexdigest()
                proof["failed_receipt_sha256"] = hashlib.sha256(changed_raw).hexdigest()
                proof["failed_terminal_sha256"] = hashlib.sha256(changed_raw).hexdigest()
                self.write_proof(control, proof_path, proof)
                args.frontend_preflight_rejection_sha256 = hashlib.sha256(_raw(proof)).hexdigest()
                with self.assertRaises(BuildControlError):
                    rejection.validate(control, args, selected, mode="refresh-frontend")

    def test_post_preflight_marker_and_foreign_lease_are_rejected(self):
        for marker in rejection.PRE_SERVICE_MARKERS:
            with self.subTest(marker=marker):
                control, args, selected, child, _path = self.fixture()
                control.files["development/attempts/" + child["attempt"] + "/" + marker] = b"{}\n"
                with self.assertRaises(BuildControlError):
                    rejection.validate(control, args, selected, mode="restart-idle")

        control, args, selected, _child, _path = self.fixture()
        control.files["active"] = ("f" * 32 + "\n").encode("ascii")
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

    def test_under_lease_proof_drift_is_rejected(self):
        control, args, selected, _child, _path = self.fixture()
        rejection.validate(control, args, selected, mode="restart-idle")
        operation = self.begin_operation(control, "iteration")
        control.files["development/current.json"] += b" "
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle", operation=operation)

    def test_displaced_current_requires_a_proof_but_matching_current_is_compatible(self):
        control, args, selected, _child, _path = self.fixture()
        args.frontend_preflight_rejection = None
        args.frontend_preflight_rejection_sha256 = None
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

        control, args, selected, _child, _path = self.fixture()
        args.frontend_preflight_rejection = None
        args.frontend_preflight_rejection_sha256 = None
        parent_raw = control.files["development/attempts/" + args.attempt + "/terminal.json"]
        control.files["development/current.json"] = parent_raw
        self.assertIsNone(rejection.validate(control, args, selected, mode="restart-idle"))

    def test_existing_frozen_and_saved_authoring_proofs_keep_their_own_recovery_path(self):
        control, args, selected, _child, _path = self.fixture()
        args.frontend_preflight_rejection = None
        args.frontend_preflight_rejection_sha256 = None
        args.frontend_frozen_resume = "c" * 32
        args.frontend_frozen_resume_sha256 = "f" * 64
        self.assertIsNone(rejection.validate(control, args, selected, mode="refresh-frontend"))

        control, args, selected, _child, _path = self.fixture()
        args.frontend_preflight_rejection = None
        args.frontend_preflight_rejection_sha256 = None
        args.saved_authoring_checkpoint = "verification/saved-authoring/checkpoint.json"
        args.saved_authoring_checkpoint_sha256 = "f" * 64
        self.assertIsNone(rejection.validate(control, args, selected, mode="restart-idle"))

    def test_unrelated_displaced_terminal_still_requires_current_authority(self):
        control, args, selected, child, _path = self.fixture()
        child["error"] = "RuntimeError: another failure"
        control.files["development/current.json"] = _raw(child)
        args.frontend_preflight_rejection = None
        args.frontend_preflight_rejection_sha256 = None
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

    def test_current_authority_drift_under_lease_is_rejected(self):
        control, args, selected, child, _path = self.fixture()
        args.frontend_preflight_rejection = None
        args.frontend_preflight_rejection_sha256 = None
        parent_raw = control.files["development/attempts/" + args.attempt + "/terminal.json"]
        control.files["development/current.json"] = parent_raw
        rejection.validate(control, args, selected, mode="restart-idle")
        operation = self.begin_operation(control, "iteration")
        control.files["development/current.json"] = _raw(child)
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle", operation=operation)

    def test_under_lease_rejects_a_changed_owner_marker_or_helper(self):
        for drift in ("marker", "helper"):
            with self.subTest(drift=drift):
                control, args, selected, _child, _path = self.fixture()
                operation = self.begin_operation(control, "iteration")
                if drift == "marker":
                    control.files["active"] = ("f" * 32 + "\n").encode("ascii")
                else:
                    control.helper_id = "f" * 64
                with self.assertRaises(BuildControlError):
                    rejection.validate(
                        control, args, selected, mode="restart-idle", operation=operation
                    )

    def test_proof_pair_path_and_recovery_mode_are_fail_closed(self):
        control, args, selected, _child, _path = self.fixture()
        args.frontend_preflight_rejection_sha256 = None
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

        control, args, selected, _child, _path = self.fixture()
        args.frontend_preflight_rejection_sha256 = "f" * 64
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

        control, args, selected, _child, _path = self.fixture()
        args.frontend_preflight_rejection = "verification/frontend-preflight-rejection/../proof.json"
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

        control, args, selected, _child, _path = self.fixture()
        args.stop_only = True
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")

        control, args, selected, _child, _path = self.fixture()
        args.frontend_frozen_resume = "c" * 32
        args.frontend_frozen_resume_sha256 = "f" * 64
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="refresh-frontend")

    def test_proof_source_identity_is_exact(self):
        control, args, selected, _child, proof_path = self.fixture()
        proof = json.loads(control.files[proof_path].decode("utf-8"))
        proof["source_identity"]["source_root"] = "/another/worktree"
        self.write_proof(control, proof_path, proof)
        args.frontend_preflight_rejection_sha256 = hashlib.sha256(_raw(proof)).hexdigest()
        with self.assertRaises(BuildControlError):
            rejection.validate(control, args, selected, mode="restart-idle")


if __name__ == "__main__":
    unittest.main()
