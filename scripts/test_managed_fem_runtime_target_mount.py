from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORTER = REPO_ROOT / "scripts" / "export_fem_gpu_runtime.sh"
CANONICAL_STORAGE_ROOT = "/zfn2/mateuszz/git/fullmag"
CANONICAL_IMAGE = f"{CANONICAL_STORAGE_ROOT}/build-volumes/fullmag-native.ext4"
MOUNT_VIEW = "/mnt/fullmag-zfn2-native"
REMOUNT_COMMAND = (
    "wsl.exe -d Ubuntu2 -u root -- mount -o remount,rw,noatime "
    f"{MOUNT_VIEW}"
)


class ManagedFemRuntimeTargetMountTest(unittest.TestCase):
    def test_exporter_requires_ext4_bind_target_before_image_build(self) -> None:
        source = EXPORTER.read_text(encoding="utf-8")

        self.assertIn(
            'FULLMAG_CONTAINER_TARGET_DIR:=${FULLMAG_NATIVE_MOUNT_VIEW}/managed-fem-runtime',
            source,
        )
        self.assertNotIn(
            'FULLMAG_CONTAINER_TARGET_DIR:=${FULLMAG_NATIVE_MOUNT_VIEW}/cargo-targets/',
            source,
        )
        self.assertIn(
            f'FULLMAG_NATIVE_BUILD_STORAGE_ROOT:={CANONICAL_STORAGE_ROOT}',
            source,
        )
        self.assertIn(
            'FULLMAG_NATIVE_BUILD_IMAGE:=${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/build-volumes/fullmag-native.ext4',
            source,
        )
        self.assertIn(
            f'FULLMAG_NATIVE_MOUNT_VIEW:={MOUNT_VIEW}',
            source,
        )
        self.assertIn('findmnt -n -o FSTYPE --target "${FULLMAG_CONTAINER_TARGET_DIR}"', source)
        self.assertIn('findmnt -n -o SOURCE --target "${FULLMAG_CONTAINER_TARGET_DIR}"', source)
        self.assertIn('/loop/backing_file', source)
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

    def test_non_ext4_target_fails_before_any_docker_command(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            docker_marker = root / "docker-called"
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

    def test_wrong_loop_backing_image_fails_before_any_docker_command(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            docker_marker = root / "docker-called"
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


if __name__ == "__main__":
    unittest.main()
