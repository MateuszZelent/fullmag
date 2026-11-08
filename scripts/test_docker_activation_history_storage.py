"""Exercise real filesystem archival, fencing, and crash reentry."""
import copy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import docker_activation_history_policy as policy
import docker_activation_history_storage as storage
from test_docker_activation_history_policy import fixture, qualify, TOKEN, PROJECT, VOLUME, raw


@unittest.skipUnless(os.name == "posix", "The managed history filesystem is Linux")
class HistoryStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "control"
        self.root.mkdir()
        (self.root / "operation.lock").touch()
        self.attempts = self.root / "activation/attempts"
        self.attempts.mkdir(parents=True)
        self.source = self.attempts / TOKEN
        self.source.mkdir()
        files, catalog, intent = fixture()
        self.files = files
        for name, content in files.items():
            (self.source / name).write_bytes(content)
        self.candidate = qualify(files, catalog, intent)
        self.identity = {"compose_project": PROJECT, "control_volume": VOLUME, "namespace": ""}
        self.evidence = "e" * 64

    def plan(self):
        return storage.make_plan(self.root, [self.candidate], identity=self.identity,
                                 external_evidence_sha256=self.evidence, protected=set())

    def apply(self, plan, **kwargs):
        return storage.apply_plan(self.root, plan, expected_plan_sha256=policy.digest(policy.canonical(plan)),
                                  fresh_external_evidence=kwargs.pop("fresh_external_evidence", lambda: self.evidence),
                                  **kwargs)

    def assert_archive(self):
        destination = self.root / "activation/history-v1" / TOKEN
        self.assertFalse(self.source.exists())
        for name, content in self.files.items():
            self.assertEqual((destination / name).read_bytes(), content)
        from docker_build_control import control_read_script
        script = control_read_script("/control/activation/attempts/" + TOKEN + "/terminal.json")
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", script.replace("/control", str(self.root))],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, self.files["terminal.json"])
        return destination

    def test_build_control_cannot_write_an_archived_attempt(self):
        self.apply(self.plan())
        from docker_build_control import BuildControl, BuildControlError
        control = object.__new__(BuildControl)
        control.namespace = ""
        def helper(script):
            return ["bash", "-euo", "pipefail", "-c", script.replace("/control", str(self.root))]
        with mock.patch.object(control, "helper_args", side_effect=helper):
            with self.assertRaises(BuildControlError):
                control.write_bytes("activation/attempts/" + TOKEN + "/new.json", b"{}\n")
            with self.assertRaisesRegex(BuildControlError, "immutable"):
                control.write_bytes("activation/history-v1/" + TOKEN + "/terminal.json", b"{}\n")
        self.assert_archive()
        self.assertFalse(self.source.exists())

    def test_full_pool_frees_one_slot_without_changing_admission_limit(self):
        for index in range(63):
            (self.attempts / f"{index:032x}").mkdir()
        from docker_build_control import BuildControl
        control = object.__new__(BuildControl)
        control.namespace = ""
        next_token = "d" * 32
        script = control.operation_script("activation", next_token).replace("/control", str(self.root))
        before = subprocess.run(["bash", "-euo", "pipefail", "-c", script], input=b"", capture_output=True)
        self.assertNotEqual(before.returncode, 0)
        self.assertFalse((self.root / "active").exists())
        self.assertEqual(len(list(self.attempts.iterdir())), 64)
        receipt = self.apply(self.plan())
        self.assertEqual(receipt["attempts"], [TOKEN])
        self.assert_archive()
        process = subprocess.Popen(["bash", "-euo", "pipefail", "-c", script],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(process.stdout.readline(), b"READY\n")
            process.stdin.close()
            self.assertEqual(process.stdout.readline(), b"LOGGED\n")
            (self.attempts / next_token / "terminal.json").write_bytes(b"{}\n")
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertFalse((self.root / "active").exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            process.stderr.close()

    def test_crash_at_each_publication_boundary_reenters_exact_plan(self):
        for phase in ("before-metadata", "after-metadata", "before-rename", "after-rename"):
            with self.subTest(phase=phase):
                # Each crash case gets independent source bytes and lock identity.
                case = HistoryStorageTests("test_idempotent_reentry")
                case.setUp()
                try:
                    plan = case.plan()
                    def stop(observed):
                        if observed == phase:
                            raise RuntimeError("injected interruption")
                    with self.assertRaisesRegex(RuntimeError, "injected"):
                        case.apply(plan, checkpoint=stop)
                    if phase == "after-rename":
                        case.assert_archive()
                    else:
                        for name, content in case.files.items():
                            self.assertEqual((case.source / name).read_bytes(), content)
                    case.apply(plan)
                    case.assert_archive()
                finally:
                    case.doCleanups()

    def test_idempotent_reentry(self):
        plan = self.plan()
        first = self.apply(plan)
        self.assertEqual(self.apply(plan), first)
        self.assert_archive()

    def test_modified_original_bytes_or_external_proof_block_before_move(self):
        plan = self.plan()
        with self.assertRaisesRegex(policy.HistoryError, "External"):
            self.apply(plan, fresh_external_evidence=lambda: "f" * 64)
        (self.source / "build.log").write_bytes(b"changed")
        with self.assertRaisesRegex(policy.HistoryError, "bytes changed"):
            self.apply(plan)
        self.assertTrue(self.source.exists())

    def test_current_pointer_race_and_forged_protection_refuse(self):
        plan = self.plan()
        current = self.root / "activation/current.json"
        current.write_bytes(raw({"attempt": TOKEN}))
        with self.assertRaisesRegex(policy.HistoryError, "guard pointers"):
            self.apply(plan)
        # A matching digest is not permission to archive the current attempt.
        plan["guard_files"]["activation/current.json"] = policy.digest(current.read_bytes())
        plan["protected"] = []
        with self.assertRaisesRegex(policy.HistoryError, "protected"):
            self.apply(plan)

    def test_active_marker_and_competing_lock_refuse(self):
        import fcntl
        plan = self.plan()
        with (self.root / "operation.lock").open("rb") as owner:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(policy.HistoryError, "active"):
                self.apply(plan)
        (self.root / "active").write_text("other-owner\n")
        with self.assertRaisesRegex(policy.HistoryError, "activity"):
            self.apply(plan)
        self.assertEqual((self.root / "active").read_text(), "other-owner\n")

    def test_links_and_duplicate_pool_entries_refuse(self):
        plan = self.plan()
        (self.source / "linked.json").symlink_to(self.source / "receipt.json")
        with self.assertRaises(policy.HistoryError):
            self.apply(plan)
        (self.source / "linked.json").unlink()
        (self.root / "activation/history-v1" / TOKEN).mkdir(parents=True)
        with self.assertRaisesRegex(policy.HistoryError, "pool changed"):
            self.apply(plan)

    def test_prepared_metadata_cannot_be_reassigned_to_another_plan(self):
        plan = self.plan()
        def stop(phase):
            if phase == "after-metadata":
                raise RuntimeError("interrupted")
        with self.assertRaises(RuntimeError):
            self.apply(plan, checkpoint=stop)
        with self.assertRaisesRegex(policy.HistoryError, "retained plan"):
            self.plan()
        changed = copy.deepcopy(plan)
        changed["identity"]["compose_project"] = "other"
        with self.assertRaisesRegex(policy.HistoryError, "metadata differs"):
            self.apply(changed)
        self.apply(plan)
        self.assert_archive()

    def test_new_pool_entry_after_preview_and_changed_lock_refuse(self):
        plan = self.plan()
        (self.attempts / ("f" * 32)).mkdir()
        with self.assertRaisesRegex(policy.HistoryError, "pool changed"):
            self.apply(plan)
        changed = copy.deepcopy(plan)
        changed["operation_lock"]["inode"] += 1
        with self.assertRaisesRegex(policy.HistoryError, "lock inode"):
            self.apply(changed)


if __name__ == "__main__":
    unittest.main()


class RejectedHistoryStorageTests(HistoryStorageTests):
    """Exercise the same crash/resume/fencing/readback contract with run_id=null."""
    def setUp(self):
        super().setUp()
        from test_docker_activation_history_policy import RejectedHistoryTests
        self.files = RejectedHistoryTests().evidence()
        for name, content in self.files.items():
            (self.source / name).write_bytes(content)
        self.candidate = policy.qualify_rejected_activation(TOKEN, self.files,
            project=PROJECT, volume=VOLUME, namespace="", store_records={}, inventory_paths=[])

    def test_all_original_paths_read_exact_rejected_bytes(self):
        self.apply(self.plan())
        from docker_build_control import control_read_script
        for name, expected in self.files.items():
            script = control_read_script("/control/activation/attempts/"+TOKEN+"/"+name)
            result = subprocess.run(["bash","-euo","pipefail","-c",script.replace("/control",str(self.root))],capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,expected)
