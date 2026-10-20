"""Regression checks for authored FEM scripts in the registered main checkout."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
DISPATCHER_PATH = ROOT / "scripts" / "windows" / "dispatch_native_fem_recipe.py"


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("dispatch_native_fem_recipe", DISPATCHER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _git(cwd: Path, *arguments: str) -> None:
    result = subprocess.run(["git", *arguments], cwd=cwd, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


@pytest.fixture
def registered_worktree(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    main = tmp_path / "fullmag"
    main.mkdir()
    (main / "scripts" / "windows").mkdir(parents=True)
    (main / "examples").mkdir()
    shutil.copy2(ROOT / "scripts" / "fullmag_storage.py", main / "scripts" / "fullmag_storage.py")
    (main / "examples" / "committed.py").write_text("print('fixture')\n", encoding="utf-8")
    _git(main, "init", "-q")
    _git(main, "config", "user.name", "Fullmag dispatch fixture")
    _git(main, "config", "user.email", "fixture@example.invalid")
    _git(main, "add", ".")
    _git(main, "commit", "-qm", "fixture")

    worktree = tmp_path / "worktree"
    _git(main, "worktree", "add", "--detach", "-q", str(worktree), "HEAD")
    authored = main / "examples" / "authored-only.py"
    authored.write_text("print('main checkout input')\n", encoding="utf-8")
    external = tmp_path / "unapproved.py"
    external.write_text("print('outside')\n", encoding="utf-8")
    return main, worktree, authored, external


def test_native_fem_accepts_main_checkout_authored_script_and_rejects_arbitrary_path(
    registered_worktree, monkeypatch
) -> None:
    _main, worktree, authored, external = registered_worktree
    dispatcher = _load_dispatcher()
    monkeypatch.setattr(dispatcher, "_is_windows_host", lambda: True)

    request = dispatcher._parse_options(
        ["windows=True", "build=True", "dev", "fem", "gpu", str(authored)],
        worktree,
    )
    assert request.script == str(authored)
    assert request.device == "gpu"
    assert request.build_mode == "true"

    with pytest.raises(dispatcher.DispatchError, match="approved checkouts"):
        dispatcher._parse_options(
            ["windows=True", "build=True", "dev", "fem", "gpu", str(external)],
            worktree,
        )


def test_native_fem_keeps_worktree_relative_script_compatible(registered_worktree, monkeypatch) -> None:
    _main, worktree, _authored, _external = registered_worktree
    dispatcher = _load_dispatcher()
    monkeypatch.setattr(dispatcher, "_is_windows_host", lambda: True)
    request = dispatcher._parse_options(
        ["windows=True", "build=True", "dev", "fem", "gpu", "examples/committed.py"],
        worktree,
    )
    assert request.script == "examples/committed.py"
