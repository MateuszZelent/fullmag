from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
RELEASE_WORKFLOW = ROOT / ".github/workflows/release.yml"
WINDOWS_MSI_SCRIPT = ROOT / "scripts/windows/build_windows_msi.ps1"


class ReleaseWorkflowContractTests(unittest.TestCase):
    def test_release_workflow_file_exists(self) -> None:
        self.assertTrue(RELEASE_WORKFLOW.is_file(), "release.yml workflow file must exist")

    def test_workflow_has_only_manual_dispatch_trigger(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", content)
        self.assertNotIn("push:", content)
        self.assertNotIn("pull_request:", content)

    def test_tag_binding_accepts_same_commit_and_rejects_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "origin.git"
            repo = root / "checkout"
            subprocess.run(["git", "init", "--bare", "--quiet", remote], check=True)
            subprocess.run(["git", "init", "--quiet", repo], check=True)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()

            git("config", "user.email", "ci@example.invalid")
            git("config", "user.name", "CI")
            git("remote", "add", "origin", str(remote))
            git("commit", "--allow-empty", "-qm", "build source")
            first = git("rev-parse", "HEAD")
            bind = ["bash", str(ROOT / "scripts/ci/bind_release_tag.sh"), "v1.0.0"]
            subprocess.run([*bind, first], cwd=repo, check=True)
            subprocess.run([*bind, first], cwd=repo, check=True)
            git("commit", "--allow-empty", "-qm", "different build")
            result = subprocess.run([*bind, git("rev-parse", "HEAD")], cwd=repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(git("ls-remote", "origin", "refs/tags/v1.0.0").split()[0], first)

    def test_extracted_archive_rejects_file_or_identity_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "fullmag"
            binary.write_bytes(b"binary")
            manifest = {
                "tag": "v1", "git_sha": "sha", "source_identity": {"head_commit_full": "sha"},
                "platform": "linux-x86_64", "files_sha256": {"fullmag": hashlib.sha256(b"binary").hexdigest()},
            }
            (root / "release-manifest.json").write_text(json.dumps(manifest))
            command = [sys.executable, str(ROOT / "scripts/ci/verify_release_bundle.py"), str(root), "v1", "sha"]
            subprocess.run([*command, "linux-x86_64"], check=True, capture_output=True)
            self.assertNotEqual(subprocess.run([*command, "windows-x86_64"], capture_output=True).returncode, 0)
            binary.write_bytes(b"modified")
            self.assertNotEqual(subprocess.run([*command, "linux-x86_64"], capture_output=True).returncode, 0)
            binary.unlink()
            self.assertNotEqual(subprocess.run([*command, "linux-x86_64"], capture_output=True).returncode, 0)

    def test_workflow_defines_required_inputs(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("version_prefix:", content)
        self.assertIn("custom_tag:", content)
        self.assertIn("is_prerelease:", content)

    def test_workflow_has_linux_and_windows_matrix_jobs(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("build-linux:", content)
        self.assertIn("runs-on: ubuntu-latest", content)
        self.assertIn("build-windows:", content)
        self.assertIn("runs-on: windows-latest", content)
        self.assertIn("publish-release:", content)

    def test_workflow_builds_the_complete_runtime_and_static_frontend(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertGreaterEqual(content.count("-p fullmag-api"), 2)
        self.assertGreaterEqual(content.count("FULLMAG_CONTROL_ROOM_STATIC_EXPORT: 1"), 2)
        self.assertIn(".fullmag/local/web/index.html", content)
        self.assertIn("fullmag-api.exe", content)
        self.assertIn("libdbus-1-dev", content)

    def test_workflow_rejects_unsafe_release_inputs(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("CUSTOM_TAG_INPUT", content)
        self.assertIn("VERSION_PREFIX_INPUT", content)
        self.assertIn("invalid semantic version prefix", content)
        self.assertIn("invalid custom tag", content)
        self.assertNotIn('PREFIX="${{ inputs.version_prefix }}"', content)
        self.assertNotIn('CUSTOM_TAG="${{ inputs.custom_tag }}"', content)

    def test_workflow_validates_bundle_contents_before_upload(self) -> None:
        content = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("test -x \"${DIST_DIR}/bin/fullmag\"", content)
        self.assertIn('test -f "${WEB_DIR}/index.html"', content)
        self.assertIn("tar -tzf", content)
        self.assertIn('"$WEB\\index.html"', content)
        self.assertIn("CreateFromDirectory", content)
        self.assertNotIn('Compress-Archive -Path "$DIST"', content)
        self.assertIn("FullName.Replace('\\', '/')", content)
        self.assertIn('(Resolve-Path $DIST).Path', content)
        self.assertIn("ZipFile", content)

    def test_runtime_resolvers_support_packaged_install_root(self) -> None:
        cli = (ROOT / "crates/fullmag-cli/src/control_room.rs").read_text(encoding="utf-8")
        desktop = (ROOT / "apps/desktop/src-tauri/src/api_sidecar.rs").read_text(encoding="utf-8")
        for content in (cli, desktop):
            self.assertIn("packaged_install_root", content)
            self.assertIn(".fullmag", content)
            self.assertIn("local", content)
            self.assertIn("web", content)

    def test_windows_msi_uses_the_active_static_export(self) -> None:
        content = WINDOWS_MSI_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("FULLMAG_CONTROL_ROOM_STATIC_EXPORT", content)
        self.assertIn("apps\\control-room\\out", content)
        self.assertIn("web\\index.html", content)
        self.assertNotIn("apps\\web\\out", content)

    def test_accepted_runtimes_are_in_portable_and_windows_packages(self) -> None:
        portable = (ROOT / "scripts/package_fullmag_portable.sh").read_text(encoding="utf-8")
        validator = (ROOT / "scripts/validate_portable_bundle.sh").read_text(encoding="utf-8")
        windows = WINDOWS_MSI_SCRIPT.read_text(encoding="utf-8")
        packaged_binaries = (
            "fullmag-api-accepted-scheduler",
            "fullmag-runtime-service",
            "fullmag-api-resource-pool",
            "fullmag-api-accepted-fem-preparer",
            "fullmag-api-accepted-fem-preparation-supervisor",
            "fullmag-api-accepted-fem-preparation-scheduler",
            "fullmag-api-preparation-resource-pool",
            "fullmag-api-preparation-retry",
        )
        for binary in packaged_binaries:
            with self.subTest(binary=binary):
                self.assertIn(f"bin/{binary}", portable)
                self.assertIn(f"bin/{binary}", validator)
                self.assertIn(f"bin/{binary}.exe", windows)

    def test_portable_runtime_dependencies_are_installed_with_runpath(self) -> None:
        portable = (ROOT / "scripts/package_fullmag_portable.sh").read_text(encoding="utf-8")
        makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
        required = set(re.findall(
            r'require_file "\$\{REPO_ROOT\}/\.fullmag/local/bin/(fullmag-api-[\w-]+)"',
            portable,
        ))
        self.assertEqual(len(required), 9)
        installed = set(re.findall(r'cargo_target_profile_dir/(fullmag-api-[\w-]+)', makefile))
        runpath = set(re.findall(
            r"patchelf --set-rpath '[^']+' \"\$\(FULLMAG_INTERNAL_INSTALL_ROOT\)/bin/(fullmag-api-[\w-]+)",
            makefile,
        ))
        for names, body in re.findall(r'for binary in ([^;]+); do \\\n(.*?)\n\t*done', makefile, re.S):
            if '$$cargo_target_profile_dir/$$binary' in body and 'cp ' in body and 'mv -f' in body:
                installed.update(names.split())
            if 'patchelf --set-rpath' in body and 'bin/$$binary' in body:
                runpath.update(names.split())
        self.assertFalse(required - installed, f"Not installed: {sorted(required - installed)}")
        self.assertFalse(required - runpath, f"Missing runpath: {sorted(required - runpath)}")

    def test_managed_runtime_export_has_safe_automatic_pruning(self) -> None:
        exporter = (ROOT / "scripts/export_fem_gpu_runtime.sh").read_text(encoding="utf-8")
        pruner = (ROOT / "scripts/prune_managed_fem_runtimes.sh").read_text(encoding="utf-8")
        self.assertIn("FULLMAG_RUNTIME_PRUNE", exporter)
        self.assertIn("prune_managed_fem_runtimes.sh", exporter)
        self.assertIn("FULLMAG_RUNTIME_KEEP_PER_FAMILY", pruner)
        self.assertIn("PROTECTED_ROOTS", pruner)
        self.assertIn("fem-gpu-host", pruner)

    def test_version_tag_computation_format(self) -> None:
        prefix = "0.1.0"
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        generated_tag = f"v{prefix}-{timestamp}"

        # Assert format: v0.1.0-YYYYMMDD-HHMMSS
        pattern = r"^v\d+\.\d+\.\d+-\d{8}-\d{6}$"
        self.assertIsNotNone(
            re.match(pattern, generated_tag),
            f"Generated tag {generated_tag} does not match expected iterative timestamp format",
        )


if __name__ == "__main__":
    unittest.main()
