from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORTER = REPO_ROOT / "scripts" / "export_fem_gpu_runtime.sh"
STORAGE_HELPER = REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
CANONICAL_STORAGE_ROOT = "/zfn2/mateuszz/git/fullmag"
CANONICAL_IMAGE = f"{CANONICAL_STORAGE_ROOT}/build-volumes/fullmag-native.ext4"
MOUNT_VIEW = "/mnt/fullmag-zfn2-native"
TARGET_ROOT = f"{MOUNT_VIEW}/managed-fem-runtime"
REMOUNT_COMMAND = (
    "wsl.exe -d Ubuntu2 -u root -- mount -o remount,rw,noatime "
    f"{MOUNT_VIEW}"
)


class ManagedFemRuntimeTargetMountTest(unittest.TestCase):
    @staticmethod
    def _target_for(repo_root: Path) -> str:
        slug = re.sub(r"[^A-Za-z0-9._-]", "-", repo_root.name)
        digest = hashlib.sha256(str(repo_root).encode()).hexdigest()
        return f"{TARGET_ROOT}/{slug}-{digest}"

    @staticmethod
    def _resolved_layout(
        storage_root: Path | None = None,
        *,
        filesystem_type: str = "9p",
        mount_options: str = "rw,nosuid,nodev,aname=drvfs",
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as raw_root:
            fake_bin = Path(raw_root) / "bin"
            fake_bin.mkdir()
            findmnt = fake_bin / "findmnt"
            findmnt.write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *"-o TARGET"*) echo /mnt/g ;;\n'
                f'  *"-o FSTYPE"*) echo {filesystem_type} ;;\n'
                f'  *"-o OPTIONS"*) echo {mount_options} ;;\n'
                "  *) exit 3 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            findmnt.chmod(0o755)
            environment = os.environ.copy()
            if storage_root is not None:
                environment[STORAGE_ROOT_ENV] = str(storage_root)
                environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            return subprocess.run(
                [
                    "bash",
                    "-euo",
                    "pipefail",
                    "-c",
                    'source "$1"; resolve_managed_fem_runtime_storage_layout; '
                    "printf '%s\\n' \"$FULLMAG_NATIVE_BUILD_STORAGE_ROOT\" "
                    '"$FULLMAG_NATIVE_BUILD_IMAGE" "$FULLMAG_NATIVE_MOUNT_VIEW" '
                    '"$FULLMAG_PERSISTENT_RUNTIME_PARENT"',
                    "bash",
                    str(STORAGE_HELPER),
                ],
                cwd=REPO_ROOT,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

    def test_default_storage_layout_uses_canonical_paths(self) -> None:
        result = self._resolved_layout()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                CANONICAL_STORAGE_ROOT,
                CANONICAL_IMAGE,
                MOUNT_VIEW,
                f"{CANONICAL_STORAGE_ROOT}/runtimes",
            ],
        )

    def test_alternate_storage_root_derives_isolated_image_mount_and_archive_paths(
        self,
    ) -> None:
        storage_root = Path("/mnt/g/git/fullmag")

        result = self._resolved_layout(storage_root)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                str(storage_root),
                str(storage_root / "build-volumes/fullmag-native.ext4"),
                str(storage_root / "build-volumes/fullmag-native.mount"),
                str(storage_root / "runtimes"),
            ],
        )

    def test_storage_layout_rejects_tmp_and_checkout_roots(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            for unsafe_root in (Path(raw_root), REPO_ROOT):
                result = self._resolved_layout(unsafe_root)

                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("qualified host mount under /mnt", result.stderr)

    def test_storage_layout_rejects_unsupported_or_read_only_host_mounts(self) -> None:
        storage_root = Path("/mnt/g/git/fullmag")
        cases = (("xfs", "rw,nosuid"), ("9p", "ro,nosuid,aname=drvfs"))
        for filesystem_type, mount_options in cases:
            result = self._resolved_layout(
                storage_root,
                filesystem_type=filesystem_type,
                mount_options=mount_options,
            )

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("unsupported durable host mount", result.stderr)

    def test_storage_layout_rejects_relative_and_root_targets(self) -> None:
        for unsafe_root in ("relative/fullmag", "/"):
            environment = {**os.environ, STORAGE_ROOT_ENV: unsafe_root}
            result = subprocess.run(
                [
                    "bash",
                    "-euo",
                    "pipefail",
                    "-c",
                    'source "$1"; resolve_managed_fem_runtime_storage_layout',
                    "bash",
                    str(STORAGE_HELPER),
                ],
                cwd=REPO_ROOT,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(STORAGE_ROOT_ENV, result.stderr)

    def test_storage_layout_rejects_symlink_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            durable = root / "durable"
            durable.mkdir()
            alias = root / "alias"
            alias.symlink_to(durable, target_is_directory=True)

            result = self._resolved_layout(alias)

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("must not be a symbolic link", result.stderr)

    def test_exporter_requires_ext4_bind_target_before_image_build(self) -> None:
        source = EXPORTER.read_text(encoding="utf-8")
        storage_source = STORAGE_HELPER.read_text(encoding="utf-8")

        self.assertIn(
            'readonly FULLMAG_CONTAINER_TARGET_ROOT="${FULLMAG_NATIVE_MOUNT_VIEW}/managed-fem-runtime"',
            source,
        )
        self.assertIn(
            'readonly FULLMAG_CONTAINER_TARGET_DIR="${FULLMAG_CONTAINER_TARGET_ROOT}/${FULLMAG_WORKTREE_TARGET_ID}"',
            source,
        )
        self.assertNotIn(
            f'readonly FULLMAG_CONTAINER_TARGET_DIR="{MOUNT_VIEW}/managed-fem-runtime"',
            source,
        )
        self.assertNotIn(
            'FULLMAG_CONTAINER_TARGET_DIR:=${FULLMAG_NATIVE_MOUNT_VIEW}/cargo-targets/',
            source,
        )
        self.assertIn("resolve_managed_fem_runtime_storage_layout", source)
        self.assertLess(
            source.index("resolve_managed_fem_runtime_storage_layout"),
            source.index('mkdir -p "${RUNTIME_PARENT}"'),
        )
        for variable in (
            "FULLMAG_NATIVE_BUILD_STORAGE_ROOT",
            "FULLMAG_NATIVE_BUILD_IMAGE",
            "FULLMAG_NATIVE_MOUNT_VIEW",
            "FULLMAG_CONTAINER_TARGET_DIR",
        ):
            self.assertNotIn(f'"${{{variable}:=', source)
        self.assertIn('findmnt -n -o FSTYPE --target "${probe_path}"', storage_source)
        self.assertIn('findmnt -n -o SOURCE --target "${probe_path}"', storage_source)
        self.assertIn('/loop/backing_file', storage_source)
        self.assertIn("validate_managed_fem_runtime_storage_target", source)
        self.assertIn(
            "wsl.exe -d Ubuntu2 -u root -- mount -o remount,rw,noatime "
            "${FULLMAG_NATIVE_MOUNT_VIEW}",
            source,
        )
        self.assertIn('-v "${FULLMAG_CONTAINER_TARGET_DIR}:/workspace/target"', source)
        self.assertLess(
            source.index("validate_container_target_dir"),
            source.index('build_managed_fem_image "${docker_build_ref}"'),
        )

    def test_alternate_9p_root_requires_an_ext4_staging_mount_before_docker(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            repo_root = root / "repo"
            scripts = repo_root / "scripts"
            library = scripts / "lib"
            library.mkdir(parents=True)
            shutil.copy2(EXPORTER, scripts / EXPORTER.name)
            shutil.copy2(
                REPO_ROOT / "scripts/lib/managed_fem_image_identity.sh",
                library / "managed_fem_image_identity.sh",
            )
            shutil.copy2(STORAGE_HELPER, library / STORAGE_HELPER.name)
            storage_root = Path("/mnt/g/git")
            image = storage_root / "build-volumes/fullmag-native.ext4"
            mount_view = str(storage_root / "build-volumes/fullmag-native.mount")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            findmnt = fake_bin / "findmnt"
            findmnt.write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *"-o TARGET"*) echo /mnt/g ;;\n'
                '  *"-o FSTYPE"*) echo 9p ;;\n'
                '  *"-o OPTIONS"*) echo rw,nosuid,nodev,aname=drvfs ;;\n'
                "  *) exit 3 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            findmnt.chmod(0o755)
            docker_marker = root / "docker-called"
            docker = fake_bin / "docker"
            docker.write_text(
                '#!/bin/sh\ntouch "$DOCKER_MARKER"\nexit 99\n',
                encoding="utf-8",
            )
            docker.chmod(0o755)
            environment = {
                **os.environ,
                STORAGE_ROOT_ENV: str(storage_root),
                "DOCKER_MARKER": str(docker_marker),
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
                "TMPDIR": str(root),
            }

            result = subprocess.run(
                ["bash", str(scripts / EXPORTER.name)],
                cwd=repo_root,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("expected a regular ext4 backing image", result.stderr)
            self.assertIn(str(image), result.stderr)
            self.assertIn(mount_view, result.stderr)
            self.assertFalse(docker_marker.exists(), "Docker ran before ext4 staging validation")

    def test_non_ext4_target_fails_before_any_docker_command(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            docker_marker = root / "docker-called"
            mkdir = fake_bin / "mkdir"
            mkdir.write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *".fullmag/runtimes"*) exec /usr/bin/mkdir "$@" ;;\n'
                "  *) exit 0 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            mkdir.chmod(0o755)
            findmnt = fake_bin / "findmnt"
            findmnt.write_text("#!/bin/sh\necho xfs\n", encoding="utf-8")
            findmnt.chmod(0o755)
            docker = fake_bin / "docker"
            docker.write_text(
                '#!/bin/sh\ntouch "$DOCKER_MARKER"\nexit 99\n',
                encoding="utf-8",
            )
            docker.chmod(0o755)
            target = root / "target"
            target.mkdir()
            environment = os.environ.copy()
            environment.update(
                {
                    "DOCKER_MARKER": str(docker_marker),
                    "FULLMAG_CONTAINER_TARGET_DIR": str(target),
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "TMPDIR": str(root),
                }
            )

            result = subprocess.run(
                ["bash", str(EXPORTER)],
                cwd=REPO_ROOT,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("must be an ext4 filesystem", result.stderr)
            self.assertIn(REMOUNT_COMMAND, result.stderr)
            self.assertFalse(docker_marker.exists(), "Docker ran before target validation")

    def test_caller_cannot_redirect_canonical_native_storage_contract(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            mkdir = fake_bin / "mkdir"
            mkdir.write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *".fullmag/runtimes"*) exec /usr/bin/mkdir "$@" ;;\n'
                "  *) exit 0 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            mkdir.chmod(0o755)
            findmnt = fake_bin / "findmnt"
            findmnt.write_text("#!/bin/sh\necho xfs\n", encoding="utf-8")
            findmnt.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "FULLMAG_NATIVE_BUILD_STORAGE_ROOT": "/evil/root",
                    "FULLMAG_NATIVE_BUILD_IMAGE": "/evil/image.ext4",
                    "FULLMAG_NATIVE_MOUNT_VIEW": "/evil/mount",
                    "FULLMAG_CONTAINER_TARGET_DIR": "/evil/target",
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "TMPDIR": str(root),
                }
            )

            result = subprocess.run(
                ["bash", str(EXPORTER)],
                cwd=REPO_ROOT,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(
                f"must be an ext4 filesystem: {self._target_for(REPO_ROOT)}",
                result.stderr,
            )
            self.assertIn(CANONICAL_IMAGE, result.stderr)
            self.assertNotIn("/evil/", result.stderr)

    def test_wrong_loop_backing_image_fails_before_any_docker_command(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            docker_marker = root / "docker-called"
            mkdir = fake_bin / "mkdir"
            mkdir.write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *".fullmag/runtimes"*) exec /usr/bin/mkdir "$@" ;;\n'
                "  *) exit 0 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            mkdir.chmod(0o755)
            findmnt = fake_bin / "findmnt"
            findmnt.write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *"-o FSTYPE"*) echo ext4 ;;\n'
                '  *"-o SOURCE"*) echo /dev/loop99 ;;\n'
                "  *) exit 3 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            findmnt.chmod(0o755)
            docker = fake_bin / "docker"
            docker.write_text(
                '#!/bin/sh\ntouch "$DOCKER_MARKER"\nexit 99\n',
                encoding="utf-8",
            )
            docker.chmod(0o755)
            sysfs_root = root / "sys" / "class" / "block"
            loop_dir = sysfs_root / "loop99" / "loop"
            loop_dir.mkdir(parents=True)
            wrong_image = root / "wrong-native.ext4"
            (loop_dir / "backing_file").write_text(
                f"{wrong_image}\n",
                encoding="utf-8",
            )
            target = root / "target"
            target.mkdir()
            environment = os.environ.copy()
            environment.update(
                {
                    "DOCKER_MARKER": str(docker_marker),
                    "FULLMAG_CONTAINER_TARGET_DIR": str(target),
                    "FULLMAG_LOOP_SYSFS_ROOT": str(sysfs_root),
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "TMPDIR": str(root),
                }
            )

            result = subprocess.run(
                ["bash", str(EXPORTER)],
                cwd=REPO_ROOT,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(CANONICAL_IMAGE, result.stderr)
            self.assertIn(str(wrong_image), result.stderr)
            self.assertFalse(docker_marker.exists(), "Docker ran before backing-image validation")

    def test_separate_worktrees_resolve_distinct_canonical_target_directories(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            mkdir = fake_bin / "mkdir"
            mkdir.write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *".fullmag/runtimes"*) exec /usr/bin/mkdir "$@" ;;\n'
                "  *) exit 0 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            mkdir.chmod(0o755)
            findmnt = fake_bin / "findmnt"
            findmnt.write_text("#!/bin/sh\necho xfs\n", encoding="utf-8")
            findmnt.chmod(0o755)
            targets = []
            for name in ("worktree-a", "worktree-b"):
                repo_root = root / name
                scripts = repo_root / "scripts"
                library = scripts / "lib"
                library.mkdir(parents=True)
                shutil.copy2(EXPORTER, scripts / EXPORTER.name)
                shutil.copy2(
                    REPO_ROOT / "scripts/lib/managed_fem_image_identity.sh",
                    library / "managed_fem_image_identity.sh",
                )
                shutil.copy2(
                    REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh",
                    library / "managed_fem_runtime_storage.sh",
                )
                runtime_parent = repo_root / ".fullmag" / "runtimes"
                self.assertFalse(runtime_parent.exists())
                environment = os.environ.copy()
                environment.update(
                    {
                        "PATH": f"{fake_bin}:{environment['PATH']}",
                        "TMPDIR": str(root),
                    }
                )
                result = subprocess.run(
                    ["bash", str(scripts / EXPORTER.name)],
                    cwd=repo_root,
                    env=environment,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                target = self._target_for(repo_root)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(f"must be an ext4 filesystem: {target}", result.stderr)
                self.assertIn(CANONICAL_IMAGE, result.stderr)
                self.assertTrue(runtime_parent.is_dir())
                targets.append(target)

            self.assertNotEqual(targets[0], targets[1])


if __name__ == "__main__":
    unittest.main()
