"""Focused interpreted regressions for volume bootstrap admission."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock

import docker_build_control as control


LOW_SPACE = {"available_bytes": 8 * 1024**3}
LOW_CONTROL_SPACE = {"available_bytes": control.MIN_FREE_CONTROL_BYTES - 1}
HELPER = "registry.invalid/cuda@sha256:" + "a" * 64
IMAGE = "sha256:" + "b" * 64
OTHER_IMAGE = "sha256:" + "c" * 64
PARENT_IMAGE = "sha256:" + "d" * 64
DEV_IMAGE = "sha256:" + "e" * 64
BACKEND_IMAGE = "sha256:" + "f" * 64
COMMIT = "c" * 40
MANIFEST = {
    "schema": "fullmag.docker.fem-gpu-dependencies.v1",
    "build": {"phase": "runtime"},
    "actual": {"source_commits": {"mfem": "m"}},
}


class StopAfterPrepare(RuntimeError):
    pass


class FakeControl:
    project = "fullmag-cache-test"
    volume = "fullmag-cache-test-control"
    image = HELPER

    def __init__(self, *, receipt=None, require_error=True, events=None,
                 stop_after_prepare=False, runtime_receipts=None):
        self.receipt = receipt
        self.require_error = require_error
        self.events = events if events is not None else []
        self.stop_after_prepare = stop_after_prepare
        self.runtime_receipts = dict(runtime_receipts or {})
        self.prepare_calls = []
        self.require_calls = []
        self.build_calls = []
        self.operation_calls = []
        self.writes = []

    def prepare(self, **kwargs):
        self.events.append("prepare")
        self.prepare_calls.append(kwargs)
        if self.stop_after_prepare:
            # Model the real prepare() reaching its image-owned helper. The
            # event must occur only after the cold pull event.
            self.helper_args("initialize")
            raise StopAfterPrepare
        return {"Name": "control"}

    def assert_windows_pre_pull_space(self):
        self.events.append("windows-pre-pull")

    def require_build_space(self, *, operation=None):
        self.require_calls.append(operation)
        if self.require_error:
            raise control.BuildControlError(
                "Docker build filesystem has less than 32 GiB free; test"
            )
        return {"available_bytes": 64 * 1024**3}

    @contextmanager
    def operation(self, phase, inputs, **kwargs):
        self.events.append("operation")
        self.operation_calls.append((phase, inputs, kwargs))
        operation = {
            "root": phase + "/attempts/" + "d" * 32,
            "receipt": {},
            "daemon_pending": False,
        }
        yield operation

    def write(self, path, value):
        self.writes.append((path, value))

    def read(self, path, *, optional=False):
        for phase, receipt in self.runtime_receipts.items():
            if path in {phase + "/verified.json", phase + "/current.json"}:
                return receipt
        if path.endswith("verified.json"):
            return self.receipt
        return None

    def helper_args(self, script, **kwargs):
        self.events.append("helper")
        return [self.image, script]

    def build(self, operation, document, service):
        self.build_calls.append((operation, document, service))


def _toolchain_config(repo):
    return {
        "name": "fullmag-cache-test",
        "services": {
            "fem-gpu-toolchain": {
                "build": {
                    "context": str(repo),
                    "dockerfile": "docker/fem-gpu/Dockerfile",
                    "target": "fem-gpu-dev",
                    "args": {"FULLMAG_CUDA_BASE_IMAGE": HELPER},
                },
                "image": "fullmag/toolchain:inputs-test",
            }
        },
    }


class BuildSpaceAdmissionTests(unittest.TestCase):
    def _run_toolchain(self, fake, *, base_present=True, inspected_image=IMAGE,
                       pull_events=None):
        repo = Path(__file__).resolve().parent
        configured = _toolchain_config(repo)
        tracked = [Path("docker/fem-gpu/Dockerfile")]
        source_bytes = {tracked[0].as_posix(): b"FROM pinned\n"}

        def capture(*args, **kwargs):
            if args[:2] == ("image", "inspect") and args[2] == HELPER:
                return subprocess.CompletedProcess(
                    args, 0 if base_present else 1, b"[]", b"missing"
                )
            if args[:2] == ("image", "inspect"):
                ref = args[2]
                return subprocess.CompletedProcess(
                    args, 0, json.dumps([{"Id": inspected_image if ref == IMAGE else ref}]).encode(), b""
                )
            raise AssertionError(args)

        manifest = [{"path": tracked[0].as_posix(),
                     "sha256": hashlib.sha256(source_bytes[tracked[0].as_posix()]).hexdigest()}]
        identity = {
            "source_inputs": manifest,
            "build_args": configured["services"]["fem-gpu-toolchain"]["build"]["args"],
            "target": "fem-gpu-dev",
        }
        digest = hashlib.sha256(control.canonical(identity)).hexdigest()
        if fake.receipt is not None and fake.receipt.get("source_digest") == "MATCH":
            fake.receipt["source_digest"] = digest
        if fake.receipt is not None and "control_volume" not in fake.receipt:
            fake.receipt["control_volume"] = fake.volume

        bootstrap = __import__("bootstrap_docker_toolchain")
        storage = __import__("fullmag_storage")
        compose_identity = __import__("docker_compose_identity")
        if pull_events is None:
            pull_events = fake.events

        def pull(*args, **kwargs):
            pull_events.append("pull")
            return b""

        def make_control(*args, **kwargs):
            fake.events.append("construct")
            return fake

        with mock.patch.object(control, "require_host"), \
             mock.patch.object(control, "validate_host_path", return_value=repo), \
             mock.patch.object(control, "local_volume"), \
             mock.patch.object(control, "toolchain_configuration", return_value=configured), \
             mock.patch.object(control, "docker_capture", side_effect=capture), \
             mock.patch.object(control, "compose_capture", side_effect=pull) as compose, \
             mock.patch.object(control, "bounded_capture", return_value=subprocess.CompletedProcess(
                 [], 0, json.dumps(MANIFEST).encode(), b"")), \
             mock.patch.object(control, "BuildControl", side_effect=make_control), \
             mock.patch.object(storage, "resolve_layout", return_value={"worktree_id": "test"}), \
             mock.patch.object(compose_identity, "compose_project_identity", return_value={
                 "project_name": "fullmag-cache-test"}), \
             mock.patch.object(storage, "git", return_value=COMMIT), \
             mock.patch.object(bootstrap, "tracked_input_files", return_value=tracked), \
             mock.patch.object(bootstrap, "input_files", return_value=tracked), \
             mock.patch.object(bootstrap, "read_input", side_effect=lambda _repo, path: source_bytes[path.as_posix()]):
            result = control.build_volume_toolchain(repo)
        return result, compose

    def _run_runtime_images(self, fake, *, observed_parents=None,
                            missing_image_ids=frozenset(), label_overrides=None,
                            receipt_overrides=None):
        import docker_dev
        bootstrap = __import__("bootstrap_docker_toolchain")
        repo = Path(__file__).resolve().parents[1]
        parent_ids = {"dev": PARENT_IMAGE, "backend": DEV_IMAGE}
        image_ids = {"dev": DEV_IMAGE, "backend": BACKEND_IMAGE}
        observed_parents = dict(observed_parents or {})
        label_overrides = dict(label_overrides or {})
        receipt_overrides = dict(receipt_overrides or {})
        digests = {}
        for kind in ("dev", "backend"):
            inventory = (docker_dev.BASE_CONTEXT_FILES if kind == "dev"
                         else docker_dev.RUNTIME_IMAGE_CONTEXT_FILES)
            names = sorted({relative for _, relative in inventory}
                           | {f"docker/all-in-one/Dockerfile.{kind}.dockerignore"})
            manifest = [{"path": name,
                         "sha256": hashlib.sha256(b"runtime input\n").hexdigest()}
                        for name in names]
            digest = hashlib.sha256(control.canonical({
                "parent_image_id": parent_ids[kind], "files": manifest,
            })).hexdigest()
            digests[kind] = digest
            receipt = {
                "state": "succeeded",
                "source_digest": digest,
                "compose_project": fake.project,
                "control_volume": fake.volume,
                "image_id": image_ids[kind],
            }
            receipt.update(receipt_overrides.get(kind, {}))
            fake.runtime_receipts["image-" + kind] = receipt

        def capture(*args, **kwargs):
            if args[:2] == ("image", "tag"):
                return subprocess.CompletedProcess(args, 0, b"", b"")
            if args[:2] != ("image", "inspect"):
                raise AssertionError(args)
            reference = args[2]
            prefix = "fullmag/" + fake.project + "-base:sha-"
            if reference.startswith(prefix):
                expected = "sha256:" + reference[len(prefix):]
                observed = observed_parents.get(expected, expected)
                return subprocess.CompletedProcess(
                    args, 0, json.dumps([{"Id": observed}]).encode(), b""
                )
            for kind, image_id in image_ids.items():
                if reference != image_id:
                    continue
                if image_id in missing_image_ids:
                    return subprocess.CompletedProcess(args, 1, b"", b"missing")
                labels = {
                    "org.fullmag.compose.project": fake.project,
                    "org.fullmag.build.input-digest": digests[kind],
                }
                labels.update(label_overrides.get(kind, {}))
                return subprocess.CompletedProcess(
                    args, 0,
                    json.dumps([{"Id": image_id, "Config": {"Labels": labels}}]).encode(),
                    b"",
                )
            raise AssertionError(args)

        with mock.patch.object(control, "require_host"), \
             mock.patch.object(control, "validate_host_path", return_value=repo), \
             mock.patch.object(control, "docker_capture", side_effect=capture), \
             mock.patch.object(bootstrap, "read_input",
                               side_effect=lambda _repo, _path: b"runtime input\n"):
            result = control.build_volume_runtime_images(
                repo, fake, {"image_id": PARENT_IMAGE}
            )
        return result, digests

    def test_warm_cache_uses_bounded_budget_without_build(self):
        fake = FakeControl(receipt={
            "state": "succeeded", "source_digest": "MATCH",
            "compose_project": "fullmag-cache-test", "image_id": IMAGE,
        })
        result, compose = self._run_toolchain(fake)
        self.assertTrue(result["cache_hit"])
        self.assertEqual(fake.prepare_calls, [{"minimum_free_bytes": control.MIN_FREE_CONTROL_BYTES}])
        self.assertEqual(fake.require_calls, [])
        self.assertEqual(fake.build_calls, [])
        self.assertEqual(fake.operation_calls[0][2], {
            "minimum_free_bytes": control.MIN_FREE_CONTROL_BYTES,
        })
        compose.assert_not_called()

    def test_image_id_drift_requires_full_guard_even_when_inspect_succeeds(self):
        fake = FakeControl(receipt={
            "state": "succeeded", "source_digest": "MATCH",
            "compose_project": "fullmag-cache-test", "image_id": IMAGE,
        })
        with self.assertRaisesRegex(control.BuildControlError, "32 GiB"):
            self._run_toolchain(fake, inspected_image=OTHER_IMAGE)
        self.assertEqual(len(fake.require_calls), 1)
        self.assertEqual(fake.build_calls, [])

    def test_warm_runtime_images_use_bounded_budget_and_exact_parent_labels(self):
        fake = FakeControl()
        result, _digests = self._run_runtime_images(fake)
        self.assertTrue(result["dev"]["cache_hit"])
        self.assertTrue(result["backend"]["cache_hit"])
        self.assertEqual([call[0] for call in fake.operation_calls],
                         ["image-dev", "image-backend"])
        self.assertEqual(
            [call[2] for call in fake.operation_calls],
            [{"minimum_free_bytes": control.MIN_FREE_CONTROL_BYTES},
             {"minimum_free_bytes": control.MIN_FREE_CONTROL_BYTES}],
        )
        self.assertEqual(fake.require_calls, [])
        self.assertEqual(fake.build_calls, [])

    def test_runtime_parent_drift_is_rejected_before_cache_use(self):
        fake = FakeControl()
        with self.assertRaisesRegex(control.BuildControlError, "parent alias"):
            self._run_runtime_images(fake, observed_parents={PARENT_IMAGE: OTHER_IMAGE})
        self.assertEqual(fake.require_calls, [])
        self.assertEqual(fake.build_calls, [])

    def test_runtime_label_drift_is_rejected_before_cache_use(self):
        fake = FakeControl()
        with self.assertRaisesRegex(control.BuildControlError, "source labels"):
            self._run_runtime_images(
                fake, label_overrides={"dev": {"org.fullmag.build.input-digest": "0" * 64}}
            )
        self.assertEqual(fake.require_calls, [])
        self.assertEqual(fake.build_calls, [])

    def test_missing_cached_runtime_image_requires_full_guard_before_build(self):
        fake = FakeControl()
        with self.assertRaisesRegex(control.BuildControlError, "32 GiB"):
            self._run_runtime_images(fake, missing_image_ids={DEV_IMAGE})
        self.assertEqual(len(fake.require_calls), 1)
        self.assertEqual(fake.build_calls, [])

    def test_runtime_control_volume_drift_requires_full_guard(self):
        fake = FakeControl()
        with self.assertRaisesRegex(control.BuildControlError, "32 GiB"):
            self._run_runtime_images(
                fake, receipt_overrides={"dev": {"control_volume": "foreign-control"}}
            )
        self.assertEqual(len(fake.require_calls), 1)
        self.assertEqual(fake.build_calls, [])

    def test_digest_drift_requires_full_guard_before_build(self):
        fake = FakeControl(receipt={
            "state": "succeeded", "source_digest": "wrong",
            "compose_project": "fullmag-cache-test", "image_id": IMAGE,
        })
        with self.assertRaisesRegex(control.BuildControlError, "32 GiB"):
            self._run_toolchain(fake)
        self.assertEqual(len(fake.require_calls), 1)
        self.assertEqual(fake.build_calls, [])

    def test_missing_helper_is_pulled_before_prepare(self):
        events = []
        fake = FakeControl(receipt=None, events=events, stop_after_prepare=True)
        with self.assertRaises(StopAfterPrepare):
            self._run_toolchain(fake, base_present=False)
        expected = ["construct"]
        if control.os.name == "nt":
            expected.append("windows-pre-pull")
        expected.extend(("pull", "prepare", "helper"))
        self.assertEqual(events, expected)

    def test_bounded_budget_does_not_start_zero_space_lease(self):
        identity = {"project_name": "fullmag-cache-test", "worktree_id": "test"}
        instance = control.BuildControl(identity, HELPER)
        with mock.patch.object(instance, "space", return_value=LOW_CONTROL_SPACE), \
             mock.patch.object(instance, "helper_args", return_value=["helper"]), \
             mock.patch.object(control.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(control.BuildControlError, "MiB"):
                with instance.operation("toolchain", {},
                                        minimum_free_bytes=control.MIN_FREE_CONTROL_BYTES):
                    self.fail("bounded cache admission must fail before lease")
        popen.assert_not_called()

    def test_windows_pre_pull_guard_uses_physical_backing_measurement(self):
        identity = {"project_name": "fullmag-cache-test", "worktree_id": "test"}
        instance = control.BuildControl(identity, HELPER)
        with mock.patch.object(instance, "_windows_backing_volume", return_value={
                "available_bytes": control.MIN_FREE_BUILD_BYTES - 1}):
            with self.assertRaisesRegex(control.BuildControlError, "32 GiB"):
                instance.assert_windows_pre_pull_space()

    def test_development_keeps_full_32_gib_guard_and_rejects_cache_budget(self):
        identity = {"project_name": "fullmag-cache-test", "worktree_id": "test"}
        instance = control.BuildControl(identity, HELPER)
        with mock.patch.object(instance, "space", return_value=LOW_CONTROL_SPACE), \
             mock.patch.object(instance, "helper_args", return_value=["helper"]), \
             mock.patch.object(control.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(control.BuildControlError, "32 GiB"):
                with instance.operation("development", {}):
                    self.fail("development must retain the full reserve")
            with self.assertRaisesRegex(control.BuildControlError, "Invalid build-space"):
                with instance.operation("development", {},
                                        minimum_free_bytes=control.MIN_FREE_CONTROL_BYTES):
                    self.fail("development must not accept cache-only budget")
        popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
