"""Reject obsolete MSI Burn production before any filesystem/build operation."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PS = shutil.which("powershell.exe") if os.name == "nt" else None

@unittest.skipUnless(PS, "native Windows PowerShell required")
class LegacyRouteGuard(unittest.TestCase):
    def test_legacy_route_fails_before_reading_inputs_or_building(self):
        absent = Path(tempfile.gettempdir()) / "fullmag-obsolete-burn-route-readonly-probe"
        self.assertFalse(absent.exists(), "The read-only probe path must not exist")
        args = [PS, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(ROOT / "scripts/windows/build_windows_installer_exe.ps1")]
        for key in ("LicenseFile", "NoticeFile", "BootstrapperApplicationDll", "SetupBuildEnvironmentScript",
                    "BuildRequirementsManifest", "InstallerBuildRequirementsManifest", "WixRoot"):
            args += ["-" + key, str(absent)]
        for key in ("LicenseFileSha256", "NoticeFileSha256", "BootstrapperApplicationSha256",
                    "SetupBuildEnvironmentScriptSha256", "BuildRequirementsManifestSha256",
                    "InstallerBuildRequirementsManifestSha256"):
            args += ["-" + key, "a" * 64]
        args += ["-BundleUpgradeCode", "7fc5fb44-9c32-4a97-a78f-e1dc22a38107"]
        for route_args in ([], ["-Route", "release"]):
            with self.subTest(route_args=route_args):
                result = subprocess.run(args + route_args, capture_output=True, text=True,
                                        encoding="utf-8", errors="replace", timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("legacy MSI Burn route has no all-backends capability package",
                              result.stdout + result.stderr)
                self.assertFalse(absent.exists())

if __name__ == "__main__":
    unittest.main()
