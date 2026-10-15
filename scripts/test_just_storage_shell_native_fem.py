"""Regression checks for the closed native FEM just dispatcher."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
SHELL = ROOT / "scripts" / "just_storage_shell.sh"
DISPATCHER = ROOT / "scripts" / "windows" / "dispatch_native_fem_recipe.py"


def _render_recipe(repo: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["just", "--dry-run", *arguments],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert result.returncode == 0, result.stderr
    # just writes a dry-run recipe to stderr.
    return (result.stderr or result.stdout).strip()


def _fixture_repo(tmp_path: Path, *, compact_fullmag: bool = False) -> Path:
    repo = tmp_path / "repo"
    (repo / "bin").mkdir(parents=True)
    (repo / "scripts" / "windows").mkdir(parents=True)
    (repo / "scripts" / "lib").mkdir(parents=True)
    (repo / "examples").mkdir()
    (repo / ".git").mkdir()
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")
    if compact_fullmag:
        start = justfile.index('fullmag opt_1=""')
        end = justfile.index("\nrun-fdm-cpu-smoke:", start)
        compact_recipe = (
            'fullmag opt_1="" opt_2="" opt_3="" opt_4="" opt_5="" '
            'opt_6="" opt_7="" opt_8="":\n'
            '    bash scripts/run_fullmag.sh "{{opt_1}}" "{{opt_2}}" '
            '"{{opt_3}}" "{{opt_4}}" "{{opt_5}}" "{{opt_6}}" '
            '"{{opt_7}}" "{{opt_8}}"\n'
        )
        justfile = justfile[:start] + compact_recipe + justfile[end + 1:]
    (repo / "justfile").write_text(justfile, encoding="utf-8")
    shutil.copy2(SHELL, repo / "scripts" / "just_storage_shell.sh")
    shutil.copy2(ROOT / "scripts" / "run_fullmag.sh", repo / "scripts" / "run_fullmag.sh")
    shutil.copy2(DISPATCHER, repo / "scripts" / "windows" / DISPATCHER.name)
    (repo / "examples" / "native_fem.py").write_text("print('fixture')\n", encoding="utf-8")
    (repo / "scripts" / "fullmag_storage.py").write_text(
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
Path(os.environ['NATIVE_FEM_LOG']).write_text(json.dumps(sys.argv), encoding='utf-8')
""",
        encoding="utf-8",
    )
    if os.name == "nt":
        powershell_script = """param(
    [string]$BuildMode,
    [string]$Frontend,
    [string]$Backend,
    [string]$Device,
    [string]$RunMode,
    [string]$WebPort,
    [string]$ScriptPath,
    [string]$BackendProfile,
    [string]$ExpectedBuildId,
    [switch]$Browser,
    [switch]$BuildOnly,
    [switch]$SkipLocalChanges
)
$payload = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $PSCommandPath,
    "-BuildMode", $BuildMode, "-Frontend", $Frontend, "-Backend", $Backend,
    "-Device", $Device, "-RunMode", $RunMode, "-WebPort", $WebPort
)
if ($Browser) { $payload += "-Browser" }
if ($ExpectedBuildId) { $payload += @("-ExpectedBuildId", $ExpectedBuildId) }
if ($BackendProfile) { $payload += @("-BackendProfile", $BackendProfile) }
if ($ScriptPath) { $payload += @("-ScriptPath", $ScriptPath) }
if ($BuildOnly) { $payload += "-BuildOnly" }
if ($SkipLocalChanges) { $payload += "-SkipLocalChanges" }
$payload = @($payload) | ConvertTo-Json -Compress
[IO.File]::WriteAllText($env:NATIVE_FEM_LOG, $payload)
"""
        for launcher in ("run_fullmag.ps1", "run_fullmag_fem.ps1"):
            (repo / "scripts" / "windows" / launcher).write_text(
                powershell_script,
                encoding="utf-8",
            )
    else:
        powershell = repo / "bin" / "powershell.exe"
        powershell.write_text(
            """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
Path(os.environ['NATIVE_FEM_LOG']).write_text(json.dumps(sys.argv), encoding='utf-8')
""",
            encoding="utf-8",
        )
        powershell.chmod(0o755)
    return repo


def _run_shell(repo: Path, recipe: str, log: Path) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["NATIVE_FEM_LOG"] = str(log)
    environment["PATH"] = str(repo / "bin") + os.pathsep + environment["PATH"]
    return subprocess.run(
        ["bash", "scripts/just_storage_shell.sh", recipe],
        cwd=repo,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def _run_just(repo: Path, log: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["NATIVE_FEM_LOG"] = str(log)
    environment["PATH"] = str(repo / "bin") + os.pathsep + environment["PATH"]
    return subprocess.run(
        ["just", *arguments],
        cwd=repo,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def _probe(repo: Path, recipe: str, **environment: str) -> subprocess.CompletedProcess[str]:
    child_environment = os.environ.copy()
    child_environment.update(environment)
    return subprocess.run(
        [
            sys.executable,
            "scripts/windows/dispatch_native_fem_recipe.py",
            "--repo-root",
            str(repo),
            "--recipe-stdin",
            "--probe",
        ],
        cwd=repo,
        env=child_environment,
        input=recipe,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def _native_windows_host() -> bool:
    if os.name == "nt":
        return True
    result = subprocess.run(["uname", "-s"], capture_output=True, text=True, check=False)
    return result.returncode == 0 and result.stdout.strip().startswith(("MINGW", "MSYS", "CYGWIN"))


def _launcher_arguments(command: list[str]) -> list[str]:
    # The Linux fixture logs argv[0] from its Unix fake.  Real PowerShell
    # consumes its host flags and the fixture script sees only $args.
    return command if os.name == "nt" else command[1:]


def test_fullmag_fem_recipe_bypasses_generic_heavy_runner(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    log = tmp_path / "fullmag.json"
    result = _run_just(
        repo,
        log,
        "fullmag",
        "windows=True",
        "build=True",
        "dev",
        "fem",
        "gpu",
        "examples/native_fem.py",
    )

    assert result.returncode == 0, result.stderr + result.stdout
    command = json.loads(log.read_text(encoding="utf-8"))
    assert _launcher_arguments(command) == [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(repo / "scripts" / "windows" / "run_fullmag_fem.ps1"),
        "-BuildMode",
        "true",
        "-Frontend",
        "dev",
        "-Backend",
        "fem",
        "-Device",
        "gpu",
        "-RunMode",
        "interactive",
        "-WebPort",
        "0",
        "-ScriptPath",
        "examples/native_fem.py",
    ]


def test_compact_fullmag_fem_recipe_survives_native_command_line_budget(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path, compact_fullmag=True)
    log = tmp_path / "compact-fullmag.json"
    result = _run_just(
        repo,
        log,
        "fullmag",
        "windows=True",
        "build=True",
        "dev",
        "fem",
        "gpu",
        "examples/native_fem.py",
    )

    assert result.returncode == 0, result.stderr + result.stdout
    command = json.loads(log.read_text(encoding="utf-8"))
    assert command[command.index("-Device") + 1] == "gpu"
    assert command[command.index("-ScriptPath") + 1] == "examples/native_fem.py"


@pytest.mark.skipif(os.name == "nt", reason="direct Git Bash helper stubs are POSIX-only")
def test_run_fullmag_preserves_fem_port_and_just_runtime_path(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    python_runtime = repo / ".fullmag" / "local" / "python" / "bin" / "python"
    python_runtime.parent.mkdir(parents=True)
    python_runtime.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    python_runtime.chmod(0o755)
    (repo / "scripts" / "lib" / "runtime_bundle_copy.sh").write_text(
        "#!/usr/bin/env bash\n",
        encoding="utf-8",
    )
    (repo / "scripts" / "lib" / "runtime_bundle_copy.sh").chmod(0o755)
    runtime = repo / "managed" / "fullmag-fem-gpu"
    runtime.parent.mkdir()
    runtime.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
Path(os.environ["NATIVE_FEM_RUNTIME_LOG"]).write_text(
    json.dumps({"argv": sys.argv[1:], "env": {
        "FULLMAG_FEM_EXECUTION": os.environ.get("FULLMAG_FEM_EXECUTION"),
        "FULLMAG_RELAX_DEVICE": os.environ.get("FULLMAG_RELAX_DEVICE"),
        "FULLMAG_FDM_EXECUTION": os.environ.get("FULLMAG_FDM_EXECUTION"),
    }}),
    encoding="utf-8",
)
""",
        encoding="utf-8",
    )
    runtime.chmod(0o755)
    fake_just = repo / "bin" / "just"
    fake_just.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    fake_just.chmod(0o755)
    log = tmp_path / "runtime.json"
    environment = os.environ.copy()
    environment["FULLMAG_GPU_RUNTIME_BIN"] = str(runtime)
    environment["NATIVE_FEM_RUNTIME_LOG"] = str(log)
    environment["PATH"] = str(repo / "bin") + os.pathsep + environment["PATH"]

    result = subprocess.run(
        [
            "bash",
            "scripts/run_fullmag.sh",
            "build=False",
            "dev",
            "fem",
            "gpu",
            "examples/native_fem.py",
        ],
        cwd=repo,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    invocation = json.loads(log.read_text(encoding="utf-8"))
    assert invocation["argv"] == [
        "--dev",
        "-i",
        "examples/native_fem.py",
        "--backend",
        "fem",
        "--web-port",
        "0",
    ]
    assert invocation["env"] == {
        "FULLMAG_FEM_EXECUTION": "gpu",
        "FULLMAG_RELAX_DEVICE": "gpu",
        "FULLMAG_FDM_EXECUTION": "cpu",
    }


@pytest.mark.skipif(os.name == "nt", reason="direct Git Bash helper stubs are POSIX-only")
def test_run_fullmag_keeps_windows_fem_and_fdm_port_defaults(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    script = repo / "scripts" / "run_fullmag.sh"
    environment = os.environ.copy()
    environment["PATH"] = str(repo / "bin") + os.pathsep + environment["PATH"]
    for backend, expected_port in (("fem", "0"), ("fdm", "3100")):
        log = tmp_path / f"{backend}-windows.json"
        environment["NATIVE_FEM_LOG"] = str(log)
        result = subprocess.run(
            [
                "bash",
                "scripts/run_fullmag.sh",
                "windows=True",
                "build=True",
                "dev",
                backend,
                "gpu",
                "examples/native_fem.py",
            ],
            cwd=repo,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr + result.stdout
        command = json.loads(log.read_text(encoding="utf-8"))
        assert command[command.index("-WebPort") + 1] == expected_port


def test_windows_build_fem_recipe_uses_the_same_closed_resolver(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    log = tmp_path / "windows-build.json"
    result = _run_just(repo, log, "windows-build", "fem", "gpu")

    assert result.returncode == 0, result.stderr + result.stdout
    command = json.loads(log.read_text(encoding="utf-8"))
    assert _launcher_arguments(command) == [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(repo / "scripts" / "windows" / "run_fullmag_fem.ps1"),
        "-BuildMode",
        "true",
        "-Frontend",
        "dev",
        "-Backend",
        "fem",
        "-Device",
        "gpu",
        "-RunMode",
        "interactive",
        "-WebPort",
        "0",
        "-BuildOnly",
    ]


def test_fullmag_fem_accepts_spaces_and_unicode_in_script_path(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    script = repo / "examples" / "native fem ż.py"
    script.write_text("print('fixture')\n", encoding="utf-8")
    log = tmp_path / "unicode.json"

    result = _run_just(
        repo,
        log,
        "fullmag",
        "windows=True",
        "build=True",
        "dev",
        "fem",
        "gpu",
        str(script.relative_to(repo)),
    )

    assert result.returncode == 0, result.stderr + result.stdout
    command = json.loads(log.read_text(encoding="utf-8"))
    assert command[-1] == str(script.relative_to(repo))


def test_fullmag_fem_accepts_windows_backslash_unicode_script_path(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    script = repo / "examples" / "native fem ż.py"
    script.write_text("print('fixture')\n", encoding="utf-8")
    host_bin = tmp_path / "windows-host-bin"
    host_bin.mkdir()
    uname = host_bin / "uname"
    uname.write_text("#!/usr/bin/env bash\nprintf '%s\\n' MINGW64_NT\n", encoding="utf-8")
    uname.chmod(0o755)
    windows_script = r"examples\native fem ż.py"
    recipe = _render_recipe(
        repo,
        "fullmag",
        "windows=True",
        "build=True",
        "dev",
        "fem",
        "gpu",
        windows_script,
    )

    result = _probe(repo, recipe, PATH=str(host_bin) + os.pathsep + os.environ["PATH"])

    assert result.returncode == 0, result.stderr


def test_fullmag_auto_device_reaches_canonical_wrapper_unchanged(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    log = tmp_path / "auto.json"

    result = _run_just(
        repo,
        log,
        "fullmag",
        "windows=True",
        "build=True",
        "dev",
        "fem",
        "--device=auto",
        "examples/native_fem.py",
    )

    assert result.returncode == 0, result.stderr + result.stdout
    command = json.loads(log.read_text(encoding="utf-8"))
    assert command[command.index("-Device") + 1] == "auto"


def test_non_native_fullmag_recipes_are_classified_for_existing_route(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    for arguments in (
        ("dev", "fdm", "cpu", "examples/native_fem.py"),
        ("dev", "fem", "cpu", "examples/native_fem.py"),
    ):
        recipe = _render_recipe(repo, "fullmag", *arguments)
        result = _probe(repo, recipe)
        expected = 0 if arguments[1] == "fem" and _native_windows_host() else 3
        assert result.returncode == expected, result.stderr


def test_non_native_external_script_is_classified_before_fem_checkout_guard(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    external_script = tmp_path / "outside-checkout.py"
    external_script.write_text("print('fixture')\n", encoding="utf-8")

    cases = [("windows=True", "dev", "fdm", "cpu")]
    if not _native_windows_host():
        cases.append(("windows=False", "dev", "fem", "cpu"))
    for arguments in cases:
        recipe = _render_recipe(repo, "fullmag", *arguments, str(external_script))
        result = _probe(repo, recipe)
        assert result.returncode == 3, result.stderr


def test_fem_without_windows_flag_keeps_windows_host_implicit_dispatch(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    recipe = _render_recipe(repo, "fullmag", "build=True", "dev", "fem", "gpu", "examples/native_fem.py")
    host_bin = tmp_path / "windows-host-bin"
    host_bin.mkdir()
    uname = host_bin / "uname"
    uname.write_text("#!/usr/bin/env bash\nprintf '%s\\n' MINGW64_NT\n", encoding="utf-8")
    uname.chmod(0o755)

    result = _probe(repo, recipe, PATH=str(host_bin) + os.pathsep + os.environ["PATH"])

    assert result.returncode == 0, result.stderr


def test_invalid_force_and_skip_values_are_rejected(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    for option in ("force=banana", "skip_local_changes=banana"):
        recipe = _render_recipe(
            repo,
            "fullmag",
            "windows=True",
            option,
            "dev",
            "fem",
            "gpu",
            "examples/native_fem.py",
        )
        result = _probe(repo, recipe)
        assert result.returncode == 2, (option, result.stderr)


def test_native_fem_recipe_mutation_is_rejected_before_dispatch(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    log = tmp_path / "mutation.json"
    marker = tmp_path / "must-not-run"
    recipe = _render_recipe(
        repo,
        "fullmag",
        "windows=True",
        "build=True",
        "dev",
        "fem",
        "gpu",
        "examples/native_fem.py",
    )

    result = _run_shell(repo, f"{recipe} && touch {marker}", log)

    assert result.returncode == 2
    assert not log.exists()
    assert not marker.exists()


def test_native_fem_launcher_mutation_is_rejected_before_dispatch(tmp_path: Path) -> None:
    repo = _fixture_repo(tmp_path)
    log = tmp_path / "launcher-mutation.json"
    recipe = _render_recipe(
        repo,
        "fullmag",
        "windows=True",
        "build=True",
        "dev",
        "fem",
        "gpu",
        "examples/native_fem.py",
    )

    if recipe.startswith("bash scripts/run_fullmag.sh "):
        mutated_recipe = recipe.replace(
            '"examples/native_fem.py"',
            '"examples/native_fem.py" && powershell.exe',
            1,
        )
    else:
        mutated_recipe = recipe.replace("run_fullmag_fem.ps1", "run_fullmag.ps1", 1)
    result = _run_shell(repo, mutated_recipe, log)

    assert result.returncode == 2
    assert not log.exists()


@pytest.mark.parametrize("route", ["build", "fem-runtime", "fdm-runtime", "invalid-id"])
def test_workspace_recipes_execute_closed_shell_and_preserve_manifest_id(tmp_path, monkeypatch, route):
    monkeypatch.setenv("OS", "Windows_NT")
    repo = _fixture_repo(tmp_path)
    log = tmp_path / "workspace-launch.json"
    digest = "a" * 64
    if route == "build":
        arguments = ["windows-fem-workspace-build", "gpu", "static", "0"]
    elif route == "fdm-runtime":
        arguments = ["windows-ui", "static", "3198", "false", "release", digest]
    else:
        if route == "invalid-id":
            digest = digest[:-1]
        arguments = ["windows-fem-workspace", "gpu", "static", "0", digest]
    result = _run_just(repo, log, *arguments)
    if route == "invalid-id":
        assert result.returncode != 0
        assert not log.exists()
        return
    assert result.returncode == 0, result.stderr + result.stdout
    command = json.loads(log.read_text(encoding="utf-8"))
    if route == "build":
        assert "-BuildOnly" in command
        assert "-ExpectedBuildId" not in command
        assert command[command.index("-BuildMode") + 1] == "true"
    else:
        assert command.count("-ExpectedBuildId") == 1
        assert command[command.index("-ExpectedBuildId") + 1] == digest
        assert command[command.index("-BuildMode") + 1] == "false"
    if route != "fdm-runtime":
        assert "-Browser" in command
        assert command[command.index("-Device") + 1] == "gpu"
