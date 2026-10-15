"""Source and optional native checks for the source-first installer helper.

The production target is an x86 Win32 EXE and is compiled by the managed
Windows installer job.  These checks deliberately do not configure CMake,
invoke a compiler, run Burn, or execute real setup/build commands.  The
native path-propagation fixture uses only temporary mocked commands.
"""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/windows/installer/FullmagEnvironmentBootstrap"
CPP = HELPER / "FullmagEnvironmentBootstrap.cpp"
CMAKE = HELPER / "CMakeLists.txt"
RC = HELPER / "FullmagEnvironmentBootstrap.rc"
MANIFEST = HELPER / "FullmagEnvironmentBootstrap.manifest"
WORKFLOW = ROOT / "scripts/windows/run_installer_environment.ps1"
SETUP = ROOT / "scripts/windows/setup_build_environment.ps1"
RESOURCE = HELPER / "resource.h"
RUN_NATIVE_WINDOWS_POWERSHELL = os.environ.get("FULLMAG_RUN_NATIVE_WINDOWS_POWERSHELL") == "1"
NATIVE_POWERSHELL = shutil.which("powershell.exe")
if NATIVE_POWERSHELL is None and RUN_NATIVE_WINDOWS_POWERSHELL:
    NATIVE_POWERSHELL = os.environ.get("FULLMAG_WINDOWS_POWERSHELL")
NATIVE_CMD = shutil.which("cmd.exe")
NATIVE_CMAKE = shutil.which("cmake.exe") or shutil.which("cmake")


def native_windows_path(path: Path) -> str:
    if os.name == "nt":
        return str(path)
    wslpath = shutil.which("wslpath")
    if wslpath is None:
        raise unittest.SkipTest("wslpath is required for native Windows PowerShell")
    return subprocess.check_output(
        [wslpath, "-w", str(path)], text=True, timeout=10
    ).strip()


def write_windows_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\r\n") as stream:
        stream.write(text)


class InstallerEnvironmentBootstrapContract(unittest.TestCase):
    def test_production_sources_are_present_and_win32_static_crt(self) -> None:
        for path in (CPP, CMAKE, RC, MANIFEST, WORKFLOW, RESOURCE):
            self.assertTrue(path.is_file(), path)
        cmake = CMAKE.read_text(encoding="utf-8")
        self.assertIn("LANGUAGES CXX RC", cmake)
        self.assertIn("CMAKE_SIZEOF_VOID_P", cmake)
        self.assertIn("must be built as x86/Win32", cmake)
        self.assertIn('MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"', cmake)
        self.assertIn('OUTPUT_NAME "fullmag-installer-environment"', cmake)
        self.assertIn("../../run_installer_environment.ps1", cmake)
        self.assertIn('VS_GLOBAL_GenerateManifest "false"', cmake)
        self.assertIn("target_link_options(FullmagEnvironmentBootstrap PRIVATE /MANIFEST:NO)", cmake)

    def test_resource_embeds_versioned_workflow_and_manifest(self) -> None:
        resource = RC.read_text(encoding="utf-8")
        self.assertIn("RT_MANIFEST", resource)
        self.assertIn('IDR_FULLMAG_WORKFLOW RCDATA "../../run_installer_environment.ps1"', resource)
        self.assertIn("IDR_FULLMAG_WORKFLOW", RESOURCE.read_text(encoding="utf-8"))
        self.assertNotIn("FullmagEnvironmentBootstrap.manifest", CMAKE.read_text(encoding="utf-8"))
        manifest = MANIFEST.read_text(encoding="utf-8")
        self.assertIn('processorArchitecture="x86"', manifest)
        self.assertIn('requestedExecutionLevel level="asInvoker"', manifest)
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('$WorkflowVersion = "1.0.0"', workflow)
        self.assertIn('embedded = $true', workflow)

    @unittest.skipUnless(
        os.name == "nt" and NATIVE_CMAKE,
        "native CMake is required for the generated Visual Studio project check",
    )
    def test_generated_visual_studio_project_disables_automatic_manifest(self) -> None:
        """Configure only and inspect the generated MSBuild manifest settings."""

        with tempfile.TemporaryDirectory() as temporary:
            build = Path(temporary) / "cmake-build"
            result = subprocess.run(
                [
                    NATIVE_CMAKE,
                    "-S",
                    str(HELPER),
                    "-B",
                    str(build),
                    "-G",
                    "Visual Studio 17 2022",
                    "-A",
                    "Win32",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            project_path = build / "FullmagEnvironmentBootstrap.vcxproj"
            self.assertTrue(project_path.is_file(), list(build.glob("*.vcxproj")))
            project = project_path.read_text(encoding="utf-8")
            self.assertRegex(project, r"<GenerateManifest>false</GenerateManifest>")

    def test_cli_is_closed_and_profile_mapping_is_explicit(self) -> None:
        cpp = CPP.read_text(encoding="utf-8")
        for option in (
            "--checkout",
            "--storage-root",
            "--profile",
            "--mode",
            "--receipt",
            "--admission-path",
            "--admission-sha256",
        ):
            self.assertIn(option, cpp)
        for profile in (
            "windows-native-fdm-cpu",
            "windows-native-fem-cpu",
            "windows-native-fem-gpu",
        ):
            self.assertIn(profile, cpp)
            self.assertIn(profile, WORKFLOW.read_text(encoding="utf-8"))
        for mode in ("setup-only", "initial-build", "launch-ui"):
            self.assertIn(mode, cpp)
            self.assertIn(mode, WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("seen.size() == 7", cpp)
        self.assertIn("CREATE_UNICODE_ENVIRONMENT", cpp)
        self.assertIn("CREATE_NO_WINDOW", cpp)
        self.assertNotIn("std::system(", cpp)
        self.assertNotIn("popen(", cpp)
        self.assertNotIn("wsl.exe", cpp.lower())

    def test_source_and_storage_guards_are_fail_closed(self) -> None:
        cpp = CPP.read_text(encoding="utf-8")
        workflow = WORKFLOW.read_text(encoding="utf-8")
        for marker in (
            "FILE_ATTRIBUTE_REPARSE_POINT",
            "ValidateNoReparseAncestors",
            "IsInside",
            "GetFileAttributesW",
            "ReceiptIsSafe",
            "admission_path",
            "admission_sha256",
            "FlushFileBuffers",
        ):
            self.assertIn(marker, cpp, marker)
        for marker in (
            "Assert-NoReparseAncestors",
            "Assert-Inside",
            "Assert-SanitizedEnvironment",
            "source_identity",
            "source_admission",
            "source_admission_hash_mismatch",
            "Assert-AdmissionUnchanged",
            "source_changed_after_setup",
            "source_changed_after_build",
            "runs_root = [string]$context.runs_root",
            "environment_hash = [string]$context.environment_hash",
            "Write-AtomicReceipt",
            "FileMode]::CreateNew",
            "SetEnvironmentVariable($name, $null, \"Process\")",
            "runtime_qualification = \"NOT VERIFIED\"",
        ):
            self.assertIn(marker, workflow, marker)
        self.assertIn("FULLMAG_PROJECT_STORAGE_ROOT", workflow)
        self.assertIn("FULLMAG_BOOTSTRAP_SOURCE_ADMISSION", workflow)
        self.assertIn("FULLMAG_BOOTSTRAP_SOURCE_ADMISSION_SHA256", workflow)
        self.assertNotIn("SetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', $null", workflow)

    def test_setup_and_initial_build_are_the_only_child_operations(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        setup = SETUP.read_text(encoding="utf-8")
        self.assertIn('"-Install", "-Lane", $Lane, "-StorageRoot", $StorageRoot, "-Json"', workflow)
        self.assertIn('"-Install", "-PrerequisitesOnly", "-Lane", $Lane, "-StorageRoot", $StorageRoot, "-Json"', workflow)
        self.assertIn('"windows-workspace-build", "release", "static", $webPort, "true"', workflow)
        self.assertIn('"windows-fem-workspace-build", $Device, "static", $webPort', workflow)
        self.assertIn('"windows-ui", "static", $webPort, "false", "release"', workflow)
        self.assertIn('"windows-fem-workspace", $Device, "static", $webPort', workflow)
        self.assertIn('"windows_build_requirements.json"', workflow)
        self.assertIn("storage_profile_not_windows_setup", workflow)
        self.assertIn("Get-ManagedJust", workflow)
        self.assertIn("cache_root", workflow)
        self.assertIn('runtime_qualification = "NOT VERIFIED"', workflow)
        self.assertIn('initial_build = [ordered]@', workflow)
        self.assertIn('$expectedSetupReportProfile = if ([string]$mapping.backend -eq "fem")', workflow)
        self.assertIn('Get-SetupReport $setupResult.output $checkout $main $storageRoot $expectedSetupReportProfile', workflow)
        self.assertIn('$runtimeLayout = Resolve-StorageLayout $python $checkout $storageRoot $expectedSetupReportProfile', workflow)
        self.assertIn('runs_root = [string]$context.runs_root', workflow)
        self.assertIn('environment_hash = [string]$context.environment_hash', workflow)
        self.assertIn('[switch]$PrerequisitesOnly', setup)
        self.assertIn('if ($PrerequisitesOnly)', setup)
        self.assertIn('storage_resolver = "not_run"', setup)
        self.assertIn('full_dependency_install = $false', setup)

    def test_fresh_host_bootstraps_git_and_python_before_source_resolution(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        setup = SETUP.read_text(encoding="utf-8")
        self.assertIn("function Invoke-PrerequisiteSetup", workflow)
        self.assertIn("function Get-PrerequisiteReport", workflow)
        self.assertIn("fullmag.windows-build-prerequisites.v1", setup)
        self.assertIn("Assert-ExecutablePath", setup)
        self.assertIn("function Get-PowerShellCommand", workflow)
        setup_path = workflow.index('$setupScript = Join-Path $checkout "scripts\\windows\\setup_build_environment.ps1"')
        preflight = workflow.index('$prerequisiteResult = Invoke-PrerequisiteSetup $powerShell $setupScript')
        source_resolution = workflow.index('$checkoutInfo = Get-MainCheckout $checkout $git')
        identity = workflow.index('$identity = Get-SourceIdentity $checkout $main $git $profile')
        full_setup = workflow.index('$setupResult = Invoke-Setup $powerShell $setupScript')
        self.assertLess(setup_path, preflight)
        self.assertLess(preflight, source_resolution)
        self.assertLess(source_resolution, identity)
        self.assertLess(identity, full_setup)
        admission = workflow.index('$admission = Get-SourceAdmission')
        resolver = workflow.index('Resolve-StorageLayout $python $main $storageRoot $storageProfile')
        self.assertLess(admission, resolver)
        self.assertIn('$git = Get-PrerequisiteExecutable $prerequisites "git"', workflow)
        self.assertIn('$python = Get-PrerequisiteExecutable $prerequisites "python"', workflow)
        self.assertIn('$script:StorageProfile = [string]$script:Requirements.storage.setup_profile', setup)
        self.assertIn('Resolve-StorageConfiguration', setup)

    def test_requested_checkout_is_the_source_and_initial_build_working_directory(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('Join-Path $checkout "windows_build_requirements.json"', workflow)
        self.assertIn('Resolve-StorageLayout $python $main $storageRoot $storageProfile', workflow)
        self.assertIn('Invoke-Setup $powerShell $setupScript', workflow)
        self.assertIn('param([Parameter(Mandatory = $true)][string]$Just, [Parameter(Mandatory = $true)][string]$Checkout', workflow)
        self.assertIn('Push-Location $Checkout', workflow)
        self.assertIn('Invoke-InitialBuild $just $checkout $storageRoot', workflow)
        self.assertNotIn('Find-GitCommand', workflow)
        self.assertNotIn('Find-PythonCommand', workflow)

    def test_admitted_tool_directories_are_available_to_full_setup_and_build(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        enter = workflow.index('$admittedToolPath = Enter-AdmittedToolPath @($git, $python)')
        setup = workflow.index('$setupResult = Invoke-Setup $powerShell $setupScript')
        build = workflow.index('$buildResult = Invoke-InitialBuild $just $checkout $storageRoot')
        restore = workflow.index('Restore-AdmittedToolPath $admittedToolPath', build)
        self.assertLess(enter, setup)
        self.assertLess(enter, build)
        self.assertLess(setup, restore)
        self.assertLess(build, restore)
        self.assertIn('function Enter-AdmittedToolPath', workflow)
        self.assertIn('Assert-RegularFile $path "prerequisite_executable"', workflow)
        self.assertIn('[Environment]::SetEnvironmentVariable("PATH", $newPath, "Process")', workflow)
        self.assertIn('finally {\n    Restore-AdmittedToolPath $admittedToolPath\n  }', workflow)
        self.assertIn('[Environment]::SetEnvironmentVariable("PATH", $null, "Process")', workflow)
        self.assertIn('[Environment]::SetEnvironmentVariable("PATH", [string]$State.original, "Process")', workflow)

    def test_launch_ui_reuses_completed_receipt_without_writing_it(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        cpp = CPP.read_text(encoding="utf-8")
        self.assertIn('if ($mode -eq "launch-ui")', workflow)
        self.assertIn('Get-ExistingInitialReceipt', workflow)
        self.assertIn('Resolve-StorageLayout $python $main $storageRoot $storageProfile -ReadOnly', workflow)
        self.assertIn('Assert-StaticWorkspaceManifest', workflow)
        self.assertIn('initial_receipt_changed_during_launch', workflow)
        launch_start = workflow.index('if ($mode -eq "launch-ui") {', workflow.index('$runsRoot'))
        launch_end = workflow.index('  $receipt = Get-ReceiptPath', launch_start)
        launch_block = workflow[launch_start:launch_end]
        self.assertNotIn('Invoke-Setup ', launch_block)
        self.assertNotIn('Write-AtomicReceipt', launch_block)
        self.assertIn('expected_build_id', launch_block)
        self.assertIn('Invoke-WorkspaceLaunch $just $checkout $storageRoot', launch_block)
        self.assertIn('$expectedBuildId', launch_block)
        self.assertIn('initial_receipt_manifest_mismatch', launch_block)
        self.assertIn('launch-ui', cpp)
        self.assertIn('receiptBefore != receiptAfter', cpp)

    def test_launch_ui_passes_manifest_identity_to_fixed_runtime_recipes(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        launch_start = workflow.index("function Invoke-WorkspaceLaunch")
        launch = workflow[launch_start:workflow.index("\ntry {\n", launch_start)]
        self.assertIn('[string]$ExpectedBuildId', launch)
        self.assertIn('Assert-Sha256Value $ExpectedBuildId "expected_build_id"', launch)
        self.assertIn('"windows-fem-workspace", $Device, "static", $webPort, $ExpectedBuildId', launch)
        self.assertIn('"windows-ui", "static", $webPort, "false", "release", $ExpectedBuildId', launch)
        self.assertIn('expected_build_id = $null', workflow)
        self.assertIn('initial_build.expected_build_id = [string]$workspaceManifest.sha256', workflow)
        self.assertIn('initial_receipt_expected_build_id', workflow)

    @unittest.skipUnless(
        NATIVE_POWERSHELL and NATIVE_CMD, "native Windows PowerShell and cmd required"
    )
    def test_native_workflow_propagates_prerequisite_tool_directory(self) -> None:
        """A setup child must see admitted tools absent from the parent PATH."""

        temporary_parent = ROOT.parent if os.name != "nt" else None
        with tempfile.TemporaryDirectory(
            dir=str(temporary_parent) if temporary_parent is not None else None
        ) as temporary:
            root = Path(temporary)
            checkout = root / "checkout"
            tools = checkout / "fake-tools"
            scripts = checkout / "scripts"
            setup_script = scripts / "windows" / "setup_build_environment.ps1"
            git = tools / "git.ps1"
            python = tools / "python.ps1"
            storage = checkout / "storage"
            receipt = storage / "runs" / "installer.json"
            tool_dir = native_windows_path(tools).replace("/", "\\").rstrip("\\/")

            write_windows_text(
                git,
                r'''param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)
$checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
[IO.File]::AppendAllText((Join-Path $checkout "git-log.txt"), (($Arguments -join " ") + "`n"))
if ($Arguments.Count -ge 4 -and $Arguments[2] -eq "rev-parse" -and $Arguments[3] -eq "--show-toplevel") {
  [IO.File]::AppendAllText((Join-Path $checkout "git-log.txt"), "branch=showtop`n")
  Write-Output $Arguments[1]
  return
}
if ($Arguments.Count -ge 4 -and $Arguments[2] -eq "rev-parse" -and $Arguments[3] -eq "HEAD") {
  [IO.File]::AppendAllText((Join-Path $checkout "git-log.txt"), "branch=head`n")
  Write-Output "0123456789abcdef0123456789abcdef01234567"
  return
}
if ($Arguments -contains "worktree") {
  [IO.File]::AppendAllText((Join-Path $checkout "git-log.txt"), "branch=worktree`n")
  $output = "worktree " + [string]$Arguments[1]
  [IO.File]::AppendAllText((Join-Path $checkout "git-log.txt"), ("output=" + $output + "`n"))
  Write-Output $output
  return
}
if ($Arguments -contains "status") {
  [IO.File]::AppendAllText((Join-Path $checkout "git-log.txt"), "branch=status`n")
  return
}
throw "unexpected git fixture arguments"
''',
            )
            write_windows_text(
                python,
                r'''param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)
$checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
[IO.File]::AppendAllText((Join-Path $checkout "python-log.txt"), (($Arguments -join " ") + "`n"))
$storage = Join-Path $checkout "storage"
New-Item -ItemType Directory -Force -Path (Join-Path $storage "runs") | Out-Null
$layout = [ordered]@{
  storage_root = $storage.Replace("\", "/")
  runs_root = (Join-Path $storage "runs").Replace("\", "/")
  build_root = (Join-Path $storage "builds").Replace("\", "/")
  cache_root = (Join-Path $storage "cache").Replace("\", "/")
  temp_root = (Join-Path $storage "tmp").Replace("\", "/")
  runtime_root = (Join-Path $storage "runtime").Replace("\", "/")
  profile = "windows-setup"
}
Write-Output ($layout | ConvertTo-Json -Compress)
return
''',
            )
            write_windows_text(
                setup_script,
                r'''param(
  [switch]$Install,
  [switch]$PrerequisitesOnly,
  [string]$Lane,
  [string]$StorageRoot,
  [switch]$Json
)
$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$tools = [IO.Path]::GetFullPath((Join-Path $root "fake-tools"))
$git = Join-Path $tools "git.ps1"
$python = Join-Path $tools "python.ps1"
$log = Join-Path $root "setup-log.txt"
if ($PrerequisitesOnly) {
  [IO.File]::AppendAllText($log, "prerequisites`r`n")
  [ordered]@{
    schema = "fullmag.windows-build-prerequisites.v1"
    readiness = "prerequisites_ready"
    repository = $root
    storage_root = $StorageRoot
    lane = $Lane
    project_owned_writes = $false
    full_dependency_install = $false
    storage_resolver = "not_run"
    tools = [ordered]@{
      git = [ordered]@{ path = $git }
      python = [ordered]@{ path = $python }
    }
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}
$hasToolDirectory = @(
  $env:PATH.Split([IO.Path]::PathSeparator) |
    Where-Object {
      [String]::Equals(
        ([IO.Path]::GetFullPath($_)).TrimEnd([char[]]@('\', '/')),
        $tools.TrimEnd([char[]]@('\', '/')),
        [StringComparison]::OrdinalIgnoreCase
      )
    }
).Count -gt 0
if (-not $hasToolDirectory) {
  Write-Error "admitted prerequisite directory is absent from PATH"
  exit 17
}
[IO.File]::AppendAllText($log, "full`r`n")
[IO.File]::WriteAllText((Join-Path $root "observed-path.txt"), $env:PATH)
$reportedProfile = if ($Lane -eq "fem-cpu") {
  "windows-native-fem-cpu"
} elseif ($Lane -eq "fem-gpu") {
  "windows-native-fem-gpu"
} else {
  "windows-setup"
}
[ordered]@{
  schema = "fullmag.windows-build-environment-report.v1"
  mode = "install"
  lane = $Lane
  readiness = "compiler_ready_provider_pending"
  repository = $root
  main_checkout = $root
  storage_root = $StorageRoot
  storage_profile = $reportedProfile
  installation = [ordered]@{ requested = $true }
} | ConvertTo-Json -Depth 8 -Compress
exit 0
''',
            )
            write_windows_text(
                checkout / ".env.example",
                "FULLMAG_PROJECT_STORAGE_ROOT=C:\\storage\n",
            )
            write_windows_text(
                checkout / ".env",
                "FULLMAG_PROJECT_STORAGE_ROOT=C:\\storage\n",
            )
            (checkout / "windows_build_requirements.json").write_text(
                json.dumps(
                    {
                        "storage": {
                            "setup_profile": "windows-setup",
                            "build_profiles": {
                                "native": "windows-native-fdm-cpu",
                                "fem_cpu": "windows-native-fem-cpu",
                                "fem_gpu": "windows-native-fem-gpu",
                            },
                        }
                    }
                ),
                encoding="utf-8",
            )
            write_windows_text(checkout / "scripts" / "fullmag_storage.py", "# fixture resolver\n")
            native_checkout = native_windows_path(checkout)
            native_main = native_checkout
            native_storage = native_windows_path(storage)
            native_runs = native_windows_path(storage / "runs")
            native_setup = native_windows_path(setup_script)
            native_template = native_windows_path(checkout / ".env.example")
            native_manifest = native_windows_path(checkout / "windows_build_requirements.json")
            native_resolver = native_windows_path(checkout / "scripts" / "fullmag_storage.py")

            def sha256(path: Path) -> str:
                return hashlib.sha256(path.read_bytes()).hexdigest()

            worktree_listing = "worktree " + native_checkout
            worktree_hash = hashlib.sha256(worktree_listing.encode("utf-8")).hexdigest()
            identity_fields = {
                "requested_checkout": native_checkout,
                "main_checkout": native_main,
                "template_hash": sha256(checkout / ".env.example"),
                "manifest_hash": sha256(checkout / "windows_build_requirements.json"),
                "resolver_hash": sha256(checkout / "scripts" / "fullmag_storage.py"),
                "git_top": native_main,
                "git_head": "0123456789abcdef0123456789abcdef01234567",
                "git_worktrees_hash": worktree_hash,
                "requested_git_top": native_checkout,
                "requested_git_head": "0123456789abcdef0123456789abcdef01234567",
                "requested_git_worktrees_hash": worktree_hash,
                "setup_hash": sha256(setup_script),
            }
            native_workflow = native_windows_path(WORKFLOW)
            native_powershell = native_windows_path(Path(NATIVE_POWERSHELL))
            environment = os.environ.copy()
            for name in list(environment):
                if name.upper().startswith("FULLMAG_"):
                    environment.pop(name)

            def run_case(lane: str, profile: str, check_bad_hash: bool) -> None:
                admission = {
                    "schema": "fullmag.windows-installer-source-admission.v1",
                    "version": "1.0.0",
                    "session_id": "0123456789abcdef0123456789abcdef",
                    "requested_checkout": native_checkout,
                    "main_checkout": native_main,
                    "storage_root": native_storage,
                    "runs_root": native_runs,
                    "storage_profile": "windows-setup",
                    "runtime_profile": profile,
                    "lane": lane,
                    "bootstrap_mode": "setup-only",
                    "environment_hash": sha256(checkout / ".env"),
                    "setup_script_path": native_setup,
                    "setup_hash": identity_fields["setup_hash"],
                    "template_path": native_template,
                    "template_hash": identity_fields["template_hash"],
                    "manifest_path": native_manifest,
                    "manifest_hash": identity_fields["manifest_hash"],
                    "resolver_script": native_resolver,
                    "resolver_hash": identity_fields["resolver_hash"],
                    "git_top": native_main,
                    "git_head": identity_fields["git_head"],
                    "git_worktrees_hash": worktree_hash,
                    "requested_git_top": native_checkout,
                    "requested_git_head": identity_fields["requested_git_head"],
                    "requested_git_worktrees_hash": worktree_hash,
                    "source_identity": identity_fields,
                }
                admission_path = storage / "runs" / "installer-source" / f"admission-{lane}.json"
                case_receipt = storage / "runs" / f"installer-{lane}.json"
                write_windows_text(admission_path, json.dumps(admission, separators=(",", ":")))
                admission_hash = sha256(admission_path)
                wrapper = root / f"run-fixture-{lane}.cmd"
                native_receipt = native_windows_path(case_receipt)
                native_admission = native_windows_path(admission_path)
                write_windows_text(
                    wrapper,
                    f'''@echo off
set "PATHEXT=.COM;.EXE;.BAT;.CMD"
set "FULLMAG_BOOTSTRAP_CHECKOUT={native_checkout}"
set "FULLMAG_BOOTSTRAP_STORAGE_ROOT={native_storage}"
set "FULLMAG_BOOTSTRAP_PROFILE={profile}"
set "FULLMAG_BOOTSTRAP_MODE=setup-only"
set "FULLMAG_BOOTSTRAP_RECEIPT={native_receipt}"
set "FULLMAG_BOOTSTRAP_SOURCE_ADMISSION={native_admission}"
set "FULLMAG_BOOTSTRAP_SOURCE_ADMISSION_SHA256={admission_hash}"
set "FULLMAG_BOOTSTRAP_WORKFLOW_VERSION=1.0.0"
"{native_powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{native_workflow}"
exit /b %ERRORLEVEL%
''',
                )
                if check_bad_hash:
                    bad_wrapper = root / f"run-fixture-{lane}-bad-admission.cmd"
                    bad_wrapper_text = wrapper.read_text(encoding="utf-8").replace(
                        f"FULLMAG_BOOTSTRAP_SOURCE_ADMISSION_SHA256={admission_hash}",
                        "FULLMAG_BOOTSTRAP_SOURCE_ADMISSION_SHA256=" + ("0" * 64),
                    )
                    write_windows_text(bad_wrapper, bad_wrapper_text)
                    bad_result = subprocess.run(
                        [NATIVE_CMD, "/d", "/s", "/c", native_windows_path(bad_wrapper)],
                        capture_output=True,
                        text=True,
                        timeout=90,
                        env=environment,
                    )
                    self.assertNotEqual(bad_result.returncode, 0, bad_result.stderr + bad_result.stdout)
                    self.assertFalse(case_receipt.exists())
                for path in (checkout / "setup-log.txt", checkout / "git-log.txt", checkout / "python-log.txt"):
                    if path.exists():
                        path.unlink()
                result = subprocess.run(
                    [NATIVE_CMD, "/d", "/s", "/c", native_windows_path(wrapper)],
                    capture_output=True,
                    text=True,
                    timeout=90,
                    env=environment,
                )
                diagnostics = [result.stderr, result.stdout]
                for name in ("setup-log.txt", "git-log.txt", "python-log.txt"):
                    path = root / "checkout" / name
                    if path.exists():
                        diagnostics.append(name + "=" + path.read_text(encoding="utf-8"))
                self.assertEqual(result.returncode, 0, "\n".join(diagnostics))
                self.assertEqual(
                    (checkout / "setup-log.txt").read_text(encoding="utf-8").splitlines(),
                    ["prerequisites", "full"],
                )
                observed_path = (checkout / "observed-path.txt").read_text(encoding="utf-8")
                self.assertEqual(observed_path.split(";")[0].rstrip("\\/"), tool_dir)
                payload = json.loads(case_receipt.read_text(encoding="utf-8"))
                self.assertEqual(payload["state"], "setup_complete")
                self.assertEqual(payload["profile"], profile)
                self.assertEqual(payload["setup"]["readiness"], "compiler_ready_provider_pending")
                self.assertEqual(payload["admission_sha256"], admission_hash)
                self.assertEqual(payload["admission_path"].lower(), native_admission.lower())
                self.assertEqual(payload["runs_root"].lower(), native_runs.lower())
                self.assertEqual(payload["environment_hash"], admission["environment_hash"])
                self.assertEqual(payload["storage_profile"], "windows-setup")
                self.assertEqual(payload["session"]["session_id"], admission["session_id"])
                self.assertEqual(payload["source_identity"]["requested_checkout"].lower(), native_checkout.lower())

            run_case("native", "windows-native-fdm-cpu", True)
            run_case("fem-cpu", "windows-native-fem-cpu", False)
            run_case("fem-gpu", "windows-native-fem-gpu", False)

    def test_prerequisite_report_binds_exact_paths_without_project_writes(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        setup = SETUP.read_text(encoding="utf-8")
        requirements = json.loads((ROOT / "windows_build_requirements.json").read_text(encoding="utf-8"))
        self.assertIn('$entry = $Report.tools.$Name', workflow)
        self.assertIn('Assert-RegularFile $path ("prerequisite_" + $Name)', workflow)
        self.assertIn('"-PrerequisitesOnly"', workflow)
        self.assertIn('[string]$ExpectedRequirementsSha256', setup)
        self.assertIn('Assert-RequirementsHash', setup)
        self.assertIn('payload_root = $script:PayloadRoot', setup)
        self.assertIn('source_admitted = $false', setup)
        self.assertIn('env_write = $false', setup)
        prerequisite_start = setup.index('if ($PrerequisitesOnly)')
        prerequisite_end = setup.index('  if (-not (Get-Command git.exe', prerequisite_start)
        prerequisite_block = setup[prerequisite_start:prerequisite_end]
        self.assertNotIn('Resolve-FullmagStorage', prerequisite_block)
        self.assertNotIn('Get-ManagedDirectory', prerequisite_block)
        self.assertNotIn('Resolve-StorageConfiguration', prerequisite_block)
        self.assertNotIn('Get-MainCheckoutRoot', prerequisite_block)
        self.assertNotIn('Get-RepoRoot', prerequisite_block)
        self.assertNotIn('Get-DotEnvStorageRoot', prerequisite_block)
        self.assertIn('project_owned_writes = $false', setup)
        self.assertIn('full_dependency_install = $false', setup)
        self.assertIn('PathOption=BashOnly', requirements['tools']['git']['install']['override'])
        python_override = requirements['tools']['python']['install']['override']
        for marker in ('PrependPath=0', 'AppendPath=0', 'Include_launcher=0'):
            self.assertIn(marker, python_override)

    def test_prerequisite_payload_hash_and_install_overrides_are_explicit(self) -> None:
        setup = SETUP.read_text(encoding="utf-8")
        requirements = json.loads((ROOT / "windows_build_requirements.json").read_text(encoding="utf-8"))
        self.assertIn('requirements_sha256 = $script:RequirementsSha256', setup)
        self.assertIn('Requirements manifest hash does not match the verified bundled payload', setup)
        self.assertEqual(
            requirements['tools']['git']['install']['path_policy'],
            'installer_must_not_modify_user_or_machine_path',
        )
        self.assertEqual(
            requirements['tools']['python']['install']['path_policy'],
            'installer_must_not_modify_user_or_machine_path',
        )

    def test_powershell_workflow_parses_when_available(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell.exe") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is unavailable on this host")
        with tempfile.TemporaryDirectory() as temporary:
            probe = Path(temporary) / "parse.ps1"
            probe.write_text(
                "param([string]$Path)\n"
                "$t=$null;$e=$null;"
                "[System.Management.Automation.Language.Parser]::ParseFile($Path,[ref]$t,[ref]$e)|Out-Null;"
                "if($e.Count){$e|Out-String|Write-Error;exit 1};exit 0\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [powershell, "-NoProfile", "-NonInteractive", "-File", str(probe), str(WORKFLOW)],
                capture_output=True,
                text=True,
                timeout=20,
            )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
