"""Pure contract tests for the local Docker worker command builder."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from local_runner.worker import (
    JOB_LABEL_KEY,
    OWNER_LABEL_KEY,
    OWNER_LABEL_VALUE,
    assert_container_identity,
    build_worker_command,
    validate_container_identity,
)


IMAGE_DIGEST = "sha256:" + "a" * 64


class WorkerCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Path(self.temp.name).resolve() / "storage"
        self.source = self.storage / "runs" / "job-123" / "source"
        self.build = self.storage / "builds" / "worktree-a" / "profile-a"
        self.artifacts = self.storage / "runs" / "job-123" / "artifacts"
        for path in (self.source, self.build, self.artifacts):
            path.mkdir(parents=True)

    def command(self, **overrides: object) -> list[str]:
        arguments: dict[str, object] = {
            "job_id": "job-123",
            "source_digest": "c" * 64,
            "image_digest": IMAGE_DIGEST,
            "source_dir": self.source,
            "build_dir": self.build,
            "artifact_dir": self.artifacts,
            "storage_root": self.storage,
            "cpus": 2,
            "memory_bytes": 2 * 1024**3,
        }
        arguments.update(overrides)
        return build_worker_command(**arguments)  # type: ignore[arg-type]

    def test_builds_argv_without_shell_or_host_checkout_mount(self) -> None:
        command = self.command()

        self.assertIsInstance(command, list)
        self.assertTrue(command)
        self.assertEqual(command[0], "docker")
        self.assertIn(IMAGE_DIGEST, command)
        self.assertNotIn("--rm", command)
        self.assertNotIn("--privileged", command)
        self.assertNotIn("/var/run/docker.sock", command)
        self.assertNotIn("docker.sock", " ".join(command))
        self.assertFalse(any(token in {"sh", "bash", "-c", "-lc", "shell"} for token in command))

        mounts = [command[index + 1] for index, token in enumerate(command[:-1]) if token == "--mount"]
        self.assertEqual(len(mounts), 3)
        source_mount = next(mount for mount in mounts if "target=/source" in mount)
        build_mount = next(mount for mount in mounts if "target=/build" in mount)
        artifact_mount = next(mount for mount in mounts if "target=/artifacts" in mount)
        self.assertIn("readonly", source_mount)
        self.assertIn("source=" + str(self.source), source_mount)
        self.assertIn("readonly", build_mount)
        self.assertNotIn("readonly", artifact_mount)
        self.assertNotIn(",rw", artifact_mount)
        self.assertNotIn(":/workspace,", " ".join(mounts))

    def test_applies_bounded_worker_sandbox_and_fixed_identity_labels(self) -> None:
        command = self.command()

        self.assertIn("--read-only", command)
        self.assertIn("--network", command)
        self.assertEqual(command[command.index("--network") + 1], "none")
        self.assertIn("--cap-drop", command)
        self.assertEqual(command[command.index("--cap-drop") + 1], "ALL")
        self.assertIn("--security-opt", command)
        self.assertEqual(
            command[command.index("--security-opt") + 1],
            "no-new-privileges:true",
        )
        self.assertIn("--pids-limit", command)
        self.assertGreater(int(command[command.index("--pids-limit") + 1]), 0)
        self.assertIn("--tmpfs", command)
        tmpfs = command[command.index("--tmpfs") + 1]
        self.assertTrue(tmpfs.startswith("/tmp:"))
        self.assertIn("size=", tmpfs)
        self.assertIn("--cpus", command)
        self.assertEqual(command[command.index("--cpus") + 1], "2")
        self.assertIn("--memory", command)
        self.assertEqual(command[command.index("--memory") + 1], str(2 * 1024**3))
        self.assertIn("--memory-swap", command)
        self.assertEqual(command[command.index("--memory-swap") + 1], str(2 * 1024**3))

        labels = [command[index + 1] for index, token in enumerate(command[:-1]) if token == "--label"]
        self.assertIn(f"{OWNER_LABEL_KEY}={OWNER_LABEL_VALUE}", labels)
        self.assertIn(f"{JOB_LABEL_KEY}=job-123", labels)

    def test_gpu_is_opt_in(self) -> None:
        cpu_command = self.command()
        self.assertNotIn("--gpus", cpu_command)

        gpu_command = self.command(gpu=True)
        self.assertIn("--gpus", gpu_command)
        self.assertEqual(gpu_command[gpu_command.index("--gpus") + 1], "all")

    def test_source_verify_is_the_only_trusted_operation(self) -> None:
        command = self.command(operation="verify-source")
        command_text = " ".join(command)
        self.assertIn("worker_entrypoint.py", command_text)
        self.assertNotIn("qualif", command_text.lower())
        self.assertNotIn("verify-fem", command_text.lower())

        # A shell fragment is data, not an operation in the catalogue.
        for operation in (
            "build",
            "qualify",
            "verify-fem",
            "source_verify",
            "source_verify; id",
            "sh -c id",
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(ValueError):
                    self.command(operation=operation)

    def test_digest_and_job_identity_are_exact(self) -> None:
        for digest in (
            "latest",
            "ubuntu:latest",
            "sha256:" + "A" * 64,
            "sha256:" + "a" * 63,
            "sha256:" + "a" * 65,
            " sha256:" + "a" * 64,
        ):
            with self.subTest(digest=digest):
                with self.assertRaises(ValueError):
                    self.command(image_digest=digest)

        for job_id in ("../other", "job/other", "job other", "job;id", "", ".."):
            with self.subTest(job_id=job_id):
                with self.assertRaises(ValueError):
                    self.command(job_id=job_id)

    def test_resources_are_bounded_and_typed(self) -> None:
        for cpus in (0, 0.01, 17, 33, float("inf"), "2", True):
            with self.subTest(cpus=cpus):
                with self.assertRaises(ValueError):
                    self.command(cpus=cpus)

        for memory_bytes in (0, 1024, 65 * 1024**3, 1024**6, 2.5, "2048", True):
            with self.subTest(memory_bytes=memory_bytes):
                with self.assertRaises(ValueError):
                    self.command(memory_bytes=memory_bytes)

        with self.assertRaises(ValueError):
            self.command(gpu="true")

    def test_paths_must_be_separate_existing_directories_under_storage(self) -> None:
        outside = Path(self.temp.name).resolve() / "outside"
        outside.mkdir()
        cases = (
            {"source_dir": outside},
            {"build_dir": outside},
            {"artifact_dir": outside},
            {"source_dir": self.storage},
            {"source_dir": self.build},
            {"build_dir": self.source},
            {"artifact_dir": self.source},
        )
        for overrides in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    self.command(**overrides)

        missing = self.storage / "missing"
        with self.assertRaises(ValueError):
            self.command(build_dir=missing)

        with self.assertRaises(ValueError):
            self.command(storage_root="storage")
        with self.assertRaises(ValueError):
            self.command(source_dir="storage/runs/job-123/source")

    def test_rejects_source_that_is_a_git_checkout(self) -> None:
        (self.source / ".git").mkdir()
        with self.assertRaises(ValueError):
            self.command()

    def test_rejects_git_checkout_as_storage_root(self) -> None:
        (self.storage / ".git").mkdir()
        with self.assertRaises(ValueError):
            self.command()

    def test_rejects_symlinked_job_directory_when_supported(self) -> None:
        link = self.storage / "linked-source"
        try:
            link.symlink_to(self.source, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable on this host")
        with self.assertRaises(ValueError):
            self.command(source_dir=link)

    def test_rejects_symlink_escape_inside_mount_when_supported(self) -> None:
        outside = Path(self.temp.name).resolve() / "outside-content"
        outside.mkdir()
        link = self.source / "outside-link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable on this host")
        with self.assertRaises(ValueError):
            self.command()

    def test_rejects_mount_delimiter_in_path(self) -> None:
        comma_dir = self.storage / "bad,name"
        comma_dir.mkdir()
        with self.assertRaises(ValueError):
            self.command(build_dir=comma_dir)


class ContainerIdentityTests(unittest.TestCase):
    def inspect(self, *, job: str = "job-123", owner: str = OWNER_LABEL_VALUE) -> dict[str, object]:
        return {
            "Id": "b" * 64,
            "Config": {"Labels": {OWNER_LABEL_KEY: owner, JOB_LABEL_KEY: job}},
        }

    def test_accepts_exact_owned_container(self) -> None:
        payload = self.inspect()
        self.assertTrue(validate_container_identity(payload, "job-123"))
        self.assertTrue(
            validate_container_identity(
                payload,
                "job-123",
                expected_container_id="b" * 64,
            )
        )
        self.assertIsNone(assert_container_identity(payload, "job-123", "b" * 64))

    def test_rejects_unrelated_or_ambiguous_container(self) -> None:
        payload = self.inspect()
        cases = (
            (self.inspect(job="other-job"), None),
            (self.inspect(owner="other-owner"), None),
            (payload, "c" * 64),
            ({"Id": "b" * 64, "Config": {"Labels": {JOB_LABEL_KEY: "job-123"}}}, None),
            ({"Id": "b" * 64, "Config": {"Labels": None}}, None),
            ({"Config": {"Labels": {OWNER_LABEL_KEY: OWNER_LABEL_VALUE, JOB_LABEL_KEY: "job-123"}}}, None),
        )
        for candidate, expected_id in cases:
            with self.subTest(candidate=candidate, expected_id=expected_id):
                self.assertFalse(validate_container_identity(candidate, "job-123", expected_id))
                with self.assertRaises(ValueError):
                    assert_container_identity(candidate, "job-123", expected_id)

        with self.assertRaises(ValueError):
            assert_container_identity(payload, "job-123")

    def test_accepts_docker_inspect_list_shape_and_rejects_wrong_job(self) -> None:
        payload = [self.inspect()]
        self.assertTrue(validate_container_identity(payload, "job-123"))
        self.assertFalse(validate_container_identity(payload, "other-job"))
        self.assertFalse(validate_container_identity([], "job-123"))
        self.assertFalse(validate_container_identity([self.inspect(), self.inspect()], "job-123"))


if __name__ == "__main__":
    unittest.main()
