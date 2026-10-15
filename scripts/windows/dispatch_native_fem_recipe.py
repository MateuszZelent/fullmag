"""Dispatch only the canonical just recipes for native Windows FEM.

The storage shell receives a complete ``just`` recipe body, not the original
arguments.  This helper validates that body against ``just --dry-run`` and
parses the user options without evaluating the recipe text.  It then enters
the canonical PowerShell wrapper, which sets FEM provenance and enters the
closed storage operation; arbitrary shell commands never reach the generic
runner.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys


class DispatchError(RuntimeError):
    pass


class NotNativeFemRecipe(DispatchError):
    """The canonical recipe is valid but selects another backend."""


@dataclass(frozen=True)
class FemRequest:
    frontend: str
    device: str
    build_mode: str
    run_mode: str
    script: str | None
    web_port: int
    skip_local_changes: bool
    build_only: bool
    browser: bool


_FULLMAG_PREFIX = "bash -euo pipefail -c '"
_SHORT_FULLMAG_PREFIX = "bash scripts/run_fullmag.sh"
_FULLMAG_MARKERS = (
    'for raw in ',
    'case "$backend" in',
    'case "$device" in',
    'case "$frontend" in',
    'exec powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ',
)
_WINDOWS_BUILD_ASSIGNMENTS = re.compile(
    r'^backend="(?P<backend>[^"]+)"; device="(?P<device>[^"]+)"; '
    r'frontend="(?P<frontend>[^"]+)"; skip_local_changes="(?P<skip>[^"]+)"; '
)
# Values are passed to `just` as argv and then appear in double-quoted shell
# literals.  Keep spaces and Unicode paths usable, while rejecting characters
# that could change the rendered shell body or its command structure.
_UNSAFE_ARGUMENT = re.compile(r'''[\x00-\x1f\x7f"'`$;&|<>()[\]{}!?*~]''')


def _safe_argument(value: str) -> bool:
    return bool(value) and _UNSAFE_ARGUMENT.search(value) is None


def _is_windows_host() -> bool:
    if os.name == "nt":
        return True
    try:
        result = subprocess.run(
            ["uname", "-s"], capture_output=True, text=True, check=False,
        )
    except OSError:
        return False
    return result.returncode == 0 and result.stdout.strip().startswith(("MINGW", "MSYS", "CYGWIN"))


def _repo(path: str) -> Path:
    value = Path(path)
    if not value.is_absolute() or ".." in value.parts:
        raise DispatchError("Repository root must be an absolute canonical path")
    resolved = value.resolve(strict=True)
    if not (resolved / ".git").exists():
        raise DispatchError(f"Repository root is not a Git checkout: {resolved}")
    return resolved


def _extract_fullmag_raws(recipe: str) -> list[str]:
    if not recipe.startswith(_FULLMAG_PREFIX) or not recipe.endswith("'"):
        raise DispatchError("Native FEM recipe is not the canonical fullmag shell body")
    for marker in _FULLMAG_MARKERS:
        if marker not in recipe:
            raise DispatchError("Native FEM recipe is missing its canonical dispatcher")
    start = recipe.index("for raw in ") + len("for raw in ")
    end = recipe.index("; do", start)
    section = recipe[start:end]
    values = re.findall(r'"([^"]*)"', section)
    if not values or " ".join(f'"{value}"' for value in values) != section:
        raise DispatchError("Native FEM option list is not a fixed quoted argument list")
    if any(not _safe_argument(value) for value in values if value):
        raise DispatchError("Native FEM options contain unsupported shell characters")
    return values


def _extract_short_fullmag_raws(recipe: str) -> list[str]:
    """Extract the fixed option vector from the compact fullmag recipe.

    The long inline recipe exceeds the native Windows process command-line
    budget once `just` passes it through Git Bash.  The compact replacement
    keeps the original eight positional slots, so it remains unambiguous and
    can be checked without evaluating shell text.
    """
    prefix = _SHORT_FULLMAG_PREFIX + " "
    if not recipe.startswith(prefix):
        raise DispatchError("Native FEM recipe is not the compact fullmag shell body")
    values = re.findall(r'"([^"]*)"', recipe[len(prefix):])
    expected = prefix + " ".join(f'"{value}"' for value in values)
    if len(values) != 8 or recipe.strip() != expected:
        raise DispatchError("Compact fullmag recipe must contain exactly eight quoted options")
    if any(not _safe_argument(value) for value in values if value):
        raise DispatchError("Native FEM options contain unsupported shell characters")
    return values


def _normalise_windows_build_value(value: str, name: str) -> str:
    prefix = f"{name}="
    if value.startswith(prefix):
        value = value[len(prefix):]
    return value


def _parse_windows_build(recipe: str) -> tuple[str, str, str, str]:
    match = _WINDOWS_BUILD_ASSIGNMENTS.match(recipe)
    if not match or "run_fullmag_fem.ps1" not in recipe:
        raise DispatchError("Native FEM recipe is not the canonical windows-build body")
    backend = _normalise_windows_build_value(match.group("backend"), "backend")
    device = _normalise_windows_build_value(match.group("device"), "device")
    frontend = _normalise_windows_build_value(match.group("frontend"), "frontend")
    skip = _normalise_windows_build_value(match.group("skip"), "skip_local_changes")
    values = [f"backend={backend}", f"device={device}", f"frontend={frontend}", f"skip_local_changes={skip}"]
    if any(not _safe_argument(value) for value in values):
        raise DispatchError("Native FEM windows-build arguments contain unsupported characters")
    return backend, device, frontend, skip


def _verify_windows_build_canonical(repo: Path, recipe: str, backend: str, device: str,
                                    frontend: str, skip: str) -> None:
    # `just` does not preserve whether a positional or key=value invocation
    # produced the body.  Compare against the small, explicit forms accepted
    # by the recipe rather than accepting a caller-supplied command fragment.
    forms = [
        [backend, device],
        [backend, device, frontend, f"skip_local_changes={skip}"],
        [f"backend={backend}", f"device={device}", f"frontend={frontend}", f"skip_local_changes={skip}"],
    ]
    for arguments in forms:
        try:
            expected = _canonical_recipe(repo, "windows-build", arguments)
        except DispatchError:
            continue
        if recipe.strip() == expected:
            return
    raise DispatchError("Native FEM recipe changed; refusing to evaluate it")


def _canonical_recipe(repo: Path, target: str, arguments: list[str]) -> str:
    try:
        result = subprocess.run(
            ["just", "--dry-run", target, *arguments],
            cwd=repo,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            check=False,
        )
    except OSError as error:
        raise DispatchError(f"Cannot inspect the canonical just recipe: {error}") from error
    if result.returncode != 0:
        diagnostic = (result.stderr or result.stdout).strip()
        raise DispatchError(f"Cannot inspect the canonical just recipe: {diagnostic}")
    # `just --dry-run` deliberately writes the rendered recipe to stderr.  Do
    # not merge both streams: a warning must not become part of the command
    # accepted as canonical.
    rendered = result.stderr.strip() if result.stderr.strip() else result.stdout.strip()
    if not rendered:
        raise DispatchError("Cannot inspect the canonical just recipe: no rendered recipe")
    return rendered


def _verify_canonical(repo: Path, recipe: str, target: str, arguments: list[str]) -> None:
    expected = _canonical_recipe(repo, target, arguments)
    if recipe.strip() != expected:
        raise DispatchError("Native FEM recipe changed; refusing to evaluate it")


def _registered_main_checkout(repo: Path) -> Path:
    """Return Git's registered main checkout through the shared resolver.

    A simulation script is authored input and may live in the main checkout
    while the compiler inputs are captured from a worktree.  The main checkout
    is the only additional authored-input root admitted here; arbitrary paths
    remain rejected.  Keep this lookup in the shared storage resolver so the
    dispatcher cannot invent a second project/worktree relationship.
    """
    resolver_path = repo / "scripts" / "fullmag_storage.py"
    if not resolver_path.is_file():
        raise DispatchError("Cannot verify the main checkout: shared storage resolver is missing")
    try:
        spec = importlib.util.spec_from_file_location("fullmag_storage_for_dispatch", resolver_path)
        if spec is None or spec.loader is None:
            raise ImportError("storage resolver has no import loader")
        resolver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(resolver)
        records = resolver.worktree_records(repo)
    except (OSError, ImportError, RuntimeError, ValueError, TypeError, AttributeError) as error:
        raise DispatchError(f"Cannot verify the main checkout through Git storage metadata: {error}") from error
    if not records or not isinstance(records[0], dict) or not isinstance(records[0].get("worktree"), str):
        raise DispatchError("Git storage metadata has no registered main checkout")
    main = Path(records[0]["worktree"])
    if not main.is_absolute():
        raise DispatchError("Git storage metadata returned a non-absolute main checkout")
    try:
        main = main.resolve(strict=True)
    except OSError as error:
        raise DispatchError("Registered main checkout is unavailable") from error
    if not (main / ".git").exists():
        raise DispatchError("Registered main checkout is not a Git checkout")
    return main


def _path_under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _parse_options(raw_values: list[str], repo: Path) -> FemRequest:
    build = "false"
    force = "false"
    windows = "false"
    frontend = "dev"
    backend = "auto"
    device = "auto"
    run_mode = "interactive"
    script: str | None = None
    web_port = "0"
    skip_local_changes = "false"
    browser = "false"
    seen: set[str] = set()

    aliases = {
        "--build": "build", "build": "build",
        "--windows": "windows", "windows": "windows",
        "--force": "force", "force": "force",
        "--skip_local_changes": "skip", "skip_local_changes": "skip",
        "--skip-local-changes": "skip", "skip-local-changes": "skip",
        "--browser": "browser", "browser": "browser",
        "--frontend": "frontend", "frontend": "frontend", "ui": "frontend",
        "--static": "static", "static": "static", "--dev": "dev", "dev": "dev",
        "--backend": "backend", "backend": "backend", "--discretization": "backend",
        "discretization": "backend", "--engine": "backend", "engine": "backend",
        "--fem": "fem", "fem": "fem", "--fdm": "fdm", "fdm": "fdm",
        "--auto": "auto", "auto": "auto", "--device": "device", "device": "device",
        "--execution": "device", "execution": "device", "--gpu": "gpu", "gpu": "gpu",
        "--cpu": "cpu", "cpu": "cpu", "--mode": "run_mode", "mode": "run_mode",
        "--run_mode": "run_mode", "run_mode": "run_mode", "--interactive": "interactive",
        "-i": "interactive", "interactive": "interactive", "--headless": "headless",
        "headless": "headless", "--script": "script", "script": "script",
        "--web_port": "web_port", "--web-port": "web_port", "--port": "web_port",
        "web_port": "web_port", "web-port": "web_port", "port": "web_port",
    }
    for raw in raw_values:
        if not raw:
            continue
        if "=" in raw:
            key, value = raw.split("=", 1)
        else:
            key = value = raw
        key_lc, value_lc = key.lower(), value.lower()
        option = aliases.get(key_lc)
        if option in {"static", "dev", "fem", "fdm", "auto", "gpu", "cpu", "interactive", "headless"}:
            option = "frontend" if option in {"static", "dev"} else "backend" if option in {"fem", "fdm", "auto"} else "device" if option in {"gpu", "cpu"} else "run_mode"
        elif option is None and key_lc in {"true", "false"}:
            option = "build"
            value_lc = key_lc
        if option is not None:
            if option in seen:
                raise DispatchError(f"Duplicate native FEM option: {raw}")
            seen.add(option)
        elif raw.startswith("-") or "=" in raw or not (raw.endswith(".py") or "/" in raw or "\\" in raw):
            raise DispatchError(f"Unsupported native FEM option: {raw}")

        if key_lc in {"--build", "build"} or key_lc in {"true", "false"}:
            build = value_lc if key_lc not in {"true", "false"} else key_lc
        elif key_lc in {"--windows", "windows"}:
            windows = value_lc
        elif key_lc in {"--force", "force"}:
            force = "true" if key_lc == raw.lower() else value_lc
        elif key_lc in {"--skip_local_changes", "skip_local_changes", "--skip-local-changes", "skip-local-changes"}:
            skip_local_changes = "true" if key_lc == raw.lower() else value_lc
        elif key_lc in {"--browser", "browser"}:
            browser = "true" if key_lc == raw.lower() else value_lc
        elif key_lc in {"--frontend", "frontend", "ui"}:
            frontend = value_lc
        elif key_lc in {"--backend", "backend", "--discretization", "discretization", "--engine", "engine"}:
            backend = value_lc
        elif key_lc in {"--device", "device", "--execution", "execution"}:
            device = value_lc
        elif key_lc in {"--mode", "mode", "--run_mode", "run_mode"}:
            run_mode = value_lc
        elif key_lc in {"--script", "script"}:
            script = value
        elif key_lc in {"--web_port", "--web-port", "--port", "web_port", "web-port", "port"}:
            web_port = value
        elif key_lc in {"--static", "static"}:
            frontend = "static"
        elif key_lc in {"--dev", "dev"}:
            frontend = "dev"
        elif key_lc in {"--fem", "fem"}:
            backend = "fem"
        elif key_lc in {"--fdm", "fdm"}:
            backend = "fdm"
        elif key_lc in {"--auto", "auto"}:
            backend = "auto"
        elif key_lc in {"--gpu", "gpu"}:
            device = "gpu"
        elif key_lc in {"--cpu", "cpu"}:
            device = "cpu"
        elif key_lc in {"--interactive", "-i", "interactive"}:
            run_mode = "interactive"
        elif key_lc in {"--headless", "headless"}:
            run_mode = "headless"
        elif script is None:
            script = raw

    true_values = {"1", "true", "yes", "on"}
    false_values = {"0", "false", "no", "off"}
    if force not in true_values | false_values:
        raise DispatchError("Native FEM force must be true or false")
    if skip_local_changes not in true_values | false_values:
        raise DispatchError("Native FEM skip_local_changes must be true or false")
    if browser not in true_values | false_values:
        raise DispatchError("Native FEM browser must be true or false")
    if windows not in true_values | false_values:
        raise DispatchError("Native FEM windows must be true or false")
    if force in true_values:
        build = "true"
    if build not in {"true", "false", "1", "0", "yes", "no", "on", "off"}:
        raise DispatchError("Native FEM build must be true or false")
    if backend not in {"fem", "fdm", "auto"}:
        raise DispatchError("Invalid native FEM backend")
    if frontend not in {"static", "dev"} or device not in {"auto", "cpu", "gpu"} or run_mode not in {"interactive", "headless", "workspace"}:
        raise DispatchError("Invalid native FEM frontend, device or run mode")
    browser_workspace = browser in true_values
    if browser_workspace:
        if backend != "fem" or run_mode != "workspace" or script is not None:
            raise DispatchError("Native FEM browser workspace requires fem, workspace mode and no simulation script")
    elif run_mode == "workspace":
        raise DispatchError("Native FEM workspace mode requires --browser")
    if not browser_workspace and not _safe_argument(script or ""):
        raise DispatchError("Native FEM simulation requires a safe script path")
    # The original shell recipe dispatches FDM/auto and Linux FEM through its
    # existing path.  Classify those valid recipes before applying FEM-only
    # checkout and script existence checks; the existing route may accept a
    # script outside this checkout.
    if backend != "fem" or (windows not in true_values and not _is_windows_host()):
        raise NotNativeFemRecipe
    script_for_lookup = script
    if not browser_workspace and (os.name == "nt" or _is_windows_host()):
        # Git Bash preserves Windows separators in the rendered recipe, while
        # pathlib on POSIX treats them as ordinary filename characters.  The
        # original spelling is retained for PowerShell provenance; only the
        # existence check uses normalized separators.
        script_for_lookup = script.replace("\\", "/")
    if not browser_workspace:
        candidate = (repo / script_for_lookup).resolve()
        if not candidate.is_file():
            raise DispatchError(f"Native FEM script is outside the checkout or missing: {script}")
        if not _path_under(candidate, repo):
            main = _registered_main_checkout(repo)
            if not _path_under(candidate, main):
                raise DispatchError(f"Native FEM script is outside the approved checkouts or missing: {script}")
    try:
        port = int(web_port, 10)
    except ValueError as error:
        raise DispatchError("Native FEM web port must be an integer") from error
    if not 0 <= port <= 65535:
        raise DispatchError("Native FEM web port must be between 0 and 65535")
    return FemRequest(frontend, device, "true" if build in {"true", "1", "yes", "on"} else "false",
                      run_mode, script, port, skip_local_changes in {"true", "1", "yes", "on"}, False,
                      browser_workspace)


def _parse_windows_build_request(recipe: str, repo: Path) -> FemRequest:
    backend, device, frontend, skip = _parse_windows_build(recipe)
    _verify_windows_build_canonical(repo, recipe, backend, device, frontend, skip)
    if backend.lower() != "fem":
        raise NotNativeFemRecipe
    if device.lower() not in {"auto", "cpu", "gpu"} or frontend.lower() not in {"static", "dev"}:
        raise DispatchError("Invalid native FEM windows-build selection")
    if skip.lower() not in {"true", "false", "1", "0", "yes", "no", "on", "off"}:
        raise DispatchError("Invalid native FEM skip_local_changes value")
    return FemRequest(frontend.lower(), device.lower(), "true", "interactive", None, 0,
                      skip.lower() in {"true", "1", "yes", "on"}, True, False)


def parse_request(recipe: str, repo: Path) -> FemRequest:
    if recipe.startswith(_FULLMAG_PREFIX):
        raw_values = _extract_fullmag_raws(recipe)
        _verify_canonical(repo, recipe, "fullmag", [value for value in raw_values if value])
        request = _parse_options(raw_values, repo)
        return request
    if recipe.startswith(_SHORT_FULLMAG_PREFIX):
        raw_values = _extract_short_fullmag_raws(recipe)
        _verify_canonical(repo, recipe, "fullmag", [value for value in raw_values if value])
        request = _parse_options(raw_values, repo)
        return request
    return _parse_windows_build_request(recipe, repo)


def dispatch(request: FemRequest, repo: Path) -> int:
    command = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File",
        str(repo / "scripts" / "windows" / "run_fullmag_fem.ps1"),
        "-BuildMode", request.build_mode, "-Frontend", request.frontend,
        "-Backend", "fem", "-Device", request.device, "-RunMode", request.run_mode,
        "-WebPort", str(request.web_port),
    ]
    if request.script is not None:
        command += ["-ScriptPath", request.script]
    if request.build_only:
        command.append("-BuildOnly")
    if request.browser:
        command.append("-Browser")
    if request.skip_local_changes:
        command.append("-SkipLocalChanges")
    return subprocess.run(command, cwd=repo, check=False).returncode


def _recipe_summary(recipe: str) -> str:
    return f"recipe_len={len(recipe)} first={recipe[:32]!r} last={recipe[-20:]!r}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    recipe_group = parser.add_mutually_exclusive_group(required=True)
    recipe_group.add_argument("--recipe")
    recipe_group.add_argument(
        "--recipe-stdin",
        action="store_true",
        help="read the rendered recipe from stdin to avoid native shell argv conversion",
    )
    parser.add_argument("--probe", action="store_true", help="validate and classify without dispatch")
    args = parser.parse_args(argv)
    if args.recipe_stdin:
        try:
            recipe = sys.stdin.buffer.read().decode("utf-8")
        except UnicodeDecodeError as error:
            parser.error(f"recipe stdin must be UTF-8: {error}")
    else:
        recipe = args.recipe
    if recipe is None:
        parser.error("one recipe transport is required")
    try:
        repo = _repo(args.repo_root)
        request = parse_request(recipe, repo)
    except NotNativeFemRecipe:
        return 3
    except (DispatchError, OSError, ValueError) as error:
        print(f"[fullmag just] invalid native FEM recipe: {error} ({_recipe_summary(recipe)})", file=sys.stderr)
        return 2
    if args.probe:
        return 0
    return dispatch(request, repo)


if __name__ == "__main__":
    raise SystemExit(main())
