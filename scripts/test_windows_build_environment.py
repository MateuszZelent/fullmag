#!/usr/bin/env python3
"""Lightweight, host-independent contract checks for the Windows setup plan.

These checks inspect the setup boundary and manifest. They do not install
software, invoke PowerShell, compile unit tests, build FEM providers, or claim
Windows compiler/runtime qualification.
"""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "windows_build_requirements.json"
SETUP = ROOT / "scripts" / "windows" / "setup_build_environment.ps1"
RUN_FULLMAG = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
GUIDE = ROOT / "docs" / "guides" / "windows-build-environment.md"


class WindowsBuildEnvironmentContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        cls.setup = SETUP.read_text(encoding="utf-8")
        cls.run_fullmag = RUN_FULLMAG.read_text(encoding="utf-8")
        cls.guide = GUIDE.read_text(encoding="utf-8")

    def test_manifest_shape_and_lane_coverage(self) -> None:
        self.assertEqual(
            self.manifest["schema_version"],
            "fullmag.windows-build-requirements.v1",
        )
        self.assertFalse(self.manifest["platform"]["wsl_fallback"])
        self.assertTrue(self.manifest["storage"]["require_argument_when_missing"])
        self.assertTrue(self.manifest["storage"]["preserve_existing_dotenv"])
        self.assertEqual(
            self.manifest["storage"]["env_key"],
            "FULLMAG_PROJECT_STORAGE_ROOT",
        )
        self.assertEqual(
            self.manifest["storage"]["build_profiles"]["fem_cpu"],
            "windows-native-fem-cpu",
        )
        self.assertEqual(
            self.manifest["storage"]["build_profiles"]["fem_gpu"],
            "windows-native-fem-gpu",
        )
        receipt_contract = self.manifest["provider_bootstrap"]["receipt_contract"]
        self.assertEqual(receipt_contract["schema"], "fullmag.windows.fem-providers.v1")
        self.assertTrue(receipt_contract["root_must_match_selected_profile"])
        self.assertFalse(receipt_contract["cpu"]["cuda"])
        self.assertTrue(receipt_contract["gpu"]["cuda"])
        self.assertEqual(receipt_contract["gpu"]["pattern"], r"^\d+(;\d+)*$")
        zstd = self.manifest["provider_bootstrap"]["internal_helpers"]["zstd"]
        self.assertEqual(zstd["kind"], "provider_bootstrap_internal_helper")
        self.assertEqual(zstd["version"], "1.5.7")
        self.assertRegex(zstd["archive_sha256"], r"^[0-9a-f]{64}$")
        self.assertFalse(zstd["host_requirement"])
        self.assertEqual(zstd["managed_by"], "scripts/windows/native_fem_dependencies.ps1")
        webview2 = self.manifest["desktop_runtime"]["webview2"]
        self.assertEqual(webview2["status_in_setup"], "NOT VERIFIED")
        self.assertTrue(webview2["official_url"].startswith("https://"))
        for lane in ("native", "fem_cpu", "fem_gpu"):
            self.assertTrue(self.manifest["lanes"][lane]["required"])
        for lane in ("fem_cpu", "fem_gpu"):
            for tool in ("python", "uv", "node", "pnpm", "just"):
                self.assertIn(tool, self.manifest["lanes"][lane]["required"])
        for provider in ("mfem", "hypre", "libceed"):
            self.assertIn(provider, self.manifest["lanes"]["fem_cpu"]["required"])
            self.assertIn(provider, self.manifest["lanes"]["fem_gpu"]["required"])

    def test_pins_are_explicit_and_official(self) -> None:
        tools = self.manifest["tools"]
        self.assertEqual(tools["node"]["minimum"], "24.18.0")
        self.assertEqual(tools["node"]["maximum_exclusive"], "25.0.0")
        self.assertEqual(tools["node"]["pinned_reference"]["version"], "24.18.0")
        self.assertRegex(tools["node"]["pinned_reference"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(tools["pnpm"]["version"], "10.8.1")
        self.assertEqual(tools["just"]["version"], "1.51.0")
        self.assertEqual(tools["just"]["install"]["method"], "official_pinned_zip")
        self.assertRegex(tools["just"]["install"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(tools["uv"]["version"], "0.13.0")
        self.assertEqual(tools["uv"]["install"]["package"], "uv==0.13.0")
        self.assertEqual(tools["rust_msvc"]["install"]["id"], "Rustlang.Rustup")
        self.assertEqual(tools["ninja"]["version"], "1.13.2")
        self.assertRegex(tools["ninja"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(tools["clang_cl"]["version"], "23.1.3")
        self.assertNotIn(
            "Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset",
            tools["msvc_x64"]["components"],
        )
        self.assertEqual(tools["msmpi_sdk"]["version"], "10.1.1")
        self.assertEqual(tools["mfem"]["version"], "v4.9")
        self.assertEqual(tools["hypre"]["version"], "v3.1.0")
        self.assertEqual(tools["libceed"]["version"], "v0.12.0")
        self.assertEqual(tools["wix"]["kind"], "optional_future_burn_tool")
        self.assertEqual(tools["wix"]["current_msi_tools"], ["candle.exe", "light.exe"])
        for tool in tools.values():
            source = tool.get("official_url") or tool.get("url")
            if source:
                self.assertTrue(source.startswith("https://"), source)

    def test_setup_is_check_first_and_storage_guarded(self) -> None:
        self.assertIn("[switch]$Install", self.setup)
        self.assertIn("[switch]$Json", self.setup)
        self.assertIn("FULLMAG_PROJECT_STORAGE_ROOT", self.setup)
        self.assertIn("Resolve-FullmagStorage -Create:$Install", self.setup)
        self.assertIn("scripts\\\\fullmag_storage.py", self.setup)
        self.assertIn("Windows-only and refuses WSL/Linux fallback", self.setup)
        self.assertIn("Refusing to overwrite an existing FULLMAG_PROJECT_STORAGE_ROOT", self.setup)
        self.assertIn("refusing to overwrite it", self.setup)
        self.assertIn("Install-PinnedNode", self.setup)
        self.assertIn("$reference.sha256", self.setup)
        self.assertIn("Invoke-Python", self.setup)
        self.assertIn("Get-MainCheckoutRoot", self.setup)
        self.assertIn("Get-StorageProfile", self.setup)
        self.assertIn("Get-ProviderPath", self.setup)
        self.assertIn("Get-ProviderReceiptLaneError", self.setup)
        self.assertIn("Assert-ProviderReceiptZstd", self.setup)
        self.assertIn("Assert-NativeFemProviderZstd", self.run_fullmag)
        self.assertIn("selected FEM storage profile", self.setup)
        self.assertIn("non-empty numeric CUDA architecture list", self.setup)
        self.assertIn("cuda_architectures", self.setup)
        self.assertIn('"worktree", "list", "--porcelain"', self.setup)
        self.assertIn("corepack.cmd", self.setup)
        self.assertIn("compiler_ready_provider_pending", self.setup)
        self.assertIn("$null = Ensure-StorageDirectory", self.setup)
        self.assertIn("$tool.install.sha256", self.setup)
        self.assertNotIn("New-Object System.Collections.Generic.List[object]", self.setup)
        self.assertIn("$script:Results.ToArray()", self.setup)
        self.assertIn("failure_location = $_.ScriptStackTrace", self.setup)
        self.assertIn("IsNullOrWhiteSpace([string]$VsInfo.cl)", self.setup)
        self.assertIn("IsNullOrWhiteSpace([string]$VsInfo.clang)", self.setup)
        self.assertIn("function Invoke-NativeOutput", self.setup)
        self.assertIn('$ErrorActionPreference = "Continue"', self.setup)
        self.assertEqual(self.setup.count("2>&1 | Out-String"), 1)
        self.assertIn("$toolchainResult.exit_code -ne 0", self.setup)
        self.assertIn("$targetResult.exit_code -ne 0", self.setup)
        self.assertIn("Initial check failed; attempting the requested installation", self.setup)
        self.assertIn("$raw -notmatch", self.setup)
        self.assertIn("Assert-MainCheckoutPath", self.setup)
        self.assertIn("Python >=3.12 must be available as python.exe on PATH", self.setup)
        self.assertNotIn("Get-Command py.exe", self.setup)
        self.assertIn("function Assert-ProviderReceiptInventory", self.setup)
        self.assertIn("Assert-ProviderReceiptPathChain", self.setup)
        self.assertIn("Provider zstd archive hash does not match", self.setup)
        self.assertIn("installed-prefix inventory omits a file", self.setup)
        self.assertIn("installed-prefix inventory does not exactly cover", self.setup)
        self.assertIn('"fullmag.windows.fem-providers.v1"', self.setup)
        self.assertIn("$script:ProviderReceiptInventoryValidated", self.setup)
        self.assertIn("Provider receipt installed prefix is missing", self.setup)
        self.assertIn("Get-FileHash -LiteralPath $resolved", self.setup)
        self.assertIn('status="blocked"; path=$script:ProviderRoot; detail=$_.Exception.Message', self.setup)
        self.assertIn('status -notin @("pass", "not_applicable", "blocked")', self.setup)
        self.assertIn('"ninja", "clang_cl", "msmpi_sdk", "mfem", "hypre", "libceed"', self.setup)
        self.assertIn("Get-CheckoutDirectoryHint", self.setup)
        self.assertIn("refusing to run git init", self.setup)
        self.assertIn("if (-not $Json) { Write-Host", self.setup)

        # The mutation calls in the executable path occur only after resolver
        # success and are gated by -Install in Get-ManagedDirectory.
        resolver_call = self.setup.index("$script:Layout = Resolve-FullmagStorage -Create:$Install")
        tools_path = self.setup.index("$script:ToolsPath = Get-ManagedDirectory")
        provider_path = self.setup.index("$script:ProviderRoot = Get-ManagedDirectory")
        self.assertLess(resolver_call, tools_path)
        self.assertLess(resolver_call, provider_path)
        managed_function = self.setup.index("function Get-ManagedDirectory")
        managed_gate = self.setup.index("elseif ($Install) { New-Item", managed_function)
        self.assertGreater(managed_gate, managed_function)
        raw_path_guard = self.setup.index("$raw -notmatch")
        full_path_normalization = self.setup.index("[System.IO.Path]::GetFullPath($raw)")
        self.assertLess(raw_path_guard, full_path_normalization)

        # WSL is mentioned only as a refusal/documentation term; no executable
        # invocation may be introduced as a fallback.
        self.assertIsNone(re.search(r"(?:&|Start-Process\s+-FilePath)\s+['\"]?wsl(?:\.exe)?", self.setup, re.I))
        self.assertIsNone(re.search(r"[A-Za-z]:\\(?:Users|home)\\", self.setup, re.I))

    def test_provider_bootstrap_is_not_duplicated_globally(self) -> None:
        self.assertIn("provider_bootstrap.script", self.setup)
        self.assertIn("will not silently install a second global provider", self.setup)
        for name in ("mfem", "hypre", "libceed", "msmpi_sdk"):
            self.assertIn(name, self.manifest["provider_bootstrap"]["required_for"])
        self.assertNotIn("zstd", self.manifest["provider_bootstrap"]["required_for"])
        self.assertNotIn("zstd", self.manifest["tools"])
        self.assertFalse(self.manifest["provider_bootstrap"]["internal_helpers"]["zstd"]["host_requirement"])

    def test_documentation_mentions_boundaries_and_entrypoints(self) -> None:
        for token in (
            "-StorageRoot",
            "-Install",
            "-Json",
            "FULLMAG_PROJECT_STORAGE_ROOT",
            "installation",
            "runtime_tool_status",
            "NOT VERIFIED",
            "run_fullmag_fem.ps1",
            "windows-build fem gpu",
            "compiler_ready_provider_pending",
            "just 1.51.0",
            "v0.12.0",
            "10.8.1",
            "fullmag.exe",
            "WiX Burn",
            "build_windows_msi.ps1",
            "candle.exe",
            "light.exe",
            "WebView2",
            "Evergreen Bootstrapper",
            "Tauri Windows prerequisites",
        ):
            self.assertIn(token, self.guide)
        self.assertIn("Split-Path -Parent (Get-Location).Path", self.guide)
        self.assertIn("osobno zarejestrowany", self.guide)
        self.assertNotIn("D:\\FullmagStorage", self.guide)

        links = re.findall(r"\]\(([^)]+)\)", self.guide)
        for link in links:
            if link.startswith(("http://", "https://", "#")):
                continue
            target = (GUIDE.parent / link.split("#", 1)[0]).resolve()
            self.assertTrue(target.is_file(), f"missing local documentation link: {link}")

    @staticmethod
    def _powershell_command() -> str | None:
        for name in ("pwsh", "powershell", "powershell.exe"):
            command = shutil.which(name)
            if command:
                return command
        return None

    @staticmethod
    def _main_checkout_root() -> Path:
        try:
            completed = subprocess.run(
                ["git", "-C", str(ROOT), "worktree", "list", "--porcelain"],
                check=True,
                capture_output=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError):
            return ROOT
        for line in completed.stdout.splitlines():
            if line.startswith("worktree "):
                return Path(line.removeprefix("worktree ").strip())
        return ROOT

    def test_native_json_fixture_preserves_main_dotenv(self) -> None:
        """Run the no-install boundary on Windows when PowerShell is available."""

        powershell = self._powershell_command()
        if powershell is None:
            self.skipTest("Windows PowerShell is unavailable on this host")

        main_checkout = self._main_checkout_root()
        dotenv = main_checkout / ".env"
        before_exists = dotenv.exists()
        before = dotenv.read_bytes() if before_exists else None
        with tempfile.TemporaryDirectory(prefix="fullmag-windows-setup-") as temporary:
            negative_root = Path(temporary) / "negative-storage-root"
            environment = os.environ.copy()
            environment.pop("FULLMAG_PROJECT_STORAGE_ROOT", None)
            completed = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(SETUP),
                    "-Lane",
                    "native",
                    "-StorageRoot",
                    str(negative_root),
                    "-Json",
                ],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

        self.assertIn(completed.returncode, (0, 2), completed.stderr)
        report = json.loads(completed.stdout)
        self.assertIsInstance(report, dict)
        self.assertEqual(report["schema"], "fullmag.windows-build-environment-report.v1")
        if before_exists:
            self.assertEqual(dotenv.read_bytes(), before)
            dotenv_text = before.decode("utf-8", errors="replace")
            if re.search(r"(?m)^\s*(?:export\s+)?FULLMAG_PROJECT_STORAGE_ROOT\s*=", dotenv_text):
                self.assertEqual(completed.returncode, 2)
                self.assertTrue(
                    any("-StorageRoot disagrees" in str(blocker) for blocker in report.get("blockers", [])),
                    report,
                )
        else:
            self.assertFalse(dotenv.exists(), "check mode must not create the main checkout .env")

    def test_native_guard_rejects_existing_child_below_junction(self) -> None:
        powershell = self._powershell_command()
        if os.name != "nt" or powershell is None:
            self.skipTest("Native Windows junction fixture requires PowerShell")
        with tempfile.TemporaryDirectory(prefix="fullmag-setup-junction-") as temporary:
            root = Path(temporary)
            storage = root / "approved"
            storage.mkdir()
            outside = root / "outside"
            (outside / "existing").mkdir(parents=True)
            junction = storage / "tools"
            subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)], check=True, capture_output=True)
            driver = root / "guard.ps1"
            driver.write_text(
                "param($Setup,$Storage,$Candidate)\n"
                "$ErrorActionPreference='Stop'\n"
                "$tokens=$null; $errors=$null\n"
                "$ast=[System.Management.Automation.Language.Parser]::ParseFile($Setup,[ref]$tokens,[ref]$errors)\n"
                "$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-StoragePath'},$true)\n"
                ". ([scriptblock]::Create($fn.Extent.Text))\n"
                "$script:Layout=[pscustomobject]@{storage_root=$Storage}\n"
                "try { Assert-StoragePath $Candidate; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }\n",
                encoding="utf-8",
            )
            result = subprocess.run([powershell, "-NoProfile", "-File", str(driver), str(SETUP), str(storage), str(junction / "existing")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("junction or symlink", result.stderr)

    def test_native_relative_storage_root_is_rejected_before_resolver(self) -> None:
        """A relative root must fail at the setup boundary on Windows."""

        powershell = self._powershell_command()
        if powershell is None:
            self.skipTest("Windows PowerShell is unavailable on this host")

        main_checkout = self._main_checkout_root()
        dotenv = main_checkout / ".env"
        if dotenv.exists() and re.search(
            r"(?m)^\s*(?:export\s+)?FULLMAG_PROJECT_STORAGE_ROOT\s*=",
            dotenv.read_text(encoding="utf-8", errors="replace"),
        ):
            self.skipTest("main checkout .env already selects a storage root")

        environment = os.environ.copy()
        environment.pop("FULLMAG_PROJECT_STORAGE_ROOT", None)
        completed = subprocess.run(
            [
                powershell,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(SETUP),
                "-Lane",
                "native",
                "-StorageRoot",
                "relative-storage-root",
                "-Json",
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2, completed.stderr)
        report = json.loads(completed.stdout)
        self.assertTrue(
            any("absolute local Windows path" in str(blocker) for blocker in report.get("blockers", [])),
            report,
        )

    def test_native_provider_receipt_rejects_inventory_outside_prefix(self) -> None:
        """An existing receipt cannot attest to files outside managed provider roots."""

        powershell = self._powershell_command()
        if os.name != "nt" or powershell is None:
            self.skipTest("Native Windows receipt fixture requires PowerShell")

        with tempfile.TemporaryDirectory(prefix="fullmag-provider-receipt-") as temporary:
            root = Path(temporary)
            provider = root / "provider"
            prefix = provider / "installed"
            prefix.mkdir(parents=True)
            installed = prefix / "mfem.dll"
            installed.write_bytes(b"installed")
            tool = provider / "tool.exe"
            tool.write_bytes(b"tool")
            zstd = provider / "tools" / "zstd-1.5.7" / "zstd-v1.5.7-win64" / "zstd.exe"
            zstd.parent.mkdir(parents=True)
            zstd.write_bytes(b"zstd")
            zstd_archive = provider / "downloads" / "zstd-v1.5.7-win64.zip"
            zstd_archive.parent.mkdir(parents=True)
            zstd_archive.write_bytes(b"archive metadata fixture")
            requirements = json.loads(MANIFEST.read_text(encoding="utf-8"))
            requirements["provider_bootstrap"]["internal_helpers"]["zstd"]["archive_sha256"] = hashlib.sha256(
                zstd_archive.read_bytes()
            ).hexdigest()
            requirements_path = root / "windows_build_requirements.json"
            requirements_path.write_text(json.dumps(requirements), encoding="utf-8")
            outside = root / "outside.dll"
            outside.write_bytes(b"outside")
            receipt_path = provider / "provider-receipt.json"
            receipt_path.write_text(
                json.dumps(
                    {
                        "files": [
                            {
                                "path": str(installed),
                                "size_bytes": installed.stat().st_size,
                                "sha256": hashlib.sha256(installed.read_bytes()).hexdigest(),
                            }
                        ],
                        "tools": [
                            {
                                "path": str(tool),
                                "sha256": hashlib.sha256(tool.read_bytes()).hexdigest(),
                            },
                            {
                                "path": str(zstd),
                                "sha256": hashlib.sha256(zstd.read_bytes()).hexdigest(),
                            }
                        ],
                        "zstd": {
                            "kind": "provider_bootstrap_internal_helper",
                            "version": "1.5.7",
                            "url": "https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip",
                            "archive": str(zstd_archive),
                            "archive_name": "zstd-v1.5.7-win64.zip",
                            "archive_sha256": hashlib.sha256(zstd_archive.read_bytes()).hexdigest(),
                            "executable": str(zstd),
                            "executable_name": "zstd.exe",
                            "executable_sha256": hashlib.sha256(zstd.read_bytes()).hexdigest(),
                            "decode_memory": "2048MB",
                        },
                    }
                ),
                encoding="utf-8",
            )
            driver = root / "receipt_guard.ps1"
            driver.write_text(
                "param($Setup,$RequirementsPath,$ProviderRoot,$ReceiptPath)\n"
                "$ErrorActionPreference='Stop'\n"
                "$tokens=$null; $errors=$null\n"
                "$ast=[System.Management.Automation.Language.Parser]::ParseFile($Setup,[ref]$tokens,[ref]$errors)\n"
                "foreach($name in @('Test-ProviderReceiptPathWithin','Assert-ProviderReceiptPathChain','Assert-ProviderReceiptZstd','Assert-ProviderReceiptInventory')) {\n"
                "  $fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)\n"
                "  if($null -eq $fn){throw \"Missing function: $name\"}\n"
                "  . ([scriptblock]::Create($fn.Extent.Text))\n"
                "}\n"
                "$script:ProviderRoot=$ProviderRoot\n"
                "$script:ProviderReceiptInventoryValidated=$false\n"
                "$script:Requirements=Get-Content -LiteralPath $RequirementsPath -Raw | ConvertFrom-Json\n"
                "try { $receipt=Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json; Assert-ProviderReceiptInventory -Receipt $receipt; exit 0 }\n"
                "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }\n",
                encoding="utf-8",
            )
            valid_result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(driver),
                    str(SETUP),
                    str(requirements_path),
                    str(provider),
                    str(receipt_path),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(valid_result.returncode, 0, valid_result.stdout + valid_result.stderr)

            extra_installed = prefix / "unexpected.dll"
            extra_installed.write_bytes(b"unexpected")
            extra_result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(driver),
                    str(SETUP),
                    str(requirements_path),
                    str(provider),
                    str(receipt_path),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(extra_result.returncode, 2, extra_result.stdout + extra_result.stderr)
            self.assertIn("omits", extra_result.stderr.lower())
            extra_installed.unlink()

            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            receipt["files"][0] = {
                "path": str(outside),
                "size_bytes": outside.stat().st_size,
                "sha256": hashlib.sha256(outside.read_bytes()).hexdigest(),
            }
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(driver),
                    str(SETUP),
                    str(requirements_path),
                    str(provider),
                    str(receipt_path),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("escapes", result.stderr.lower())

    def test_native_run_receipt_requires_pinned_zstd_metadata(self) -> None:
        """The runtime receipt boundary accepts the pinned helper and rejects drift."""

        powershell = self._powershell_command()
        if os.name != "nt" or powershell is None:
            self.skipTest("Native Windows receipt fixture requires PowerShell")

        with tempfile.TemporaryDirectory(prefix="fullmag-run-provider-receipt-") as temporary:
            root = Path(temporary)
            provider = root / "provider"
            zstd = provider / "tools" / "zstd-1.5.7" / "zstd-v1.5.7-win64" / "zstd.exe"
            zstd.parent.mkdir(parents=True)
            zstd.write_bytes(b"zstd")
            archive = provider / "downloads" / "zstd-v1.5.7-win64.zip"
            archive.parent.mkdir(parents=True)
            archive.write_bytes(b"archive metadata fixture")
            requirements = json.loads(MANIFEST.read_text(encoding="utf-8"))
            requirements["provider_bootstrap"]["internal_helpers"]["zstd"]["archive_sha256"] = hashlib.sha256(
                archive.read_bytes()
            ).hexdigest()
            requirements_path = root / "windows_build_requirements.json"
            requirements_path.write_text(json.dumps(requirements), encoding="utf-8")
            metadata = {
                "kind": "provider_bootstrap_internal_helper",
                "version": "1.5.7",
                "url": "https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip",
                "archive": str(archive),
                "archive_name": "zstd-v1.5.7-win64.zip",
                "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "executable": str(zstd),
                "executable_name": "zstd.exe",
                "executable_sha256": hashlib.sha256(zstd.read_bytes()).hexdigest(),
                "decode_memory": "2048MB",
            }
            receipt_path = root / "receipt.json"
            receipt_path.write_text(
                json.dumps(
                    {
                        "zstd": metadata,
                        "tools": [{"path": str(zstd), "sha256": metadata["executable_sha256"]}],
                    }
                ),
                encoding="utf-8",
            )
            driver = root / "zstd_receipt_guard.ps1"
            driver.write_text(
                "param($RunScript,$RequirementsPath,$ProviderRoot,$ReceiptPath)\n"
                "$ErrorActionPreference='Stop'\n"
                "$tokens=$null; $errors=$null\n"
                "$ast=[System.Management.Automation.Language.Parser]::ParseFile($RunScript,[ref]$tokens,[ref]$errors)\n"
                "foreach($name in @('Resolve-AbsolutePath','Get-Sha256File','Test-NativeFemPathWithin','Assert-NativeFemPathChain','Assert-NativeFemProviderZstd')) {\n"
                "  $fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)\n"
                "  if($null -eq $fn){throw \"Missing function: $name\"}\n"
                "  . ([scriptblock]::Create($fn.Extent.Text))\n"
                "}\n"
                "$requirements=Get-Content -LiteralPath $RequirementsPath -Raw | ConvertFrom-Json\n"
                "$receipt=Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json\n"
                "try { Assert-NativeFemProviderZstd -Receipt $receipt -Requirements $requirements -ProviderRoot $ProviderRoot; exit 0 }\n"
                "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }\n",
                encoding="utf-8",
            )

            def run_guard() -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [
                        powershell,
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(driver),
                        str(RUN_FULLMAG),
                        str(requirements_path),
                        str(provider),
                        str(receipt_path),
                    ],
                    capture_output=True,
                    text=True,
                )

            valid = run_guard()
            self.assertEqual(valid.returncode, 0, valid.stdout + valid.stderr)
            archive_bytes = archive.read_bytes()
            archive.write_bytes(archive_bytes + b"tampered")
            tampered_archive = run_guard()
            self.assertEqual(tampered_archive.returncode, 2, tampered_archive.stdout + tampered_archive.stderr)
            self.assertIn("archive hash", tampered_archive.stderr.lower())
            archive.write_bytes(archive_bytes)
            invalid = json.loads(receipt_path.read_text(encoding="utf-8"))
            invalid["zstd"]["decode_memory"] = "128MB"
            receipt_path.write_text(json.dumps(invalid), encoding="utf-8")
            drifted = run_guard()
            self.assertEqual(drifted.returncode, 2, drifted.stdout + drifted.stderr)
            self.assertIn("does not match", drifted.stderr.lower())

    def test_native_main_checkout_guard_rejects_outside_and_reparse_paths(self) -> None:
        """The .env guard checks both lexical confinement and existing junctions."""

        powershell = self._powershell_command()
        if os.name != "nt" or powershell is None:
            self.skipTest("Native Windows path fixture requires PowerShell")

        with tempfile.TemporaryDirectory(prefix="fullmag-main-checkout-") as temporary:
            root = Path(temporary)
            main = root / "main"
            outside = root / "outside"
            main.mkdir()
            outside.mkdir()
            outside_env = outside / ".env"
            outside_env.write_text("FULLMAG_PROJECT_STORAGE_ROOT=C:\\outside\n", encoding="utf-8")
            driver = root / "main_guard.ps1"
            driver.write_text(
                "param($Setup,$MainRoot,$Candidate)\n"
                "$ErrorActionPreference='Stop'\n"
                "$tokens=$null; $errors=$null\n"
                "$ast=[System.Management.Automation.Language.Parser]::ParseFile($Setup,[ref]$tokens,[ref]$errors)\n"
                "$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-MainCheckoutPath'},$true)\n"
                "if($null -eq $fn){throw 'Missing Assert-MainCheckoutPath'}\n"
                ". ([scriptblock]::Create($fn.Extent.Text))\n"
                "$script:MainRepoRoot=$MainRoot\n"
                "try { Assert-MainCheckoutPath $Candidate '.env'; exit 0 }\n"
                "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }\n",
                encoding="utf-8",
            )

            outside_result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(driver),
                    str(SETUP),
                    str(main),
                    str(outside_env),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(outside_result.returncode, 2, outside_result.stdout + outside_result.stderr)
            self.assertIn("inside the main checkout", outside_result.stderr.lower())

            junction = main / "linked"
            link_result = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)],
                capture_output=True,
                text=True,
            )
            if link_result.returncode != 0:
                self.skipTest(f"junction creation unavailable: {link_result.stderr}")
            reparse_result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(driver),
                    str(SETUP),
                    str(main),
                    str(junction / ".env"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(reparse_result.returncode, 2, reparse_result.stdout + reparse_result.stderr)
            self.assertIn("junction or symlink", reparse_result.stderr.lower())

    def test_native_corrupt_provider_receipt_is_blocked(self) -> None:
        """A corrupt existing receipt is an actionable blocker, not pending bootstrap."""

        powershell = self._powershell_command()
        if os.name != "nt" or powershell is None:
            self.skipTest("Native Windows receipt fixture requires PowerShell")

        with tempfile.TemporaryDirectory(prefix="fullmag-corrupt-receipt-") as temporary:
            root = Path(temporary)
            provider = root / "provider"
            provider.mkdir()
            receipt_path = provider / "provider-receipt.json"
            receipt_path.write_text("{not-json", encoding="utf-8")
            driver = root / "receipt_parse_guard.ps1"
            driver.write_text(
                "param($Setup,$ProviderRoot)\n"
                "$ErrorActionPreference='Stop'\n"
                "$tokens=$null; $errors=$null\n"
                "$ast=[System.Management.Automation.Language.Parser]::ParseFile($Setup,[ref]$tokens,[ref]$errors)\n"
                "$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ProviderReceipt'},$true)\n"
                "if($null -eq $fn){throw 'Missing Get-ProviderReceipt'}\n"
                ". ([scriptblock]::Create($fn.Extent.Text))\n"
                "$script:ProviderRoot=$ProviderRoot\n"
                "try { $null=Get-ProviderReceipt; exit 0 }\n"
                "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(driver),
                    str(SETUP),
                    str(provider),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            combined = f"{result.stdout or ''}{result.stderr or ''}"
            self.assertEqual(result.returncode, 2, combined)
            self.assertIn("invalid", combined.lower())


if __name__ == "__main__":
    raise SystemExit(unittest.main(verbosity=2))
