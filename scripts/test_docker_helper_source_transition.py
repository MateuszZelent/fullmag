"""Verify exact sealed-app/current-helper transitions without executing native code."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import docker_helper_source as helper

_spec = importlib.util.spec_from_file_location(
    "transition_backend_source", Path(__file__).resolve().parents[1] / "docker/all-in-one/backend_source.py")
_backend_source = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_backend_source)
capture_bytes = _backend_source._live_canonical


def tree_bytes(files):
    return b"".join((row["mode"] + " blob " + row["sha256"][:40] + "\t" + row["path"]).encode()
                    + b"\0" for row in sorted(files, key=lambda value: value["path"]))


def git_tree_bytes(tree):
    return b"".join((row["mode"] + " " + row["type"] + " " + row["blob"] + "\t" + name).encode()
                    + b"\0" for name, row in sorted(tree.items()))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def capture(commit, files, tree):
    capsule = {"schema_version": "fullmag.source-capsule.v1", "source_mode": "snapshot",
               "resolved_commit": commit, "files": files, "deleted": [],
               "included_untracked": [], "excluded": []}
    digest = sha(capture_bytes(capsule))
    capsule.update(entries=files, source_digest=digest, source_digest_sha256=digest,
                   schema="fullmag.source-capsule.v1", manifest_filename="manifest.json",
                   repo_root="/opt/fullmag/source", git_common_dir="/opt/fullmag/source-git",
                   requested_ref=None, head_commit=commit, dirty=True, working_tree_dirty=False)
    native = {"schema": "fullmag.source-snapshot.v2", "head_commit_full": commit,
              "head_tree_sha256": sha(tree_bytes(files)), "git_status_porcelain_v1": [],
              "dirty_path_content": [], "ignored_non_runtime_dirty": True}
    native["source_snapshot_sha256"] = sha(capture_bytes(native))
    native.update(source_snapshot_dirty=False, dirty_content_sha256=sha(b"[]\n"))
    value = {"schema": "fullmag.docker-backend-live-source.v1", "resolved_commit": commit,
             "source_manifest": capsule, "source_manifest_sha256": sha(capture_bytes(capsule)),
             "native_source_identity": native, "source_snapshot_sha256": native["source_snapshot_sha256"],
             "source_digest": digest, "git_object_ids": {},
             "source_root": "/opt/fullmag/source", "git_common_dir": "/opt/fullmag/source-git",
             "source_mode": "live-shadow-v1"}
    value["live_manifest_sha256"] = sha(capture_bytes(value))
    return value


class SameRootTransitionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app_commit, self.helper_commit = "a" * 40, "b" * 40
        self.old_name = "scripts/docker_volume_dev.py"
        self.new_name = "scripts/docker_volume_frontend_frozen_recovery.py"
        self.physics = {"path": "crates/physics.rs", "mode": "100644",
                        "sha256": "1" * 64, "size": 100, "type": "file"}
        old = {"path": self.old_name, "mode": "100644", "sha256": "2" * 64, "size": 100, "type": "file"}
        changed = {**old, "sha256": "3" * 64}
        added = {"path": self.new_name, "mode": "100644", "sha256": "4" * 64, "size": 100, "type": "file"}
        self.before = capture(self.app_commit, [self.physics, old], b"base-tree")
        self.after = capture(self.helper_commit, [self.physics, changed, added], b"helper-tree")
        self.raw_base = capture_bytes(self.before)
        self.app = {"commit": self.app_commit, "source_digest": self.before["source_digest"],
                    "snapshot": self.before["source_snapshot_sha256"],
                    "native": self.before["native_source_identity"], "manifest_sha256": sha(self.raw_base)}
        self.binding = {"schema": helper.SCHEMA, "root": str(self.root), "app_source_root": str(self.root),
                        "commit": self.helper_commit, "files": []}
        self.value = {"schema": helper.SAME_ROOT_TRANSITION_SCHEMA, "app_source": self.app,
                      "helper_source": self.binding, "submodules": {}, "excluded_files": {}, "changes": {
            self.old_name: {"base_sha256": old["sha256"], "candidate_sha256": changed["sha256"],
                            "base_mode": "100644", "candidate_mode": "100644"},
            self.new_name: {"base_sha256": None, "candidate_sha256": added["sha256"],
                            "base_mode": None, "candidate_mode": "100644"}}}
        self.receipt = {"manifest_sha256": sha(self.raw_base),
                        "live_manifest_sha256": self.before["live_manifest_sha256"]}
        tree = lambda files: {row["path"]: {"mode": row["mode"], "type": "blob",
                                           "blob": row["sha256"][:40]} for row in files}
        self.old_tree = tree(self.before["source_manifest"]["files"])
        self.new_tree = tree(self.after["source_manifest"]["files"])
        self.index = {name: [{"mode": row["mode"], "blob": row["blob"], "stage": "0"}]
                      for name, row in self.new_tree.items()}
        self.status = b""

    def rebind_tree_hashes(self):
        for document, tree in ((self.before, self.old_tree), (self.after, self.new_tree)):
            native = document["native_source_identity"]
            native["head_tree_sha256"] = sha(git_tree_bytes(tree))
            core = {key: native[key] for key in (
                "schema", "head_commit_full", "head_tree_sha256", "git_status_porcelain_v1",
                "dirty_path_content", "ignored_non_runtime_dirty")}
            native["source_snapshot_sha256"] = sha(capture_bytes(core))
            document["source_snapshot_sha256"] = native["source_snapshot_sha256"]
            del document["live_manifest_sha256"]
            document["live_manifest_sha256"] = sha(capture_bytes(document))
        self.raw_base = capture_bytes(self.before)
        self.app.update(snapshot=self.before["source_snapshot_sha256"],
                        manifest_sha256=sha(self.raw_base))
        self.receipt.update(manifest_sha256=sha(self.raw_base),
                            live_manifest_sha256=self.before["live_manifest_sha256"])

    def verify(self, value=None, current=None, receipt=None, raw_base=None, expected_sha=None):
        value = self.value if value is None else value
        raw = helper._canonical(value)
        def git(root, *args, **kwargs):
            if args[:1] == ("status",):
                return self.status
            if args[:1] == ("ls-tree",):
                return git_tree_bytes(self.old_tree if self.app_commit in args else self.new_tree)
            self.fail("unexpected Git query: " + repr(args))
        with patch.object(helper, "_same_root_executed_helpers"), \
             patch.object(helper, "revalidate_binding", return_value=self.binding), \
             patch.object(helper, "_git", side_effect=git), \
             patch.object(helper, "_read_tree", side_effect=[self.old_tree, self.new_tree]), \
             patch.object(helper, "_read_index", return_value=self.index):
            return helper.verify_same_root_transition(
                raw, sha(raw) if expected_sha is None else expected_sha, self.raw_base if raw_base is None else raw_base,
                self.after if current is None else current, self.app,
                self.receipt if receipt is None else receipt, self.root,
                base_context_files=(), runtime_context_files=())

    def test_exact_helper_only_transition_keeps_both_source_identities(self):
        result = self.verify()
        self.assertEqual(result["app_source"]["commit"], self.app_commit)
        self.assertEqual(result["helper_source"]["commit"], self.helper_commit)
        self.assertNotEqual(result["app_source"]["commit"], result["helper_source"]["commit"])

    def test_base_capture_must_be_the_sealed_receipt_input(self):
        with self.assertRaisesRegex(helper.HelperSourceError, "sealed package input"):
            self.verify(receipt={**self.receipt, "manifest_sha256": "f" * 64})

    def test_complete_file_map_forbids_unreviewed_physics_change(self):
        files = copy.deepcopy(self.after["source_manifest"]["files"])
        files[0]["sha256"] = "f" * 64
        changed = capture(self.helper_commit, files, b"helper-tree")
        with self.assertRaisesRegex(helper.HelperSourceError, "Entire source file map"):
            self.verify(current=changed)

    def test_reviewed_manifest_cannot_add_a_path_outside_closed_set(self):
        value = copy.deepcopy(self.value)
        value["changes"]["crates/physics.rs"] = value["changes"][self.old_name]
        with self.assertRaisesRegex(helper.HelperSourceError, "closed helper path"):
            self.verify(value=value)

    def test_exact_hash_mode_and_new_file_absence_are_required(self):
        for key, invalid in (("base_sha256", "f" * 64), ("candidate_sha256", "f" * 64),
                             ("base_mode", "100755"), ("candidate_mode", "120000")):
            value = copy.deepcopy(self.value)
            value["changes"][self.old_name][key] = invalid
            with self.subTest(key=key), self.assertRaises(helper.HelperSourceError):
                self.verify(value=value)
        value = copy.deepcopy(self.value)
        value["changes"][self.new_name]["base_sha256"] = "f" * 64
        with self.assertRaises(helper.HelperSourceError):
            self.verify(value=value)

    def test_entire_index_and_untracked_status_must_be_clean(self):
        self.index["foreign"] = [{"mode": "100644", "blob": "f" * 40, "stage": "0"}]
        with self.assertRaisesRegex(helper.HelperSourceError, "Entire helper index"):
            self.verify()
        del self.index["foreign"]
        self.status = b"?? untracked.py\0"
        with self.assertRaisesRegex(helper.HelperSourceError, "unreviewed change"):
            self.verify()

    def test_unreviewed_tree_change_is_rejected_even_if_file_hash_map_matches(self):
        self.new_tree["foreign"] = {"mode": "160000", "type": "commit", "blob": "f" * 40}
        self.index["foreign"] = [{"mode": "160000", "blob": "f" * 40, "stage": "0"}]
        self.rebind_tree_hashes()
        with self.assertRaisesRegex(helper.HelperSourceError, "Entire committed tree"):
            self.verify()

    def test_capsule_exclusions_and_sparse_objects_cannot_change(self):
        for key in ("excluded", "deleted", "included_untracked"):
            changed = copy.deepcopy(self.after)
            changed["source_manifest"][key] = ["foreign"]
            core = {k: changed["source_manifest"][k] for k in (
                "schema_version", "source_mode", "resolved_commit", "files", "deleted", "included_untracked", "excluded")}
            changed["source_manifest"]["source_digest"] = sha(capture_bytes(core))
            changed["source_digest"] = changed["source_manifest"]["source_digest"]
            changed["source_manifest"]["source_digest_sha256"] = changed["source_digest"]
            changed["source_manifest_sha256"] = sha(capture_bytes(changed["source_manifest"]))
            del changed["live_manifest_sha256"]
            changed["live_manifest_sha256"] = sha(capture_bytes(changed))
            with self.subTest(key=key), self.assertRaisesRegex(helper.HelperSourceError, "inventory changed"):
                self.verify(current=changed)
        changed = copy.deepcopy(self.after)
        changed["git_object_ids"]["foreign"] = "f" * 40
        del changed["live_manifest_sha256"]
        changed["live_manifest_sha256"] = sha(capture_bytes(changed))
        with self.assertRaisesRegex(helper.HelperSourceError, "Sparse source objects"):
            self.verify(current=changed)



    def test_reviewed_manifest_raw_cas_cannot_be_replaced(self):
        with self.assertRaisesRegex(helper.HelperSourceError, "transition CAS"):
            self.verify(expected_sha="f" * 64)

    def test_exact_empty_uninitialized_gitlinks_are_rechecked(self):
        name = "external_solvers/solver"
        entry = {"mode": "160000", "type": "commit", "blob": "f" * 40}
        self.old_tree[name] = dict(entry)
        self.new_tree[name] = dict(entry)
        self.index[name] = [{"mode": "160000", "blob": "f" * 40, "stage": "0"}]
        child = self.root / name
        child.mkdir(parents=True)
        self.value["submodules"][name] = {"gitlink": "f" * 40, "state": "uninitialized_empty"}
        self.rebind_tree_hashes()
        self.verify()
        (child / "foreign").write_text("changed")
        with self.assertRaisesRegex(helper.HelperSourceError, "Physical submodule state"):
            self.verify()

    def test_executing_helper_cannot_come_from_an_unbound_root(self):
        self.binding["files"] = [{"path": "scripts/docker_helper_source.py"}]
        with self.assertRaisesRegex(helper.HelperSourceError, "executing helper"):
            helper._same_root_executed_helpers(self.root, self.binding)



    def test_capture_serializer_is_the_existing_backend_source_lf_contract(self):
        self.assertTrue(capture_bytes(self.before).endswith(b"\n"))
        self.assertNotEqual(sha(helper._canonical(self.before)), sha(capture_bytes(self.before)))
        self.assertEqual(helper._transition_capture(self.before)[0], self.before["source_manifest"])

    def test_only_exact_preexisting_fms_baseline_is_preserved(self):
        name = "examples/fem_antenna_closed_loop_nonmagnetic.20261022.fms"
        path = self.root / name
        path.parent.mkdir()
        path.write_bytes(b"foreign saved scene")
        self.value["excluded_files"][name] = {
            "sha256": sha(path.read_bytes()), "size": len(path.read_bytes()),
            "mode": "100644", "status": "??"}
        self.status = b"?? " + name.encode() + b"\0"
        self.verify()
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(helper.HelperSourceError, "FMS bytes/mode/size"):
            self.verify()
        self.value["excluded_files"]["scripts/untrusted.py"] = self.value["excluded_files"][name]
        with self.assertRaisesRegex(helper.HelperSourceError, "closed FMS"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
