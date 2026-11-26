"""Generated authoring restart checks; no backend lifecycle or Solve."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from docker_build_control import BuildControlError, canonical
import test_docker_volume_receipts as receipt_fixtures
import docker_saved_authoring_generated as generated


class GeneratedAuthoringRestartTests(unittest.TestCase):
    def fixture(self):
        dev, pin, scene, _, files, pack, actual, proof = receipt_fixtures.SavedAuthoringRestartTests().fixture()
        source = b"raise RuntimeError('source must never execute')\\n"
        path = "/opt/fullmag/runtime-control/local-live/current/scene_document.py"
        source_pin = {"path": path, "bytes": len(source),
                      "sha256": hashlib.sha256(source).hexdigest(),
                      "archive_entry": "project/source.py"}
        files[source_pin["archive_entry"]] = source
        manifest = json.loads(files["manifest/project.json"])
        manifest["source"] = source_pin["archive_entry"]
        files["manifest/project.json"] = canonical(manifest)
        raw = pack(files)
        pin["schema"] = generated.SCHEMA
        pin["generated_source"] = source_pin
        pin["archive"].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        observation = {"path": path, "bytes": len(source), "sha256": source_pin["sha256"],
                       "workspace_root": str(Path(path).parent), "device": 1, "inode": 2,
                       "mtime_ns": 3, "ctime_ns": 4}
        proof["generated_source"] = {"before": observation.copy(), "after": observation.copy()}
        for suffix in ("before", "after"):
            script = {"origin": "generated", "writable": True, "path": path}
            proof["resources"]["current_" + suffix]["body"].update(
                script={**script, "sha256": source_pin["sha256"]}, script_path=path)
            proof["resources"]["status_" + suffix]["body"]["session"].update(
                script=script, workspace_root=str(Path(path).parent))
        return dev, pin, scene, raw, files, pack, actual, proof, source

    def validate(self, pin, proof=None, scene=None):
        import docker_volume_dev as dev
        dev._saved_authoring_validate_request(pin, project="fullmag-test", attempt="b"*32,
            config_sha256="c"*64, selected="/selected", allow_generated=True)
        if proof is not None:
            dev._saved_authoring_validate_probe(proof, pin, scene)

    def test_accepts_explicit_generated_checkpoint_and_exact_archive(self):
        dev, pin, scene, raw, _, _, actual, proof, _ = self.fixture()
        self.validate(pin, proof, scene)
        dev._saved_authoring_validate_services(pin, actual)
        self.assertEqual(dev._saved_authoring_validate_archive(
            raw, pin["archive"], generated_source=pin["generated_source"]), scene)

    def test_legacy_and_recovery_entry_points_keep_refusing_generated(self):
        dev, pin, scene, _, _, _, _, proof, _ = self.fixture()
        with self.assertRaises(BuildControlError):
            dev._saved_authoring_validate_request(pin, project="fullmag-test", attempt="b"*32,
                config_sha256="c"*64, selected="/selected")
        for schema in ("fullmag.saved-authoring-restart.v1", "fullmag.saved-empty-authoring-restart.v1"):
            old = copy.deepcopy(pin); old["schema"] = schema
            with self.subTest(schema=schema), self.assertRaises(BuildControlError):
                self.validate(old)
        old = copy.deepcopy(pin); old["schema"] = "fullmag.saved-authoring-restart.v1"
        old.pop("generated_source")
        with self.assertRaises(BuildControlError):
            dev._saved_authoring_validate_probe(proof, old, scene)

    def test_rejects_incomplete_or_mixed_checkpoint_pins(self):
        _, pin, _, _, _, _, _, _, _ = self.fixture()
        mutations = [
            lambda x: x.pop("generated_source"),
            lambda x: x["generated_source"].update(bytes=True),
            lambda x: x["generated_source"].update(bytes=8*1024**2+1),
            lambda x: x["generated_source"].update(sha256="unknown"),
            lambda x: x["generated_source"].update(path="/outside/exports/foo.py"),
            lambda x: x["generated_source"].update(archive_entry="project/foreign.py"),
            lambda x: x.update(cancelled_preclaim={}),
            lambda x: x.update(historical_preclaim={}),
        ]
        for mutate in mutations:
            bad = copy.deepcopy(pin);mutate(bad)
            with self.subTest(mutate=mutate), self.assertRaises((BuildControlError, ValueError)):
                self.validate(bad)

    def test_rejects_changed_source_scope_and_active_runtime(self):
        _, pin, scene, _, _, _, _, proof, _ = self.fixture()
        mutations = [
            lambda x: x["resources"]["current_after"]["body"]["script"].update(origin="user_file"),
            lambda x: x["resources"]["current_before"]["body"]["script"].update(writable=False),
            lambda x: x["resources"]["current_after"]["body"].update(script_path="/foreign.py"),
            lambda x: x["resources"]["current_after"]["body"]["script"].update(sha256="f"*64),
            lambda x: x["resources"]["status_after"]["body"]["session"].update(workspace_root="/other"),
            lambda x: x["resources"]["status_after"]["body"]["session"].update(request_scope_epoch="other:1"),
            lambda x: x["resources"]["status_before"]["body"].update(run={"run_id": "active"}),
            lambda x: x["resources"]["preparation"].update(status=200),
            lambda x: x["resources"]["queue"]["body"].update(items=[{"state": "queued"}]),
            lambda x: x["resources"]["commands"]["body"].update(accepted_count=1),
            lambda x: x["resources"]["mesh"].update(status=200, body={"active_build": {}}),
            lambda x: x["resources"]["scene_after"]["body"].update(objects=[{"id": "changed"}]),
            lambda x: x.update(reservation_states=["active"]),
            lambda x: x.update(run_directories=["foreign"]),
            lambda x: x["generated_source"]["after"].update(inode=99),
            lambda x: x["generated_source"]["after"].update(sha256="f"*64),
            lambda x: x["generated_source"]["after"].update(bytes=0),
        ]
        for mutate in mutations:
            bad = copy.deepcopy(proof);mutate(bad)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                self.validate(pin, bad, scene)

    def test_rejects_archive_with_different_generated_bytes_or_entry(self):
        dev, pin, _, _, files, pack, _, _, _ = self.fixture()
        for change in ("content", "entry"):
            bad = copy.deepcopy(files)
            if change == "content":
                bad["project/source.py"] += b"changed"
            else:
                manifest = json.loads(bad["manifest/project.json"]);manifest["source"] = None
                bad["manifest/project.json"] = canonical(manifest)
                bad.pop("project/source.py")
            raw = pack(bad);archive_pin = {**pin["archive"], "bytes": len(raw),
                                          "sha256": hashlib.sha256(raw).hexdigest()}
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                dev._saved_authoring_validate_archive(raw, archive_pin,
                    generated_source=pin["generated_source"])

    def test_guest_source_observation_checks_real_files_without_executing_them(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp);path = workspace/"scene_document.py"
            content = b"raise RuntimeError('not executed')"
            path.write_bytes(content)
            pin = {"path": str(path), "bytes": len(content),
                   "sha256": hashlib.sha256(content).hexdigest(), "archive_entry": "project/source.py"}
            scope = {};exec(generated.PROBE_FUNCTION, scope)
            observe = scope["observe_generated_source"]
            first = observe(pin, workspace)
            self.assertEqual(first["sha256"], pin["sha256"])
            self.assertEqual(first, observe(pin, workspace))
            replacement = workspace/"replacement.py";replacement.write_bytes(content)
            os.replace(replacement, path)
            self.assertNotEqual(first["inode"], observe(pin, workspace)["inode"])
            with self.assertRaises(RuntimeError):observe(pin, workspace/"other")
            path.write_bytes(b"changed")
            with self.assertRaises(RuntimeError):observe(pin, workspace)
            path.unlink();outside = workspace/"other.py";outside.write_bytes(content)
            path.symlink_to(outside)
            with self.assertRaises(RuntimeError):observe(pin, workspace)
            path.unlink();os.link(outside,path)
            with self.assertRaises(RuntimeError):observe(pin, workspace)
            path.unlink();path.write_bytes(b"x"*(8*1024**2+1))
            with self.assertRaises(RuntimeError):observe(pin, workspace)


if __name__ == "__main__":
    unittest.main()
