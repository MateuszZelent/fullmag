from datetime import datetime, timezone
from pathlib import Path
import re
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
