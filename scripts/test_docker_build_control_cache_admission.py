"""Focused interpreted regressions for volume bootstrap admission."""
from contextlib import contextmanager
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
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
    "declared": {
        "cuda": {"architectures": "86-real"},
        "hypre": {"gpu_architectures": "86"},
        "petsc": {"cuda_architectures": "86"},
        "libceed": {"cuda_architecture": "86"},
    },
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
                    "args": {
                        "FULLMAG_CUDA_BASE_IMAGE": HELPER,
                        "FULLMAG_CUDA_ARCHITECTURES": "86-real",
                        "FULLMAG_HYPRE_GPU_ARCHITECTURES": "86",
                        "FULLMAG_PETSC_CUDA_ARCHITECTURES": "86",
                        "FULLMAG_LIBCEED_CUDA_ARCHITECTURE": "86",
                    },
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

        class BuildControlFactory:
            def __call__(self, *args, **kwargs):
                return make_control(*args, **kwargs)

            @staticmethod
            def assert_windows_pre_pull_space():
                fake.events.append("windows-pre-pull")

        build_control_factory = BuildControlFactory()
        with mock.patch.object(control, "require_host"), \
             mock.patch.object(control, "validate_host_path", return_value=repo), \
             mock.patch.object(control, "local_volume"), \
             mock.patch.object(control, "toolchain_configuration", return_value=configured), \
             mock.patch.object(control, "docker_capture", side_effect=capture), \
             mock.patch.object(control, "compose_capture", side_effect=pull) as compose, \
             mock.patch.object(control, "bounded_capture", return_value=subprocess.CompletedProcess(
                 [], 0, json.dumps(MANIFEST).encode(), b"")), \
             mock.patch.object(control, "BuildControl", new=build_control_factory), \
             mock.patch.object(storage, "resolve_layout", side_effect=AssertionError("Image-only build must not resolve host storage")), \
             mock.patch.object(compose_identity, "compose_source_identity", return_value={
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

    def test_toolchain_and_both_image_producers_share_semantic_hash_contract(self):
        digest=control.build_input_digest
        fake=FakeControl(receipt={'state':'succeeded','source_digest':'MATCH',
            'compose_project':'fullmag-cache-test','image_id':IMAGE})
        with mock.patch.object(control,'build_input_digest',wraps=digest) as observed:
            self._run_toolchain(fake)
            self.assertEqual(observed.call_count,1)
        fake=FakeControl()
        with mock.patch.object(control,'build_input_digest',wraps=digest) as observed:
            result,_=self._run_runtime_images(fake)
            self.assertEqual(observed.call_count,2)
            self.assertEqual(set(result),{'dev','backend'})

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

    def test_runtime_image_context_rejects_windows_submount_before_buildkit(self):
        repo = Path(__file__).resolve().parents[1]
        mountinfo = (
            "1 0 8:1 / / rw - ext4 /dev/sda rw\n"
            f"2 1 0:42 / {repo}/docker/windows-data rw - 9p E:\\134 rw\n"
        )
        with mock.patch.object(control, "validate_host_path", return_value=repo), \
                mock.patch.object(control.Path, "read_text", return_value=mountinfo), \
                mock.patch.object(control, "docker_capture") as docker:
            with self.assertRaisesRegex(ValueError, "runtime image build context.*9p.*windows-data"):
                control.build_volume_runtime_images(repo, mock.Mock(), {})
        docker.assert_not_called()

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
        expected = ["windows-pre-pull"] if control.os.name == "nt" else []
        expected.extend(("pull", "construct", "prepare", "helper"))
        self.assertEqual(events, expected)

    def test_bounded_budget_does_not_start_zero_space_lease(self):
        identity = {"project_name": "fullmag-cache-test", "worktree_id": "test"}
        with mock.patch("docker_control_namespace.resolve_namespace", return_value=None):
            instance = control.BuildControl(identity, HELPER)
        with mock.patch.object(instance, "space", return_value=LOW_CONTROL_SPACE), \
             mock.patch.object(instance, "helper_args", return_value=["helper"]), \
             mock.patch.object(control.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(control.BuildControlError, "MiB"):
                with instance.operation("toolchain", {},
                                        minimum_free_bytes=control.MIN_FREE_CONTROL_BYTES):
                    self.fail("bounded cache admission must fail before lease")
        popen.assert_not_called()

    def test_docker_text_decodes_bounded_capture_and_optional_stderr(self):
        observed = subprocess.CompletedProcess([], 0, b"out", b"err")
        with mock.patch.object(control, "docker_capture", return_value=observed) as capture:
            self.assertEqual(control.docker_text("version"), "out")
            self.assertEqual(control.docker_text("version", combined=True), "outerr")
        self.assertEqual(capture.call_args_list, [
            mock.call("version", timeout=90),
            mock.call("version", timeout=90),
        ])

    def test_windows_pre_pull_guard_uses_physical_backing_measurement(self):
        with mock.patch.object(control.BuildControl, "_windows_backing_volume", return_value={
                "available_bytes": control.MIN_FREE_BUILD_BYTES - 1}) as backing_volume:
            with self.assertRaisesRegex(control.BuildControlError, "32 GiB"):
                control.BuildControl.assert_windows_pre_pull_space()
        backing_volume.assert_called_once_with()

    def test_development_keeps_full_32_gib_guard_and_rejects_cache_budget(self):
        identity = {"project_name": "fullmag-cache-test", "worktree_id": "test"}
        with mock.patch("docker_control_namespace.resolve_namespace", return_value=None):
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


class BuildAttemptWindowTests(unittest.TestCase):
    def _control(self):
        with mock.patch("docker_control_namespace.resolve_namespace", return_value=None):
            return control.BuildControl(
                {"project_name": "fullmag-cache-test", "worktree_id": "test"}, HELPER)

    def _admission(self, phase, count, blocker=None):
        # Execute the actual shell admission, stopping before it creates a lease.
        instance = self._control()
        token = "a" * 32
        script = instance.operation_script(phase, token)
        boundary = "mkdir '" + instance.path(f"{phase}/attempts/{token}") + "';"
        prefix, suffix = script.split(boundary, 1)
        self.assertTrue(suffix)
        with tempfile.TemporaryDirectory(prefix="fullmag-admission-", dir="/tmp") as directory:
            root = Path(directory)
            attempts = root / phase / "attempts"
            attempts.mkdir(parents=True)
            for number in range(count):
                (attempts / f"{number:032x}").mkdir()
            if blocker == "active":
                (root / "active").write_text("retained owner")
            elif blocker in ("closing", "dangling-closing"):
                closing = root / "cache-retirement" / "closing.json"
                closing.parent.mkdir()
                if blocker == "closing":
                    closing.write_text("{}")
                else:
                    closing.symlink_to(root / "missing")
            lock = None
            if blocker == "lock":
                import fcntl
                lock = (root / "operation.lock").open("w")
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                result = subprocess.run(
                    ["bash", "-euo", "pipefail", "-c", prefix.replace("/control", directory)],
                    capture_output=True, text=True, timeout=5)
            finally:
                if lock is not None:
                    lock.close()
            self.assertEqual(len(list(attempts.iterdir())), count)
            self.assertFalse((attempts / token).exists())
            return result.returncode

    @unittest.skipUnless(control.os.name == "posix", "Linux helper shell admission")
    def test_toolchain_admits_64_and_127_but_refuses_128(self):
        for count, allowed in ((63, True), (64, True), (127, True), (128, False)):
            with self.subTest(count=count):
                self.assertEqual(self._admission("toolchain", count) == 0, allowed)

    @unittest.skipUnless(control.os.name == "posix", "Linux helper shell admission")
    def test_other_phase_windows_are_unchanged(self):
        for phase in ("image-dev", "image-backend", "development", "recreate-services"):
            for count, allowed in ((63, True), (64, False)):
                with self.subTest(phase=phase, count=count):
                    self.assertEqual(self._admission(phase, count) == 0, allowed)
        for count, allowed in ((127, True), (128, False)):
            with self.subTest(phase="iteration", count=count):
                self.assertEqual(self._admission("iteration", count) == 0, allowed)

    @unittest.skipUnless(control.os.name == "posix", "Linux helper shell admission")
    def test_toolchain_still_refuses_active_closing_and_locked_group(self):
        for blocker in ("active", "closing", "dangling-closing", "lock"):
            with self.subTest(blocker=blocker):
                self.assertNotEqual(self._admission("toolchain", 0, blocker), 0)

    def test_receipt_reports_the_phase_specific_attempt_limit(self):
        for phase, limit in (("toolchain", 128), ("iteration", 128),
                             ("image-dev", 64), ("image-backend", 64),
                             ("development", 64), ("recreate-services", 64)):
            instance = self._control()
            logger = mock.Mock(stdin=io.BytesIO())
            logger.wait.return_value = 0
            with self.subTest(phase=phase), \
                 mock.patch.dict(control.os.environ, {}, clear=True), \
                 mock.patch.object(instance, "space", return_value={"available_bytes": 64 * 1024**3}), \
                 mock.patch.object(instance, "helper_args", return_value=["helper"]), \
                 mock.patch.object(instance, "_line", side_effect=["READY", "LOGGED"]), \
                 mock.patch.object(instance, "_pin_operation_helper", return_value="b" * 64), \
                 mock.patch.object(instance, "write") as write, \
                 mock.patch.object(control.subprocess, "Popen", return_value=logger), \
                 mock.patch.object(control, "mirror_console"):
                with instance.operation(phase, {}) as operation:
                    operation["receipt"]["state"] = "succeeded"
                    self.assertEqual(operation["receipt"]["attempt_limit"], limit)
                terminal = [call.args[1] for call in write.call_args_list
                            if call.args[0].endswith("/terminal.json")]
                self.assertEqual(len(terminal), 1)
                self.assertEqual(terminal[0]["attempt_limit"], limit)


if __name__ == "__main__":
    unittest.main()
