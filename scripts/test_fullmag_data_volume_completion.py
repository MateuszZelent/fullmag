"""Final registration commit proof; real tiny files, no Docker or mounts."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from scripts import fullmag_data_volume_completion as completion
from scripts import fullmag_data_volume_guard as guard
from scripts import fullmag_data_volume_journal as journal
from scripts.test_fullmag_data_volume_pending import GuardFixture


def encoded(value):
    return (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode()


class CompletionFixture:
    def __init__(self, test, *, qualified_change=None, runtime_change=None, registered_change=None):
        self.guard = GuardFixture(test)
        self.pending = self.guard.marker()
        self.guard.write_marker(self.pending)
        self.op = Path(self.guard.layout["storage_root"]) / "migrations/data-volumes" / self.pending["volume_id"]
        self.op.mkdir(parents=True)
        self.scope = {key: self.pending[key] for key in ("volume_id", "compose_project", "source_root")}
        restart_sha = self.write("restart-result.json", dict(self.scope,
            schema="fullmag.data-volume-restart-result.v1", state="runtime-started-not-scientifically-qualified",
            namespace_admitted=True, data_migrated=False, originals_retired=False))
        runtime = dict(self.scope, schema="fullmag.data-volume-runtime-qualified.v1", state="qualified")
        runtime.update(runtime_change or {})
        runtime_sha = self.write("runtime-qualified.json", runtime)
        zarr_sha = self.write("zarr-qualified.json", dict(self.scope,
            schema="fullmag.data-volume-zarr-qualified.v1", state="qualified"))
        qualified = {key: self.pending[key] for key in
            ("project_id", "worktree_id", "compose_project", "volume_id", "plan_sha256", "copy_receipt_sha256")}
        qualified.update(schema="fullmag.data-volume-migration-qualified.v1", state="runtime-and-full-zarr-qualified",
            restart_receipt_sha256=restart_sha, runtime_qualification_sha256=runtime_sha,
            zarr_qualification_sha256=zarr_sha, namespace_admitted=True, data_migrated=True, originals_retired=False)
        qualified.update(qualified_change or {})
        qualified_sha = self.write("migration-qualified.json", qualified)
        self.registration = self.guard.registration()
        self.registration["migration_receipt_sha256"] = qualified_sha
        registration_raw = self.guard.write_active_registration(self.registration)
        self.registration_sha = hashlib.sha256(registration_raw).hexdigest()
        registered = dict(schema="fullmag.data-volume-registered.v1", state="registration-pair-published",
            volume_id=self.pending["volume_id"], registration_sha256=self.registration_sha,
            migration_receipt_sha256=qualified_sha, index_path=str(self.guard.index_path),
            index_sha256_at_publication=hashlib.sha256(self.guard.index_path.read_bytes()).hexdigest())
        registered.update(registered_change or {})
        registered_sha = self.write("volume-registered.json", registered)
        current = {"schema": journal.SCHEMA, "volume_id": self.pending["volume_id"],
                   "request_sha256": self.pending["plan_sha256"], "events": []}
        for phase in journal.PHASES[:-1]:
            receipt_sha = {"runtime-qualified": runtime_sha, "zarr-qualified": zarr_sha,
                           "volume-registered": registered_sha}.get(phase, "e" * 64)
            input_sha = qualified_sha if phase == "volume-registered" else "f" * 64
            current = journal.append_terminal(journal.append_started(current, phase, input_sha), "succeeded", receipt_sha)
        self.prefix = current
        self.write("journal.json", current)
        self.witness = {key: self.pending[key] for key in
            ("volume_id", "project_id", "worktree_id", "compose_project", "plan_sha256", "copy_receipt_sha256")}
        self.witness.update(schema=completion.SCHEMA, registration_sha256=self.registration_sha,
            migration_receipt_sha256=qualified_sha, journal_relative="journal.json", journal_prefix=deepcopy(current))
        self.write("registration-committed.json", self.witness)

    def write(self, name, value):
        path = self.op / name
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = encoded(value)
        path.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def verify(self):
        return completion.verify_committed_registration(self.guard.layout, self.guard.compose_project,
            self.pending, self.registration, self.registration_sha)


class RegistrationCompletionTests(unittest.TestCase):
    def test_pending_matching_pair_without_commit_proof_cannot_start(self):
        fixture = GuardFixture(self)
        fixture.write_marker()
        fixture.write_active_registration()
        mounts, directories = fixture._probe_mocks()
        with mounts, directories, self.assertRaisesRegex(ValueError, "registration commit witness"):
            guard.verify_registered_volume(fixture.layout, fixture.compose_project)

    def test_complete_proof_allows_ordinary_guard_without_changing_any_bytes(self):
        case = CompletionFixture(self)
        paths = [path for path in case.op.rglob("*") if path.is_file()]
        before = {path: path.read_bytes() for path in paths}
        self.assertEqual(case.verify(), case.witness)
        mounts, directories = case.guard._probe_mocks()
        with mounts, directories:
            result = guard.verify_registered_volume(case.guard.layout, case.guard.compose_project)
        self.assertEqual(result["state"], "verified")
        self.assertEqual(before, {path: path.read_bytes() for path in paths})

    def test_every_fixed_receipt_is_required_and_digest_pinned(self):
        for filename in ("registration-committed.json", "volume-registered.json", "migration-qualified.json",
                         "restart-result.json", "runtime-qualified.json", "zarr-qualified.json"):
            for variant in ("missing", "changed"):
                with self.subTest(filename=filename, variant=variant):
                    case = CompletionFixture(self)
                    path = case.op / filename
                    if variant == "missing": path.unlink()
                    else: path.write_bytes(path.read_bytes() + b" ")
                    if filename == "registration-committed.json" and variant == "changed":
                        # Witness formatting is not itself an external SHA pin.
                        self.assertEqual(case.verify(), case.witness)
                    else:
                        with self.assertRaises(ValueError): case.verify()

    def test_witness_is_closed_and_bound_to_exact_registration_scope_and_path(self):
        for key, value in (("extra", True), ("registration_sha256", "0" * 64),
                           ("migration_receipt_sha256", "1" * 64), ("project_id", "foreign"),
                           ("worktree_id", "other-worktree"), ("compose_project", "foreign"),
                           ("volume_id", "d" * 32), ("plan_sha256", "2" * 64),
                           ("copy_receipt_sha256", "3" * 64), ("journal_relative", "../journal.json")):
            with self.subTest(key=key):
                case = CompletionFixture(self)
                case.witness[key] = value
                case.write("registration-committed.json", case.witness)
                with self.assertRaises(ValueError): case.verify()

    def test_coherent_but_invalid_qualified_or_registered_scope_refuses(self):
        for change in ({"extra": True}, {"namespace_admitted": False}, {"data_migrated": False},
                       {"originals_retired": True}, {"project_id": "foreign"}, {"copy_receipt_sha256": "0" * 64}):
            with self.subTest(qualified=change):
                case = CompletionFixture(self, qualified_change=change)
                with self.assertRaises(ValueError): case.verify()
        for change in ({"extra": True}, {"index_path": "/foreign/index.json"},
                       {"state": "started"}, {"index_sha256_at_publication": True}):
            with self.subTest(registered=change):
                case = CompletionFixture(self, registered_change=change)
                with self.assertRaises(ValueError): case.verify()

    def test_coherent_but_foreign_runtime_wrapper_refuses(self):
        for change in ({"volume_id": "d" * 32}, {"compose_project": "foreign"},
                       {"source_root": "/foreign/source"}, {"state": "started"}, {"schema": "foreign"}):
            with self.subTest(change=change):
                case = CompletionFixture(self, runtime_change=change)
                with self.assertRaises(ValueError): case.verify()

    def test_registration_prefix_and_current_journal_cannot_rewrite_history(self):
        for variant in ("prefix-failed", "current-failed", "prefix-short", "header", "past-event"):
            with self.subTest(variant=variant):
                case = CompletionFixture(self)
                if variant.startswith("prefix"):
                    prefix = case.witness["journal_prefix"]
                    if variant == "prefix-failed": prefix["events"][-1]["state"] = "failed-confirmed"
                    else: prefix["events"] = prefix["events"][:-2]
                    case.write("registration-committed.json", case.witness)
                else:
                    current = deepcopy(case.prefix)
                    if variant == "current-failed": current["events"][-1]["state"] = "failed-confirmed"
                    elif variant == "header": current["request_sha256"] = "0" * 64
                    else: current["events"][1]["receipt_sha256"] = "1" * 64
                    case.write("journal.json", current)
                with self.assertRaises(ValueError): case.verify()

    def test_later_legal_retirement_suffix_and_unrelated_index_changes_remain_readable(self):
        for terminal in (None, "succeeded", "failed-confirmed", "outcome-unknown-resources-retained"):
            with self.subTest(terminal=terminal):
                case = CompletionFixture(self)
                current = journal.append_started(case.prefix, "originals-retired", "a" * 64)
                if terminal is not None: current = journal.append_terminal(current, terminal, "b" * 64)
                case.write("journal.json", current)
                index = json.loads(case.guard.index_path.read_bytes())
                index["unrelated"] = {"updated": "legal"}
                case.guard.index_path.write_bytes(encoded(index))
                self.assertEqual(case.verify(), case.witness)

    def test_selected_recovery_journal_must_be_the_exact_witness_path(self):
        case = CompletionFixture(self)
        parent = {key: deepcopy(case.prefix[key]) for key in ("schema", "volume_id", "request_sha256")}
        parent["events"] = []
        parent = journal.append_terminal(journal.append_started(parent, "image-created", "a" * 64),
                                         "failed-confirmed", "b" * 64)
        parent_sha = case.write("journal.json", parent)
        relative = "recovery/" + "f" * 32 + "/journal.json"
        case.write(relative, case.prefix)
        case.write("active-attempt.json", {"schema": "fullmag.data-volume-active-recovery.v2",
            "volume_id": case.pending["volume_id"], "attempt": "f" * 32, "journal_relative": relative,
            "parent_journal_relative": "journal.json", "parent_journal_sha256": parent_sha, "state": "started"})
        with self.assertRaisesRegex(ValueError, "Selected completion journal"): case.verify()
        case.witness["journal_relative"] = relative
        case.write("registration-committed.json", case.witness)
        self.assertEqual(case.verify(), case.witness)

    def test_proof_or_registration_drift_during_readback_refuses(self):
        case = CompletionFixture(self)
        original = guard._read_optional_regular
        def changed(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if Path(path) == case.guard.registration_path:
                (case.op / "runtime-qualified.json").write_bytes(b"changed")
            return result
        with patch.object(guard, "_read_optional_regular", side_effect=changed), self.assertRaises(ValueError):
            case.verify()

    def test_registration_failure_artifact_is_not_a_retirement_failure_suffix(self):
        case = CompletionFixture(self)
        case.write("registration-failed.json", {"state": "outcome-unknown-resources-retained"})
        with self.assertRaisesRegex(ValueError, "registration failure"): case.verify()

    def test_late_registration_failure_refuses_after_all_receipts_were_read(self):
        case = CompletionFixture(self)
        original = guard._read_optional_regular
        def failure(path, *args, **kwargs):
            raw = original(path, *args, **kwargs)
            if Path(path) == case.guard.registration_path:
                case.write("registration-failed.json", {"state": "unknown"})
            return raw
        with patch.object(guard, "_read_optional_regular", side_effect=failure), self.assertRaises(ValueError):
            case.verify()

    def test_qualification_terminal_receipts_and_final_inputs_are_the_exact_pins(self):
        for phase in ("runtime-qualified", "zarr-qualified", "volume-registered"):
            with self.subTest(phase=phase):
                case = CompletionFixture(self)
                for event in case.prefix["events"]:
                    if event["phase"] == phase and (event["state"] == "succeeded" or phase == "volume-registered"):
                        event["inputs_sha256" if phase == "volume-registered" else "receipt_sha256"] = "0" * 64
                case.witness["journal_prefix"] = deepcopy(case.prefix)
                case.write("registration-committed.json", case.witness)
                case.write("journal.json", case.prefix)
                with self.assertRaises(ValueError): case.verify()


if __name__ == "__main__":
    unittest.main()
